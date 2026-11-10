"""Маршруты NestJS (ТЗ §6.2): @Controller('prefix') и методы @Get('p'), @Post(), @Put,
@Patch, @Delete, @Options, @Head, @All внутри класса. Глобальный префикс
app.setGlobalPrefix('api') в любом файле пакета добавляется ко всем маршрутам пакета;
префикс не строкой делает их нерешёнными. Поиск идёт по маске кода (codetext.py).

Префикс членом перечисления `@Controller(Имя.Член)` (ТЗ §15 п. 15 К4) раскрывается в
строковое значение `enum Имя { Член = 'строка' }`: сначала в пакете файла контроллера, иначе
в любом пакете репозитория; объявления с разными значениями в нескольких пакетах —
подсказка «неоднозначно», член не строкой или не найден — подсказка, как раньше. Перечисления
репозитория читаются один раз за запуск и только когда такой префикс встретился.

Префикс и путь метода именем константы (`@Controller(PREFIX)`, `@Get(PATH)`, ТЗ §15 п. 18
К1) раскрываются по nodeconst (файл, затем импортированное имя в пакете или репозитории);
разные значения — подсказка «константа объявлена в нескольких файлах»."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import cast

from archmap_scan import codebase, codetext, nodeconst, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, Route, route_hint
from archmap_scan.walk import Files

NAME = "nest"
FRAMEWORK = "NestJS"
WANTED = frozenset({"@nestjs/core", "@nestjs/common"})
_CONTROLLER = re.compile(rf"@Controller[ \t]*\({SP}")
_METHOD = re.compile(rf"@(Get|Post|Put|Patch|Delete|Options|Head|All)[ \t]*\({SP}({STR})?")
_GLOBAL = re.compile(rf"\.[ \t]*setGlobalPrefix[ \t]*\({SP}({STR})?")
_PATH_KEY = re.compile(rf"path[ \t]*:{SP}({STR})")
_STR = re.compile(STR)
_ID = r"[A-Za-z_$][A-Za-z0-9_$]{0,99}"
_MEMBER_REF = re.compile(rf"({_ID})[ \t]*\.[ \t]*({_ID}){SP}[),]")
_NAME_REF = re.compile(rf"({_ID}){SP}[),]")
_ENUM = re.compile(rf"\benum[ \t]+({_ID})[ \t]*\{{")
_ENUM_ITEM = re.compile(rf"\s*({_ID})\s*(?:=\s*({STR})?)?")
# Сколько знаков тела перечисления читается и сколько перечислений в файле.
_MAX_ENUM = 50_000
_MAX_ENUMS = 2000
# Значения членов: имя перечисления → [(каталог пакета, член → строка или None)].
_Enums = dict[str, list[tuple[str, dict[str, str | None]]]]
Resolver = Callable[[str, str], tuple[str | None, str]]


def _join(*parts: str) -> str:
    pieces = [p.strip("/") for p in parts if p.strip("/")]
    return "/" + "/".join(pieces)


def _dynamic(
    code: codetext.Code, rel: str, found: Findings, start: int,
    reason: str = texts.REASON_DYNAMIC_ROUTE, method: str | None = None,
) -> None:
    found.hints.append(route_hint(
        code.expression(start), reason, Loc(rel, code.line(start)), method,
    ))


def _enum_members(code: codetext.Code, start: int) -> dict[str, str | None]:
    """Члены перечисления от позиции после «{»: строковое значение или None (число,
    выражение, без значения)."""
    mask = code.mask
    end = mask.find("}", start, start + _MAX_ENUM)
    out: dict[str, str | None] = {}
    if end < 0:
        return out
    at = start
    for piece in mask[start:end].split(","):
        m = _ENUM_ITEM.fullmatch(piece.rstrip())
        if m is not None:
            value = None
            if m.group(2) is not None:
                literal, dynamic = code.literal(at + m.start(2), at + m.end(2))
                value = None if dynamic else literal
            out.setdefault(m.group(1), value)
        at += len(piece) + 1
    return out


def _enums(files: Files, ctx: Context) -> _Enums:
    """Перечисления TypeScript репозитория (один разбор на запуск)."""
    memo = files.memo.get("nest-enums")
    if memo is not None:
        return cast(_Enums, memo)
    out: _Enums = {}
    # Пропуск кода для разработки при поиске перечислений в покрытие маршрутов не идёт:
    # маршрутов в этих файлах разборщик не искал.
    kept, files.dev_code = files.dev_code, set()
    for rel, text in codebase.sources(files, ctx, codebase.NODE, None, ("enum",)):
        if not rel.endswith((".ts", ".mts", ".cts", ".tsx")):
            continue
        code = codetext.load(files, rel, text, codetext.JS)
        if code is None:
            continue
        pkgs = codebase.owner_packages(files, ctx, rel, codebase.NODE)
        folder = pkgs[0].dir if pkgs else ""
        for n, m in enumerate(_ENUM.finditer(code.mask)):
            if n >= _MAX_ENUMS:
                break
            out.setdefault(m.group(1), []).append((folder, _enum_members(code, m.end())))
    files.dev_code = kept
    files.memo["nest-enums"] = out
    return out


def _resolver(files: Files, ctx: Context, rel: str) -> Resolver:
    """Значение члена перечисления для контроллера файла rel и причина подсказки, если
    значения нет."""
    def resolve(name: str, member: str) -> tuple[str | None, str]:
        found = _enums(files, ctx).get(name, [])
        pkgs = codebase.owner_packages(files, ctx, rel, codebase.NODE)
        own = [members for folder, members in found if pkgs and folder == pkgs[0].dir]
        values = {members.get(member) for members in own or [m for _f, m in found]}
        if len(values) > 1:
            return None, texts.REASON_ENUM_AMBIGUOUS
        value = next(iter(values), None)
        return value, texts.REASON_DYNAMIC_ROUTE
    return resolve


def enum_value(files: Files, ctx: Context, rel: str, name: str, member: str) -> str | None:
    """Строковое значение члена перечисления репозитория для кода файла rel (то же правило,
    что у префикса @Controller): None — не найдено, не строка или неоднозначно."""
    return _resolver(files, ctx, rel)(name, member)[0]


Named = Callable[[str], tuple[str | None, str] | None]


def _named(consts: nodeconst.Index, code: codetext.Code, rel: str) -> Named:
    """Значение константы по имени и причина подсказки, если значения нет; None — имя не
    константа (подсказка о выражении, как раньше)."""
    def resolve(name: str) -> tuple[str | None, str] | None:
        found = consts.lookup(rel, name, code)
        if found is None:
            return None
        if found is nodeconst.AMBIGUOUS:
            return None, texts.REASON_CONST_AMBIGUOUS
        return found.value, texts.REASON_DYNAMIC_ROUTE
    return resolve


def _controller(
    code: codetext.Code, rel: str, found: Findings, start: int, enum: Resolver, named: Named,
) -> str | None:
    """Префикс контроллера по аргументу @Controller: строка, член перечисления, константа,
    { path: '…' } или пусто; None — префикс не строкой."""
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
        ref = _MEMBER_REF.match(mask, start)
        if ref is None:
            name = _NAME_REF.match(mask, start)
            const = named(name.group(1)) if name is not None else None
            if const is None or const[0] is None:
                _dynamic(code, rel, found, start, const[1] if const else texts.REASON_DYNAMIC_ROUTE)
                return None
            return const[0]
        member, reason = enum(ref.group(1), ref.group(2))
        if member is None:
            _dynamic(code, rel, found, start, reason)
        return member
    value, dynamic = code.literal(hit.start(), hit.end())
    if dynamic:
        _dynamic(code, rel, found, start,
                 code.reason(hit.start(), hit.end(), texts.REASON_DYNAMIC_ROUTE))
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
        enum = _resolver(files, ctx, rel)
        named = _named(nodeconst.index(files, ctx), code, rel)
        controllers = [
            (m.start(), _controller(code, rel, found, m.end(), enum, named))
            for m in _CONTROLLER.finditer(code.mask)
        ]
        for m in _METHOD.finditer(code.mask):
            owner = [c for c in controllers if c[0] < m.start()]
            if not owner:
                continue
            prefix = owner[-1][1]
            method = m.group(1).upper()
            method = "ANY" if method == "ALL" else method
            if m.group(2) is not None:
                path, dynamic = code.literal(m.start(2), m.end(2))
                if dynamic:
                    _dynamic(code, rel, found, m.start(2),
                             code.reason(m.start(2), m.end(2), texts.REASON_DYNAMIC_ROUTE),
                             method)
                    continue
            elif code.mask[m.end():m.end() + 1] == ")":
                path = ""
            else:
                ref = _NAME_REF.match(code.mask, m.end())
                value = named(ref.group(1)) if ref is not None else None
                if value is None or value[0] is None:
                    reason = value[1] if value else texts.REASON_DYNAMIC_ROUTE
                    _dynamic(code, rel, found, m.end(), reason, method)
                    continue
                path = value[0]
            found.routes.append(Route(
                method=method,
                path=_join(global_prefix or "", prefix or "", path),
                loc=Loc(rel, code.line(m.start())), framework=FRAMEWORK, parser=NAME,
                prefix_unresolved=prefix is None or global_prefix is None,
            ))
    return found
