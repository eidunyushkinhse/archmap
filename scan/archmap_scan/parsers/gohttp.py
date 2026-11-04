"""Маршруты Go (ТЗ §6.2): net/http (http.HandleFunc("/p"), mux.Handle, шаблоны Go 1.22
«GET /p»), gorilla/mux (r.HandleFunc(…).Methods("GET"), PathPrefix(…).Subrouter()), chi
(r.Get("/p"), r.Route("/v1", func(r chi.Router) {…})), gin, echo и fiber (r.GET("/p"),
e.POST, app.Get, группы r.Group("/v1")). Группы — присваиванием в том же файле
(v1 := r.Group("/v1")) или замыканием (r.Group("/api", func(api Router) {…})).

Префикс решён, если цепочка групп доходит до корня, созданного в этом же файле
(gin.Default(), echo.New(), fiber.New(), chi.NewRouter(), mux.NewRouter(),
http.NewServeMux()) или до пакета http; иначе маршрут помечен prefix_unresolved.
Вызовы клиентов (client.Get("/api/…")) отсеиваются по имени получателя. Поиск идёт по
маске кода (codetext.py), выражения начинаются с «.», имя слева от точки берётся
ручным просмотром назад.

Путь в обёртке (ТЗ §15 п. 2): аргумент вида ИМЯ("/литерал") на известном объекте
маршрутизации (корень, группа, параметр замыкания группы) даёт маршрут с этим литералом
(group.Delete(toMacaronPath("/api/v1/…")) у Grafana); на неизвестном получателе или в
другом виде путь остаётся подсказкой «путь задан выражением».
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from archmap_scan import codebase, codetext, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route
from archmap_scan.walk import Files

NAME = "go-http"
FRAMEWORKS = {
    "github.com/gin-gonic/gin": "Gin", "github.com/labstack/echo": "Echo",
    "github.com/gofiber/fiber": "Fiber", "github.com/go-chi/chi": "chi",
    "github.com/gorilla/mux": "gorilla/mux",
}
_DEFAULT_FRAMEWORK = "net/http"
_VERBS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
_METHODS = {
    **{v: v for v in _VERBS}, **{v.capitalize(): v for v in _VERBS},
    "Any": "ANY", "All": "ANY", "HandleFunc": "ANY", "Handle": "ANY",
}
_CALL = re.compile(rf"\.[ \t]*({'|'.join(_METHODS)})[ \t]*\({SP}({STR})?")
_GROUP = re.compile(rf"\.[ \t]*(Group|PathPrefix|Route)[ \t]*\({SP}({STR})")
_ROOT = re.compile(r"\.[ \t]*(Default|New|NewRouter|NewServeMux)[ \t]*\(")
_FUNC = re.compile(r"func[ \t]*\([ \t]*([A-Za-z_][A-Za-z0-9_]{0,99})")
_METHODS_CALL = re.compile(r"[ \t]*\.[ \t]*Methods[ \t]*\(")
# Путь в обёртке: ИМЯ( строковый литерал ) с одним аргументом.
_WRAPPED = re.compile(rf"[A-Za-z_][A-Za-z0-9_]{{0,99}}[ \t]*\({SP}({STR}){SP}\)")
_STR = re.compile(STR)
_NEEDLES = (
    ".HandleFunc(", ".Handle(", ".GET(", ".POST(", ".PUT(", ".DELETE(", ".PATCH(", ".Get(",
    ".Post(", ".Put(", ".Delete(", ".Patch(", ".Any(", ".All(", ".Group(", ".Route(",
)
_ROOT_PACKAGES = frozenset({"gin", "echo", "fiber", "chi", "mux", "http"})
# Имена получателей, у которых Get и Post — запросы, а не маршруты.
_CLIENTS = frozenset({
    "client", "httpClient", "cli", "req", "request", "resp", "res", "c", "ctx", "cache", "db",
    "redis", "rdb", "kv", "store", "os", "viper", "cfg", "config", "conf", "env", "q",
    "query", "values", "header", "Header", "url", "u", "params", "form", "session", "sess",
})
_MAX_SPAN = 200_000  # самое длинное тело замыкания группы, которое просматривается
_MAX_DEPTH = 8


@dataclass
class _Scope:
    """Тело замыкания группы: внутри него параметр name — группа с путём path на
    получателе parent (вызов группы стоит в позиции at)."""

    name: str
    start: int
    end: int
    parent: str
    at: int
    path: str


@dataclass
class _File:
    code: codetext.Code
    rel: str
    framework: str
    roots: set[str] = field(default_factory=set)
    # Группа присваиванием: имя → (получатель, позиция вызова, путь).
    groups: dict[str, tuple[str, int, str]] = field(default_factory=dict)
    scopes: list[_Scope] = field(default_factory=list)


def _assigned(mask: str, pos: int) -> str | None:
    """Имя слева от «:=» или «=» перед позицией pos (начало выражения)."""
    i = pos - 1
    while i >= 0 and mask[i] in " \t":
        i -= 1
    if i < 0 or mask[i] != "=":
        return None
    i -= 1
    if i >= 0 and mask[i] == ":":
        i -= 1
    elif i >= 0 and mask[i] in "!<>=+-*/":
        return None  # сравнение или составное присваивание
    while i >= 0 and mask[i] in " \t":
        i -= 1
    end = i + 1
    while i >= 0 and end - i <= 100 and (mask[i].isalnum() or mask[i] == "_"):
        i -= 1
    name = mask[i + 1:end]
    return name if name and not name[0].isdigit() else None


def _start_of(code: codetext.Code, dot: int) -> int:
    """Позиция начала имени получателя перед точкой."""
    i = dot - 1
    while i >= 0 and code.mask[i] in " \t":
        i -= 1
    while i >= 0 and (code.mask[i].isalnum() or code.mask[i] == "_"):
        i -= 1
    return i + 1


def _body(mask: str, start: int) -> tuple[int, int] | None:
    """Тело функции: позиции «{» и парной «}» от start."""
    open_at = mask.find("{", start, start + 500)
    if open_at == -1:
        return None
    depth = 0
    stop = min(len(mask), open_at + _MAX_SPAN)
    for i in range(open_at, stop):
        ch = mask[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return open_at, i
    return None


def _structure(f: _File) -> None:
    code, mask = f.code, f.code.mask
    for m in _ROOT.finditer(mask):
        pkg = code.receiver(m.start())
        if pkg in _ROOT_PACKAGES:
            name = _assigned(mask, _start_of(code, m.start()))
            if name:
                f.roots.add(name)
    for m in _GROUP.finditer(mask):
        recv = code.receiver(m.start())
        if recv is None:
            continue
        path, dynamic = code.literal(m.start(2), m.end(2))
        if dynamic:
            continue
        name = _assigned(mask, _start_of(code, m.start()))
        if name:
            f.groups[name] = (recv, m.start(), path)
        func = _FUNC.match(mask, _skip_comma(mask, m.end(2)))
        if func is not None:
            body = _body(mask, func.end())
            if body is not None:
                f.scopes.append(_Scope(func.group(1), body[0], body[1], recv, m.start(), path))


def _skip_comma(mask: str, pos: int) -> int:
    """Позиция после «, » за аргументом-путём (там может начаться замыкание)."""
    i = pos
    while i < len(mask) and mask[i] in " \t\r\n":
        i += 1
    if i < len(mask) and mask[i] == ",":
        i += 1
    while i < len(mask) and mask[i] in " \t\r\n":
        i += 1
    return i


def _prefix(f: _File, recv: str, pos: int, depth: int = 0) -> tuple[str, bool]:
    """Полный префикс получателя recv в позиции pos и решён ли он."""
    if depth > _MAX_DEPTH:
        return "", False
    # Замыкание группы, внутри которого стоит вызов и параметр которого — recv.
    inner = [s for s in f.scopes if s.name == recv and s.start < pos < s.end]
    if inner:
        scope = max(inner, key=lambda s: s.start)
        base, ok = _prefix(f, scope.parent, scope.at, depth + 1)
        return base + scope.path, ok
    if recv in f.groups:
        parent, at, path = f.groups[recv]
        if parent != recv:
            base, ok = _prefix(f, parent, at, depth + 1)
            return base + path, ok
    if recv in f.roots or recv == "http":
        return "", True
    return "", False


def _known(f: _File, recv: str, pos: int) -> bool:
    """Получатель — объект маршрутизации, созданный или полученный в этом файле."""
    return (
        recv in f.roots or recv in f.groups or recv == "http"
        or any(s.name == recv and s.start < pos < s.end for s in f.scopes)
    )


def _methods(f: _File, end: int) -> list[str] | None:
    """Методы из .Methods("GET", "POST") после вызова HandleFunc(…), который кончается
    в end (позиция после открывающей скобки)."""
    mask = f.code.mask
    depth = 1
    i = end
    stop = min(len(mask), end + 5000)
    while i < stop and depth:
        if mask[i] == "(":
            depth += 1
        elif mask[i] == ")":
            depth -= 1
        i += 1
    m = _METHODS_CALL.match(mask, i)
    if m is None:
        return None
    out: list[str] = []
    pos = m.end()
    while True:
        while pos < len(mask) and mask[pos] in " \t\r\n,":
            pos += 1
        s = _STR.match(mask, pos)
        if s is None:
            break
        value, _dyn = f.code.literal(s.start(), s.end())
        out.append(value.upper())
        pos = s.end()
    return out or None


def _not_string(f: _File, found: Findings, recv: str, at: int, arg: int) -> None:
    """Путь не строкой. Подсказка — только если это точно маршрут: получатель — известный
    объект маршрутизации или в выражении есть путь («toPath("/api…")»); иначе это
    Get(ctx, key) хранилища или кэша."""
    mask = f.code.mask
    ch = mask[arg:arg + 1]
    if ch and (ch.isalpha() or ch == "_") and not mask.startswith("func", arg):
        if _known(f, recv, at) or '"/' in f.code.expression(arg):
            _dynamic(f, found, arg)


def _dynamic(f: _File, found: Findings, start: int) -> None:
    found.hints.append(Hint("dynamic_names", {
        "kind": "route", "name": f.code.expression(start), "reason": texts.REASON_DYNAMIC_ROUTE,
        "source": str(Loc(f.rel, f.code.line(start))),
    }))


def _wrapped(f: _File, recv: str, at: int, arg: int) -> tuple[int, int, int] | None:
    """Путь в обёртке toPath("/p") на известном объекте маршрутизации: позиции литерала
    в маске и конец обёртки; иначе None."""
    if not _known(f, recv, at):
        return None
    w = _WRAPPED.match(f.code.mask, arg)
    if w is None:
        return None
    return w.start(1), w.end(1), w.end()


def _scan(f: _File, found: Findings) -> None:
    _structure(f)
    code, mask = f.code, f.code.mask
    for m in _CALL.finditer(mask):
        recv = code.receiver(m.start())
        if recv is None or recv in _CLIENTS:
            continue
        verb = m.group(1)
        arg = m.end()
        wrapped = None
        if m.group(2) is None:
            wrapped = _wrapped(f, recv, m.start(), arg)
            if wrapped is None:
                _not_string(f, found, recv, m.start(), arg)
                continue
            start, end, after = wrapped
        else:
            start, end = m.start(2), m.end(2)
            after = end
        value, _dyn = code.literal(start, end)
        method = _METHODS[verb]
        path = value
        if verb == "Handle" and value in _VERBS:
            # gin: r.Handle("GET", "/p", h) — метод первым аргументом.
            nxt = _STR.match(mask, _skip_comma(mask, after))
            if nxt is None:
                continue
            method = value
            path, _dyn = code.literal(nxt.start(), nxt.end())
        elif verb in ("HandleFunc", "Handle"):
            head, sep, tail = value.partition(" ")
            if sep and head in _VERBS:
                method, path = head, tail.strip()  # шаблон Go 1.22: «GET /items/{id}»
        if not path.startswith("/"):
            if wrapped is not None:
                _dynamic(f, found, arg)  # обёртка не над путём: как прежде, подсказка
            continue
        methods = [method]
        if verb in ("HandleFunc", "Handle") and method == "ANY":
            methods = _methods(f, after) or methods
        base, ok = _prefix(f, recv, m.start())
        for meth in methods:
            found.routes.append(Route(
                method=meth, path=(base + path) or "/", loc=Loc(f.rel, code.line(m.start())),
                framework=f.framework, parser=NAME, prefix_unresolved=not ok,
            ))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.GO):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.GO, None, _NEEDLES):
        # Фреймворк — по импорту в самом файле: в одном модуле их бывает несколько.
        framework = next(
            (name for dep, name in FRAMEWORKS.items() if f'"{dep}' in text), _DEFAULT_FRAMEWORK,
        )
        code = codetext.load(files, rel, text, codetext.GO)
        if code is not None:
            _scan(_File(code, rel, framework), found)
    return found
