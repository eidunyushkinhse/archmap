"""Расписания пакета cron и @nestjs/schedule в коде Node.js (ТЗ §15 п. 15 Л4) в пакете с
зависимостью cron или @nestjs/schedule.

- `@Cron("выражение")` и `@Cron(CronExpression.X)` над методом: имя из `name:` вторым
  аргументом или имя метода;
- `new CronJob("выражение", f)`: имя по функции вторым аргументом, у выражения в нём —
  `файл:строка`; выражение полем объекта (`config.x.cron`) — подсказка, параметр функции
  (`new CronJob(expression, …)` внутри обёртки) — ни записи, ни подсказки;
- объектный аргумент с ключами `name`, `expression` или `cronTime` и `onTick` (так immich
  регистрирует задания через `cronRepository.create({ name, expression, onTick })`,
  `CronJob.from({ cronTime, onTick })`): ключи читаются только своего уровня объекта, без
  `onTick` объект не регистрация (обновление `update({ name, expression })`, индексы
  таблиц с `expression`); тип и интерфейс (`;` на своём уровне) и образец разбора
  параметра (`create({ name, onTick }: CronCreate)`, `({ onTick }) =>`) не читаются. Имя —
  строка, член строкового перечисления репозитория (`CronJob.NightlyJobs`, как префикс NestJS
  в К4) или как написано, без ключа `name` — функция в `onTick: f`, иначе `файл:строка`;
  выражение не строкой — подсказка с именем ключа: поле объекта — «расписание из
  конфигурации», имя — «задано переменной».

Выражение: строка как написана, шаблонная строка с подстановкой — подсказка, член
`CronExpression.X` раскрывается по словарю _NEST_CRON (неизвестный член — как написан).
Поиск по маске JS (codetext.JS); больше 2000 совпадений в файле (clike.MAX_READS) — файл
непрочитан.
"""

from __future__ import annotations

import re

from archmap_scan import clike, codebase, codetext, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import CodeSchedule, Findings, Loc, schedule_hint
from archmap_scan.parsers import nest
from archmap_scan.walk import Files

NAME = "node-cronjob"
WANTED = frozenset({"cron", "@nestjs/schedule"})
_ID = r"[A-Za-z_$][A-Za-z0-9_$]{0,99}"
_DECORATOR = re.compile(rf"@Cron[ \t]*\({SP}")
_NEW = re.compile(rf"\bnew[ \t]+CronJob[ \t]*(?:<[^<>()\n]{{0,200}}>)?[ \t]*\({SP}")
_ON_TICK = re.compile(r"(?<![\w$.])onTick\b")
_STR = re.compile(STR)
_MEMBER = re.compile(rf"({_ID})[ \t]*\.[ \t]*({_ID})")
_PATH = re.compile(rf"{_ID}(?:[ \t]*\.[ \t]*{_ID}){{0,10}}")
_ARG_END = re.compile(rf"{SP}[,)}}]")
_COMMA = re.compile(rf"{SP},{SP}")
_KEY = re.compile(r"(?<![\w$.])(name|expression|cronTime|onTick)\b[ \t]*(:|(?=[,}\s]))")
_BRACKETS = re.compile(r"[{}()\[\]]")
_NAME_OPTION = re.compile(rf"(?<![\w$.])name[ \t]*:{SP}")
_METHOD = re.compile(
    rf"\s*(?:@{_ID}[ \t]*(?:\([^()]{{0,300}}\))?\s*){{0,10}}"
    rf"(?:(?:public|private|protected|static|async|override|readonly)[ \t]+){{0,4}}({_ID})[ \t]*[(<]"
)
_SPACES = re.compile(SP)
_MAX_OBJECT = 5000
_NEEDLES = ("@Cron(", "CronJob", "onTick")
# Члены CronExpression @nestjs/schedule по словарю ТЗ §15 п. 15 Л4 (вид по смыслу, без поля
# секунд): неизвестный член пишется как написан.
_NEST_CRON = {
    "EVERY_MINUTE": "* * * * *", "EVERY_5_MINUTES": "*/5 * * * *",
    "EVERY_10_MINUTES": "*/10 * * * *", "EVERY_30_MINUTES": "*/30 * * * *",
    "EVERY_HOUR": "0 * * * *", "EVERY_DAY_AT_MIDNIGHT": "0 0 * * *", "EVERY_WEEK": "0 0 * * 0",
    **{f"EVERY_DAY_AT_{h}AM": f"0 {h} * * *" for h in range(1, 12)},
    **{f"EVERY_DAY_AT_{h}PM": f"0 {h + 12} * * *" for h in range(1, 12)},
}


