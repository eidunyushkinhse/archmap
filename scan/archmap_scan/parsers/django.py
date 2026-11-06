"""Миграции Django (ТЗ §6.3): файлы <приложение>/migrations/<номер>_<имя>.py.

Порядок по dependencies внутри приложения и между приложениями (зависимости от приложений
вне репозитория не учитываются; squash-миграция с replaces заменяет перечисленные);
цикл или ссылка на неизвестную миграцию известного приложения — ошибка семьи. Состояние
моделей ведётся по операциям; таблица — db_table или app_label + "_" + имя модели в нижнем
регистре; внешний ключ даёт колонку <поле>_id со ссылкой на таблицу.ключ цели. RunPython —
миграция данных: структуры не меняет и считается отдельно (data_migrations), а не
пропуском. RunSQL с литеральным SQL разбирает SQL-разборщик (таблицы, созданные им,
добавляются к таблицам приложения); RunSQL без литерала и незнакомые операции считаются
пропущенными. Ничего не исполняется и не импортируется: только ast и литералы.
"""

from __future__ import annotations

import ast
import heapq
from dataclasses import dataclass, field

from archmap_scan import dialect, paths, pyast, sqlddl, texts
from archmap_scan.context import Context
from archmap_scan.model import Column, Findings, Loc, Table, TableSet, unparsed_hint
from archmap_scan.walk import Files

NAME = "django"

# Модель пользователя Django по умолчанию, если настройки её не переопределяют.
DEFAULT_USER_MODEL = "auth.User"

# Операции, которые колонок таблиц не меняют: пропускаются без счётчика.
_NOOP = frozenset({
    "AddIndex", "RemoveIndex", "RenameIndex", "AddConstraint", "RemoveConstraint",
    "AlterUniqueTogether", "AlterIndexTogether", "AlterModelOptions", "AlterModelManagers",
    "AlterModelTableComment", "AlterConstraint", "CreateExtension", "HStoreExtension",
    "TrigramExtension", "BtreeGinExtension", "BtreeGistExtension", "UnaccentExtension",
    "CryptoExtension", "CITextExtension", "BloomExtension", "AddIndexConcurrently",
    "RemoveIndexConcurrently", "CreateCollation", "RemoveCollation", "AddConstraintNotValid",
    "ValidateConstraint",
})

# Поля Django → тип колонки как в DDL PostgreSQL. Своё поле проекта ищется по окончанию
# имени класса (BoundedBigIntegerField → bigint), самое длинное окончание выигрывает.
_TYPES: tuple[tuple[str, str], ...] = tuple(sorted((
    ("BigAutoField", "bigserial"), ("SmallAutoField", "smallserial"), ("AutoField", "serial"),
    ("PositiveBigIntegerField", "bigint"), ("PositiveSmallIntegerField", "smallint"),
    ("PositiveIntegerField", "integer"), ("BigIntegerField", "bigint"),
    ("SmallIntegerField", "smallint"), ("IntegerField", "integer"),
    ("BooleanField", "boolean"), ("NullBooleanField", "boolean"),
    ("DateTimeField", "timestamp with time zone"), ("DateField", "date"),
    ("TimeField", "time"), ("DurationField", "interval"), ("FloatField", "double precision"),
    ("DecimalField", "numeric"), ("UUIDField", "uuid"), ("JSONField", "jsonb"),
    ("TextField", "text"), ("CharField", "varchar"), ("EmailField", "varchar"),
    ("URLField", "varchar"), ("SlugField", "varchar"), ("FileField", "varchar"),
    ("ImageField", "varchar"), ("FilePathField", "varchar"), ("BinaryField", "bytea"),
    ("GenericIPAddressField", "inet"), ("IPAddressField", "inet"), ("HStoreField", "hstore"),
    ("CICharField", "citext"), ("CIEmailField", "citext"), ("CITextField", "citext"),
    ("SearchVectorField", "tsvector"),
), key=lambda kv: -len(kv[0])))
# Длина по умолчанию у строковых полей Django без max_length.
_DEFAULT_LENGTH = {
    "EmailField": 254, "URLField": 200, "SlugField": 50, "FileField": 100,
    "ImageField": 100, "FilePathField": 100,
}
# Тип колонки внешнего ключа по типу первичного ключа цели.
_FK_TYPE = {"serial": "integer", "bigserial": "bigint", "smallserial": "smallint"}
# Классы внешних ключей. HybridCloudForeignKey из Sentry, несмотря на имя, обычное число
# без связи с таблицей, и колонка у него называется как поле.
_FK_CLASSES = frozenset({"ForeignKey", "OneToOneField", "ParentalKey", "TreeForeignKey",
                         "TreeOneToOneField"})
