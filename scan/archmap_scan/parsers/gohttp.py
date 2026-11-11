"""Маршруты Go (ТЗ §6.2): net/http (http.HandleFunc("/p"), mux.Handle, шаблоны Go 1.22
«GET /p»), gorilla/mux (r.HandleFunc(…).Methods("GET"), PathPrefix(…).Subrouter()), chi
(r.Get("/p"), r.Route("/v1", func(r chi.Router) {…})), gin, echo и fiber (r.GET("/p"),
e.POST, app.Get, группы r.Group("/v1")). Группы — присваиванием в том же файле
(v1 := r.Group("/v1")) или замыканием (r.Group("/api", func(api Router) {…})).

Префикс решён, если цепочка групп доходит до корня, созданного в этом же файле
(gin.Default(), echo.New(), fiber.New(), chi.NewRouter(), mux.NewRouter(),
http.NewServeMux()) или до пакета http; иначе маршрут помечен prefix_unresolved.
Вызовы клиентов (client.Get("/api/…")) отсеиваются по имени получателя, запросы по виду
вызова (ТЗ §15 п. 16 П4): функции запроса net/http (http.Get(url), http.Post) и глагол с
одним аргументом без обработчика (api.Get(url)) ни маршрута, ни подсказки не дают. Конец
первого аргумента виден там, где разбор и так его находит (литерал, обёртка, склейка, текст
выражения для подсказки), отдельного прохода по аргументам нет. Поиск идёт по
маске кода (codetext.py), выражения начинаются с «.», имя слева от точки берётся
ручным просмотром назад.

Путь в обёртке (ТЗ §15 п. 2): аргумент вида ИМЯ("/литерал") на известном объекте
маршрутизации (корень, группа, параметр замыкания группы) даёт маршрут с этим литералом
(group.Delete(toMacaronPath("/api/v1/…")) у Grafana); на неизвестном получателе или в
другом виде путь остаётся подсказкой «путь задан выражением».

Путь склейкой (ТЗ §15 п. 15 К5): «имя + "/литерал"» на известном объекте маршрутизации
даёт маршрут с путём литерала и prefix_unresolved (baseUrl+"/cart/checkout" у Online
Boutique), склейка литералов «"/x" + "/y"» — путь целиком; «"/литерал" + имя» и склейка
без литерала остаются подсказками. Методы из .Methods(…) — строками и константами
http.MethodGet и подобными.

Префикс через параметр функции регистрации (ТЗ §15 п. 3): файлы одного каталога (пакет)
разбираются в два прохода. Маршрут, цепочка групп которого обрывается на параметре
функции (registerFolderAPI(apiRoute …) у Grafana), ждёт второго прохода: места вызова
функции в файлах пакета дают префикс по известному объекту маршрутизации на позиции
параметра, по записи на каждый отличный префикс. Место вызова с неизвестным объектом
даёт запись как прежде (префикс не решён); вызов не ищется дальше одного уровня.
"""

from __future__ import annotations

import re
from bisect import bisect_left
from dataclasses import dataclass, field

from archmap_scan import clike, codebase, codetext, gocode, paths, texts
from archmap_scan.codetext import SP, STR
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, Route, route_hint
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
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}")
# Склейка пути: имя (или поле) слева, «+», литералы, конец аргумента.
_HEAD = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}(?:\.[A-Za-z_][A-Za-z0-9_]{0,99})?")
_PLUS = re.compile(rf"{SP}\+{SP}")
_ARG_END = re.compile(rf"{SP}[,)]")
# Первый аргумент последний: вызов без обработчика (ТЗ §15 п. 16 П4), если за скобкой нет
# цепочки: ws.GET("/").To(h) у go-restful — построитель маршрута, обработчик в цепочке.
_CLOSE = re.compile(rf"{SP}\)(?!{SP}\.)")
_CHAIN = re.compile(rf"{SP}\.")
# Функции пакета net/http, которые делают запрос, а не регистрируют маршрут (П4):
# http.Get(url), http.Post(url, t, b), http.Head(url); http.PostForm под _CALL не попадает.
_HTTP_REQUESTS = frozenset({"Get", "Post", "Head"})
_MAX_PARTS = 50
_HTTP_METHOD = re.compile(
    r"http[ \t]*\.[ \t]*Method(Get|Head|Post|Put|Patch|Delete|Connect|Options|Trace)\b"
)
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
_MAX_DEPTH = 8
_MAX_SITES = 50  # сколько мест вызова одной функции регистрации разбирается в пакете


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


