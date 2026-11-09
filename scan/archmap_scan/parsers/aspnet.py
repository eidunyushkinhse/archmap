"""Маршруты ASP.NET Core (ТЗ §15 п. 15 К2): минимальный API и атрибуты контроллеров в коде C#
проекта .NET с Sdk="Microsoft.NET.Sdk.Web" или зависимостью Microsoft.AspNetCore.*.

Минимальный API: `X.MapGet("путь", …)`, `MapPost`, `MapPut`, `MapDelete`, `MapPatch`,
`MapMethods("путь", new[] { "GET" } | [HttpMethods.Get], …)` и `MapHealthChecks("путь")` (как
GET). Группа `var g = X.MapGroup("префикс")` даёт префикс вызовам на g в том же файле (берётся
последнее присваивание до вызова), группа группы складывается; MapGroup с путём не литералом
даёт записи с `prefix_unresolved`. Получатель не группа этого файла (app, endpoints,
builder) — корень, получатель не имя (цепочка вызовов) — префикс не решён. `MapGrpcService`
и `MapHub` не маршруты HTTP.

Контроллер — класс с `[ApiController]` или наследник `Controller`/`ControllerBase`. Метод с
`[HttpGet]`, `[HttpGet("x")]`, `[HttpPost("x")]` и другими глаголами — маршрут: префикс
`[Route("…")]` класса и шаблон метода (шаблон с «/» или «~/» в начале — от корня), без
шаблона — путь префикса; `[Route("x")]` метода без глагола — ANY. `[controller]` — имя класса
без суффикса Controller как написано, `[action]` — имя метода без суффикса Async (так их
подставляет ASP.NET Core). Контроллер без `[Route]` у класса и метода идёт по маршруту по
соглашению: путь `/Контроллер/действие` с `prefix_unresolved`, шаблон соглашения
(MapControllerRoute) не читается.

Путь интерполированной строкой `$"…{x}…"`, константой или выражением — подсказка о
динамическом пути. Поиск по маске C# (codetext.CS); файлы `*Test.cs`, `*Tests.cs`, `*.Tests*` и
каталоги тестов (clike.in_test_dir) не читаются; больше 2000 вызовов, атрибутов, классов или
записей в файле (clike.MAX_READS) — файл непрочитан.
"""

from __future__ import annotations

import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field

from archmap_scan import clike, codebase, codetext, paths, texts, vocab
from archmap_scan.codetext import SP
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, Route, route_hint
from archmap_scan.walk import Files

NAME = "aspnet"
FRAMEWORK = "ASP.NET Core"
_ID = r"[A-Za-z_][A-Za-z0-9_]{0,99}"
_STR = r'(?:\$@|@\$|\$|@)?"[ ]*"'
_MAP = re.compile(
    rf"\.[ \t]*Map(Get|Post|Put|Delete|Patch|Methods|HealthChecks|Group)[ \t]*"
    rf"(?:<[^<>()\n]{{0,200}}>)?[ \t]*\({SP}(?P<arg>{_STR})?"
)
_VERB_ATTR = re.compile(
    rf"(?<![\w.])Http(Get|Post|Put|Delete|Patch|Head|Options)(?:Attribute)?\b"
    rf"(?:[ \t]*\({SP}(?P<arg>{_STR})?)?"
)
_ROUTE_ATTR = re.compile(rf"(?<![\w.])Route(?:Attribute)?[ \t]*\({SP}(?P<arg>{_STR})?")
# Класс и всё до «{» тела: основной конструктор и базовые типы.
_CLASS = re.compile(rf"\bclass[ \t]+({_ID})([^{{;]{{0,300}})\{{")
_BASES = re.compile(r"(?:^|[\s,.:])(Controller|ControllerBase)\b")
_API_CONTROLLER = re.compile(r"(?<![\w.])ApiController(?:Attribute)?\b")
_ATTR_BRACKETS = re.compile(r"[\[\]]")
_SPACES = re.compile(r"\s*")
# Между блоком атрибутов и скобкой параметров метода нет конца инструкции, тела и
# объявления типа: иначе атрибуты не у метода (свойство, класс с основным конструктором).
_NOT_SIGNATURE = re.compile(r"[;{}=\[\]]|\b(?:class|struct|record|interface)\b")
_HTTP_METHOD = re.compile(rf'[\[\]{{}}(),]|"[ ]*"|HttpMethods[ \t]*\.[ \t]*({_ID})')
_ARG_END = re.compile(r"[()\[\]{},]")
# Сколько разделителей смотреть в аргументах одного вызова MapMethods.
_MAX_TOKENS = 200
_NEEDLES = (".Map", "Http", "Route")
_TEST_FILE = re.compile(r"(?:Tests?\.cs|\.Tests?\.[^/]*)$")
_KEYWORDS = frozenset({"if", "for", "foreach", "while", "switch", "using", "lock", "return", "new"})