class _File:
    def __init__(self, files: Files, ctx: Context, code: codetext.Code, rel: str) -> None:
        self.files = files
        self.ctx = ctx
        self.code = code
        self.rel = rel
        self.found = Findings()

    def loc(self, pos: int) -> Loc:
        return Loc(self.rel, self.code.line(pos))

    def hint(self, expression: str, reason: str, pos: int, task: str) -> None:
        """Расписание выражением: имя и расписание подсказки — выражение как написано, задача
        та же, что была бы у записи (ТЗ §15 п. 16 П3)."""
        self.found.hints.append(schedule_hint(
            expression, reason, self.loc(pos), schedule=expression, task=task,
        ))

    def add(self, name: str, schedule: str, pos: int) -> None:
        self.found.schedules.append(CodeSchedule(
            name=name, schedule=schedule, task=name, loc=self.loc(pos), parser=NAME,
        ))

    def expression(self, pos: int) -> tuple[str | None, str | None, str]:
        """Выражение с позиции pos: (расписание, None, "") или (None, текст, причина
        подсказки); (None, None, "") — ни записи, ни подсказки (параметр)."""
        mask = self.code.mask
        lit = _STR.match(mask, pos)
        if lit is not None:
            value, dynamic = self.code.literal(lit.start(), lit.end())
            if dynamic:
                return None, self.code.expression(pos), texts.REASON_SCHEDULE_VARIABLE
            return value, None, ""
        path = _PATH.match(mask, pos)
        if path is None or _ARG_END.match(mask, path.end()) is None:
            return None, self.code.expression(pos), texts.REASON_SCHEDULE_VARIABLE
        text = " ".join(self.code.text[path.start():path.end()].split())
        member = _MEMBER.fullmatch(mask, path.start(), path.end())
        if member is not None and member.group(1) == "CronExpression":
            return _NEST_CRON.get(member.group(2), text), None, ""
        if "." in text:
            return None, text, texts.REASON_SCHEDULE_CONFIG
        return None, text, texts.REASON_SCHEDULE_VARIABLE

    def name_at(self, pos: int) -> str | None:
        """Имя задания с позиции pos: строка, член перечисления (значение или как написан)."""
        mask = self.code.mask
        lit = _STR.match(mask, pos)
        if lit is not None:
            value, dynamic = self.code.literal(lit.start(), lit.end())
            return None if dynamic else value
        member = _MEMBER.match(mask, pos)
        if member is not None and _ARG_END.match(mask, member.end()):
            known = nest.enum_value(self.files, self.ctx, self.rel, member.group(1), member.group(2))
            return known or self.code.text[member.start():member.end()]
        return None


def _close(mask: str, pos: int, limit: int) -> int | None:
    """Позиция после скобки, закрывающей открытую до pos; None — не закрыта в limit."""
    depth = 1
    for m in _BRACKETS.finditer(mask, pos, min(len(mask), pos + limit)):
        depth += 1 if m.group() in "({[" else -1
        if depth == 0:
            return m.end()
    return None


def _decorators(f: _File) -> None:
    mask = f.code.mask
    for m in clike.matches(f.files, f.rel, _DECORATOR, mask) or []:
        end = _close(mask, m.end(), 2000)
        if end is None:
            continue
        schedule, hint, reason = f.expression(m.end())
        name = None
        option = _NAME_OPTION.search(mask, m.end(), end)
        if option is not None:
            name = f.name_at(option.end())
        if name is None:
            method = _METHOD.match(mask, end)
            name = method.group(1) if method is not None else str(f.loc(m.start()))
        if schedule is None:
            if hint is not None:
                f.hint(hint, reason, m.start(), name)
            continue
        f.add(name, schedule, m.start())


def _constructors(f: _File) -> None:
    mask = f.code.mask
    for m in clike.matches(f.files, f.rel, _NEW, mask) or []:
        lit = _STR.match(mask, m.end())
        path = None if lit is not None else _PATH.match(mask, m.end())
        if lit is None and (path is None or "." not in path.group()):
            continue  # параметр обёртки или выражение: не расписание этого места
        schedule, hint, reason = f.expression(m.end())
        name = str(f.loc(m.start()))
        after = lit.end() if lit is not None else path.end() if path is not None else m.end()
        comma = _COMMA.match(mask, after)
        if comma is not None:
            job = _PATH.match(mask, comma.end())
            if job is not None and _ARG_END.match(mask, job.end()):
                name = " ".join(f.code.text[job.start():job.end()].split()).removeprefix("this.")
        if schedule is None:
            if hint is not None and reason == texts.REASON_SCHEDULE_CONFIG:
                f.hint(hint, reason, m.start(), name)
            continue
        f.add(name, schedule, m.start())