_NOT_FK = {"HybridCloudForeignKey": "bigint"}
# Операции, которые понимает разборщик. Своя операция проекта с таким окончанием имени
# (SafeDeleteModel, SafeRemoveField) читается как операция Django.
_KNOWN = ("CreateModel", "DeleteModel", "RenameModel", "AlterModelTable", "AddField",
          "RemoveField", "AlterField", "RenameField", "AlterOrderWithRespectTo",
          "SeparateDatabaseAndState")
_M2M = ("ManyToManyField", "ParentalManyToManyField", "TreeManyToManyField")


# Миграция или модель: (метка приложения, имя).
_Key = tuple[str, str]


@dataclass
class _Field:
    name: str
    column: str
    explicit_column: bool
    type: str | None
    pk: bool
    required: bool
    target: tuple[str, str] | None  # (приложение, модель в нижнем регистре)
    locs: list[Loc]


@dataclass
class _Model:
    app: str
    name: str
    db_table: str | None
    managed: bool
    fields: list[_Field]
    locs: list[Loc]

    @property
    def table(self) -> str:
        return self.db_table or f"{self.app}_{self.name.lower()}"

    def get(self, name: str) -> _Field | None:
        return next((f for f in self.fields if f.name == name), None)


@dataclass
class _Migration:
    app: str
    name: str
    path: str
    deps: list[tuple[str, str]]
    run_before: list[tuple[str, str]]
    replaces: list[tuple[str, str]]
    operations: ast.expr | None
    line: int


@dataclass
class _AppStats:
    dropped: int = 0
    skipped: int = 0
    data_migrations: int = 0
    examples: list[tuple[Loc, str]] = field(default_factory=list)
    # Таблицы из RunSQL с литеральным SQL: их ведёт SQL-разборщик (sqlddl).
    sql: sqlddl.Schema = field(default_factory=sqlddl.Schema)

    def skip(self, loc: Loc, text: str) -> None:
        self.skipped += 1
        if len(self.examples) < 3:
            self.examples.append((loc, text))


@dataclass
class _State:
    user_model: tuple[str, str]
    models: dict[tuple[str, str], _Model] = field(default_factory=dict)
    stats: dict[str, _AppStats] = field(default_factory=dict)

    def app_stats(self, app: str) -> _AppStats:
        return self.stats.setdefault(app, _AppStats())


def is_migration(rel: str) -> bool:
    folder = paths.parent(rel)
    base = paths.name(rel)
    return (paths.name(folder) == "migrations" and base.endswith(".py")
            and base[:1].isdigit())


def _model_ref(text: str, app: str) -> tuple[str, str] | None:
    """«zerver.Realm» → (zerver, realm); «Realm» — то же приложение."""
    if not text or text == "self":
        return None
    if "." in text:
        target_app, _, model = text.rpartition(".")
        return (target_app, model.lower())
    return (app, text.lower())


def _target(call: ast.Call, app: str, model: str, state: _State) -> tuple[str, str] | None:
    kw = pyast.kwargs(call)
    node = kw.get("to", call.args[0] if call.args else None)
    if isinstance(node, ast.Attribute) and node.attr == "AUTH_USER_MODEL":
        return state.user_model
    text = pyast.value(node)
    if text == "self":
        return (app, model.lower())
    return _model_ref(text, app) if isinstance(text, str) else None


