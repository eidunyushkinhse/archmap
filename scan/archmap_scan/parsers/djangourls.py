"""Маршруты Django (ТЗ §6.2): urlpatterns с path, re_path и url, вложенные include() по
модулю, по списку и по списку прямо в вызове, роутеры DRF (router.register(prefix,
ViewSet) → /prefix/ и /prefix/{id}/). Метод у маршрута Django — ANY: представление
решает само.

Обёртка регистрации (ТЗ §15 п. 1): вызов в списке маршрутов с другим именем резолвится
по импорту или определению в том же модуле до функции репозитория; если она возвращает
path/re_path/url с первым параметром путём (rest_path у Zulip), вызов — маршрут, а
методы — из именованных аргументов GET=, POST= и других по записи на метод. Один
уровень: обёртка над обёрткой не резолвится.

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
from archmap_scan.model import Findings, Loc, Route, route_hint
from archmap_scan.walk import Files

NAME = "django-urls"
FRAMEWORK = "Django"
WANTED = frozenset({"django", "djangorestframework"})
_NEEDLES = ("urlpatterns", "ROOT_URLCONF", "DefaultRouter", "SimpleRouter")
_PATH_FUNCS = frozenset({"path", "re_path", "url"})
_ROUTERS = frozenset({"DefaultRouter", "SimpleRouter"})
# Именованные аргументы вызова обёртки, которые называют метод маршрута (регистр точный).
_VERBS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
# Конструкции ast, в тело которых поиск return обёртки не заходит: у них свой return.
_NESTED = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
# Пределы обхода: глубина include() и сколько маршрутов даёт один корень (повторные
# подключения одного списка под разными префиксами законны, но не бесконечны).
_MAX_DEPTH = 16
_MAX_ROUTES = 50_000

Key = tuple[str, str]  # (файл, имя списка); роутер DRF — «router:имя»


@dataclass(frozen=True)
class _Leaf:
    route: str
    loc: Loc
    method: str = "ANY"


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


def _is_include(node: ast.AST | None) -> bool:
    return isinstance(node, ast.Call) and pyast.last_name(node) == "include"


def _own_nodes(body: list[ast.stmt]) -> list[ast.AST]:
    """Элементы дерева тела функции без вложенных функций, классов и лямбд (обход без
    рекурсии)."""
    out: list[ast.AST] = []
    stack: list[ast.AST] = list(body)
    while stack:
        node = stack.pop()
        out.append(node)
        stack += [c for c in ast.iter_child_nodes(node) if not isinstance(c, _NESTED)]
    return out


def _route_param(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
    """Имя первого параметра, если функция — обёртка: в теле есть return path(…),
    re_path(…) или url(…), у которого путь (первый позиционный, route= или regex=) — сам
    этот параметр, а представление — не include(). Иначе None."""
    params = [*fn.args.posonlyargs, *fn.args.args]
    if not params:
        return None
    first = params[0].arg
    for node in _own_nodes(fn.body):
        if not isinstance(node, ast.Return) or not isinstance(node.value, ast.Call):
            continue
        call = node.value
        if pyast.last_name(call) not in _PATH_FUNCS:
            continue
        raw = pycode.arg(call, 0, "route") or pycode.kwarg(call, "regex")
        if isinstance(raw, ast.Name) and raw.id == first:
            if not _is_include(pycode.arg(call, 1, "view")):
                return first
    return None


def _wrappers(tree: ast.Module) -> dict[str, str | None]:
    """Функции верхнего уровня модуля: имя → параметр пути у обёртки, None у прочих."""
    return {
        stmt.name: _route_param(stmt) for stmt in tree.body
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


class _Urls:
    def __init__(self, files: Files, found: Findings) -> None:
        self.files = files
        self.found = found
        self.lists: dict[Key, list[_Leaf | _Ref]] = {}
        self.modules: dict[str, _Module] = {}
        self.loaded: set[str] = set()
        self.anon = 0
        # Обёртки: функции верхнего уровня по файлу; ответ по (файл вызова, имя вызова),
        # отрицательный тоже; деревья модулей, разобранных ради определения, до load().
        self.defs: dict[str, dict[str, str | None]] = {}
        self.wrapper_of: dict[tuple[str, str], str | None] = {}
        self.trees: dict[str, ast.Module | None] = {}

    # Разбор файла

    def _parse(self, rel: str) -> ast.Module | None:
        """Дерево файла; файл разбирается один раз, даже если нужен и списками, и
        определением обёртки."""
        if rel in self.trees:
            return self.trees.pop(rel)
        text = self.files.read(rel, keep=False)
        return pyast.parse(text) if text is not None else None

    def load(self, rel: str) -> _Module | None:
        if rel in self.loaded:
            return self.modules.get(rel)
        self.loaded.add(rel)
        tree = self._parse(rel)
        if tree is None:
            self.defs.setdefault(rel, {})
            return None
        self.defs.setdefault(rel, _wrappers(tree))
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
        if not isinstance(elt, ast.Call):
            return []
        if pyast.last_name(elt) not in _PATH_FUNCS:
            return self._wrapped(mod, elt)
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

    def _wrapped(self, mod: _Module, call: ast.Call) -> list[_Leaf | _Ref]:
        """Вызов обёртки регистрации: маршрут на каждый метод из именованных аргументов
        (без них ANY). Не обёртка или include() среди аргументов — пропуск, как раньше."""
        param = self._wrapper(mod, call)
        if param is None:
            return []
        values = [*call.args, *(kw.value for kw in call.keywords)]
        if any(_is_include(v) for v in values):
            return []
        raw = pycode.arg(call, 0, param)
        route = pycode.string(raw)
        loc = Loc(mod.rel, call.lineno)
        if route is None:
            if raw is not None:
                self._dynamic(raw, loc)
            return []
        named = {kw.arg for kw in call.keywords}
        methods = [verb for verb in _VERBS if verb in named] or ["ANY"]
        return [_Leaf(route, loc, method) for method in methods]

    def _wrapper(self, mod: _Module, call: ast.Call) -> str | None:
        """Параметр пути, если вызываемое — обёртка из репозитория, иначе None."""
        name = pycode.dotted(call.func)
        if name is None:
            return None
        key = (mod.rel, name)
        if key not in self.wrapper_of:
            self.wrapper_of[key] = self._resolve_wrapper(mod, name)
        return self.wrapper_of[key]

    def _resolve_wrapper(self, mod: _Module, name: str) -> str | None:
        """Функция по имени вызова: определение в том же модуле, «from m import f» и
        «m.f» по импорту модуля. Определение модуля по импорту не идёт дальше: обёртка,
        импортированная им самим, не резолвится (один уровень, циклов нет)."""
        head, _, rest = name.partition(".")
        own = self.defs.get(mod.rel, {})
        if not rest and head in own:
            return own[head]
        imp = mod.imps.get(head)
        if imp is None or (not rest and not imp.attr):
            return None
        full = f"{imp.target}.{rest}" if rest else imp.target
        if imp.level:
            full = full.lstrip(".")
        module, _, func = full.rpartition(".")
        if not module and not imp.level:
            return None
        rel = codebase.resolve_module(self.files, mod.rel, module, imp.level)
        if rel is None:
            return None
        return self._defs(rel).get(func)

    def _defs(self, rel: str) -> dict[str, str | None]:
        if rel not in self.defs:
            tree = self._parse(rel)
            self.defs[rel] = _wrappers(tree) if tree is not None else {}
            if rel not in self.loaded:
                self.trees[rel] = tree  # load() этого файла возьмёт дерево отсюда
        return self.defs[rel]

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
        # Метод не пишется: path() и re_path() принимают любой (П3).
        self.found.hints.append(route_hint(
            pycode.short(node), pycode.dynamic_reason(node, texts.REASON_DYNAMIC_ROUTE),
            Loc(loc.path, getattr(node, "lineno", loc.line)),
        ))

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
                        method=item.method, path="/" + prefix + _clean(item.route), loc=item.loc,
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
