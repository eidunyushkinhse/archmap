"""Маршруты Express, Koa-router и Fastify (ТЗ §6.2): app.get('/p', …), router.post(…),
router.route('/p').get(…).post(…), префиксы app.use('/prefix', router) в том же файле,
свой префикс new Router({ prefix: '/api' }) у Koa-router.

Вызов считается маршрутом, только если путь — строка с «/» в начале (или «*»), а получатель
— объект маршрутизации: имя, присвоенное из express(), Router(), new Router(), fastify(),
или привычное имя (app, router, server, fastify и имена на router). Так вызовы
HTTP-клиентов (axios.get('/api/…')) маршрутами не становятся. Роутер, подключение
которого в файле не видно, даёт маршруты с prefix_unresolved. Регулярные выражения идут
по маске кода (codetext.py): строки в комментариях не находятся.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from archmap_scan import codebase, codetext, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route
from archmap_scan.walk import Files

NAME = "express"
FRAMEWORKS = {"express": "Express", "fastify": "Fastify", "@koa/router": "Koa",
              "koa-router": "Koa", "koa": "Koa"}
WANTED = frozenset(FRAMEWORKS)
_METHODS = {
    "get": "GET", "post": "POST", "put": "PUT", "patch": "PATCH", "delete": "DELETE",
    "del": "DELETE", "head": "HEAD", "options": "OPTIONS", "all": "ANY",
}
_METHOD_NAMES = "|".join(_METHODS)
_ROUTE = re.compile(rf"\.[ \t]*({_METHOD_NAMES})[ \t]*\({SP}({STR})?")
_CHAIN = re.compile(rf"\.[ \t]*route[ \t]*\({SP}({STR}){SP}\)")
_CHAINED = re.compile(rf"\.[ \t]*({_METHOD_NAMES})[ \t]*\(")
_BIND = re.compile(
    r"(?:const|let|var)[ \t]+([A-Za-z_$][\w$]{0,99})[ \t]*=[ \t]*(?:new[ \t]+)?"
    r"((?:[A-Za-z_$][\w$]{0,99}\.)?[A-Za-z_$][\w$]{0,99})[ \t]*\("
)
_KOA_PREFIX = re.compile(rf"prefix[ \t]*:[ \t]*({STR})")
_USE_PREFIX = re.compile(rf"\.[ \t]*use[ \t]*\({SP}({STR}){SP},{SP}([A-Za-z_$][\w$]{{0,99}})")
_USE_ROOT = re.compile(
    rf"\.[ \t]*use[ \t]*\({SP}([A-Za-z_$][\w$]{{0,99}})(?:[ \t]*\.[ \t]*routes[ \t]*\(\))?{SP}[),]"
)
_NEEDLES = (".get(", ".post(", ".put(", ".patch(", ".delete(", ".all(", ".route(", ".del(")
_APPS = frozenset({"express", "fastify", "Fastify"})
_ROUTERS = frozenset({"Router", "express.Router"})
_APP_NAMES = frozenset({"app", "server", "fastify", "instance"})
# Сколько символов после .route('/p') смотреть в поисках цепочки методов.
_CHAIN_SPAN = 2000


@dataclass
class _File:
    code: codetext.Code
    rel: str
    framework: str
    apps: set[str] = field(default_factory=set)
    routers: dict[str, str | None] = field(default_factory=dict)  # имя → свой префикс
    mounts: dict[str, list[tuple[str, str | None]]] = field(default_factory=dict)


def _valid(f: _File, name: str) -> bool:
    return (
        name in f.apps or name in f.routers or name in _APP_NAMES
        or name.lower().endswith("router")
    )


def _bindings(f: _File) -> None:
    mask = f.code.mask
    for m in _BIND.finditer(mask):
        name, factory = m.group(1), m.group(2)
        if factory in _APPS:
            f.apps.add(name)
        elif factory in _ROUTERS:
            own: str | None = ""
            # new Router({ prefix: '/api' }) у Koa-router: префикс в аргументах вызова.
            window = mask[m.end():m.end() + 300]
            close = window.find(")")
            hit = _KOA_PREFIX.search(window, 0, close if close != -1 else len(window))
            if hit is not None:
                start = m.end() + hit.start(1)
                value, dynamic = f.code.literal(start, m.end() + hit.end(1))
                own = None if dynamic else value
            f.routers[name] = own
    for m in _USE_PREFIX.finditer(mask):
        parent = f.code.receiver(m.start())
        value, dynamic = f.code.literal(m.start(1), m.end(1))
        f.mounts.setdefault(m.group(2), []).append((parent or "", None if dynamic else value))
    for m in _USE_ROOT.finditer(mask):
        parent = f.code.receiver(m.start())
        f.mounts.setdefault(m.group(1), []).append((parent or "", ""))


def _prefixes(f: _File, name: str, depth: int = 0) -> list[tuple[str, bool]]:
    """Полные префиксы получателя: приложение — корень, роутер — по подключениям в файле."""
    if name in f.apps or (name in _APP_NAMES and name not in f.routers):
        return [("", True)]
    own = f.routers.get(name, "")
    mounts = f.mounts.get(name)
    if not mounts or depth > 4:
        return [(own or "", False)]
    out: list[tuple[str, bool]] = []
    for parent, prefix in mounts:
        for base, ok in _prefixes(f, parent, depth + 1):
            full = base + (prefix or "") + (own or "")
            item = (full, ok and prefix is not None and own is not None)
            if item not in out:
                out.append(item)
    return out[:8]


def _path(f: _File, found: Findings, start: int, end: int, at: int) -> str | None:
    value, dynamic = f.code.literal(start, end)
    if dynamic:
        joined = f.code.joined(start, end)
        # Склейка не с путём (app.get('env' + x) — чтение настройки Express) не маршрут.
        if not joined or value.startswith("/"):
            _dynamic(f, found, start, at, f.code.reason(start, end, texts.REASON_DYNAMIC_ROUTE))
        return None
    if not (value.startswith("/") or value == "*"):
        return None
    return value


def _dynamic(
    f: _File, found: Findings, start: int, at: int, reason: str = texts.REASON_DYNAMIC_ROUTE,
) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "route", "name": f.code.expression(start), "reason": reason,
        "source": str(Loc(f.rel, f.code.line(at))),
    }))


def _emit(f: _File, found: Findings, recv: str, method: str, path: str, at: int) -> None:
    for base, ok in _prefixes(f, recv):
        full = base + path if path != "*" else (base + "/*" if base else "*")
        found.routes.append(Route(
            method=method, path=full, loc=Loc(f.rel, f.code.line(at)),
            framework=f.framework, parser=NAME, prefix_unresolved=not ok,
        ))


def _chain(f: _File, found: Findings, recv: str, path: str, start: int, at: int) -> None:
    """router.route('/p').get(…).post(…): методы цепочки на глубине скобок ноль."""
    mask = f.code.mask
    depth = 0
    i = start
    stop = min(len(mask), start + _CHAIN_SPAN)
    while i < stop:
        ch = mask[i]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth < 0:
                return
        elif ch == ";" and depth == 0:
            return
        elif ch == "." and depth == 0:
            m = _CHAINED.match(mask, i)
            if m is None:
                if mask.startswith(".route", i):
                    return
            else:
                _emit(f, found, recv, _METHODS[m.group(1)], path, at)
                i = m.end()
                depth = 1
                continue
        i += 1


def _scan(f: _File, found: Findings) -> None:
    _bindings(f)
    mask = f.code.mask
    for m in _ROUTE.finditer(mask):
        recv = f.code.receiver(m.start())
        if recv is None or not _valid(f, recv):
            continue
        if m.group(2) is None:
            # Первый аргумент не строка: путь из переменной или выражения.
            arg = m.end()
            ch = mask[arg:arg + 1]
            if ch and (ch.isalpha() or ch in "_$") and not mask.startswith(("function", "async"), arg):
                _dynamic(f, found, arg, m.start())
            continue
        path = _path(f, found, m.start(2), m.end(2), m.start())
        if path is not None:
            _emit(f, found, recv, _METHODS[m.group(1)], path, m.start())
    for m in _CHAIN.finditer(mask):
        recv = f.code.receiver(m.start())
        if recv is None or not _valid(f, recv):
            continue
        path = _path(f, found, m.start(1), m.end(1), m.start())
        if path is not None:
            _chain(f, found, recv, path, m.end(), m.start())


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.NODE, WANTED):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.NODE, WANTED, _NEEDLES):
        deps = {d.lower() for d in codebase.deps_of(files, ctx, rel, codebase.NODE)}
        framework = next((name for dep, name in FRAMEWORKS.items() if dep in deps), "")
        code = codetext.load(files, rel, text, codetext.JS)
        if code is not None:
            _scan(_File(code, rel, framework), found)
    return found
