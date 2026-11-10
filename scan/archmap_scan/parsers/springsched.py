"""Расписания Spring @Scheduled в коде Java и Kotlin (ТЗ §15 п. 17 Л1).

Пакет со Spring Boot (артефакт spring-boot*). @Scheduled над методом: cron = "0 0 * * * *"
(выражение как написано), fixedRate = 5000 и fixedDelay = 5000 (число, 5000L, 30_000) —
«every 5000 ms» и «every 5000 ms after completion» (timeUnit = TimeUnit.SECONDS даёт «s»,
MINUTES — «min», HOURS — «h», DAYS — «d»); fixedRateString и fixedDelayString — число той же
формой, длительность («PT10S», «10s») как написана: «every PT10S». Имя расписания и задача —
имя метода. Строка константой класса Java раскрывается (clike), подстановка «${key:d}» —
дефолтом; подстановка без дефолта даёт подсказку «из конфигурации» с выражением, выражение
или константа Kotlin — подсказку «задано переменной» (П3). cron = "-" (расписание выключено)
записи не даёт, дефолт «-» у подстановки — подсказка «из конфигурации». @Schedules с
несколькими @Scheduled — по записи на каждую. @Scheduled без cron, fixedRate и fixedDelay
(одноразовый запуск initialDelay) не расписание.
"""

from __future__ import annotations

import bisect
import re

from archmap_scan import clike, codebase, codetext, jvm, jvmconf, texts
from archmap_scan.context import Context
from archmap_scan.model import CodeSchedule, Findings, Loc, schedule_hint
from archmap_scan.walk import Files

NAME = "spring-scheduled"
STACK = ("spring-boot",)
_NEEDLES = ("Scheduled",)
_NAMES = frozenset({"Scheduled", "Schedules"})
_UNITS = {
    "NANOSECONDS": "ns", "MICROSECONDS": "us", "MILLISECONDS": "ms", "SECONDS": "s",
    "MINUTES": "min", "HOURS": "h", "DAYS": "d",
}
_NUMBER = re.compile(r"-?[0-9][0-9_]{0,30}[Ll]?")
_FORMS = {"fixedRate": "every {}", "fixedDelay": "every {} after completion"}
_LABELS = frozenset({"cron", *_FORMS})
_STRING_FORMS = {"fixedRateString": "fixedRate", "fixedDelayString": "fixedDelay"}
# Выключенное расписание Spring (Scheduled.CRON_DISABLED).
_DISABLED = "-"
# Начало выражения в подсказке.
_EXPR_CHARS = 200


def _method_name(outline: jvm.Outline, member: jvm.Member | None) -> str | None:
    if member is None or member.kind != "method":
        return None
    m = jvm.ID.match(outline.code.mask, member.at)
    return m.group() if m is not None else None


def _value(
    code: codetext.Code, repo: clike.Repo | None, rel: str, lo: int, hi: int,
) -> str | None:
    """Текст значения аргумента [lo, hi): строка (литерал или константа класса Java) или число
    как написано; иначе None (выражение, константа Kotlin)."""
    text = jvm.string_value(code, repo, rel, lo, hi)
    if text is not None:
        return text
    if _NUMBER.fullmatch(code.mask, lo, hi):
        return code.mask[lo:hi]
    return None


def _schedule(
    code: codetext.Code, outline: jvm.Outline, repo: clike.Repo | None, rel: str,
    ann: jvm.Annotation, task: str, found: Findings,
) -> None:
    loc = Loc(rel, code.line(ann.at))
    unit = "ms"
    picked: tuple[str, int, int] | None = None
    if ann.args >= 0:
        for arg in jvm.args(outline, ann.args, clike.MAX_READS):
            if arg.label == "timeUnit":
                name = code.mask[arg.start:arg.end].rsplit(".", 1)[-1].strip()
                unit = _UNITS.get(name, unit)
            elif (arg.label in _LABELS or arg.label in _STRING_FORMS) and picked is None:
                picked = (arg.label, arg.start, arg.end)
    if picked is None:
        return
    label, lo, hi = picked
    value = _value(code, repo, rel, lo, hi)
    if value is None:
        expr = code.text[lo:min(hi, lo + _EXPR_CHARS)].strip()
        found.hints.append(schedule_hint(task, texts.REASON_SCHEDULE_VARIABLE, loc, expr, task))
        return
    written = value
    if "${" in value:
        expanded = jvmconf.expand(value)
        if expanded is None or expanded.strip() == _DISABLED:
            found.hints.append(
                schedule_hint(task, texts.REASON_SCHEDULE_CONFIG, loc, written[:_EXPR_CHARS], task),
            )
            return
        value = expanded
    value = value.strip()
    if not value or value == _DISABLED:
        return
    if label == "cron":
        text = value
    else:
        form = _FORMS[_STRING_FORMS.get(label, label)]
        number = _NUMBER.fullmatch(value)
        amount = value.rstrip("Ll").replace("_", "") if number else value
        text = form.format(f"{amount} {unit}" if number else amount)
    found.schedules.append(CodeSchedule(name=task, schedule=text, task=task, loc=loc, parser=NAME))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not jvm.stack_present(files, ctx, STACK):
        return found
    found.applied.add(NAME)
    repo = clike.Repo(files, ctx, codebase.JAVA, codetext.JAVA)
    for rel, code, language in jvm.sources(files, ctx, STACK, _NEEDLES):
        if language == codebase.JAVA:
            repo.note(rel, code)
        part = Findings()
        try:
            hits = jvm.annotation_hits(code, _NAMES)
            if not hits:
                continue
            outline = jvm.Outline.of(code)
            anns = jvm.bind_annotations(outline, hits)
            members = jvm.members(outline, anns)
            # @Scheduled внутри @Schedules({@Scheduled, @Scheduled}): метод тот же, что у @Schedules. Группы по
            # позиции скобок, поиск делением пополам: аннотаций в файле бывают тысячи.
            groups = [a for a in anns if a.name == "Schedules" and a.args >= 0]
            starts = [g.args for g in groups]
            for ann in anns:
                if ann.name != "Scheduled":
                    continue
                member = members.get(ann.at)
                k = bisect.bisect_left(starts, ann.at) - 1
                if k >= 0 and ann.at < groups[k].end:
                    member = members.get(groups[k].at)
                task = _method_name(outline, member)
                if task is None:
                    continue
                _schedule(
                    code, outline, repo if language == codebase.JAVA else None, rel, ann, task,
                    part,
                )
                if len(part.schedules) + len(part.hints) > clike.MAX_READS:
                    raise jvm.TooMany
        except jvm.TooMany:
            files.refuse(rel)
            continue
        found.schedules.extend(part.schedules)
        found.hints.extend(part.hints)
    return found