@dataclass(frozen=True)
class _Pending:
    """Маршрут тела функции func, префикс которого приходит параметром номер index:
    путь уже несёт префикс групп внутри функции, место вызова добавит свой."""

    method: str
    path: str
    loc: Loc
    func: str
    index: int


@dataclass
class _File:
    code: codetext.Code
    rel: str
    framework: str
    roots: set[str] = field(default_factory=set)
    # Группа присваиванием: имя → (получатель, позиция вызова, путь).
    groups: dict[str, tuple[str, int, str]] = field(default_factory=dict)
    scopes: list[_Scope] = field(default_factory=list)
    funcs: list[gocode.Func] | None = None  # разбираются при первой нужде (_param_of)
    starts: list[int] = field(default_factory=list)  # начала тел funcs по порядку
    pending: list[_Pending] = field(default_factory=list)
    closures: dict[int, tuple[int, int] | None] = field(default_factory=dict)
    # Подсказок маршрутов из файла; больше clike.MAX_READS — файл непрочитан (ТЗ §15 п. 19 П7).
    dynamic: int = 0


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
            body = gocode.body(mask, func.end())
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


def _chain(f: _File, recv: str, pos: int, depth: int = 0) -> tuple[str, bool, str, int]:
    """Полный префикс получателя recv в позиции pos, решён ли он и, если нет, на каком
    имени и в какой позиции цепочка групп оборвалась («» и -1 — оборвалась не на имени)."""
    if depth > _MAX_DEPTH:
        return "", False, "", -1
    # Замыкание группы, внутри которого стоит вызов и параметр которого — recv.
    inner = [s for s in f.scopes if s.name == recv and s.start < pos < s.end]
    if inner:
        scope = max(inner, key=lambda s: s.start)
        base, ok, last, at = _chain(f, scope.parent, scope.at, depth + 1)
        return base + scope.path, ok, last, at
    if recv in f.groups:
        parent, at, path = f.groups[recv]
        if parent != recv:
            base, ok, last, lat = _chain(f, parent, at, depth + 1)
            return base + path, ok, last, lat
    if recv in f.roots or recv == "http":
        return "", True, "", -1
    return "", False, recv, pos


def _prefix(f: _File, recv: str, pos: int) -> tuple[str, bool]:
    """Полный префикс получателя recv в позиции pos и решён ли он."""
    base, ok, _last, _at = _chain(f, recv, pos)
    return base, ok


def _param_of(f: _File, name: str, pos: int) -> tuple[str, int] | None:
    """(функция, номер параметра), если name в позиции pos — параметр функции, в теле
    которой стоит pos, и его не перекрывает параметр замыкания между ними."""
    if f.funcs is None:
        f.funcs = gocode.functions(f.code.mask)
        f.starts = [fn.start for fn in f.funcs]
    i = bisect_left(f.starts, pos) - 1
    func = f.funcs[i] if i >= 0 else None
    if func is None or not pos < func.end or not name or name not in func.params:
        return None
    mask = f.code.mask
    for m in _FUNC.finditer(mask, func.start, pos):
        if m.group(1) != name:
            continue
        if m.start() not in f.closures:
            f.closures[m.start()] = gocode.body(mask, m.end())
        span = f.closures[m.start()]
        if span is not None and span[0] < pos < span[1]:
            return None  # имя перекрыто параметром замыкания
    return func.name, func.params.index(name)


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
        if s is not None:
            value, _dyn = f.code.literal(s.start(), s.end())
            out.append(value.upper())
            pos = s.end()
            continue
        const = _HTTP_METHOD.match(mask, pos)
        if const is None:
            break
        out.append(const.group(1).upper())
        pos = const.end()
    return out or None