def _object_start(mask: str, pos: int) -> int | None:
    """Позиция «{» объекта, ключ которого стоит в pos (не дальше _MAX_OBJECT назад): скобки
    просматриваются в обратном порядке по перевёрнутому участку маски."""
    lo = max(0, pos - _MAX_OBJECT)
    depth = 0
    for m in _BRACKETS.finditer(mask[lo:pos][::-1]):
        ch = m.group()
        if ch in ")]}":
            depth += 1
        elif depth == 0:
            return pos - 1 - m.start() if ch == "{" else None
        else:
            depth -= 1
    return None


def _keys(mask: str, start: int, end: int) -> dict[str, re.Match[str]] | None:
    """Ключи своего уровня объекта «{» в start, «}» перед end; None — тип или интерфейс
    (на своём уровне есть «;»: `{ expression: string; onTick: () => void }`)."""
    keys: dict[str, re.Match[str]] = {}
    depth = 0
    pos = start + 1

    def segment(stop: int) -> bool:
        if mask.find(";", pos, stop) != -1:
            return False
        for key in _KEY.finditer(mask, pos, stop):
            keys.setdefault(key.group(1), key)
        return True

    for bracket in _BRACKETS.finditer(mask, start + 1, end - 1):
        if depth == 0 and not segment(bracket.start()):
            return None
        depth += 1 if bracket.group() in "({[" else -1
        pos = bracket.end()
    if depth == 0 and not segment(end - 1):
        return None
    return keys


def _pattern(mask: str, end: int) -> bool:
    """Объект перед end — образец разбора, а не значение: за ним «:» или «=» (параметр
    `create({ name, onTick }: CronCreate)`, `const { a } = x`) или «)» и тело функции
    (`({ onTick }) => …`, `function f({ onTick }) {`)."""
    pos = _skip(mask, end)
    ch = mask[pos:pos + 1]
    if ch == ":" or (ch == "=" and mask[pos + 1:pos + 2] not in ("=", ">")):
        return True
    if ch != ")":
        return False
    after = _skip(mask, pos + 1)
    return mask[after:after + 1] in ("{", ":") or mask.startswith("=>", after)


def _tick_name(f: _File, key: re.Match[str]) -> str | None:
    """Имя функции в `onTick: f` (без `this.`); стрелка, литеральная функция — None."""
    if key.group(2) != ":":
        return None
    mask = f.code.mask
    job = _PATH.match(mask, _skip(mask, key.end()))
    if job is None or _ARG_END.match(mask, job.end()) is None:
        return None
    return " ".join(f.code.text[job.start():job.end()].split()).removeprefix("this.")


def _objects(f: _File) -> None:
    mask = f.code.mask
    seen: set[int] = set()
    for tick in clike.matches(f.files, f.rel, _ON_TICK, mask) or []:
        start = _object_start(mask, tick.start())
        if start is None or start in seen:
            continue
        seen.add(start)
        end = _close(mask, start + 1, _MAX_OBJECT)
        if end is None or _pattern(mask, end):
            continue
        keys = _keys(mask, start, end)
        if keys is None:
            continue
        expr = keys.get("expression") or keys.get("cronTime")
        if expr is None or "onTick" not in keys:
            continue
        label = keys.get("name")
        name = None
        if label is not None and label.group(2) == ":":
            name = f.name_at(_skip(mask, label.end()))
        elif label is None:
            name = _tick_name(f, keys["onTick"])
        at = label.start() if label is not None else expr.start()
        task = name or str(f.loc(at))
        if expr.group(2) != ":":
            f.hint(expr.group(1), texts.REASON_SCHEDULE_VARIABLE, expr.start(), task)
            continue
        schedule, hint, reason = f.expression(_skip(mask, expr.end()))
        if schedule is None:
            if hint is not None:
                f.hint(hint, reason, expr.start(), task)
            continue
        f.add(task, schedule, at)


def _skip(mask: str, pos: int) -> int:
    m = _SPACES.match(mask, pos)
    return m.end() if m is not None else pos


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.NODE, WANTED):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.NODE, WANTED, _NEEDLES):
        code = codetext.load(files, rel, text, codetext.JS)
        if code is None:
            continue
        f = _File(files, ctx, code, rel)
        _decorators(f)
        _constructors(f)
        _objects(f)
        found.schedules.extend(f.found.schedules)
        found.hints.extend(f.found.hints)
    return found
