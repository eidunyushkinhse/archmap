"""Маршруты HTTP Python-фреймворков с приложением и роутерами (ТЗ §6.2): FastAPI, Starlette
и Flask устроены одинаково, разница в именах — она в Flavor.

Объект маршрутизации — приложение (FastAPI(), Flask()) или роутер (APIRouter(prefix=),
Blueprint(url_prefix=)), присвоенный имени. Маршрут — декоратор @объект.get("/p") или
@объект.route("/p", methods=[…]), вызов add_api_route / add_url_rule. Подключение —
include_router(r, prefix=) / register_blueprint(bp, url_prefix=) в том же файле или по
импорту имени из другого файла репозитория. Префиксы складываются по цепочке подключений
от приложения; роутер, подключение которого не видно (или префикс которого не литерал),
даёт маршруты с prefix_unresolved. Всё только по литералам; путь не литералом уходит в
подсказки как динамическое имя.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from archmap_scan import codebase, pyast, pycode, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Route
from archmap_scan.walk import Files

# Сколько разных префиксов держать у одного роутера (подключён в нескольких местах) и
# насколько глубоко идти по цепочке подключений и реэкспортов.
_MAX_PREFIXES = 8
_MAX_DEPTH = 8
_ANY = "ANY"

Key = tuple[str, str]  # (файл, имя объекта в файле)
_ROOT: Key = ("", "")  # маршрут без объекта (Starlette Route): префикс в самом маршруте


@dataclass(frozen=True)
class Flavor:
    parser: str
    apps: frozenset[str]  # вызовы, создающие приложение
    routers: frozenset[str]  # вызовы, создающие роутер со своим префиксом
    prefix_kw: str  # ключ своего префикса роутера и префикса подключения
    include: str  # метод подключения роутера
    overrides: bool  # префикс подключения заменяет свой (Flask), а не складывается
    methods: frozenset[str]  # декораторы-методы: get, post…
    route_any: frozenset[str]  # декораторы с methods=: api_route, route
    add_rule: str  # вызов-маршрут: add_api_route / add_url_rule
    mount: str | None  # подключение приложения по пути: app.mount("/sub", subapp)
    path_kws: tuple[str, ...]  # имя аргумента пути у декоратора
    needles: tuple[str, ...]  # подстроки для отбора файлов до разбора
    decorator: re.Pattern[str]  # декоратор-маршрут в тексте (отбор файлов)


@dataclass
class _Mount:
    parent: Key | None
    child: Key | None
    prefix: str | None  # None — префикс подключения не литерал
    has_prefix: bool


@dataclass
class _Decl:
    target: Key | None
    method: str
    path: str
    loc: Loc
    prefix: str = ""  # префикс Mount у маршрута Starlette


@dataclass
class _Module:
    rel: str
    imps: dict[str, pycode.Imported]
    # Имя → (вид app | router, свой префикс; None — префикс не литерал).
    objects: dict[str, tuple[str, str | None]] = field(default_factory=dict)
    decls: list[_Decl] = field(default_factory=list)
    mounts: list[_Mount] = field(default_factory=list)
    framework: str = ""


def _join(prefix: str, path: str, overrides: bool) -> str:
    """Путь с префиксом: FastAPI склеивает как есть, Flask — через один «/»."""
    if overrides:
        if not prefix:
            return path or "/"
        if not path:
            return prefix
        return prefix.rstrip("/") + "/" + path.lstrip("/")
    return (prefix + path) or "/"


class _Collector:
    def __init__(self, flavor: Flavor, files: Files, found: Findings) -> None:
        self.flavor = flavor
        self.files = files
        self.found = found
        self.modules: dict[str, _Module] = {}
        self.skipped: set[str] = set()

    # Разбор одного файла

    def collect(self, rel: str, tree: ast.Module, framework: str) -> None:
        mod = _Module(rel=rel, imps=pycode.imports(tree), framework=framework)
        self.modules[rel] = mod
        fl = self.flavor
        for node in ast.walk(tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Call):
                self._object(mod, node, node.value)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute):
                        self._decorator(mod, dec)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr == fl.include:
                    self._mount(mod, node)
                elif node.func.attr == fl.add_rule:
                    self._rule(mod, node)
                elif node.func.attr == fl.mount:
                    self._subapp(mod, node)
        if fl.parser == "fastapi":
            self._starlette(mod, tree)

    def _object(self, mod: _Module, node: ast.Assign | ast.AnnAssign, call: ast.Call) -> None:
        name = pyast.last_name(call)
        fl = self.flavor
        if name not in fl.apps and name not in fl.routers:
            return
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        prefix: str | None = ""
        if name in fl.routers:
            raw = pycode.kwarg(call, fl.prefix_kw)
            if raw is not None:
                prefix = pycode.string(raw)
                if prefix is None:
                    self._dynamic(mod, raw)
        for target in targets:
            var = pycode.dotted(target)
            if var is not None:
                mod.objects[var] = ("app" if name in fl.apps else "router", prefix)

    def _path(self, mod: _Module, call: ast.Call) -> str | None:
        raw = pycode.arg(call, 0)
        if raw is None:
            for kw in self.flavor.path_kws:
                raw = pycode.kwarg(call, kw)
                if raw is not None:
                    break
        if raw is None:
            return None
        path = pycode.string(raw)
        if path is None:
            self._dynamic(mod, raw)
            return None
        if path and not path.startswith("/"):
            return None  # не путь маршрута: у FastAPI и Flask путь начинается с «/»
        return path

    def _methods(self, call: ast.Call) -> list[str]:
        raw = pycode.kwarg(call, "methods")
        if raw is None:
            return ["GET"]
        found = pycode.strings(raw)
        if not found:
            return [_ANY]
        return sorted({m.upper() for m in found})

    def _decorator(self, mod: _Module, dec: ast.Call) -> None:
        assert isinstance(dec.func, ast.Attribute)
        attr = dec.func.attr
        fl = self.flavor
        if attr in fl.methods:
            methods = [attr.upper()]
        elif attr in fl.route_any:
            methods = self._methods(dec)
        else:
            return
        path = self._path(mod, dec)
        if path is None:
            return
        target = self._ref(mod, dec.func.value)
        for method in methods:
            mod.decls.append(_Decl(target, method, path, Loc(mod.rel, dec.lineno)))

    def _rule(self, mod: _Module, call: ast.Call) -> None:
        assert isinstance(call.func, ast.Attribute)
        path = self._path(mod, call)
        if path is None:
            return
        target = self._ref(mod, call.func.value)
        for method in self._methods(call):
            mod.decls.append(_Decl(target, method, path, Loc(mod.rel, call.lineno)))

    def _mount(self, mod: _Module, call: ast.Call) -> None:
        assert isinstance(call.func, ast.Attribute)
        child = pycode.arg(call, 0)
        if child is None:
            return
        raw = pycode.kwarg(call, self.flavor.prefix_kw)
        prefix = pycode.string(raw) if raw is not None else ""
        if raw is not None and prefix is None:
            self._dynamic(mod, raw)
        mod.mounts.append(_Mount(
            parent=self._ref(mod, call.func.value), child=self._ref(mod, child),
            prefix=prefix, has_prefix=raw is not None,
        ))

    def _starlette(self, mod: _Module, tree: ast.Module) -> None:
        """Route("/p", f, methods=[…]) и Mount("/api", routes=[…]) Starlette. Route вне
        списка routes у Mount считается маршрутом без префикса."""
        seen: set[int] = set()

        def kind_of(node: ast.AST) -> str | None:
            if not isinstance(node, ast.Call):
                return None
            kind = pyast.last_name(node)
            if kind not in ("Route", "Mount"):
                return None
            name = pycode.qualname(node.func, mod.imps) or ""
            return kind if name.startswith(("starlette.", "fastapi.")) else None

        def visit(call: ast.Call, kind: str, prefix: str) -> None:
            seen.add(id(call))
            path = self._path(mod, call)
            if path is None:
                return
            if kind == "Route":
                for method in self._methods(call):
                    mod.decls.append(_Decl(_ROOT, method, path, Loc(mod.rel, call.lineno), prefix))
                return
            inner = pycode.arg(call, 1, "routes")
            if isinstance(inner, (ast.List, ast.Tuple)):
                for item in inner.elts:
                    sub = kind_of(item)
                    if sub is not None:
                        assert isinstance(item, ast.Call)
                        visit(item, sub, _join(prefix, path, False))

        for wanted in ("Mount", "Route"):
            for node in ast.walk(tree):
                if kind_of(node) == wanted and id(node) not in seen:
                    assert isinstance(node, ast.Call)
                    visit(node, wanted, "")

    def _subapp(self, mod: _Module, call: ast.Call) -> None:
        assert isinstance(call.func, ast.Attribute)
        raw = pycode.arg(call, 0, "path")
        child = pycode.arg(call, 1, "app")
        if raw is None or child is None or pycode.dotted(child) is None:
            return  # app.mount("/static", StaticFiles(…)): не приложение с маршрутами
        prefix = pycode.string(raw)
        if prefix is None:
            self._dynamic(mod, raw)
        mod.mounts.append(_Mount(
            parent=self._ref(mod, call.func.value), child=self._ref(mod, child),
            prefix=prefix, has_prefix=True,
        ))

    def _ref(self, mod: _Module, node: ast.AST) -> Key | None:
        name = pycode.dotted(node)
        return (mod.rel, name) if name is not None else None

    def _dynamic(self, mod: _Module, node: ast.AST) -> None:
        self.found.hints.append(Hint("dynamic_names", {
            "kind": "route", "name": pycode.short(node),
            "reason": pycode.dynamic_reason(node, texts.REASON_DYNAMIC_ROUTE),
            "source": str(Loc(mod.rel, getattr(node, "lineno", 1))),
        }))

    # Сборка по всем файлам

    def _module(self, rel: str) -> _Module | None:
        """Разобранный файл; не отобранный по подстрокам (реэкспорт в __init__.py) читается
        по требованию, только ради импортов."""
        mod = self.modules.get(rel)
        if mod is None and rel not in self.skipped:
            self.skipped.add(rel)
            text = self.files.read(rel, keep=False)
            tree = pyast.parse(text) if text is not None else None
            if tree is not None:
                mod = self.modules[rel] = _Module(rel=rel, imps=pycode.imports(tree))
        return mod

    def resolve(self, key: Key | None, depth: int = 0) -> Key | None:
        """Объект маршрутизации по имени в файле: свой, импортированный (в том числе через
        реэкспорт в __init__.py) или атрибут импортированного модуля."""
        if key is None or depth > _MAX_DEPTH:
            return None
        rel, name = key
        mod = self._module(rel)
        if mod is None:
            return None
        if name in mod.objects:
            return key
        head, _, rest = name.partition(".")
        imp = mod.imps.get(head)
        if imp is None:
            return None
        if imp.attr is None:
            # import pkg.mod; pkg.mod.router → модуль pkg.mod, имя router
            module, _, var = (imp.module + ("." + rest if rest else "")).rpartition(".")
            target = codebase.resolve_module(self.files, rel, module, imp.level)
            return self.resolve((target, var), depth + 1) if target and var else None
        if rest:
            # from pkg import mod; mod.router
            target = codebase.resolve_module(
                self.files, rel, f"{imp.module}.{imp.attr}" if imp.module else imp.attr, imp.level,
            )
            return self.resolve((target, rest), depth + 1) if target else None
        target = codebase.resolve_module(self.files, rel, imp.module, imp.level)
        return self.resolve((target, imp.attr), depth + 1) if target else None

    def prefixes(self) -> dict[Key, list[tuple[str, bool]]]:
        """Объект → [(полный префикс, решён ли)]: приложения — корень, роутеры — по
        цепочкам подключений, не подключённые роутеры — свой префикс, нерешённый."""
        objects: dict[Key, tuple[str, str | None]] = {
            (rel, var): obj for rel, mod in self.modules.items() for var, obj in mod.objects.items()
        }
        mounts: dict[Key, list[tuple[Key | None, str | None, bool]]] = {}
        for mod in list(self.modules.values()):
            for m in mod.mounts:
                child = self.resolve(m.child)
                if child is not None:
                    parent = self.resolve(m.parent)
                    mounts.setdefault(child, []).append((parent, m.prefix, m.has_prefix))
        memo: dict[Key, list[tuple[str, bool]]] = {}

        def of(key: Key, depth: int) -> list[tuple[str, bool]]:
            if key in memo:
                return memo[key]
            kind, own = objects[key]
            if key not in mounts or depth > _MAX_DEPTH:
                # Приложение — корень; роутер без видимого подключения — свой префикс,
                # но где он подключён, не известно.
                result = [("", True)] if kind == "app" else [(own or "", False)]
            else:
                result = []
                for parent, prefix, has_prefix in mounts[key]:
                    bases = of(parent, depth + 1) if parent in objects else [("", False)]
                    for base, ok in bases:
                        if self.flavor.overrides:
                            mid = prefix if has_prefix else own
                            mid_ok = mid is not None
                        else:
                            mid = (prefix or "") + (own or "")
                            mid_ok = prefix is not None and own is not None
                        full = _join(base, mid or "", self.flavor.overrides) if mid else base
                        item = (full, ok and mid_ok)
                        if item not in result:
                            result.append(item)
                result = result[:_MAX_PREFIXES]
            memo[key] = result
            return result

        return {key: of(key, 0) for key in objects}

    def routes(self) -> Iterable[Route]:
        prefixes = self.prefixes()
        for mod in list(self.modules.values()):
            for decl in mod.decls:
                if decl.target == _ROOT:  # Starlette Route: префикс уже в decl.prefix
                    bases = [(decl.prefix, True)]
                else:
                    key = self.resolve(decl.target)
                    bases = prefixes.get(key, [("", False)]) if key else [("", False)]
                for base, ok in bases:
                    yield Route(
                        method=decl.method, path=_join(base, decl.path, self.flavor.overrides),
                        loc=decl.loc, framework=mod.framework, parser=self.flavor.parser,
                        prefix_unresolved=not ok,
                    )


def parse(
    flavor: Flavor, files: Files, ctx: Context, frameworks: dict[str, str],
) -> Findings:
    """Маршруты фреймворка по файлам пакетов, в зависимостях которых он есть. frameworks —
    зависимость → имя фреймворка в выводе (первая найденная в пакете файла)."""
    found = Findings()
    wanted = frozenset(frameworks)
    if not codebase.stack_present(files, ctx, codebase.PYTHON, wanted):
        return found
    found.applied.add(flavor.parser)
    col = _Collector(flavor, files, found)
    for rel, text in codebase.sources(
        files, ctx, codebase.PYTHON, wanted, flavor.needles, flavor.decorator,
    ):
        tree = pyast.parse(text)
        if tree is None:
            continue
        deps = {d.lower() for d in codebase.deps_of(files, ctx, rel, codebase.PYTHON)}
        framework = next((name for dep, name in frameworks.items() if dep in deps), "")
        col.collect(rel, tree, framework)
    seen: set[tuple[str, str, Loc, bool]] = set()
    for route in col.routes():
        key = (route.method, route.path, route.loc, route.prefix_unresolved)
        if key not in seen:
            seen.add(key)
            found.routes.append(route)
    return found