def column_type(call: ast.Call) -> str | None:
    """Тип колонки по классу поля: CharField(max_length=40) → varchar(40)."""
    cls = pyast.last_name(call) or ""
    kw = pyast.kwargs(call)
    if cls == "ArrayField":
        base = kw.get("base_field", call.args[0] if call.args else None)
        inner = column_type(base) if isinstance(base, ast.Call) else None
        return f"{inner}[]" if inner else "array"
    base_type = next((sql for suffix, sql in _TYPES if cls.endswith(suffix)), None)
    if base_type is None:
        return cls or None
    if base_type == "varchar":
        length = pyast.value(kw.get("max_length"))
        if not isinstance(length, int):
            length = next((n for suffix, n in _DEFAULT_LENGTH.items() if cls.endswith(suffix)), None)
        return f"varchar({length})" if isinstance(length, int) else "varchar"
    if base_type == "numeric":
        digits = pyast.value(kw.get("max_digits"))
        places = pyast.value(kw.get("decimal_places"))
        if isinstance(digits, int) and isinstance(places, int):
            return f"numeric({digits}, {places})"
    return base_type


def _field(
    name: str, call: ast.Call, app: str, model: str, state: _State, loc: Loc,
) -> _Field | None:
    """Колонка поля или None (ManyToMany: колонки у модели нет)."""
    cls = pyast.last_name(call) or ""
    if cls.endswith(_M2M):
        return None
    kw = pyast.kwargs(call)
    is_fk = cls not in _NOT_FK and (cls in _FK_CLASSES or cls.endswith("ForeignKey"))
    db_column = pyast.value(kw.get("db_column"))
    explicit = isinstance(db_column, str)
    column = db_column if isinstance(db_column, str) else (f"{name}_id" if is_fk else name)
    pk = pyast.value(kw.get("primary_key")) is True
    null = pyast.value(kw.get("null")) is True
    col_type = None if is_fk else _NOT_FK.get(cls) or column_type(call)
    return _Field(
        name=name, column=column, explicit_column=explicit,
        type=col_type, pk=pk, required=pk or not null,
        target=_target(call, app, model, state) if is_fk else None, locs=[loc],
    )


def _fields(node: ast.expr | None, app: str, model: str, state: _State, path: str) -> list[_Field]:
    out: list[_Field] = []
    if not isinstance(node, (ast.List, ast.Tuple)):
        return out
    for item in node.elts:
        if not (isinstance(item, ast.Tuple) and len(item.elts) == 2):
            continue
        name = pyast.value(item.elts[0])
        call = item.elts[1]
        if not (isinstance(name, str) and isinstance(call, ast.Call)):
            continue
        made = _field(name, call, app, model, state, Loc(path, item.lineno))
        if made is not None and all(f.name != made.name for f in out):
            out.append(made)
    return out


def _options(node: ast.expr | None) -> dict[str, object]:
    if not isinstance(node, ast.Dict):
        return {}
    out: dict[str, object] = {}
    for key, value in zip(node.keys, node.values, strict=False):
        name = pyast.value(key)
        if isinstance(name, str):
            out[name] = pyast.value(value, default=_Unknown)
    return out


class _Unknown:
    """Значение опции не литерал."""


def _arg(call: ast.Call, name: str, pos: int) -> ast.expr | None:
    kw = pyast.kwargs(call)
    if name in kw:
        return kw[name]
    return call.args[pos] if len(call.args) > pos else None


def _str_arg(call: ast.Call, name: str, pos: int) -> str | None:
    found = pyast.value(_arg(call, name, pos))
    return found if isinstance(found, str) else None


