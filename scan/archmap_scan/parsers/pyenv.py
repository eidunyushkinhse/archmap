"""Параметры конфигурации в коде Python (ТЗ §6.2): os.getenv("X", дефолт),
os.environ["X"], os.environ.get("X", дефолт), классы BaseSettings
(поле в верхнем регистре с env_prefix, дефолт присваиванием, Field(default=, alias=,
validation_alias=, env=)), decouple.config("X", default=, cast=), django-environ
(env = environ.Env(X=(bool, False)), env("X"), env.bool("X", default=)).

required ставится чтению, которое без значения не обходится: os.environ["X"], поле
BaseSettings без дефолта, config и env без default. Тип — по явному приведению или
аннотации поля, иначе по дефолту. Дефолт — текст литерала; пишется ли он, решает сборка
по правилу секретов. Имя не строкой уходит в hints.dynamic_names. os.environ.setdefault
не чтение, а запись значения по умолчанию для процесса (ТЗ §13.1): ни параметр, ни подсказка.

Обёртки чтения (ТЗ §15 п. 14 Е2: get_from_env PostHog, 867 вызовов): функция уровня модуля,
тело которой читает os.getenv, os.environ.get или os.environ[…] по первому параметру, —
обёртка. Её вызов с литералом даёт параметр; дефолт — второй позиционный аргумент или
именованный, если второй параметр обёртки со словом default или fallback в имени; тип по
type_cast= (int, float, str, bool, str_to_bool) или по дефолту. Вызов сопоставляется с
определением тем же путём, что голое имя реестра каналов (pyregistry, ч. 2 В1): своё имя
файла или импорт «from m import f» и «m.f» через codebase.resolve_module, с одним шагом
реэкспорта «from x import f» в модуле-посреднике. Имя идентификатором (константа модуля
этого файла или импортированная) раскрывается строковым литералом её присваивания на
уровне модуля, место присваивания идёт в основания; иначе подсказка. Чтение по параметру
внутри самой обёртки подсказкой не считается.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field

from archmap_scan import codebase, pyast, pycode, secrets, texts
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Hint, Loc
from archmap_scan.pyregistry import name_words
from archmap_scan.walk import Files

NAME = "python-env"
# Подстроки для отбора файлов: «environ» без точки или скобки встречается в слове
# «environment» почти в каждом файле, поэтому ищется обращение к нему.
_NEEDLES = ("getenv", "environ.", "environ[", "BaseSettings", "decouple")
# Последние имена вызовов, среди которых бывают чтения параметров: остальные вызовы не
# разбираются дальше (так быстрее на больших репозиториях).
_CALL_NAMES = frozenset({"getenv", "get", "config", *(
    "str bool int float list tuple dict json url db_url db cache_url cache email_url email "
    "search_url path decimal"
).split()})
_GETTERS = frozenset({"os.getenv", "os.environ.get"})
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,199}")
_CAST_TYPES = {"bool": "bool", "int": "int", "str": "string", "timedelta": "duration"}
# Методы django-environ → тип значения.
_ENV_METHODS = {
    "str": "string", "bool": "bool", "int": "int", "float": None, "list": None, "tuple": None,
    "dict": None, "json": None, "url": "string", "db_url": "string", "db": "string",
    "cache_url": "string", "cache": "string", "email_url": "string", "email": "string",
    "search_url": "string", "path": "string", "decimal": None,
}


# Приведение type_cast= обёртки → тип параметра.
_TYPE_CASTS = {
    "int": "int", "float": "float", "str": "string", "bool": "bool", "str_to_bool": "bool",
}
_DEFAULT_WORDS = frozenset({"default", "fallback"})
_MAX_REEXPORT = 3


@dataclass(frozen=True)
class _Wrapper:
    """Обёртка чтения: имя второго параметра, если он дефолт (иначе None)."""

    name: str
    default: str | None


@dataclass
class _Repo:
    """Обёртки и строковые константы модулей репозитория по файлам."""

    files: Files
    wrappers: dict[str, dict[str, _Wrapper]] = field(default_factory=dict)
    imports: dict[str, dict[str, pycode.Imported]] = field(default_factory=dict)
    consts: dict[str, dict[str, tuple[str, int]]] = field(default_factory=dict)

    def constants(self, rel: str, tree: ast.Module | None = None) -> dict[str, tuple[str, int]]:
        """Строковые присваивания уровня модуля файла rel: имя → (литерал, строка)."""
        if rel in self.consts:
            return self.consts[rel]
        if tree is None:
            text = self.files.read(rel, keep=False)
            tree = pyast.parse(text) if text is not None else None
        out: dict[str, tuple[str, int]] = {}
        for stmt in tree.body if tree is not None else []:
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
                target, value = stmt.targets[0], stmt.value
            elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
                target, value = stmt.target, stmt.value
            else:
                continue
            text_value = pycode.string(value)
            if isinstance(target, ast.Name) and text_value is not None:
                out.setdefault(target.id, (text_value, stmt.lineno))
        self.consts[rel] = out
        return out

    def imports_of(self, rel: str) -> dict[str, pycode.Imported]:
        """Импорты модуля-посредника (читается по первой нужде)."""
        if rel not in self.imports:
            text = self.files.read(rel, keep=False)
            tree = pyast.parse(text) if text is not None else None
            self.imports[rel] = pycode.imports(tree) if tree is not None else {}
            if tree is not None and rel not in self.consts:
                self.constants(rel, tree)
        return self.imports[rel]

    def module_of(
        self, rel: str, imps: dict[str, pycode.Imported], node: ast.AST,
    ) -> tuple[str | None, str]:
        """(файл модуля, имя в нём) для голого имени или «модуль.имя» вызова и аргумента:
        своё имя файла — (rel, имя); импорт — файл модуля репозитория или None."""
        if isinstance(node, ast.Name):
            imp = imps.get(node.id)
            if imp is None:
                return rel, node.id
            if not imp.attr:
                return None, node.id
            return codebase.resolve_module(self.files, rel, imp.module, imp.level), imp.attr
        full = pycode.qualname(node, imps)
        if full is None:
            return None, ""
        level = len(full) - len(full.lstrip("."))
        module, _, attr = full[level:].rpartition(".")
        if not module or not attr:
            return None, attr
        return codebase.resolve_module(self.files, rel, module, level), attr

    def wrapper(self, rel: str, imps: dict[str, pycode.Imported], func: ast.AST) -> _Wrapper | None:
        """Обёртка, которую зовёт вызов func в файле rel, с одним шагом реэкспорта."""
        target, attr = self.module_of(rel, imps, func)
        for _ in range(_MAX_REEXPORT):
            if target is None:
                return None
            own = self.wrappers.get(target, {})
            if attr in own:
                return own[attr]
            imp = self.imports_of(target).get(attr)
            if imp is None or not imp.attr:
                return None
            target, attr = (
                codebase.resolve_module(self.files, target, imp.module, imp.level), imp.attr,
            )
        return None

    def constant(
        self, rel: str, tree: ast.Module, imps: dict[str, pycode.Imported], node: ast.AST,
    ) -> tuple[str, Loc] | None:
        """Литерал константы, которой задано имя параметра, и место её присваивания."""
        if not isinstance(node, (ast.Name, ast.Attribute)):
            return None
        target, attr = self.module_of(rel, imps, node)
        if target is None:
            return None
        hit = self.constants(target, tree if target == rel else None).get(attr)
        return (hit[0], Loc(target, hit[1])) if hit is not None else None


class _File:
    def __init__(self, rel: str, tree: ast.Module, found: Findings, repo: _Repo) -> None:
        self.rel = rel
        self.tree = tree
        self.found = found
        self.repo = repo
        self.imps = pycode.imports(tree)
        self.skip: set[int] = set()  # чтения по параметру внутри обёрток этого файла
        self.const_loc: Loc | None = None  # место константы последнего имени из name()

    def name(self, node: ast.AST | None, at: ast.AST) -> str | None:
        """Имя параметра литералом или константой; иначе подсказка о динамическом имени."""
        self.const_loc = None
        value = pycode.string(node)
        if value is None and node is not None:
            hit = self.repo.constant(self.rel, self.tree, self.imps, node)
            if hit is not None:
                value, self.const_loc = hit
        if value is None:
            if node is not None:
                self.found.hints.append(Hint("dynamic_names", {
                    "kind": "config", "name": pycode.short(node),
                    "reason": pycode.dynamic_reason(node, texts.REASON_DYNAMIC_PARAM),
                    "source": str(Loc(self.rel, getattr(at, "lineno", 1))),
                }))
            return None
        return value if _VAR.fullmatch(value) else None

    def add(
        self, name: str, at: ast.AST, default: ast.AST | None, *, required: bool = False,
        type_: str | None = None,
    ) -> None:
        has, text = pycode.literal_default(default)
        self.found.code_params.append(CodeParam(
            name=name, loc=Loc(self.rel, getattr(at, "lineno", 1)), parser=NAME, default=text,
            has_default=has, required=True if required and not has else None,
            type=type_ or secrets.value_type(text),
            extra_locs=[self.const_loc] if self.const_loc is not None else [],
        ))


def _cast(node: ast.AST | None) -> str | None:
    return _CAST_TYPES.get(node.id) if isinstance(node, ast.Name) else None


def _env_instances(f: _File) -> set[str]:
    """Имена экземпляров django-environ и параметры из их схемы Env(X=(bool, False))."""
    names: set[str] = set()
    for node in ast.walk(f.tree):
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
            continue
        if pycode.qualname(node.value.func, f.imps) != "environ.Env":
            continue
        names |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        for kw in node.value.keywords:
            if not kw.arg or not _VAR.fullmatch(kw.arg):
                continue
            scheme = kw.value
            if isinstance(scheme, ast.Tuple) and scheme.elts:
                default = scheme.elts[1] if len(scheme.elts) > 1 else None
                f.add(kw.arg, kw.value, default, type_=_cast(scheme.elts[0]))
            else:
                f.add(kw.arg, kw.value, None, type_=_cast(scheme))
    return names


def _call(f: _File, call: ast.Call, envs: set[str]) -> None:
    last = pyast.last_name(call)
    if last not in _CALL_NAMES and last not in envs:
        return
    if id(call) in f.skip:
        return
    qual = pycode.qualname(call.func, f.imps)
    if qual in _GETTERS:
        name = f.name(pycode.arg(call, 0, "key"), call)
        if name:
            f.add(name, call, pycode.arg(call, 1, "default"))
        return
    if qual == "decouple.config":
        name = f.name(pycode.arg(call, 0, "option"), call)
        if name:
            default = pycode.arg(call, 1, "default")
            f.add(name, call, default, required=default is None,
                  type_=_cast(pycode.kwarg(call, "cast")))
        return
    func = call.func
    if isinstance(func, ast.Name) and func.id in envs:
        method: str | None = "str"
    elif (
        isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name)
        and func.value.id in envs and func.attr in _ENV_METHODS
    ):
        method = func.attr
    else:
        return
    name = f.name(pycode.arg(call, 0, "var"), call)
    if name:
        default = pycode.arg(call, 1, "default")
        f.add(name, call, default, required=default is None, type_=_ENV_METHODS.get(method or ""))


def _settings_classes(f: _File) -> list[tuple[ast.ClassDef, str]]:
    """Классы BaseSettings и их наследники в этом файле с env_prefix: свой или
    унаследованный от класса-родителя в том же файле."""
    classes = {n.name: n for n in ast.walk(f.tree) if isinstance(n, ast.ClassDef)}
    prefix: dict[str, str] = {}
    changed = True
    while changed:
        changed = False
        for name, cls in classes.items():
            if name in prefix:
                continue
            for base in cls.bases:
                last = (pycode.dotted(base) or "").rsplit(".", 1)[-1]
                if last == "BaseSettings" or last in prefix:
                    own = _prefix(cls)
                    prefix[name] = own if own is not None else prefix.get(last, "")
                    changed = True
                    break
    return [(classes[n], prefix[n]) for n in sorted(prefix)]


def _prefix(cls: ast.ClassDef) -> str | None:
    """env_prefix класса: model_config = SettingsConfigDict(env_prefix=…) или словарь,
    либо вложенный class Config: env_prefix = …; None — класс его не задаёт."""
    for stmt in cls.body:
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and stmt.value is not None:
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            if not any(isinstance(t, ast.Name) and t.id == "model_config" for t in targets):
                continue
            value = stmt.value
            if isinstance(value, ast.Call):
                return pycode.string(pycode.kwarg(value, "env_prefix")) or ""
            if isinstance(value, ast.Dict):
                for key, item in zip(value.keys, value.values, strict=False):
                    if pycode.string(key) == "env_prefix":
                        return pycode.string(item) or ""
        if isinstance(stmt, ast.ClassDef) and stmt.name == "Config":
            for inner in stmt.body:
                if isinstance(inner, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "env_prefix" for t in inner.targets
                ):
                    return pycode.string(inner.value) or ""
    return None


def _field(f: _File, stmt: ast.AnnAssign, prefix: str) -> None:
    assert isinstance(stmt.target, ast.Name)
    field = stmt.target.id
    if field.startswith("_") or field == "model_config":
        return
    if "ClassVar" in (pycode.dotted(stmt.annotation) or pycode.short(stmt.annotation)):
        return
    type_ = _cast(stmt.annotation)
    name = (prefix + field).upper()
    value = stmt.value
    if value is None:
        f.add(name, stmt, None, required=True, type_=type_)
        return
    if isinstance(value, ast.Call) and pyast.last_name(value) == "Field":
        for key in ("alias", "validation_alias", "env"):
            alias = pycode.string(pycode.kwarg(value, key))
            if alias and _VAR.fullmatch(alias):
                name = alias
                break
        default = pycode.arg(value, 0, "default")
        if default is None:
            # default_factory: дефолт есть, но вычисляется, текста у него нет.
            default = pycode.kwarg(value, "default_factory")
        f.add(name, stmt, default, required=True, type_=type_)
        return
    f.add(name, stmt, value, type_=type_)


def _reads(f: _File, func: ast.FunctionDef | ast.AsyncFunctionDef, param: str) -> list[ast.AST]:
    """Чтения окружения по параметру param в теле функции: os.getenv(param),
    os.environ.get(param), os.environ[param]."""
    out: list[ast.AST] = []
    for node in ast.walk(func):
        if isinstance(node, ast.Call) and pycode.qualname(node.func, f.imps) in _GETTERS:
            arg = pycode.arg(node, 0, "key")
            if isinstance(arg, ast.Name) and arg.id == param:
                out.append(node)
        elif isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Name):
            if node.slice.id == param and pycode.qualname(node.value, f.imps) == "os.environ":
                out.append(node)
    return out


def _wrappers(f: _File) -> dict[str, _Wrapper]:
    """Обёртки чтения файла: функции уровня модуля, читающие окружение по первому параметру."""
    out: dict[str, _Wrapper] = {}
    for stmt in f.tree.body:
        if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        params = [a.arg for a in (*stmt.args.posonlyargs, *stmt.args.args)]
        if not params:
            continue
        reads = _reads(f, stmt, params[0])
        if not reads:
            continue
        f.skip.update(id(node) for node in reads)
        second = params[1] if len(params) > 1 else None
        default = second if second and _DEFAULT_WORDS & set(name_words(second)) else None
        out.setdefault(stmt.name, _Wrapper(stmt.name, default))
    return out


def _wrapper_call(f: _File, call: ast.Call) -> None:
    """Вызов обёртки: литерал или константа — параметр, выражение — подсказка."""
    if not isinstance(call.func, (ast.Name, ast.Attribute)) or id(call) in f.skip:
        return
    wrapper = f.repo.wrapper(f.rel, f.imps, call.func)
    if wrapper is None:
        return
    first = call.args[0] if call.args and not isinstance(call.args[0], ast.Starred) else None
    name = f.name(first, call)
    if not name:
        return
    default = pycode.arg(call, 1, wrapper.default) if wrapper.default else None
    cast = pycode.kwarg(call, "type_cast")
    type_ = _TYPE_CASTS.get(cast.id) if isinstance(cast, ast.Name) else None
    f.add(name, call, default, type_=type_)


def _scan(f: _File) -> None:
    envs = _env_instances(f)
    for node in ast.walk(f.tree):
        if isinstance(node, ast.Call):
            _call(f, node, envs)
        elif isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load):
            if id(node) in f.skip:
                continue
            if pycode.qualname(node.value, f.imps) == "os.environ":
                name = f.name(node.slice, node)
                if name:
                    f.add(name, node, None, required=True)
    for cls, prefix in _settings_classes(f):
        for stmt in cls.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                _field(f, stmt, prefix)


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.PYTHON):
        return found
    found.applied.add(NAME)
    repo = _Repo(files)
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, None, _NEEDLES):
        tree = pyast.parse(text)
        if tree is None:
            continue
        f = _File(rel, tree, found, repo)
        own = _wrappers(f)
        if own:
            repo.wrappers[rel] = own
        _scan(f)
    if not repo.wrappers:
        return found
    # Второй проход: файлы с вызовами обёрток. Импорты модулей-посредников реэкспорта
    # («from posthog.settings import get_from_env») читаются по первой нужде.
    needles = tuple(sorted({w.name + "(" for own in repo.wrappers.values() for w in own.values()}))
    names = {w.name for own in repo.wrappers.values() for w in own.values()}
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, None, needles):
        tree = pyast.parse(text)
        if tree is None:
            continue
        f = _File(rel, tree, found, repo)
        repo.imports.setdefault(rel, f.imps)
        if rel in repo.wrappers:
            _wrappers(f)  # чтения по параметру внутри обёрток — не вызовы
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and pyast.last_name(node) in names:
                _wrapper_call(f, node)
    return found
