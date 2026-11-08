"""Маршруты actix-web (ТЗ §15 п. 15 К3) в коде Rust крейта с зависимостью actix-web.

- `.route("путь", web::get().to(h))` (и `post`, `put`, `delete`, `patch`, `head`, `options`,
  `trace`, `connect`; `web::method(…)`, `web::route()`, `web::to(h)` и прочее выражение —
  ANY) — метод и путь;
- `web::resource("путь")`: каждый `.route(web::get().to(h))` на его цепочке — запись с путём
  ресурса, `.to(h)` прямо на ресурсе — ANY;
- `web::scope("префикс")`: вызовы на его цепочке и всё внутри их скобок (`.service(…)`,
  `.configure(|cfg| { … })`) получают префикс; вложенные scope складываются. Вложенность
  считается по парным скобкам маски одним проходом: цепочка scope или resource кончается
  на «,» или «;» своего уровня или на закрывающей скобке. Имена без `web::` (`use
  actix_web::web::*`) читаются так же;
- атрибуты `#[get("путь")]`, `#[post("путь")]` и другие, `#[route("путь", method = "GET")]`
  над `fn` — метод и путь без префикса: такой обработчик подключается `.service(h)`, и
  scope, внутри которого его подключили, механически не находится (решение исполнителя:
  путь как написан, без `prefix_unresolved`).

Путь константой `const ИМЯ: &str = "…";` того же файла раскрывается; `format!`, переменная
и прочее выражение — подсказка о динамическом пути, записи под таким scope идут с
`prefix_unresolved`. Модуль тестов `#[cfg(test)] mod … { … }` и каталоги тестов не читаются.
Пределы: выражение в скобках не длиннее 200 тыс. знаков маски, вложенность до 1000 скобок,
не больше 5000 записей и 400 тыс. скобок и разделителей на файл; сверх — файл непрочитан.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from dataclasses import dataclass

from archmap_scan import clike, codebase, codetext, texts, vocab
from archmap_scan.codetext import SP
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route
from archmap_scan.parsers.rustenv import test_modules
from archmap_scan.walk import Files

NAME = "actix"
FRAMEWORK = "actix-web"
_LIT = r'"[ ]*"'
_VERBS = "get|post|put|delete|patch|head|options|trace|connect"
# Один проход по маске: скобки, разделители, начало scope/resource, .route( и .to(.
# Опережающая проверка первого знака ускоряет поиск по длинным участкам без них в разы.
_TOKENS = re.compile(
    r"(?=[()\[\]{},;.sr])(?:(?P<open>[(\[{])|(?P<close>[)\]}])|(?P<sep>[,;])"
    r"|(?<![\w.])(?P<head>scope|resource)[ \t]*\("
    r"|\.[ \t\r\n]{0,200}(?P<call>route|to)[ \t]*\()"
)
_FN_BEFORE = re.compile(r"\bfn[ \t]+$")
_ARG = re.compile(rf"{SP}(?:(?P<lit>{_LIT})|(?P<word>[A-Za-z_][A-Za-z0-9_:]{{0,200}}))?")
_COMMA = re.compile(rf"{SP},")
_METHOD = re.compile(
    rf"{SP}(?:web[ \t]*::[ \t]*)?(?P<m>{_VERBS}|method|route|to)[ \t]*\("
)
_ATTR = re.compile(
    rf"#[ \t]*\[[ \t]*(?:actix_web[ \t]*::[ \t]*)?(?P<verb>{_VERBS}|route)[ \t]*\("
    rf"{SP}(?P<lit>{_LIT})?"
)
_ATTR_METHOD = re.compile(rf'\bmethod[ \t]*=[ \t]*(?P<lit>{_LIT})')
_ATTR_END = re.compile(r"[\[\]]")
_FN_AFTER = re.compile(
    r"[ \t\r\n]*(?:#[ \t]*\[[^\[\]\n]{0,300}\][ \t\r\n]*){0,10}"
    r"(?:pub(?:[ \t]*\([^()\n]{0,40}\))?[ \t]+)?(?:async[ \t]+)?fn\b"
)
_CONST = re.compile(
    rf"\b(?:const|static)[ \t]+([A-Z_][A-Z0-9_]{{0,99}})[ \t]*:[ \t]*&[ \t]*(?:'static[ \t]+)?"
    rf"str[ \t]*=[ \t]*({_LIT})[ \t]*;"
)
_NEEDLES = (
    "route(", "scope(", "resource(", "#[get", "#[post", "#[put", "#[delete", "#[patch", "#[head",
    "#[options", "#[trace", "#[connect", "#[actix_web::",
)
_MAX_EXPRESSION = 200_000
_MAX_RECORDS = 5000
_MAX_TOKENS = 400_000
_MAX_DEPTH = 1000


@dataclass
class _Head:
    kind: str  # scope или resource
    path: str | None  # None — путь не литералом
    pos: int


@dataclass
class _Frame:
    base: str  # префиксы scope снаружи подряд
    unresolved: bool
    head: _Head | None = None  # scope или resource текущей цепочки на этом уровне


class _Overflow(Exception):
    pass


def _path(out: str) -> str:
    """Путь из частей, склеенных подряд как у actix-web: без двойных «/», от корня."""
    while "//" in out:
        out = out.replace("//", "/")
    return out if out.startswith("/") else "/" + out


class _File:
    def __init__(self, code: codetext.Code, rel: str, found: Findings) -> None:
        self.code = code
        self.rel = rel
        self.found = found
        self.count = 0
        self.consts: dict[str, str] | None = None

    def add(self, method: str, path: str, pos: int, unresolved: bool = False) -> None:
        self.count += 1
        if self.count > _MAX_RECORDS:
            raise _Overflow
        self.found.routes.append(Route(
            method=method, path=_path(path), loc=Loc(self.rel, self.code.line(pos)),
            framework=FRAMEWORK, parser=NAME, prefix_unresolved=unresolved,
        ))

    def dynamic(self, pos: int, expr_at: int) -> None:
        self.found.hints.append(Hint("dynamic_names", {
            "kind": "route", "name": self.code.expression(expr_at),
            "reason": texts.REASON_DYNAMIC_ROUTE, "source": str(Loc(self.rel, self.code.line(pos))),
        }))

    def const(self, name: str) -> str | None:
        """Значение строковой константы файла `const ИМЯ: &str = "…";`."""
        if self.consts is None:
            self.consts = {}
            for m in _CONST.finditer(self.code.mask):
                self.consts.setdefault(m.group(1), clike.literal_value(self.code, *m.span(2)))
        return self.consts.get(name)

    def argument(self, pos: int) -> tuple[str | None, int, bool]:
        """Первый аргумент вызова с позиции после «(»: путь (литерал или константа файла),
        позиция за ним и признак, что аргумент есть, но путь не раскрыт."""
        mask = self.code.mask
        m = _ARG.match(mask, pos)
        if m is None or (m.group("lit") is None and m.group("word") is None):
            return None, pos, True
        if m.group("lit") is not None:
            return clike.literal_value(self.code, m.start("lit"), m.end("lit")), m.end(), False
        word = m.group("word")
        after = mask[m.end():m.end() + 1]
        value = self.const(word) if after != "(" and after != "!" else None
        if value is None:
            return None, m.end(), not _METHOD.match(mask, pos)
        return value, m.end(), False


def _route(f: _File, frame: _Frame, pos: int, args: int) -> None:
    """Вызов `.route(` на позиции pos, аргументы с позиции args."""
    mask = f.code.mask
    head = frame.head
    path, after, dynamic = f.argument(args)
    if path is None and not dynamic:
        # Без пути: маршрут ресурса `.route(web::get().to(h))`.
        m = _METHOD.match(mask, args)
        if head is None or head.kind != "resource" or m is None:
            return
        method = m.group("m")
        if head.path is None:
            return
        f.add(_verb(method), frame.base + head.path, pos, frame.unresolved)
        return
    if path is None:
        f.dynamic(pos, args)
        return
    comma = _COMMA.match(mask, after)
    m = _METHOD.match(mask, comma.end()) if comma is not None else None
    method = _verb(m.group("m")) if m is not None else "ANY"
    prefix = head.path if head is not None and head.path is not None else ""
    unresolved = frame.unresolved or (head is not None and head.path is None)
    f.add(method, frame.base + prefix + path, pos, unresolved)


def _verb(name: str) -> str:
    return name.upper() if name not in ("method", "route", "to") else "ANY"


def _sweep(f: _File, tests: list[tuple[int, int]]) -> None:
    """Один проход по скобкам маски: стек уровней, у каждого префикс снаружи и текущая
    цепочка scope или resource."""
    mask = f.code.mask
    stack = [_Frame("", False)]
    starts = [a for a, _ in tests]
    expression = 0  # начало внешней круглой скобки
    parens = 0
    for n, m in enumerate(_TOKENS.finditer(mask)):
        if n > _MAX_TOKENS:
            raise _Overflow
        frame = stack[-1]
        kind = m.lastgroup
        if kind == "sep":
            frame.head = None
            continue
        if kind == "close":
            if len(stack) > 1:
                stack.pop()
            if m.group() == ")" and parens > 0:
                parens -= 1
            continue
        if parens == 0 and m.group().endswith("("):
            expression = m.start()
        elif parens > 0 and m.start() - expression > _MAX_EXPRESSION:
            raise _Overflow
        k = bisect_right(starts, m.start()) - 1
        in_test = k >= 0 and m.start() < tests[k][1]
        if kind == "head" and not in_test and not _FN_BEFORE.search(mask, max(0, m.start() - 20), m.start()):
            path, _after, dynamic = f.argument(m.end())
            if path is None:
                f.dynamic(m.start(), m.end())
            frame.head = _Head(m.group("head"), path, m.start())
        elif kind == "call" and not in_test:
            if m.group("call") == "route":
                _route(f, frame, m.start(), m.end())
            elif (
                frame.head is not None and frame.head.kind == "resource"
                and frame.head.path is not None
            ):
                f.add("ANY", frame.base + frame.head.path, m.start(), frame.unresolved)
        # Открытая скобка: новый уровень с префиксом цепочки scope этого уровня.
        head = frame.head
        base, unresolved = frame.base, frame.unresolved
        if head is not None and head.kind == "scope" and kind != "head":
            if head.path is None:
                unresolved = True
            else:
                base += head.path
        if len(stack) > _MAX_DEPTH:
            raise _Overflow
        stack.append(_Frame(base, unresolved))
        if m.group().endswith("("):
            parens += 1


def _attributes(f: _File, tests: list[tuple[int, int]]) -> None:
    mask = f.code.mask
    starts = [a for a, _ in tests]
    for m in _ATTR.finditer(mask):
        k = bisect_right(starts, m.start()) - 1
        if k >= 0 and m.start() < tests[k][1]:
            continue
        end = _attr_end(mask, m.end())
        if end < 0 or _FN_AFTER.match(mask, end) is None:
            continue
        if m.group("lit") is None:
            f.dynamic(m.start(), m.end())
            continue
        path = clike.literal_value(f.code, m.start("lit"), m.end("lit"))
        verb = m.group("verb")
        methods = [verb.upper()]
        if verb == "route":
            methods = [
                clike.literal_value(f.code, a.start("lit"), a.end("lit")).upper()
                for a in _ATTR_METHOD.finditer(mask, m.end(), end)
            ] or ["ANY"]
        for method in dict.fromkeys(methods):
            f.add(method, path, m.start())


def _attr_end(mask: str, pos: int) -> int:
    """Позиция после «]» атрибута, открытого до pos; -1 — не закрыт в 2000 знаках."""
    depth = 1
    for m in _ATTR_END.finditer(mask, pos, min(len(mask), pos + 2000)):
        depth += 1 if m.group() == "[" else -1
        if depth == 0:
            return m.end()
    return -1


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    wanted = vocab.FAMILY_LANGUAGES["http_routes"][codebase.RUST]
    if not any(
        p.language == codebase.RUST and vocab.family_reads("http_routes", p.language, p.deps)
        for p in codebase.packages(files, ctx)
    ):
        return found
    found.applied.add(NAME)
    for rel, text in codebase.sources(files, ctx, codebase.RUST, frozenset(wanted), _NEEDLES):
        if clike.in_test_dir(rel):
            continue
        code = codetext.load(files, rel, text, codetext.RUST)
        if code is None:
            continue
        part = Findings()
        f = _File(code, rel, part)
        tests = test_modules(code.mask) if "cfg" in code.mask else []
        try:
            _sweep(f, tests)
            _attributes(f, tests)
        except _Overflow:
            files.refuse(rel)
            continue
        found.routes.extend(part.routes)
        found.hints.extend(part.hints)
    return found