def _create_model(call: ast.Call, app: str, state: _State, loc: Loc) -> bool:
    name = _str_arg(call, "name", 0)
    if name is None:
        return False
    options = _options(_arg(call, "options", 2))
    if options.get("proxy") is True:
        return True
    db_table = options.get("db_table")
    model = _Model(
        app=app, name=name, db_table=db_table if isinstance(db_table, str) else None,
        managed=options.get("managed") is not False,
        fields=_fields(_arg(call, "fields", 1), app, name, state, loc.path), locs=[loc],
    )
    state.models[(app, name.lower())] = model
    return True


def _rename_model(call: ast.Call, app: str, state: _State, loc: Loc) -> bool:
    old = _str_arg(call, "old_name", 0)
    new = _str_arg(call, "new_name", 1)
    if old is None or new is None:
        return False
    model = state.models.pop((app, old.lower()), None)
    if model is None:
        return True
    model.name = new
    model.locs.append(loc)
    state.models[(app, new.lower())] = model
    for other in state.models.values():
        for f in other.fields:
            if f.target == (app, old.lower()):
                f.target = (app, new.lower())
    return True


def _field_op(kind: str, call: ast.Call, app: str, state: _State, loc: Loc) -> bool:
    model_name = _str_arg(call, "model_name", 0)
    if model_name is None:
        return False
    model = state.models.get((app, model_name.lower()))
    if kind == "RenameField":
        old = _str_arg(call, "old_name", 1)
        new = _str_arg(call, "new_name", 2)
        if old is None or new is None:
            return False
        target = model.get(old) if model else None
        if target is not None:
            if not target.explicit_column:
                target.column = f"{new}_id" if target.column == f"{old}_id" else new
            target.name = new
            target.locs.append(loc)
        return True
    name = _str_arg(call, "name", 1)
    if name is None:
        return False
    if kind == "RemoveField":
        if model is not None:
            model.fields = [f for f in model.fields if f.name != name]
        return True
    node = _arg(call, "field", 2)
    if not isinstance(node, ast.Call):
        return False
    if model is None:
        return True
    made = _field(name, node, app, model.name, state, loc)
    old_field = model.get(name)
    if kind == "AddField":
        if made is not None and old_field is None:
            model.fields.append(made)
        return True
    # AlterField: новое определение на месте старого.
    if old_field is not None:
        index = model.fields.index(old_field)
        if made is None:
            del model.fields[index]
        else:
            made.locs = old_field.locs + [loc]
            model.fields[index] = made
    elif made is not None:
        model.fields.append(made)
    return True


def _operation(call: ast.Call, app: str, state: _State, loc: Loc) -> bool:
    """Одна операция; False — не понята (считается пропущенной)."""
    kind = pyast.last_name(call) or ""
    if kind in _NOOP:
        return True
    kind = next((known for known in _KNOWN if kind.endswith(known)), kind)
    if kind == "CreateModel":
        return _create_model(call, app, state, loc)
    if kind == "DeleteModel":
        name = _str_arg(call, "name", 0)
        if name is None:
            return False
        gone = state.models.pop((app, name.lower()), None)
        if gone is not None and gone.managed:
            state.app_stats(app).dropped += 1
        return True
    if kind == "RenameModel":
        return _rename_model(call, app, state, loc)
    if kind == "AlterModelTable":
        name = _str_arg(call, "name", 0)
        if name is None:
            return False
        model = state.models.get((app, name.lower()))
        table = pyast.value(_arg(call, "table", 1), default=_Unknown)
        if table is _Unknown:
            return False
        if model is not None:
            model.db_table = table if isinstance(table, str) else None
            model.locs.append(loc)
        return True
    if kind in ("AddField", "RemoveField", "AlterField", "RenameField"):
        return _field_op(kind, call, app, state, loc)
    if kind == "AlterOrderWithRespectTo":
        name = _str_arg(call, "name", 0)
        model = state.models.get((app, name.lower())) if name else None
        if model is not None and model.get("_order") is None:
            model.fields.append(_Field("_order", "_order", True, "integer", False, True, None,
                                       [loc]))
        return name is not None
    if kind.endswith("RunPython"):
        state.app_stats(app).data_migrations += 1
        return True
    if kind.endswith("RunSQL"):
        return _run_sql(call, app, state, loc)
    if kind == "SeparateDatabaseAndState":
        # База меняется только database_operations; state_operations — модель Django.
        ops = _arg(call, "database_operations", 0)
        _apply(ops, app, state, loc.path)
        return True
    return False