def _concat(f: _File, arg: int) -> tuple[str, int, bool] | None:
    """Путь склейкой с позиции arg до конца аргумента: литералы через «+» («"/x" + "/y"»)
    или имя и литералы за ним («baseUrl + "/x"»). Путь, позиция после последнего литерала
    и признак имени слева; None — склейка другого вида или не склейка."""
    mask = f.code.mask
    pos = arg
    lead = False
    if _STR.match(mask, pos) is None:
        head = _HEAD.match(mask, pos)
        plus = _PLUS.match(mask, head.end()) if head is not None else None
        if plus is None:
            return None
        lead, pos = True, plus.end()
    parts: list[str] = []
    end = pos
    for _ in range(_MAX_PARTS):
        s = _STR.match(mask, pos)
        if s is None:
            return None
        parts.append(f.code.literal(s.start(), s.end())[0])
        end = s.end()
        plus = _PLUS.match(mask, end)
        if plus is None:
            break
        pos = plus.end()
    else:
        return None
    if _ARG_END.match(mask, end) is None or (not lead and len(parts) < 2):
        return None
    return "".join(parts), end, lead


_ARG_CHARS = 80  # сколько знаков первого аргумента смотрится (_first_arg)


def _first_arg(code: codetext.Code, start: int, limit: int = _ARG_CHARS) -> tuple[str, bool]:
    """Текст первого аргумента с позиции start (как codetext.expression) и признак, что он
    последний и за скобкой вызова нет цепочки (вызов без обработчика, П4). Не видно в limit
    знаков — признака нет."""
    out: list[str] = []
    depth = 0
    mask = code.mask
    for i in range(start, min(len(mask), start + limit)):
        ch = mask[i]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                return "".join(out).strip(), ch == ")" and not _CHAIN.match(mask, i + 1)
            depth -= 1
        elif ch in ",;\n" and depth == 0:
            break
        out.append(code.text[i])
    return "".join(out).strip(), False


def _not_string(
    f: _File, found: Findings, known: bool, arg: int, method: str, handler: bool,
) -> None:
    """Путь не строкой. Подсказка — только если это точно маршрут: получатель — известный
    объект маршрутизации (known, _known) или в выражении есть путь («toPath("/api…")»);
    иначе это Get(ctx, key) хранилища или кэша. handler — вызову нужен обработчик (глагол): с
    одним аргументом это запрос клиента, подсказки нет (П4)."""
    mask = f.code.mask
    ch = mask[arg:arg + 1]
    if ch and (ch.isalpha() or ch == "_") and not mask.startswith("func", arg):
        text, last = _first_arg(f.code, arg)
        if not (known or '"/' in text):
            return
        if handler and last:
            return
        _dynamic(f, found, arg, method=method, name=text)


def _dynamic(
    f: _File, found: Findings, start: int, reason: str = texts.REASON_DYNAMIC_ROUTE,
    method: str | None = None, name: str | None = None,
) -> None:
    f.dynamic += 1
    if f.dynamic > clike.MAX_READS:
        return
    found.hints.append(route_hint(
        f.code.expression(start) if name is None else name, reason,
        Loc(f.rel, f.code.line(start)), method,
    ))


def _wrapped(f: _File, known: bool, arg: int) -> tuple[int, int, int] | None:
    """Путь в обёртке toPath("/p") на известном объекте маршрутизации (known, _known):
    позиции литерала в маске и конец обёртки; иначе None."""
    if not known:
        return None
    w = _WRAPPED.match(f.code.mask, arg)
    if w is None:
        return None
    return w.start(1), w.end(1), w.end()


def _after_http(mask: str, dot: int) -> bool:
    """Перед точкой вызова (через пробелы) кончается «http»: получатель (codetext.receiver)
    может быть «http»; иначе точно не он."""
    i = dot
    while i > 0 and mask[i - 1] in " \t":
        i -= 1
    return mask.endswith("http", 0, i)


def _no_path_arg(code: codetext.Code, arg: int) -> bool:
    """В тексте первого аргумента нет «"/». Текст аргумента (_first_arg) — начало исходного
    текста с arg не длиннее _ARG_CHARS: без «"/» в этом окне его нет и в тексте."""
    return '"/' not in code.text[arg:arg + _ARG_CHARS]


