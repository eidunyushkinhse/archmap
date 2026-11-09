"""Расписания robfig/cron в коде Go (ТЗ §15 п. 15 Л2) в модуле с зависимостью
github.com/robfig/cron.

В файле, который импортирует robfig/cron, вызовы `c.AddFunc(spec, f)`, `c.AddJob(spec, j)`
и `c.Schedule(cron.Every(d), j)` дают расписание. Расписание как написано: литерал
(`@every 10m`, `0 0 * * *`), строковая константа или переменная верхнего уровня этого файла
(gocode.string_constants) раскрывается, выражение (`fmt.Sprintf("@every %s", d)`,
`cron.Every(time.Hour)`) пишется текстом; имя переменной без строкового значения в файле —
подсказка «расписание задано переменной». Имя и задача — имя функции, метода или задания
вторым аргументом (`s.cleanup`, `job`); у литеральной функции `func() {…}` и прочих
выражений имя записи — `файл:строка`. Файлы `_test.go` не читаются (walk), больше 2000
вызовов в файле (clike.MAX_READS) — файл непрочитан.
"""

from __future__ import annotations

import re

from archmap_scan import clike, codebase, codetext, gocode, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import CodeSchedule, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "go-cron"
WANTED = frozenset({"github.com/robfig/cron"})
_CALL = re.compile(rf"\.[ \t]*(AddFunc|AddJob|Schedule)[ \t]*\({SP}")
_LIT = re.compile(STR)
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}(?:\.[A-Za-z_][A-Za-z0-9_]{0,99}){0,5}")
_LIST = re.compile(r"[()\[\]{},]")
_ARG_END = re.compile(rf"{SP}[,)]")
_SPACES = re.compile(SP)
_NEEDLES = ("robfig/cron",)


def _first_arg_end(mask: str, pos: int) -> int | None:
    """Позиция запятой после первого аргумента вызова (аргумент с позиции pos); None — до
    неё скобка вызова закрылась или запятой нет в gocode.MAX_LIST знаков."""
    depth = 0
    for m in _LIST.finditer(mask, pos, min(len(mask), pos + gocode.MAX_LIST)):
        ch = m.group()
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                return None
            depth -= 1
        elif depth == 0:
            return m.start()
    return None


def _spec(
    code: codetext.Code, consts: dict[str, tuple[str, int]], start: int, end: int,
) -> tuple[str | None, str]:
    """Расписание аргумента [start, end): текст и пусто; None и имя — переменная без
    строкового значения в файле (подсказка)."""
    mask, text = code.mask, code.text
    lit = _LIT.fullmatch(mask, start, end)
    if lit is not None:
        return text[start + 1:end - 1], ""
    ident = _IDENT.fullmatch(mask, start, end)
    if ident is not None:
        hit = consts.get(ident.group())
        if hit is not None:
            return hit[0], ""
        return None, ident.group()
    return " ".join(text[start:end].split()), ""


def _job(code: codetext.Code, rel: str, pos: int, at: int) -> str:
    """Имя задания с позиции pos: функция, метод или переменная до конца аргумента;
    литеральная функция и прочее выражение — место вызова."""
    ident = _IDENT.match(code.mask, pos)
    if ident is not None and ident.group() != "func" and _ARG_END.match(code.mask, ident.end()):
        return ident.group()
    return str(Loc(rel, code.line(at)))


def _scan(files: Files, code: codetext.Code, rel: str, found: Findings) -> None:
    calls = clike.matches(files, rel, _CALL, code.mask)
    if not calls:
        return
    mask = code.mask
    consts = gocode.string_constants(code.text, mask)
    for m in calls:
        start = m.end()
        end = _first_arg_end(mask, start)
        if end is None:
            continue
        spec_end = clike.skip_back(mask, end)
        if spec_end <= start:
            continue
        loc = Loc(rel, code.line(m.start()))
        schedule, variable = _spec(code, consts, start, spec_end)
        if schedule is None:
            found.hints.append(Hint("dynamic_names", {
                "kind": "schedule", "name": variable, "reason": texts.REASON_SCHEDULE_VARIABLE,
                "source": str(loc),
            }))
            continue
        job_at = _SPACES.match(mask, end + 1)
        name = _job(code, rel, job_at.end() if job_at is not None else end + 1, m.start())
        found.schedules.append(CodeSchedule(
            name=name, schedule=schedule, task=name, loc=loc, parser=NAME,
        ))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.GO, WANTED):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.GO, WANTED, _NEEDLES):
        if '"github.com/robfig/cron' not in text:
            continue
        code = codetext.load(files, rel, text, codetext.GO)
        if code is not None:
            _scan(files, code, rel, found)
    return found