def _run_sql(call: ast.Call, app: str, state: _State, loc: Loc) -> bool:
    """RunSQL("…") и RunSQL(["…", ("…", params)]): литеральный SQL — SQL-разборщику, как
    op.execute у Alembic. Нелитеральный — пропуск с подсказкой."""
    node = _arg(call, "sql", 0)
    if node is None:
        return False
    items = node.elts if isinstance(node, (ast.List, ast.Tuple)) else [node]
    sql: list[tuple[str, int]] = []
    for item in items:
        if isinstance(item, ast.Tuple) and item.elts:
            item = item.elts[0]
        text = pyast.value(item)
        if not isinstance(text, str):
            return False
        sql.append((text, item.lineno))
    schema = state.app_stats(app).sql
    for text, line in sql:
        sqlddl.apply_text(text, loc.path, schema, line_offset=line - 1)
    return True


def _apply(ops: ast.expr | None, app: str, state: _State, path: str) -> None:
    if ops is None:
        return
    if not isinstance(ops, (ast.List, ast.Tuple)):
        state.app_stats(app).skip(Loc(path, ops.lineno), "operations")
        return
    for item in ops.elts:
        loc = Loc(path, item.lineno)
        if not isinstance(item, ast.Call):
            state.app_stats(app).skip(loc, "operations")
            continue
        if not _operation(item, app, state, loc):
            state.app_stats(app).skip(loc, pyast.last_name(item) or "operation")


def _pairs(node: ast.expr | None, state: _State) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if not isinstance(node, (ast.List, ast.Tuple)):
        return out
    for item in node.elts:
        if isinstance(item, ast.Call) and pyast.last_name(item) == "swappable_dependency":
            out.append((state.user_model[0], "__first__"))
            continue
        pair = pyast.value(item)
        if isinstance(pair, list) and len(pair) == 2 and all(isinstance(x, str) for x in pair):
            out.append((pair[0], pair[1]))
    return out


def _migration(rel: str, app: str, tree: ast.Module, state: _State) -> _Migration | None:
    cls = next((s for s in tree.body if isinstance(s, ast.ClassDef) and s.name == "Migration"),
               None)
    if cls is None:
        return None
    attrs: dict[str, ast.expr] = {}
    for stmt in cls.body:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    attrs[target.id] = stmt.value
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) \
                and stmt.value is not None:
            attrs[stmt.target.id] = stmt.value
    if "operations" not in attrs and "dependencies" not in attrs:
        return None
    return _Migration(
        app=app, name=paths.name(rel)[:-3], path=rel,
        deps=_pairs(attrs.get("dependencies"), state),
        run_before=_pairs(attrs.get("run_before"), state),
        replaces=_pairs(attrs.get("replaces"), state),
        operations=attrs.get("operations"), line=cls.lineno,
    )