def _scan(f: _File, found: Findings) -> None:
    _structure(f)
    code, mask = f.code, f.code.mask
    # Объектов маршрутизации в файле нет: из известных получателей (_known) остаётся «http».
    only_http = not (f.roots or f.groups or f.scopes)
    for m in _CALL.finditer(mask):
        if f.dynamic > clike.MAX_READS:
            return  # файл непрочитан (П7), дальше не разбирается
        if (
            only_http and m.group(2) is None and _no_path_arg(code, m.end())
            and not _after_http(mask, m.start())
        ):
            # Получатель неизвестен, путь не строкой и без «"/» в аргументе: ни склейки, ни
            # обёртки, ни подсказки (_not_string), и получатель искать не нужно. Два
            # мегабайта «x.Get(» шли около 5,6 с (ТЗ §15 п. 18 П2).
            continue
        recv = code.receiver(m.start())
        if recv is None or recv in _CLIENTS:
            continue
        verb = m.group(1)
        if recv == "http" and verb in _HTTP_REQUESTS:
            continue  # http.Get(url): запрос клиента (П4)
        # Глагол (Get, POST и другие) регистрирует маршрут только с обработчиком: вызов с
        # одним аргументом — запрос клиента (П4). Handle, HandleFunc, Any и All не глаголы.
        handler = verb.upper() in _VERBS
        arg = m.end()
        wrapped = None
        concat = None
        if m.group(2) is None:
            # Известный ли получатель, считается один раз на вызов (ТЗ §15 п. 18 П2).
            known = _known(f, recv, m.start())
            if not known and _no_path_arg(code, arg):
                continue  # то же для файла с объектами маршрутизации (П2)
            # «baseUrl + "/x"» на известном объекте маршрутизации (К5).
            concat = _concat(f, arg) if known else None
            if concat is None:
                wrapped = _wrapped(f, known, arg)
                if wrapped is None:
                    _not_string(f, found, known, arg, _METHODS[verb], handler)
                    continue
                start, end, after = wrapped
        else:
            start, end = m.start(2), m.end(2)
            after = end
        if concat is None:
            value, _dyn = code.literal(start, end)
            if code.joined(start, end):
                # «"/x" + "/y"»: путь целиком (К5).
                concat = _concat(f, start) if wrapped is None else None
                if concat is None:
                    # «"/"+root+"/"»: литерал лишь часть пути (ТЗ §15 п. 10 А).
                    text, bare = _first_arg(code, start)
                    if value.startswith("/") and not (handler and bare):
                        _dynamic(
                            f, found, start, texts.REASON_JOINED_NAME, _METHODS[verb], text,
                        )
                    continue
        lead = False
        if concat is not None:
            value, after, lead = concat
        if handler and _CLOSE.match(mask, after):
            continue  # r.Get("/x"): без обработчика, запрос клиента (П4)
        method = _METHODS[verb]
        path = value
        if verb == "Handle" and value in _VERBS:
            # gin: r.Handle("GET", "/p", h) — метод первым аргументом.
            nxt = _STR.match(mask, _skip_comma(mask, after))
            if nxt is None:
                continue
            method = value
            path, _dyn = code.literal(nxt.start(), nxt.end())
            if code.joined(nxt.start(), nxt.end()):
                _dynamic(f, found, nxt.start(), texts.REASON_JOINED_NAME, method)
                continue
        elif verb in ("HandleFunc", "Handle"):
            head, sep, tail = value.partition(" ")
            if sep and head in _VERBS:
                method, path = head, tail.strip()  # шаблон Go 1.22: «GET /items/{id}»
        if not path.startswith("/"):
            if wrapped is not None:
                # Обёртка не над путём: как прежде, подсказка.
                _dynamic(f, found, arg, method=method)
            continue
        methods = [method]
        if verb in ("HandleFunc", "Handle") and method == "ANY":
            methods = _methods(f, after) or methods
        base, ok, last, at = _chain(f, recv, m.start())
        param = None if ok or lead else _param_of(f, last, at)
        ok = ok and not lead
        loc = Loc(f.rel, code.line(m.start()))
        for meth in methods:
            if param is not None:
                f.pending.append(_Pending(meth, base + path, loc, *param))
                continue
            found.routes.append(Route(
                method=meth, path=(base + path) or "/", loc=loc,
                framework=f.framework, parser=NAME, prefix_unresolved=not ok,
            ))


