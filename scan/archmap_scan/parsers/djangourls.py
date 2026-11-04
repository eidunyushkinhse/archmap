"""Маршруты Django (ТЗ §6.2): urlpatterns с path, re_path и url, вложенные include() по
модулю, по списку и по списку прямо в вызове, роутеры DRF (router.register(prefix,
ViewSet) → /prefix/ и /prefix/{id}/). Метод у маршрута Django — ANY: представление
решает само.

Корень — ROOT_URLCONF из настроек; без него корнем считается urlpatterns файла, который
никто не подключает. Префиксы складываются по цепочке include() от корня. Списки, до
которых от корня дойти не удалось (подключены не строкой или не подключены вовсе), дают
маршруты с prefix_unresolved. Списки собираются из присваиваний на уровне модуля (в том
числе внутри if и for), «+=», append и extend; имена — только литералами.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field

from archmap_scan import codebase, pyast, pycode, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route
from archmap_scan.walk import Files

NAME = "django-urls"
FRAMEWORK = "Django"
WANTED = frozenset({"django", "djangorestframework"})
_NEEDLES = ("urlpatterns", "ROOT_URLCONF", "DefaultRouter", "SimpleRouter")
_PATH_FUNCS = frozenset({"path", "re_path", "url"})
_ROUTERS = frozenset({"DefaultRouter", "SimpleRouter"})
# Пределы обхода: глубина include() и сколько маршрутов даёт один корень (повторные
# подключения одного списка под разными префиксами законны, но не бесконечны).
_MAX_DEPTH = 16
_MAX_ROUTES = 50_000

Key = tuple[str, str]  # (файл, имя списка); роутер DRF — «router:имя»


@dataclass(frozen=True)
class _Leaf:
    route: str
    loc: Loc


@dataclass(frozen=True)
class _Ref:
    target: Key | None
    prefix: str
    loc: Loc


@dataclass
class _Module:
    rel: str
    imps: dict[str, pycode.Imported]
    names: set[str] = field(default_factory=set)  # списки и роутеры, объявленные в модуле


def _clean(piece: str) -> str:
    """Кусок пути без якорей регулярного выражения: «^api/» → «api/», «^x/$» → «x/»."""
    if piece.startswith("^"):
        piece = piece[1:]
    if piece.endswith("$") and not piece.endswith("\\$"):
        piece = piece[:-1]
    return piece


class _Urls:
    def __init__(self, files: Files, found: Findings) -> None:
        self.files = files
        self.found = found
        self.lists: dict[Key, list[_Leaf | _Ref]] = {}
        self.modules: dict[str, _Module] = {}
        self.loaded: set[str] = set()
        self.anon = 0

    # Разбор файла

    def load(self, rel: str) -> _Module | None:
        if rel in self.loaded:
            return self.modules.get(rel)
        self.loaded.add(rel)
        text = self.files.read(rel, keep=False)
        tree = pyast.parse(text) if text is not None else None
        if tree is None:
            return None
        mod = _Module(rel=rel, imps=pycode.imports(tree))
        self.modules[rel] = mod
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                if pyast.last_name(node.value) in _ROUTERS:
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            mod.names.add("router:" + target.id)
                            self.lists.setdefault((rel, "router:" + target.id), [])
        self._body(mod, tree.body)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr == "register" and isinstance(node.func.value, ast.Name):
                    key = (rel, "router:" + node.func.value.id)
                    if key in self.lists:
                        self._register(mod, key, node)
        return mod

    def _body(self, mod: _Module, body: list[ast.stmt]) -> None:
        """Инструкции уровня модуля (с заходом в if, for, try и with)."""
        for stmt in body:
            if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and stmt.value is not None:
                targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                for target in targets:
                    if isinstance(target, ast.Name):
                        self._add(mod, target.id, stmt.value)
            elif isinstance(stmt, ast.AugAssign) and isinstance(stmt.target, ast.Name):
                self._add(mod, stmt.target.id, stmt.value)
            elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
                call = stmt.value
                if (
                    isinstance(call.func, ast.Attribute)
                    and call.func.attr in ("append", "extend", "insert")
                    and isinstance(call.func.value, ast.Name)
                    and call.args
                ):
                    item = call.args[-1]
                    value = item if call.func.attr == "extend" else ast.List(elts=[item])
                    self._add(mod, call.func.value.id, value)
            elif isinstance(stmt, (ast.If, ast.For, ast.While, ast.With)):
                self._body(mod, stmt.body)
                self._body(mod, getattr(stmt, "orelse", []))
            elif isinstance(stmt, ast.Try):
                for part in (stmt.body, stmt.orelse, stmt.finalbody):
                    self._body(mod, part)
                for handler in stmt.handlers:
                    self._body(mod, handler.body)

    def _add(self, mod: _Module, name: str, value: ast.expr) -> None:
        items = self._items(mod, value, name)
        if items is None:
            return
        mod.names.add(name)
        self.lists.setdefault((mod.rel, name), []).extend(items)

    def _items(
        self, mod: _Module, expr: ast.expr, own: str | None = None,
    ) -> list[_Leaf | _Ref] | None:
        """Элементы списка маршрутов из выражения; None — выражение не список маршрутов."""
        if isinstance(expr, (ast.List, ast.Tuple)):
            out: list[_Leaf | _Ref] = []
            for elt in expr.elts:
                if isinstance(elt, ast.Starred):
                    out += self._items(mod, elt.value, own) or []
                else:
                    out += self._item(mod, elt)
            return out
        if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
            left = self._items(mod, expr.left, own)
            right = self._items(mod, expr.right, own)
            if left is None and right is None:
                return None
            return (left or []) + (right or [])
        if isinstance(expr, ast.Call):
            name = pyast.last_name(expr)
            if name in ("list", "format_suffix_patterns") and expr.args:
                return self._items(mod, expr.args[0], own)
            if name == "i18n_patterns":
                return self._items(mod, ast.List(elts=list(expr.args)), own)
            return None
        if isinstance(expr, (ast.Name, ast.Attribute)):
            if isinstance(expr, ast.Name) and expr.id == own:
                return []  # urlpatterns = urlpatterns + […]: сам себя список не включает
            target = self._ref(mod, expr)
            if target is None:
                return None
            return [_Ref(target, "", Loc(mod.rel, expr.lineno))]
        return None

    def _item(self, mod: _Module, elt: ast.expr) -> list[_Leaf | _Ref]:
        if not isinstance(elt, ast.Call) or pyast.last_name(elt) not in _PATH_FUNCS:
            return []
        raw = pycode.arg(elt, 0, "route") or pycode.kwarg(elt, "regex")
        route = pycode.string(raw)
        loc = Loc(mod.rel, elt.lineno)
        if route is None:
            if raw is not None:
                self._dynamic(raw, loc)
            return []
        view = pycode.arg(elt, 1, "view")
        if isinstance(view, ast.Call) and pyast.last_name(view) == "include":
            return self._include(mod, view, route, loc)
        return [_Leaf(route, loc)]

    def _include(
        self, mod: _Module, call: ast.Call, prefix: str, loc: Loc,
    ) -> list[_Leaf | _Ref]:
        target = pycode.arg(call, 0)
        if isinstance(target, ast.Tuple) and target.elts:
            target = target.elts[0]  # include(("app.urls", "ns")) и include((patterns, "ns"))
        if target is None:
            return []
        module = pycode.string(target)
        if module is not None:
            rel = codebase.resolve_module(self.files, mod.rel, module)
            return [_Ref((rel, "urlpatterns") if rel else None, prefix, loc)]
        if isinstance(target, ast.List):
            self.anon += 1
            key = (mod.rel, f"@{self.anon}")
            self.lists[key] = self._items(mod, target) or []
            return [_Ref(key, prefix, loc)]
        if isinstance(target, (ast.Name, ast.Attribute)):
            return [_Ref(self._ref(mod, target), prefix, loc)]
        self._dynamic(target, loc)
        return []

    def _ref(self, mod: _Module, expr: ast.expr) -> Key | None:
        """Список по имени: свой (urls, router.urls), импортированный список или
        urlpatterns импортированного модуля."""
        name = pycode.dotted(expr)
        if name is None:
            return None
        head, _, rest = name.partition(".")
        if rest == "urls" and f"router:{head}" in mod.names:
            return (mod.rel, "router:" + head)
        if not rest and head in mod.names:
            return (mod.rel, head)
        imp = mod.imps.get(head)
        if imp is None:
            return (mod.rel, name) if not rest else None
        full = imp.target if not rest else f"{imp.target}.{rest}"
        if imp.level:
            full = full.lstrip(".")
        # Сначала «модуль.urlpatterns», затем «модуль.имя списка».
        rel = codebase.resolve_module(self.files, mod.rel, full, imp.level)
        if rel is not None:
            return (rel, "urlpatterns")
        module, _, attr = full.rpartition(".")
        rel = codebase.resolve_module(self.files, mod.rel, module, imp.level) if module else None
        return (rel, attr) if rel else None

    def _register(self, mod: _Module, key: Key, call: ast.Call) -> None:
        raw = pycode.arg(call, 0, "prefix")
        prefix = pycode.string(raw)
        loc = Loc(mod.rel, call.lineno)
        if prefix is None:
            if raw is not None:
                self._dynamic(raw, loc)
            return
        base = _clean(prefix).strip("/")
        self.lists[key] += [_Leaf(f"{base}/", loc), _Leaf(f"{base}/{{id}}/", loc)]

    def _dynamic(self, node: ast.AST, loc: Loc) -> None:
        self.found.hints.append(Hint("dynamic_names", {
            "kind": "route", "name": pycode.short(node), "reason": texts.REASON_DYNAMIC_ROUTE,
            "source": str(Loc(loc.path, getattr(node, "lineno", loc.line))),
        }))

    # Обход от корней

    def walk(self, roots: list[Key], resolved: bool, reached: set[Key]) -> None:
        """Маршруты списков от корней. Списки, уже пройденные от настоящих корней
        (reached), повторно не обходятся: недостижимый список, подключающий их, их
        префиксы не меняет."""
        count = 0
        done = set(reached)

        def visit(key: Key, prefix: str, depth: int, stack: tuple[Key, ...]) -> None:
            nonlocal count
            if key in done and not resolved:
                return
            mod = self.load(key[0])
            reached.add(key)
            if key not in self.lists and mod is not None and depth < _MAX_DEPTH:
                # Корневой модуль реэкспортирует список: from app.urls import urlpatterns.
                target = self._ref(mod, ast.Name(id=key[1]))
                if target is not None and target != key and target not in stack:
                    visit(target, prefix, depth + 1, (*stack, target))
                return
            for item in self.lists.get(key, []):
                if count >= _MAX_ROUTES:
                    return
                if isinstance(item, _Leaf):
                    count += 1
                    self.found.routes.append(Route(
                        method="ANY", path="/" + prefix + _clean(item.route), loc=item.loc,
                        framework=FRAMEWORK, parser=NAME, prefix_unresolved=not resolved,
                    ))
                elif (
                    item.target is not None and item.target not in stack and depth < _MAX_DEPTH
                ):
                    nested = prefix + _clean(item.prefix)
                    visit(item.target, nested, depth + 1, (*stack, item.target))

        for root in roots:
            visit(root, "", 0, (root,))


def _root_urlconfs(files: Files, ctx: Context) -> list[Key]:
    roots: list[Key] = []
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, WANTED, ("ROOT_URLCONF",)):
        tree = pyast.parse(text)
        if tree is None:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if any(isinstance(t, ast.Name) and t.id == "ROOT_URLCONF" for t in node.targets):
                module = pycode.string(node.value)
                target = codebase.resolve_module(files, rel, module) if module else None
                if target is not None and (target, "urlpatterns") not in roots:
                    roots.append((target, "urlpatterns"))
    return roots


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.PYTHON, WANTED):
        return found
    found.applied.add(NAME)
    urls = _Urls(files, found)
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, WANTED, _NEEDLES):
        if "urlpatterns" in text or "Router(" in text:
            urls.load(rel)
    roots = _root_urlconfs(files, ctx)
    for root in roots:
        urls.load(root[0])
    referenced = {
        item.target for items in list(urls.lists.values()) for item in items
        if isinstance(item, _Ref) and item.target is not None
    }
    tops = sorted(k for k in urls.lists if k not in referenced and not k[1].startswith("@"))
    if not roots:
        roots = [k for k in tops if k[1] == "urlpatterns"]
    reached: set[Key] = set()
    urls.walk(roots, True, reached)
    urls.walk([k for k in tops if k not in reached], False, reached)
    # Списки в цикле подключений без корня: каждый обходится один раз, нерешённым.
    for key in sorted(urls.lists):
        if key not in reached and not key[1].startswith("@"):
            urls.walk([key], False, reached)
    return found
