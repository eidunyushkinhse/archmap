"""Параметры конфигурации в коде Python (ТЗ §6.2): os.getenv("X", дефолт),
os.environ["X"], os.environ.get("X", дефолт), os.environ.setdefault, классы BaseSettings
(поле в верхнем регистре с env_prefix, дефолт присваиванием, Field(default=, alias=,
validation_alias=, env=)), decouple.config("X", default=, cast=), django-environ
(env = environ.Env(X=(bool, False)), env("X"), env.bool("X", default=)).

required ставится чтению, которое без значения не обходится: os.environ["X"], поле
BaseSettings без дефолта, config и env без default. Тип — по явному приведению или
аннотации поля, иначе по дефолту. Дефолт — текст литерала; пишется ли он, решает сборка
по правилу секретов. Имя не строкой уходит в hints.dynamic_names.
"""

from __future__ import annotations

import ast
import re

from archmap_scan import codebase, pyast, pycode, secrets, texts
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Hint, Loc
from archmap_scan.walk import Files

NAME = "python-env"
# Подстроки для отбора файлов: «environ» без точки или скобки встречается в слове
# «environment» почти в каждом файле, поэтому ищется обращение к нему.
_NEEDLES = ("getenv", "environ.", "environ[", "BaseSettings", "decouple")
# Последние имена вызовов, среди которых бывают чтения параметров: остальные вызовы не
# разбираются дальше (так быстрее на больших репозиториях).
_CALL_NAMES = frozenset({"getenv", "get", "setdefault", "config", *(
    "str bool int float list tuple dict json url db_url db cache_url cache email_url email "
    "search_url path decimal"
).split()})
_GETTERS = frozenset({"os.getenv", "os.environ.get", "os.environ.setdefault"})
_VAR = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,199}")
_CAST_TYPES = {"bool": "bool", "int": "int", "str": "string", "timedelta": "duration"}
# Методы django-environ → тип значения.
_ENV_METHODS = {
    "str": "string", "bool": "bool", "int": "int", "float": None, "list": None, "tuple": None,
    "dict": None, "json": None, "url": "string", "db_url": "string", "db": "string",
    "cache_url": "string", "cache": "string", "email_url": "string", "email": "string",
    "search_url": "string", "path": "string", "decimal": None,
}


class _File:
    def __init__(self, rel: str, tree: ast.Module, found: Findings) -> None:
        self.rel = rel
        self.tree = tree
        self.found = found
        self.imps = pycode.imports(tree)

    def name(self, node: ast.AST | None, at: ast.AST) -> str | None:
        """Имя параметра литералом; не строка — подсказка о динамическом имени."""
        value = pycode.string(node)
        if value is None:
            if node is not None:
                self.found.hints.append(Hint("dynamic_names", {
                    "kind": "config", "name": pycode.short(node),
                    "reason": texts.REASON_DYNAMIC_PARAM,
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


def _scan(f: _File) -> None:
    envs = _env_instances(f)
    for node in ast.walk(f.tree):
        if isinstance(node, ast.Call):
            _call(f, node, envs)
        elif isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Load):
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
    for rel, text in codebase.sources(files, ctx, codebase.PYTHON, None, _NEEDLES):
        tree = pyast.parse(text)
        if tree is not None:
            _scan(_File(rel, tree, found))
    return found