@dataclass
class _Class:
    name: str
    start: int
    prefix: str | None  # шаблон [Route] класса, None — его нет
    dynamic: int | None = None  # позиция выражения [Route] класса не литералом
    controller: bool = False
    hinted: bool = False  # подсказка о [Route] класса уже записана


class _TooMany(Exception):
    pass


@dataclass
class _File:
    files: Files
    code: codetext.Code
    rel: str
    found: Findings
    # Группы присваиванием по порядку: имя → [(позиция, получатель, путь; None — путь не
    # литералом)]; вызов берёт последнее присваивание до себя.
    groups: dict[str, list[tuple[int, str | None, str | None]]] = field(default_factory=dict)
    count: int = 0

    def matches(self, pattern: re.Pattern[str]) -> list[re.Match[str]]:
        found = clike.matches(self.files, self.rel, pattern, self.code.mask)
        if found is None:
            raise _TooMany
        return found


def _join(*parts: str) -> str:
    pieces = [p.strip("/") for p in parts if p.strip("/")]
    return "/" + "/".join(pieces)


def _literal(f: _File, start: int, end: int) -> str | None:
    """Значение строкового литерала маски [start, end); None — интерполяция с подстановкой."""
    text = f.code.text
    head = text[start:start + 2]
    if head.startswith("$") or head.endswith("$"):
        value = text[text.index('"', start) + 1:end - 1]
        if "{" in value.replace("{{", ""):
            return None
        return value.replace("{{", "{").replace("}}", "}")
    return clike.literal_value(f.code, start, end)


def _dynamic(f: _File, at: int, expr_at: int, method: str | None = None) -> None:
    f.found.hints.append(route_hint(
        f.code.expression(expr_at), texts.REASON_DYNAMIC_ROUTE, Loc(f.rel, f.code.line(at)),
        method,
    ))


def _map_method(kind: str) -> str | None:
    """Метод вызова Map<kind>: MapHealthChecks — GET, у MapMethods и MapGroup метод в
    имени не назван."""
    if kind == "HealthChecks":
        return "GET"
    return None if kind in ("Methods", "Group") else kind.upper()


def _add(f: _File, method: str, path: str, at: int, unresolved: bool = False) -> None:
    f.count += 1
    if f.count > clike.MAX_READS:
        raise _TooMany
    f.found.routes.append(Route(
        method=method, path=path, loc=Loc(f.rel, f.code.line(at)), framework=FRAMEWORK,
        parser=NAME, prefix_unresolved=unresolved,
    ))


# Минимальный API

def _assigned(mask: str, pos: int) -> str | None:
    """Имя слева от «=» перед позицией pos (начало выражения): «var api = app.MapGroup(…)»."""
    i = clike.skip_back(mask, pos)
    if i == 0 or mask[i - 1] != "=" or (i >= 2 and mask[i - 2] in "=!<>+-*/?"):
        return None
    end = clike.skip_back(mask, i - 1)
    start = clike.ident_before(mask, end)
    return mask[start:end] if start is not None else None


def _receiver_start(mask: str, dot: int) -> int:
    """Начало имени получателя перед точкой вызова."""
    end = clike.skip_back(mask, dot)
    start = clike.ident_before(mask, end)
    return start if start is not None else end


def _prefix(f: _File, recv: str | None, pos: int, depth: int = 0) -> tuple[str, bool]:
    """Префикс получателя в позиции pos и решён ли он: группа этого файла складывает пути,
    иначе корень; получатель не имя (цепочка вызовов) — префикс не решён."""
    if recv is None or depth > 8:
        return "", False
    items = f.groups.get(recv, [])
    i = bisect_left([at for at, _p, _path in items], pos) - 1
    if i < 0:
        return "", True
    at, parent, path = items[i]
    base, ok = _prefix(f, parent, at, depth + 1) if parent != recv else ("", True)
    if path is None:
        return base, False
    return (_join(base, path) if path.strip("/") else base), ok


def _methods(f: _File, pos: int) -> list[str]:
    """Методы второго аргумента MapMethods: строки и HttpMethods.X до конца аргумента."""
    mask = f.code.mask
    depth = 0
    out: list[str] = []
    for n, m in enumerate(_HTTP_METHOD.finditer(mask, pos, min(len(mask), pos + 2000))):
        tok = m.group()
        if n > _MAX_TOKENS:
            break
        if tok in "[{(":
            depth += 1
        elif tok in "]})":
            depth -= 1
            if depth < 0:
                break
        elif tok == ",":
            if depth == 0:
                break
        elif m.group(1) is not None:
            out.append(m.group(1).upper())
        else:
            out.append(f.code.text[m.start() + 1:m.end() - 1].upper())
    return out


