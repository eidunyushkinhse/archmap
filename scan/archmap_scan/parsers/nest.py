"""Маршруты NestJS (ТЗ §6.2): @Controller('prefix') и методы @Get('p'), @Post(), @Put,
@Patch, @Delete, @Options, @Head, @All внутри класса. Глобальный префикс
app.setGlobalPrefix('api') в любом файле пакета добавляется ко всем маршрутам пакета;
префикс не строкой делает их нерешёнными. Поиск идёт по маске кода (codetext.py)."""

from __future__ import annotations

import re

from archmap_scan import codebase, codetext, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route
from archmap_scan.walk import Files

NAME = "nest"
FRAMEWORK = "NestJS"
WANTED = frozenset({"@nestjs/core", "@nestjs/common"})
_CONTROLLER = re.compile(rf"@Controller[ \t]*\({SP}")
_METHOD = re.compile(rf"@(Get|Post|Put|Patch|Delete|Options|Head|All)[ \t]*\({SP}({STR})?")
_GLOBAL = re.compile(rf"\.[ \t]*setGlobalPrefix[ \t]*\({SP}({STR})?")
_PATH_KEY = re.compile(rf"path[ \t]*:{SP}({STR})")
_STR = re.compile(STR)


def _join(*parts: str) -> str:
    pieces = [p.strip("/") for p in parts if p.strip("/")]
    return "/" + "/".join(pieces)


def _dynamic(code: codetext.Code, rel: str, found: Findings, start: int) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "route", "name": code.expression(start), "reason": texts.REASON_DYNAMIC_ROUTE,
        "source": str(Loc(rel, code.line(start))),
    }))


def _controller(code: codetext.Code, rel: str, found: Findings, start: int) -> str | None:
    """Префикс контроллера по аргументу @Controller: строка, { path: '…' } или пусто;
    None — префикс не строкой."""
    mask = code.mask
    ch = mask[start:start + 1]
    if ch == ")":
        return ""
    if ch == "{":
        close = mask.find("}", start, start + 500)
        hit = _PATH_KEY.search(mask, start, close if close != -1 else start + 500)
        if hit is None:
            return ""
        value, dynamic = code.literal(hit.start(1), hit.end(1))
        return None if dynamic else value
    hit = _STR.match(mask, start)
    if hit is None:
        _dynamic(code, rel, found, start)
        return None
    value, dynamic = code.literal(hit.start(), hit.end())
    if dynamic:
        _dynamic(code, rel, found, start)
        return None
    return value


def _global_prefix(files: Files, ctx: Context, texts_of: dict[str, str]) -> dict[str, str | None]:
    """Каталог пакета → глобальный префикс (None — не строкой)."""
    out: dict[str, str | None] = {}
    for rel, text in texts_of.items():
        if "setGlobalPrefix" not in text:
            continue
        code = codetext.load(files, rel, text, codetext.JS)
        if code is None:
            continue
        for m in _GLOBAL.finditer(code.mask):
            pkgs = codebase.owner_packages(files, ctx, rel, codebase.NODE)
            if not pkgs:
                continue
            if m.group(1) is None:
                out[pkgs[0].dir] = None
                continue
            value, dynamic = code.literal(m.start(1), m.end(1))
            out[pkgs[0].dir] = None if dynamic else value
    return out


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.NODE, WANTED):
        return found
    found.applied.add(NAME)
    texts_of = dict(codebase.sources(
        files, ctx, codebase.NODE, WANTED, ("@Controller", "setGlobalPrefix"),
    ))
    prefixes = _global_prefix(files, ctx, texts_of)
    for rel, text in texts_of.items():
        if "@Controller" not in text:
            continue
        pkgs = codebase.owner_packages(files, ctx, rel, codebase.NODE)
        global_prefix = prefixes.get(pkgs[0].dir, "") if pkgs else ""
        code = codetext.load(files, rel, text, codetext.JS)
        if code is None:
            continue
        controllers = [
            (m.start(), _controller(code, rel, found, m.end()))
            for m in _CONTROLLER.finditer(code.mask)
        ]
        for m in _METHOD.finditer(code.mask):
            owner = [c for c in controllers if c[0] < m.start()]
            if not owner:
                continue
            prefix = owner[-1][1]
            if m.group(2) is not None:
                path, dynamic = code.literal(m.start(2), m.end(2))
                if dynamic:
                    _dynamic(code, rel, found, m.start(2))
                    continue
            elif code.mask[m.end():m.end() + 1] == ")":
                path = ""
            else:
                _dynamic(code, rel, found, m.end())
                continue
            method = m.group(1).upper()
            found.routes.append(Route(
                method="ANY" if method == "ALL" else method,
                path=_join(global_prefix or "", prefix or "", path),
                loc=Loc(rel, code.line(m.start())), framework=FRAMEWORK, parser=NAME,
                prefix_unresolved=prefix is None or global_prefix is None,
            ))
    return found