def order(migrations: list[_Migration]) -> tuple[list[_Migration], str | None]:
    """Порядок применения: зависимости, squash вместо заменённых, ничьи по (app, имя)."""
    nodes: dict[_Key, _Migration] = {}
    for m in sorted(migrations, key=lambda m: m.path):
        nodes.setdefault((m.app, m.name), m)
    alias: dict[_Key, _Key] = {}
    for key, m in sorted(nodes.items()):
        for replaced in m.replaces:
            if replaced != key:
                alias[replaced] = key
    for replaced in alias:
        nodes.pop(replaced, None)
    apps = {app for app, _ in nodes}

    def resolve(dep: _Key) -> _Key:
        # Цепочка замен конечна: шагов не больше, чем записей в alias (данные бывают циклическими).
        for _ in range(len(alias)):
            if dep not in alias:
                break
            dep = alias[dep]
        return dep

    parents: dict[_Key, set[_Key]] = {key: set() for key in nodes}
    for key, m in nodes.items():
        for dep in m.deps:
            resolved = resolve(dep)
            if resolved[0] not in apps or resolved == key:
                continue
            if resolved[1] in ("__first__", "__latest__"):
                continue
            if resolved not in nodes:
                return [], texts.django_broken(f"{m.app}.{m.name}", f"{dep[0]}.{dep[1]}")
            parents[key].add(resolved)
        for dep in m.run_before:
            resolved = resolve(dep)
            if resolved in nodes and resolved != key:
                parents[resolved].add(key)
    _first_deps(nodes, parents)
    children: dict[_Key, list[_Key]] = {}
    for key, ps in parents.items():
        for p in ps:
            children.setdefault(p, []).append(key)
    pending = {key: len(ps) for key, ps in parents.items()}
    ready = [key for key, n in pending.items() if n == 0]
    heapq.heapify(ready)
    out: list[_Migration] = []
    while ready:
        key = heapq.heappop(ready)
        out.append(nodes[key])
        for child in children.get(key, []):
            pending[child] -= 1
            if pending[child] == 0:
                heapq.heappush(ready, child)
    if len(out) < len(nodes):
        done = {(m.app, m.name) for m in out}
        stuck = sorted(f"{a}.{n}" for a, n in nodes if (a, n) not in done)
        return [], texts.django_cycle(stuck)
    return out, None


def _first_deps(nodes: dict[_Key, _Migration], parents: dict[_Key, set[_Key]]) -> None:
    """Зависимость («app», «__first__») — от первой миграции приложения."""
    firsts: dict[str, _Key] = {}
    for key in sorted(nodes):
        app = key[0]
        if app not in firsts and not any(p[0] == app for p in parents[key]):
            firsts[app] = key
    for key, m in nodes.items():
        for dep in m.deps:
            if dep[1] == "__first__" and dep[0] in firsts and firsts[dep[0]] != key:
                parents[key].add(firsts[dep[0]])


def _label(files: Files, app_dir: str) -> str:
    """Метка приложения: label в apps.py, иначе имя каталога."""
    rel = f"{app_dir}/apps.py" if app_dir else "apps.py"
    text = files.read(rel) if rel in files.paths else None
    tree = pyast.parse(text) if text else None
    for cls in tree.body if tree else []:
        if not isinstance(cls, ast.ClassDef):
            continue
        for stmt in cls.body:
            if isinstance(stmt, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "label" for t in stmt.targets
            ):
                found = pyast.value(stmt.value)
                if isinstance(found, str) and found:
                    return found
    return paths.name(app_dir) or "app"


def _settings_files(files: Files) -> list[str]:
    """Файлы настроек Django: каталог или имя со словом settings, каталог conf."""
    out = []
    for rel in files.paths:
        if not rel.endswith(".py"):
            continue
        parts = rel.lower().split("/")
        if any("settings" in p or p == "conf" for p in parts):
            out.append(rel)
    return out


def _engine(files: Files) -> tuple[str, Loc] | None:
    """Диалект базы по DATABASES[…]["ENGINE"] в настройках (ТЗ §7, пункт 3). SQLite уступает
    другим движкам: обычно это настройки разработки и тестов."""
    found: list[tuple[str, Loc]] = []
    for rel in _settings_files(files):
        text = files.read(rel)
        if text is None or "ENGINE" not in text:
            continue
        hit = dialect.django_engine(text)
        if hit is not None:
            found.append((hit[0], Loc(rel, hit[1])))
    real = [f for f in found if f[0] != dialect.SQLITE]
    best = real or found
    return best[0] if best else None


