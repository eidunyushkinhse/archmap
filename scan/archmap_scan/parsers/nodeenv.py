"""Параметры конфигурации в коде Node (ТЗ §6.2): process.env.X и process.env['X'], дефолт
из «|| 'v'» и «?? 'v'» сразу за чтением (строка, число, true или false). Поиск по маске
кода (codetext.py): чтение в комментарии не находится. Имя не строкой
(process.env[name]) уходит в hints.dynamic_names."""

from __future__ import annotations

import re

from archmap_scan import codebase, codetext, secrets, texts
from archmap_scan.codetext import STR
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "node-env"
# Дефолт сразу за чтением: «|| 'v'», «?? 20», «|| true».
_DEFAULT = (
    rf"(?:[ \t]*(?:\|\||\?\?)[ \t]*"
    rf"({STR}|-?[0-9]{{1,20}}(?:\.[0-9]{{1,20}})?|true|false))?"
)
_DOT = re.compile(
    rf"process[ \t]*\.[ \t]*env[ \t]*\.[ \t]*([A-Za-z_][A-Za-z0-9_]{{0,199}}){_DEFAULT}"
)
_BRACKET = re.compile(rf"process[ \t]*\.[ \t]*env[ \t]*\[[ \t]*({STR})?")
_BRACKET_TAIL = re.compile(rf"[ \t]*\]{_DEFAULT}")
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,199}")
_STR = re.compile(STR)


def _add(code: codetext.Code, rel: str, found: Findings, name: str, at: int,
         default: tuple[int, int] | None) -> None:
    text: str | None = None
    if default is not None:
        start, end = default
        if _STR.fullmatch(code.mask, start, end):
            value, dynamic = code.literal(start, end)
            text = None if dynamic else value
        else:
            text = code.text[start:end]
    found.code_params.append(CodeParam(
        name=name, loc=Loc(rel, code.line(at)), parser=NAME, default=text,
        has_default=default is not None, type=secrets.value_type(text),
    ))


def _scan(code: codetext.Code, rel: str, found: Findings) -> None:
    for m in _DOT.finditer(code.mask):
        span = m.span(2) if m.group(2) is not None else None
        _add(code, rel, found, m.group(1), m.start(), span)
    for m in _BRACKET.finditer(code.mask):
        name, dynamic = code.literal(m.start(1), m.end(1)) if m.group(1) else ("", True)
        if dynamic:
            found.hints.append(Hint("dynamic_names", {
                "kind": "config", "name": code.expression(m.start(1) if m.group(1) else m.end()),
                "reason": texts.REASON_DYNAMIC_PARAM,
                "source": str(Loc(rel, code.line(m.start()))),
            }))
            continue
        if not _VAR.fullmatch(name):
            continue
        tail = _BRACKET_TAIL.match(code.mask, m.end())
        span = tail.span(1) if tail is not None and tail.group(1) is not None else None
        _add(code, rel, found, name, m.start(), span)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.NODE):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.NODE, None, ("process.env",)):
        code = codetext.load(files, rel, text, codetext.JS)
        if code is not None:
            _scan(code, rel, found)
    return found