def _after_arg(mask: str, pos: int) -> int:
    """Позиция после запятой за первым аргументом (начало второго аргумента), иначе -1."""
    depth = 0
    for n, m in enumerate(_ARG_END.finditer(mask, pos, min(len(mask), pos + 2000))):
        ch = m.group()
        if n > _MAX_TOKENS:
            break
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                return -1
            depth -= 1
        elif depth == 0:
            return m.end()
    return -1


def _minimal(f: _File) -> None:
    code, mask = f.code, f.code.mask
    for m in f.matches(_MAP):
        recv = code.receiver(m.start())
        kind = m.group(1)
        arg = m.group("arg")
        if kind == "Group":
            name = _assigned(mask, _receiver_start(mask, m.start()))
            if name is None:
                continue
            path = _literal(f, m.start("arg"), m.end("arg")) if arg is not None else None
            if path is None or (arg is not None and code.joined(m.start("arg"), m.end("arg"))):
                path = None
                _dynamic(f, m.start(), m.end() if arg is None else m.start("arg"))
            f.groups.setdefault(name, []).append((m.start(), recv, path))
            continue
        if arg is None:
            _dynamic(f, m.start(), m.end(), _map_method(kind))
            continue
        path = _literal(f, m.start("arg"), m.end("arg"))
        if path is None or code.joined(m.start("arg"), m.end("arg")):
            _dynamic(f, m.start(), m.start("arg"), _map_method(kind))
            continue
        base, ok = _prefix(f, recv, m.start())
        full = _join(base, path)
        if kind == "Methods":
            second = _after_arg(mask, m.end("arg"))
            methods = _methods(f, second) if second >= 0 else []
            for method in dict.fromkeys(methods or ["ANY"]):
                _add(f, method, full, m.start(), not ok)
            continue
        _add(f, _map_method(kind) or "ANY", full, m.start(), not ok)


# Контроллеры

def _attrs_before(mask: str, pos: int) -> tuple[int, int]:
    """Начало и конец блока атрибутов перед позицией pos: от конца прошлой инструкции («;»,
    «{», «}») до pos, не дальше 3000 знаков."""
    lo = max(0, pos - 3000)
    cut = max(mask.rfind(";", lo, pos), mask.rfind("{", lo, pos), mask.rfind("}", lo, pos))
    return (cut + 1 if cut >= 0 else lo), pos


def _in_attribute(mask: str, pos: int) -> bool:
    """Перед позицией pos «[» или «,» списка атрибутов."""
    before = clike.skip_back(mask, pos)
    return before > 0 and mask[before - 1] in "[,"


def _classes(f: _File) -> list[_Class]:
    mask = f.code.mask
    out: list[_Class] = []
    for m in f.matches(_CLASS):
        start, end = _attrs_before(mask, m.start())
        prefix: str | None = None
        dynamic: int | None = None
        for route in _ROUTE_ATTR.finditer(mask, start, end):
            if not _in_attribute(mask, route.start()):
                continue
            if route.group("arg") is None:
                dynamic = route.end()
            else:
                prefix = _literal(f, route.start("arg"), route.end("arg"))
                dynamic = route.start("arg") if prefix is None else None
            break
        controller = (
            _API_CONTROLLER.search(mask, start, end) is not None
            or _BASES.search(m.group(2)) is not None
        )
        out.append(_Class(m.group(1), m.start(), prefix, dynamic, controller))
    return out


def _token(template: str, cls: str, action: str) -> str:
    """Подстановка [controller] и [action] в шаблон (без учёта регистра токенов)."""
    out = re.sub(r"\[controller\]", cls, template, flags=re.IGNORECASE)
    return re.sub(r"\[action\]", action, out, flags=re.IGNORECASE)


def _attr_end(mask: str, pos: int, limit: int) -> int:
    """Позиция после «]», закрывающей список атрибутов, внутри которого стоит pos; -1 —
    не закрыт до limit."""
    depth = 1
    for m in _ATTR_BRACKETS.finditer(mask, pos, limit):
        depth += 1 if m.group() == "[" else -1
        if depth == 0:
            return m.end()
    return -1


