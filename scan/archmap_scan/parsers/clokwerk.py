"""Расписания clokwerk в коде Rust (ТЗ §15 п. 15 Л3) в крейте с зависимостью clokwerk.

`scheduler.every(TimeUnits::minutes(N))`, `.every(1.hour())`, `.every(Interval::Daily)` и
цепочка за ним: `.at("hh:mm")` добавляется к расписанию через пробел, `.run(замыкание)`
даёт имя и задачу. Расписание — текст аргумента every как написан. Имя и задача — первый
вызов свободной функции в теле run (`update_hot_ranks(…)`; методы `x.clone()`, макросы и
конструкторы с заглавной буквы не считаются); нет такого вызова — `файл:строка`.

Поиск по маске Rust (codetext.RUST): every в комментарии и строке не читается, модуль
тестов `#[cfg(test)] mod … { … }` и каталоги тестов не читаются. Пределы: аргумент every и
звено цепочки до 2000 знаков, тело run до 20 тыс. знаков, до 10 звеньев цепочки, больше
2000 вызовов every в файле (clike.MAX_READS) — файл непрочитан.
"""

from __future__ import annotations

import re
from bisect import bisect_right

from archmap_scan import clike, codebase, codetext
from archmap_scan.codetext import SP
from archmap_scan.context import Context
from archmap_scan.model import CodeSchedule, Findings, Loc
from archmap_scan.parsers.rustenv import test_modules
from archmap_scan.walk import Files

NAME = "clokwerk"
WANTED = frozenset({"clokwerk"})
_EVERY = re.compile(r"\.[ \t\r\n]{0,200}every[ \t]*\(")
_LINK = re.compile(rf"{SP}\.{SP}([A-Za-z_][A-Za-z0-9_]{{0,99}})[ \t]*\(")
_LIT = re.compile(rf'{SP}("[ ]*")')
_PARENS = re.compile(r"[()]")
# Вызов свободной функции: имя со строчной буквы, перед ним не точка и не часть имени.
_FREE_CALL = re.compile(r"(?<![.\w])([a-z_][a-z0-9_]{0,99})[ \t]*\(")
_KEYWORDS = frozenset({
    "if", "while", "for", "match", "loop", "return", "move", "async", "await", "in", "as",
    "let", "fn", "unsafe", "where", "impl",
})
_MAX_ARG = 2000
_MAX_BODY = 20_000
_MAX_LINKS = 10
_NEEDLES = (".every(",)


def _close(mask: str, pos: int, limit: int) -> int | None:
    """Позиция закрывающей «)» для «(», открытой перед pos; None — не закрыта в limit."""
    depth = 1
    for m in _PARENS.finditer(mask, pos, min(len(mask), pos + limit)):
        depth += 1 if m.group() == "(" else -1
        if depth == 0:
            return m.start()
    return None


def _task(code: codetext.Code, start: int, end: int) -> str | None:
    """Первый вызов свободной функции в участке [start, end)."""
    for m in _FREE_CALL.finditer(code.mask, start, min(end, start + _MAX_BODY)):
        if m.group(1) not in _KEYWORDS:
            return m.group(1)
    return None


def _schedule(code: codetext.Code, rel: str, m: re.Match[str], found: Findings) -> None:
    mask, text = code.mask, code.text
    close = _close(mask, m.end(), _MAX_ARG)
    if close is None:
        return
    every = " ".join(text[m.end():close].split())
    if not every:
        return
    at: str | None = None
    task: str | None = None
    pos = close + 1
    for _ in range(_MAX_LINKS):
        link = _LINK.match(mask, pos)
        if link is None:
            break
        limit = _MAX_BODY if link.group(1) == "run" else _MAX_ARG
        end = _close(mask, link.end(), limit)
        if end is None:
            break
        if link.group(1) == "at":
            lit = _LIT.match(mask, link.end())
            if lit is not None:
                at = clike.literal_value(code, lit.start(1), lit.end(1))
        elif link.group(1) == "run":
            task = _task(code, link.end(), end)
        elif link.group(1) == "every":
            break  # следующее расписание той же цепочки читается своим совпадением
        pos = end + 1
    name = task or str(Loc(rel, code.line(m.start())))
    found.schedules.append(CodeSchedule(
        name=name, schedule=f"{every} {at}" if at else every, task=name,
        loc=Loc(rel, code.line(m.start())), parser=NAME,
    ))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.RUST, WANTED):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.RUST, WANTED, _NEEDLES):
        if clike.in_test_dir(rel):
            continue
        code = codetext.load(files, rel, text, codetext.RUST)
        if code is None:
            continue
        calls = clike.matches(files, rel, _EVERY, code.mask)
        if not calls:
            continue
        tests = test_modules(code.mask) if "cfg" in code.mask else []
        starts = [a for a, _ in tests]
        for m in calls:
            k = bisect_right(starts, m.start()) - 1
            if k < 0 or m.start() >= tests[k][1]:
                _schedule(code, rel, m, found)
    return found