def _user_model(files: Files) -> tuple[str, str]:
    """AUTH_USER_MODEL из файлов настроек (каталог или имя со словом settings, каталог conf)."""
    for rel in _settings_files(files):
        text = files.read(rel)
        if text is None or "AUTH_USER_MODEL" not in text:
            continue
        tree = pyast.parse(text)
        found = pyast.value(pyast.module_assign(tree, "AUTH_USER_MODEL")) if tree else None
        if isinstance(found, str) and "." in found:
            ref = _model_ref(found, "")
            if ref is not None:
                return ref
    app, _, model = DEFAULT_USER_MODEL.partition(".")
    return (app, model.lower())


def _tables(state: _State, app: str) -> list[Table]:
    out: list[Table] = _model_tables(state, app)
    names = {t.name.lower() for t in out}
    out += [t for t in state.app_stats(app).sql.tables.values() if t.name.lower() not in names]
    return out


def _model_tables(state: _State, app: str) -> list[Table]:
    out: list[Table] = []
    for model in state.models.values():
        if model.app != app or not model.managed:
            continue
        table = Table(name=model.table, locs=list(model.locs))
        for f in model.fields:
            ref = None
            col_type = f.type
            if f.target is not None:
                target = state.models.get(f.target)
                pk = next((x for x in target.fields if x.pk), None) if target else None
                table_name = target.table if target else f"{f.target[0]}_{f.target[1]}"
                ref = f"{table_name}.{pk.column if pk else 'id'}"
                col_type = _FK_TYPE.get(pk.type or "", pk.type) if pk else None
            table.columns.append(Column(
                name=f.column, type=col_type, pk=f.pk, required=f.required, references=ref,
                locs=list(f.locs),
            ))
        out.append(table)
    return out


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    candidates = [rel for rel in files.paths if is_migration(rel)]
    if not candidates:
        return found
    state = _State(user_model=_user_model(files))
    app_dirs: dict[str, str] = {}
    migrations: list[_Migration] = []
    labels: dict[str, str] = {}
    for rel in candidates:
        app_dir = paths.parent(paths.parent(rel))
        if app_dir not in labels:
            labels[app_dir] = _label(files, app_dir)
        app = labels[app_dir]
        text = files.read(rel)
        tree = pyast.parse(text) if text is not None else None
        if tree is None:
            if text is not None:
                found.hints.append(unparsed_hint(rel, texts.REASON_BAD_PYTHON))
            continue
        made = _migration(rel, app, tree, state)
        if made is not None:
            migrations.append(made)
            app_dirs.setdefault(app, app_dir)
    if not migrations:
        return found
    ordered, error = order(migrations)
    if error is not None:
        common = _common_dir(sorted(set(app_dirs.values())))
        found.table_sets.append(TableSet(parser=NAME, dir=common, error=error))
        return found
    for m in ordered:
        _apply(m.operations, m.app, state, m.path)
    engine = _engine(files)
    for app, app_dir in sorted(app_dirs.items()):
        stats = state.app_stats(app)
        tables = _tables(state, app)
        sql = stats.sql
        skipped = stats.skipped + sql.skipped
        examples = (stats.examples + sql.examples)[:3]
        dropped = stats.dropped + sql.dropped
        if not tables and not skipped and not dropped and not stats.data_migrations:
            continue
        found.table_sets.append(TableSet(
            parser=NAME, dir=app_dir, tables=tables, dropped=dropped,
            skipped=skipped, skipped_examples=examples, data_migrations=stats.data_migrations,
            queried=sql.from_query(),
            dialect=engine[0] if engine else None, dialect_loc=engine[1] if engine else None,
        ))
    return found


def _common_dir(dirs: list[str]) -> str:
    if not dirs:
        return ""
    parts = dirs[0].split("/")
    for other in dirs[1:]:
        theirs = other.split("/")
        n = 0
        while n < min(len(parts), len(theirs)) and parts[n] == theirs[n]:
            n += 1
        parts = parts[:n]
    return "/".join(parts)