def _method_after(mask: str, pos: int, limit: int) -> tuple[str, int] | None:
    """Имя и позиция метода, к которому относятся атрибуты на позиции pos: после закрытия
    этого и следующих блоков атрибутов первая скобка параметров, перед ней имя метода."""
    stop = min(limit, pos + 3000)
    j = _attr_end(mask, pos, stop)
    for _ in range(20):
        if j < 0:
            return None
        gap = _SPACES.match(mask, j, stop)
        j = gap.end() if gap is not None else j
        if mask[j:j + 1] != "[":
            break
        j = _attr_end(mask, j + 1, stop)
    if j < 0:
        return None
    paren = mask.find("(", j, stop)
    if paren < 0 or _NOT_SIGNATURE.search(mask, j, paren):
        return None
    end = clike.skip_back(mask, paren)
    if end > j and mask[end - 1] == ">":
        lt = mask.rfind("<", j, end)
        if lt < 0:
            return None
        end = clike.skip_back(mask, lt)
    start = clike.ident_before(mask, end)
    if start is None or mask[start:end] in _KEYWORDS:
        return None
    return mask[start:end], start


def _controllers(f: _File, classes: list[_Class]) -> None:
    mask = f.code.mask
    starts = [c.start for c in classes]
    seen: set[int] = set()
    if not any(c.controller for c in classes):
        return
    attrs = sorted([*f.matches(_VERB_ATTR), *f.matches(_ROUTE_ATTR)], key=lambda x: x.start())
    for m in attrs:
        if not _in_attribute(mask, m.start()):
            continue
        i = bisect_right(starts, m.start())
        if i == 0 or not classes[i - 1].controller:
            continue
        method = _method_after(mask, m.end(), starts[i] if i < len(starts) else len(mask))
        if method is None or method[1] in seen:
            continue
        seen.add(method[1])
        _action(f, classes[i - 1], method[0], method[1])


def _action(f: _File, cls: _Class, name: str, at: int) -> None:
    """Маршруты метода name класса cls по атрибутам в блоке перед ним."""
    mask = f.code.mask
    start, end = _attrs_before(mask, at)
    verbs: list[tuple[str, str | None, int]] = []  # (метод, шаблон, позиция)
    routes: list[str] = []  # шаблоны [Route] метода, у каждого свой маршрут
    for m in _VERB_ATTR.finditer(mask, start, end):
        if not _in_attribute(mask, m.start()):
            continue
        template = None
        if m.group("arg") is not None:
            template = _literal(f, m.start("arg"), m.end("arg"))
            if template is None:
                _dynamic(f, m.start(), m.start("arg"), m.group(1).upper())
                return
        verbs.append((m.group(1).upper(), template, m.start()))
    for m in _ROUTE_ATTR.finditer(mask, start, end):
        if m.group("arg") is None or not _in_attribute(mask, m.start()):
            continue
        route = _literal(f, m.start("arg"), m.end("arg"))
        if route is None:
            _dynamic(f, m.start(), m.start("arg"))
            return
        routes.append(route)
    if not verbs and not routes:
        return
    if cls.dynamic is not None:
        if not cls.hinted:
            cls.hinted = True
            _dynamic(f, cls.dynamic, cls.dynamic)
        return
    controller = cls.name.removesuffix("Controller") or cls.name
    action = name.removesuffix("Async") or name
    pairs: list[tuple[str, str | None, int]] = []
    for method, template, pos in verbs or [("ANY", None, at)]:
        # Глагол без шаблона берёт шаблоны [Route] метода, глагол с шаблоном — свой.
        choices: list[str | None] = list(routes) if template is None and routes else [template]
        pairs.extend((method, tpl, pos) for tpl in choices)
    for method, tpl, pos in pairs:
        unresolved = False
        if tpl is not None and tpl.startswith(("/", "~/")):
            path = _join(_token(tpl.lstrip("~"), controller, action))
        elif cls.prefix is not None:
            path = _join(
                _token(cls.prefix, controller, action), _token(tpl or "", controller, action),
            )
        elif tpl is not None:
            path = _join(_token(tpl, controller, action))
        else:
            # Маршрут по соглашению: шаблон регистрирует MapControllerRoute, его не читаем.
            path, unresolved = _join(controller, action), True
        _add(f, method, path, pos, unresolved)


def _test_file(rel: str) -> bool:
    return clike.in_test_dir(rel) or _TEST_FILE.search(paths.name(rel)) is not None


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not any(
        p.language == codebase.DOTNET and vocab.family_reads("http_routes", p.language, p.deps)
        for p in codebase.packages(files, ctx)
    ):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.DOTNET, None, _NEEDLES):
        if _test_file(rel):
            continue
        deps = tuple(codebase.deps_of(files, ctx, rel, codebase.DOTNET))
        if not vocab.family_reads("http_routes", codebase.DOTNET, deps):
            continue
        code = codetext.load(files, rel, text, codetext.CS)
        if code is None:
            continue
        part = Findings()
        f = _File(files, code, rel, part)
        try:
            _minimal(f)
            _controllers(f, _classes(f))
        except _TooMany:
            files.refuse(rel)
            continue
        found.routes.extend(part.routes)
        found.hints.extend(part.hints)
    return found