def _site_prefixes(
    sites: list[tuple[_File, int, list[str]]], index: int,
) -> list[tuple[str, bool]]:
    """Префиксы мест вызова для параметра номер index: известный объект маршрутизации на
    этой позиции даёт свой префикс, иначе (выражение, параметр другой функции, нет
    вызовов) — префикс как прежде, пустой и не решённый."""
    out: set[tuple[str, bool]] = set()
    for f, at, args in sites:
        arg = args[index] if index < len(args) else ""
        if _IDENT.fullmatch(arg) and _known(f, arg, at):
            out.add(_prefix(f, arg, at))
        else:
            out.add(("", False))
    return sorted(out) or [("", False)]


def _package(group: list[_File], found: Findings) -> None:
    """Второй проход по файлам каталога: маршруты, ждущие префикса параметра, получают
    его от мест вызова своей функции. Имя, определённое в пакете больше одного раза
    (методы разных типов, варианты сборки), не резолвится: чей вызов, не известно."""
    pending = [(f, p) for f in group for p in f.pending]
    if not pending:
        return
    declared = [gocode.declared(f.code.mask) for f in group]
    defined: dict[str, int] = {}
    for names in declared:
        for name, _at in names:
            defined[name] = defined.get(name, 0) + 1
    wanted = {p.func for _f, p in pending if defined.get(p.func) == 1}
    sites: dict[str, list[tuple[_File, int, list[str]]]] = {}
    for f, names in zip(group, declared, strict=True):
        skip = {at for _name, at in names}
        for name, at, args in gocode.calls(f.code.mask, wanted, skip, _MAX_SITES):
            if len(sites.setdefault(name, [])) < _MAX_SITES:
                sites[name].append((f, at, args))
    prefixes: dict[tuple[str, int], list[tuple[str, bool]]] = {}
    for f, p in pending:
        key = (p.func, p.index)
        if key not in prefixes:
            prefixes[key] = _site_prefixes(sites.get(p.func, []), p.index)
        for base, ok in prefixes[key]:
            found.routes.append(Route(
                method=p.method, path=(base + p.path) or "/", loc=p.loc,
                framework=f.framework, parser=NAME, prefix_unresolved=not ok,
            ))


def _within(folder: str, other: str) -> bool:
    """Каталог folder — other или лежит внутри него."""
    return not other or folder == other or folder.startswith(other + "/")


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.GO):
        return found
    found.applied.add(NAME)
    # Файлы идут по порядку путей, поэтому файлы каталога лежат одним куском среди его
    # подкаталогов: открыты только каталоги на пути к текущему файлу, остальные уже
    # закрыты и разобраны вторым проходом (в памяти маски одного пути, не всего дерева).
    open_dirs: dict[str, list[_File]] = {}
    for rel, text in codebase.sources(files, ctx, codebase.GO, None, _NEEDLES):
        folder = paths.parent(rel)
        for done in sorted(d for d in open_dirs if not _within(folder, d)):
            _package(open_dirs.pop(done), found)
        # Фреймворк — по импорту в самом файле: в одном модуле их бывает несколько.
        framework = next(
            (name for dep, name in FRAMEWORKS.items() if f'"{dep}' in text), _DEFAULT_FRAMEWORK,
        )
        code = codetext.load(files, rel, text, codetext.GO)
        if code is not None:
            f = _File(code, rel, framework)
            local = Findings()
            _scan(f, local)
            if f.dynamic > clike.MAX_READS:
                # Подсказок больше предела: файл непрочитан, его маршруты и подсказки не
                # выдаются и во второй проход пакета он не идёт, как у clike.matches (П7).
                files.refuse(rel)
                continue
            found.routes.extend(local.routes)
            found.hints.extend(local.hints)
            open_dirs.setdefault(folder, []).append(f)
    for done in sorted(open_dirs):
        _package(open_dirs[done], found)
    return found
