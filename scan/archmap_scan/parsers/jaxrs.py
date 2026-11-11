"""Маршруты JAX-RS (ТЗ §15 п. 17 К2): ресурсы, глаголы и локаторы подресурсов в коде Java и
Kotlin пакета с зависимостью JAX-RS (jakarta.ws.rs-api, javax.ws.rs-api, jboss-jaxrs-api_*,
resteasy-*, quarkus-resteasy*, quarkus-rest*, jersey-*).

Ресурс — класс (не интерфейс: аннотации интерфейсов — клиентские прокси RESTEasy и
MicroProfile, они не читаются). Корневой ресурс — неабстрактный класс с @Path у класса, до
которого не дошёл ни один локатор. Метод с глаголом @GET, @POST, @PUT, @DELETE, @PATCH,
@HEAD, @OPTIONS и необязательным @Path даёт маршрут; метод с @Path без глагола — локатор
подресурса: маршруты возвращаемого класса пишутся под путём локатора, @Path у класса
подресурса не применяется (так по правилам JAX-RS). Методы базового класса (extends)
наследуются. Класс ищется по простому имени: тот же файл, импорт, тот же пакет, тот же
модуль, единственный в репозитории; Object, интерфейс или класс вне разобранного кода —
подсказка с путём локатора. Цепочка не длиннее восьми локаторов, повтор класса в цепочке её
обрывает. Префикс приложения: quarkus.http.root-path из файла настроек и @ApplicationPath
приложений, где работает модуль ресурса (сам модуль и модули, манифест которых зависит от его
артефакта); разные значения или подстановка — prefix_unresolved. Переменная с регулярным выражением
«{name: regex}» пишется «{name}»; путь константой раскрывается clike.Repo (Java), выражение
даёт подсказку с методом.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from archmap_scan import clike, codebase, codetext, jvm, jvmconf, paths, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route, hint_fields, route_hint
from archmap_scan.walk import Files

NAME = "jaxrs"
FRAMEWORK = "JAX-RS"
STACK = (
    "jakarta.ws.rs", "javax.ws.rs", "jboss-jaxrs-api", "resteasy", "quarkus-resteasy",
    "quarkus-rest", "jersey",
)
_SETTINGS_STACK = (*STACK, "quarkus")
_NEEDLES = ("@Path", "@ApplicationPath", "@GET", "@POST", "@PUT", "@DELETE", "@PATCH", "@HEAD", "@OPTIONS")
_VERBS = frozenset({"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"})
_NAMES = frozenset({"Path", "ApplicationPath", *_VERBS})
_ROOT_KEYS = ("quarkus.http.root-path",)
MAX_DEPTH = 8
# Предел обхода цепочек (посещений методов) на репозиторий: у Keycloak их около тысячи,
# цепочка из тысяч классов с ветвлением — враждебный вход (дальше одна подсказка).
MAX_VISITS = 50_000


@dataclass
class _Method:
    name: str
    line: int
    verbs: list[str]
    path: str | None  # путь @Path метода; None — @Path нет
    dynamic: str | None = None  # выражение пути не литералом
    returns: str | None = None  # тип, который возвращает локатор


@dataclass
class _Resource:
    name: str
    rel: str
    module: str
    path: str | None  # @Path класса; None — нет
    dynamic: str | None
    dynamic_line: int
    abstract: bool
    base: str | None
    methods: list[_Method] = field(default_factory=list)


@dataclass
class _Index:
    by_name: dict[str, list[_Resource]] = field(default_factory=dict)
    imports: dict[str, list[tuple[bool, str, bool]]] = field(default_factory=dict)
    app_paths: dict[str, list[str | None]] = field(default_factory=dict)  # модуль → пути


class _Dynamic(Exception):
    def __init__(self, at: int) -> None:
        super().__init__(at)
        self.at = at


def _path_arg(
    code: codetext.Code, outline: jvm.Outline, repo: clike.Repo | None, rel: str,
    ann: jvm.Annotation,
) -> str:
    """Путь аннотации @Path: первый аргумент или value =; не литерал — _Dynamic."""
    if ann.args < 0:
        raise _Dynamic(ann.at)
    for arg in jvm.args(outline, ann.args):
        if arg.label is None or arg.label == "value":
            value = jvm.string_value(code, repo, rel, arg.start, arg.end)
            if value is None:
                raise _Dynamic(arg.start)
            return jvm.template(value)
    raise _Dynamic(ann.at)


def _read_file(
    files: Files, ctx: Context, rel: str, code: codetext.Code, language: str,
    repo: clike.Repo | None, index: _Index,
) -> None:
    hits = jvm.annotation_hits(code, _NAMES)
    if not hits:
        return
    outline = jvm.Outline.of(code)
    anns = jvm.bind_annotations(outline, hits)
    members = jvm.members(outline, anns)
    module = jvmconf.package_dir(files, ctx, rel, language)
    index.imports[rel] = clike.imports(code) if language == codebase.JAVA else []
    by_at = {d.at: d for d in outline.decls}
    classes: dict[int, _Resource] = {}  # тело класса → ресурс

    def resource(decl: jvm.Decl) -> _Resource:
        res = classes.get(decl.body)
        if res is None:
            res = _Resource(
                decl.name, rel, module, None, None, 0, jvm.is_abstract(outline, decl),
                jvm.superclass(outline, decl),
            )
            classes[decl.body] = res
        return res

    method_anns: dict[int, list[jvm.Annotation]] = {}
    for ann in anns:
        member = members.get(ann.at)
        if member is None:
            continue
        if member.kind == "type":
            decl = by_at.get(member.at)
            if decl is None or decl.kind != "class" or decl.body < 0:
                continue
            if ann.name == "ApplicationPath":
                try:
                    value: str | None = _path_arg(code, outline, repo, rel, ann)
                except _Dynamic:
                    value = None
                index.app_paths.setdefault(module, []).append(value)
            elif ann.name == "Path":
                res = resource(decl)
                try:
                    res.path = _path_arg(code, outline, repo, rel, ann)
                except _Dynamic as exc:
                    res.dynamic, res.dynamic_line = code.expression(exc.at), code.line(ann.at)
            continue
        if member.kind == "method":
            method_anns.setdefault(member.at, []).append(ann)
    owners = outline.owners(method_anns)
    for name_at, group in method_anns.items():
        decl = owners.get(name_at)
        if decl is None or decl.kind != "class":
            continue
        verbs = [a.name for a in group if a.name in _VERBS]
        path_ann = next((a for a in group if a.name == "Path"), None)
        if not verbs and path_ann is None:
            continue
        first = min(a.at for a in group)
        paren = next(m.paren for a in group if (m := members.get(a.at)) is not None)
        method = _Method(
            code.mask[name_at:clike.skip_back(code.mask, paren)], code.line(first),
            list(dict.fromkeys(verbs)), None,
        )
        if path_ann is not None:
            try:
                method.path = _path_arg(code, outline, repo, rel, path_ann)
            except _Dynamic as exc:
                method.dynamic = code.expression(exc.at)
        if not verbs:
            method.returns = jvm.return_type(outline, name_at, paren)
        resource(decl).methods.append(method)
    for res in classes.values():
        index.by_name.setdefault(res.name, []).append(res)


def _resolve(index: _Index, name: str | None, origin: _Resource) -> tuple[_Resource | None, str]:
    """Ресурс по простому имени для кода в origin: тот же файл, импорт Java, тот же пакет,
    тот же модуль, единственный в репозитории. Второе — причина, если не найден
    («unknown» или «ambiguous»)."""
    cands = index.by_name.get(name, []) if name is not None else []
    if not cands:
        return None, "unknown"
    if len(cands) == 1:
        return cands[0], ""
    same = [c for c in cands if c.rel == origin.rel]
    if len(same) == 1:
        return same[0], ""
    for static, imported, _star in index.imports.get(origin.rel, []):
        if static or imported.rsplit(".", 1)[-1] != name:
            continue
        tail = imported.replace(".", "/")
        hits = [c for c in cands if c.rel.rsplit(".", 1)[0].endswith(tail)]
        if len(hits) == 1:
            return hits[0], ""
    folder = paths.parent(origin.rel)
    same = [c for c in cands if paths.parent(c.rel) == folder]
    if len(same) == 1:
        return same[0], ""
    same = [c for c in cands if c.module == origin.module]
    if len(same) == 1:
        return same[0], ""
    return None, "ambiguous"


@dataclass
class _Walk:
    index: _Index
    found: Findings
    unresolved: bool = False
    visits: int = 0
    hinted: set[tuple[str, int, str]] = field(default_factory=set)
    limited: bool = False

    def hint(self, name: str, reason: str, rel: str, line: int, method: str | None = None) -> None:
        """Подсказка; у одного места (файл, строка) с одной причиной — одна, под каким бы
        путём цепочки до него ни дошли (первый путь)."""
        key = (rel, line, reason)
        if key in self.hinted:
            return
        self.hinted.add(key)
        if reason == texts.REASON_DYNAMIC_ROUTE:
            self.found.hints.append(route_hint(name, reason, Loc(rel, line), method))
            return
        self.found.hints.append(Hint("dynamic_names", {
            "kind": "route", "name": name, "reason": reason, "source": str(Loc(rel, line)),
            **hint_fields(method=method),
        }))

    def methods(self, res: _Resource) -> list[tuple[_Resource, _Method]]:
        """Методы ресурса и его базовых классов (сначала свои). Метод базового класса с
        именем метода наследника переопределён и не берётся; перегрузки одного класса
        берутся все."""
        out: list[tuple[_Resource, _Method]] = []
        seen_names: set[str] = set()
        seen_classes: set[int] = set()
        cur: _Resource | None = res
        for _ in range(MAX_DEPTH + 1):
            if cur is None or id(cur) in seen_classes:
                break
            seen_classes.add(id(cur))
            own = [m for m in cur.methods if m.name not in seen_names]
            out.extend((cur, m) for m in own)
            seen_names.update(m.name for m in cur.methods)
            cur = _resolve(self.index, cur.base, cur)[0] if cur.base else None
        return out

    def expand(self, res: _Resource, base: str, chain: tuple[int, ...]) -> None:
        for owner, m in self.methods(res):
            self.visits += 1
            if self.visits > MAX_VISITS:
                if not self.limited:
                    self.limited = True
                    self.hint(base, texts.REASON_LOCATOR_LIMIT, owner.rel, m.line)
                return
            if m.dynamic is not None:
                self.hint(m.dynamic, texts.REASON_DYNAMIC_ROUTE, owner.rel, m.line,
                          m.verbs[0] if len(m.verbs) == 1 else None)
                continue
            full = _join(base, m.path or "")
            if m.verbs:
                for verb in m.verbs:
                    self.found.routes.append(Route(
                        method=verb, path=full, loc=Loc(owner.rel, m.line), framework=FRAMEWORK,
                        parser=NAME, prefix_unresolved=self.unresolved,
                    ))
                continue
            target, why = _resolve(self.index, m.returns, owner)
            if target is None:
                reason = (
                    texts.REASON_LOCATOR_AMBIGUOUS if why == "ambiguous"
                    else texts.REASON_LOCATOR_UNKNOWN
                )
                self.hint(full, reason, owner.rel, m.line)
                continue
            if id(target) in chain:
                continue
            if len(chain) > MAX_DEPTH:
                self.hint(full, texts.REASON_LOCATOR_DEPTH, owner.rel, m.line)
                continue
            self.expand(target, full, (*chain, id(target)))


def _join(*parts: str) -> str:
    pieces = [p.strip("/") for p in parts if p.strip("/")]
    return "/" + "/".join(pieces)


def _apps_of(files: Files, ctx: Context) -> dict[str, list[str]]:
    """Модуль ресурса → модули приложений, в которых он работает: сам модуль и модули,
    манифест которых зависит от его артефакта (quarkus/runtime Keycloak подключает
    keycloak-services, где лежат ресурсы)."""
    pkgs = jvm.packages(files, ctx)
    out: dict[str, list[str]] = {}
    for pkg in pkgs:
        name = (pkg.name or "").lower()
        users = [p.dir for p in pkgs if p.dir != pkg.dir and name and name in p.deps]
        out[pkg.dir] = [pkg.dir, *users]
    return out


def _pick(values: list[str | None]) -> tuple[str, bool]:
    """Значение префикса из значений приложений модуля: нет — пусто, одно — оно, None
    (подстановка, выражение) или несколько разных — префикс не решён."""
    distinct = set(values)
    if not distinct:
        return "", False
    if len(distinct) > 1:
        return "", True
    only = next(iter(distinct))
    return (only or "", only is None)


def _root_paths(files: Files, ctx: Context) -> dict[str, list[str | None]]:
    """quarkus.http.root-path по модулям из файлов настроек (с «${» — None)."""
    out: dict[str, list[str | None]] = {}
    for rel in jvmconf.settings_files(files, ctx, _SETTINGS_STACK):
        got = jvmconf.first_value(files, [rel], _ROOT_KEYS)
        if got is not None:
            out.setdefault(jvmconf.module_of(rel), []).append(None if "${" in got[0] else got[0])
    return out


def _app_prefix(
    apps_of: dict[str, list[str]], roots: dict[str, list[str | None]],
    apps: dict[str, list[str | None]], module: str,
) -> tuple[str, bool]:
    """Префикс приложения ресурса модуля module: quarkus.http.root-path и @ApplicationPath
    приложений, где модуль работает (сам модуль и модули, зависящие от него), и признак
    «не решён»."""
    users = apps_of.get(module, [module])
    root, bad_root = _pick([v for m in users for v in roots.get(m, [])])
    app, bad_app = _pick([v for m in users for v in apps.get(m, [])])
    prefix = _join(root, app) if (root.strip("/") or app.strip("/")) else ""
    return prefix, bad_root or bad_app


def _reached(index: _Index) -> set[int]:
    """Ресурсы, до которых доходит локатор ресурса из другой компоненты сильной связности:
    предок, достижимый только из собственных потомков (цикл A → B → A), корневым остаётся,
    иначе цикл съел бы корень. Компоненты считает итеративный Тарьян, время линейно."""
    edges: dict[int, set[int]] = {}
    preds: dict[int, set[int]] = {}
    for items in index.by_name.values():
        for res in items:
            for m in res.methods:
                if m.verbs or m.dynamic is not None:
                    continue
                target, _why = _resolve(index, m.returns, res)
                if target is not None and target is not res:
                    edges.setdefault(id(res), set()).add(id(target))
                    preds.setdefault(id(target), set()).add(id(res))
    comp = _components(edges)
    return {node for node, sources in preds.items() if any(comp[s] != comp[node] for s in sources)}


def _components(edges: dict[int, set[int]]) -> dict[int, int]:
    """Номер компоненты сильной связности каждой вершины графа (итеративный Тарьян)."""
    nodes = set(edges) | {t for ts in edges.values() for t in ts}
    index: dict[int, int] = {}
    low: dict[int, int] = {}
    comp: dict[int, int] = {}
    stack: list[int] = []
    on_stack: set[int] = set()
    counter = 0
    for start in sorted(nodes):
        if start in index:
            continue
        work: list[tuple[int, list[int]]] = [(start, sorted(edges.get(start, ())))]
        index[start] = low[start] = counter
        counter += 1
        stack.append(start)
        on_stack.add(start)
        while work:
            node, todo = work[-1]
            if todo:
                nxt = todo.pop()
                if nxt not in index:
                    index[nxt] = low[nxt] = counter
                    counter += 1
                    stack.append(nxt)
                    on_stack.add(nxt)
                    work.append((nxt, sorted(edges.get(nxt, ()))))
                elif nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                while True:
                    top = stack.pop()
                    on_stack.discard(top)
                    comp[top] = node
                    if top == node:
                        break
    return comp


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not jvm.stack_present(files, ctx, STACK):
        return found
    found.applied.add(NAME)
    repos = jvm.Repos(files, ctx)
    index = _Index()
    for rel, code, language in jvm.sources(files, ctx, STACK, _NEEDLES):
        repo = repos.note(rel, code, language)
        part = _Index()
        try:
            _read_file(files, ctx, rel, code, language, repo, part)
        except jvm.TooMany:
            files.refuse(rel)
            continue
        for name, items in part.by_name.items():
            index.by_name.setdefault(name, []).extend(items)
        index.imports.update(part.imports)
        for module, values in part.app_paths.items():
            index.app_paths.setdefault(module, []).extend(values)
    walk = _Walk(index, found)
    reached = _reached(index)
    root_paths = _root_paths(files, ctx)
    apps_of = _apps_of(files, ctx)
    roots = sorted(
        (r for items in index.by_name.values() for r in items),
        key=lambda r: (r.rel, r.name),
    )
    for res in roots:
        if res.abstract or id(res) in reached:
            continue
        if res.dynamic is not None:
            walk.hint(res.dynamic, texts.REASON_DYNAMIC_ROUTE, res.rel, res.dynamic_line)
            continue
        if res.path is None:
            continue
        prefix, walk.unresolved = _app_prefix(apps_of, root_paths, index.app_paths, res.module)
        walk.expand(res, _join(prefix, res.path), (id(res),))
    return found
