"""Маршруты Spring MVC и WebFlux (ТЗ §15 п. 17 К1): аннотации контроллеров в коде Java и
Kotlin пакета с зависимостью Spring Boot (артефакт spring-boot*, у Gradle — плагин
org.springframework.boot).

Контроллер — класс с @RestController или @Controller (интерфейсы, в том числе @FeignClient и
клиентские контракты, маршрутов не дают). Префикс класса — @RequestMapping("/x"),
@RequestMapping(value = "/x") или path = "/x"; массив {"/a", "/b"} (Kotlin ["/a", "/b"]) даёт
по маршруту на элемент. Метод с @GetMapping, @PostMapping, @PutMapping, @DeleteMapping,
@PatchMapping (путь первым аргументом, value = или path =; без пути — путь префикса) или
@RequestMapping (методы из method = {RequestMethod.GET, …}, без method — ANY, как у класса,
если там method задан). Путь складывается как у ASP.NET Core: ведущая косая добавляется,
«{id}» и «*» как написаны, переменная с регулярным выражением «{id:[0-9]+}» пишется «{id}».
Префикс приложения server.servlet.context-path или spring.webflux.base-path из файла
настроек того же модуля (jvmconf), если он задан литералом; с подстановкой «${…}» —
маршруты с prefix_unresolved. Путь константой класса раскрывается по clike.Repo (Java),
выражение или шаблон Kotlin с «$» — подсказка о динамическом пути с методом.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from archmap_scan import clike, codetext, jvm, jvmconf, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, Route, route_hint
from archmap_scan.walk import Files

NAME = "spring"
FRAMEWORK = "Spring"
STACK = ("spring-boot",)
_NEEDLES = ("Mapping",)
_CONTROLLERS = frozenset({"RestController", "Controller"})
_VERBS = {
    "GetMapping": "GET", "PostMapping": "POST", "PutMapping": "PUT", "DeleteMapping": "DELETE",
    "PatchMapping": "PATCH",
}
_NAMES = frozenset({*_CONTROLLERS, "RequestMapping", *_VERBS})
_METHODS = frozenset({"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"})
_PATH_LABELS = frozenset({"value", "path"})
CONTEXT_KEYS = ("server.servlet.context-path", "spring.webflux.base-path")


class _Dynamic(Exception):
    """Путь аннотации не литерал: позиция выражения для подсказки."""

    def __init__(self, at: int) -> None:
        super().__init__(at)
        self.at = at


@dataclass
class _Class:
    decl: jvm.Decl
    controller: bool = False
    mapping: jvm.Annotation | None = None


@dataclass
class _File:
    files: Files
    rel: str
    code: codetext.Code
    outline: jvm.Outline
    repo: clike.Repo | None
    found: Findings
    prefix: str
    unresolved: bool
    count: int = 0
    hinted: set[int] = field(default_factory=set)


def join(*parts: str) -> str:
    """Путь из частей: ведущая косая одна, пустые части и косые на стыках убраны."""
    pieces = [p.strip("/") for p in parts if p.strip("/")]
    return "/" + "/".join(pieces)


def _paths(f: _File, ann: jvm.Annotation) -> list[str]:
    """Пути аннотации: элементы value, path или первого позиционного аргумента; аргумента
    нет — путь пустой. Элемент не литерал — _Dynamic."""
    if ann.args < 0:
        return [""]
    chosen: jvm.Arg | None = None
    for arg in jvm.args(f.outline, ann.args):
        if arg.label is None or arg.label in _PATH_LABELS:
            chosen = arg
            break
    if chosen is None:
        return [""]
    out: list[str] = []
    for lo, hi in jvm.items(f.outline, chosen):
        value = jvm.string_value(f.code, f.repo, f.rel, lo, hi)
        if value is None:
            raise _Dynamic(lo)
        out.append(jvm.template(value))
    return out or [""]


def _methods(f: _File, ann: jvm.Annotation) -> list[str]:
    """Методы HTTP из аргумента method = {RequestMethod.GET, …}; пусто — метод не задан."""
    if ann.args < 0:
        return []
    mask = f.code.mask
    for arg in jvm.args(f.outline, ann.args):
        if arg.label != "method":
            continue
        out: list[str] = []
        for lo, hi in jvm.items(f.outline, arg):
            name = mask[lo:hi].rsplit(".", 1)[-1].strip().upper()
            if name in _METHODS and name not in out:
                out.append(name)
        return out
    return []


def _hint(f: _File, ann: jvm.Annotation, at: int, method: str | None) -> None:
    f.found.hints.append(route_hint(
        f.code.expression(at), texts.REASON_DYNAMIC_ROUTE,
        Loc(f.rel, f.code.line(ann.at)), method,
    ))


def _add(f: _File, method: str, path: str, ann: jvm.Annotation) -> None:
    f.count += 1
    if f.count > clike.MAX_READS:
        raise jvm.TooMany
    f.found.routes.append(Route(
        method=method, path=path, loc=Loc(f.rel, f.code.line(ann.at)), framework=FRAMEWORK,
        parser=NAME, prefix_unresolved=f.unresolved,
    ))


def _classes(
    f: _File, anns: list[jvm.Annotation], members: dict[int, jvm.Member | None],
) -> dict[int, _Class]:
    """Классы файла с аннотациями над ними: позиция тела → класс."""
    by_at = {d.at: d for d in f.outline.decls}
    out: dict[int, _Class] = {}
    for ann in anns:
        member = members.get(ann.at)
        if member is None or member.kind != "type":
            continue
        decl = by_at.get(member.at)
        if decl is None or decl.body < 0:
            continue
        cls = out.setdefault(decl.body, _Class(decl))
        if ann.name in _CONTROLLERS:
            cls.controller = decl.kind == "class"
        elif ann.name == "RequestMapping" and cls.mapping is None:
            cls.mapping = ann
    return out


def _prefixes(f: _File, cls: _Class) -> list[str] | None:
    """Префиксы класса; None — префикс не литерал (подсказка записана один раз)."""
    if cls.mapping is None:
        return [""]
    try:
        return _paths(f, cls.mapping)
    except _Dynamic as exc:
        if cls.decl.body not in f.hinted:
            f.hinted.add(cls.decl.body)
            _hint(f, cls.mapping, exc.at, None)
        return None


def _parse_file(f: _File, hits: list[tuple[str, int, int, int]]) -> None:
    anns = jvm.bind_annotations(f.outline, hits)
    members = jvm.members(f.outline, anns)
    classes = _classes(f, anns, members)
    if not any(c.controller for c in classes.values()):
        return
    on_methods = [
        a for a in anns
        if a.name not in _CONTROLLERS and (m := members.get(a.at)) is not None
        and m.kind == "method"
    ]
    owners = f.outline.owners(a.at for a in on_methods)
    for ann in on_methods:
        decl = owners.get(ann.at)
        cls = classes.get(decl.body) if decl is not None else None
        if cls is None or not cls.controller:
            continue
        verb = _VERBS.get(ann.name)
        methods = [verb] if verb is not None else _methods(f, ann)
        if not methods and cls.mapping is not None:
            methods = _methods(f, cls.mapping)
        try:
            tails = _paths(f, ann)
        except _Dynamic as exc:
            _hint(f, ann, exc.at, verb)
            continue
        prefixes = _prefixes(f, cls)
        if prefixes is None:
            continue
        for prefix in prefixes:
            for tail in tails:
                for method in methods or ["ANY"]:
                    _add(f, method, join(f.prefix, prefix, tail), ann)


def _context(
    files: Files, ctx: Context, module: str, memo: dict[str, tuple[str, bool]],
) -> tuple[str, bool]:
    """Префикс приложения модуля из файла настроек и признак «не литерал»."""
    if module not in memo:
        rels = jvmconf.module_files(files, ctx, module, STACK)
        got = jvmconf.first_value(files, rels, CONTEXT_KEYS)
        if got is None:
            memo[module] = ("", False)
        elif "${" in got[0]:
            memo[module] = ("", True)
        else:
            memo[module] = (got[0], False)
    return memo[module]


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not jvm.stack_present(files, ctx, STACK):
        return found
    found.applied.add(NAME)
    repos = jvm.Repos(files, ctx)
    contexts: dict[str, tuple[str, bool]] = {}
    for rel, code, language in jvm.sources(files, ctx, STACK, _NEEDLES):
        repo = repos.note(rel, code, language)
        part = Findings()
        try:
            hits = jvm.annotation_hits(code, _NAMES)
            if not hits:
                continue
            module = jvmconf.package_dir(files, ctx, rel, language)
            prefix, unresolved = _context(files, ctx, module, contexts)
            outline = jvm.Outline.of(code)
            f = _File(
                files, rel, code, outline, repo, part, prefix, unresolved,
            )
            _parse_file(f, hits)
        except jvm.TooMany:
            files.refuse(rel)
            continue
        found.routes.extend(part.routes)
        found.hints.extend(part.hints)
    return found
