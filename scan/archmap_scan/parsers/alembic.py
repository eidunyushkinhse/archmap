"""Миграции Alembic (ТЗ §6.3): каталог с env.py и versions/*.py.

Ревизии упорядочиваются по цепочке down_revision (слияние ветвей — ревизией с несколькими
родителями); цикл или ссылка на неизвестную ревизию — ошибка семьи с текстом. Читается
только функция upgrade(): вызовы op.create_table, add_column, drop_column, drop_table,
rename_table, alter_column, create_foreign_key, create_primary_key, batch_alter_table и
op.execute с DDL в строке (её разбирает SQL-разборщик). Остальные вызовы op, которые
меняют колонки непонятным образом или стоят в условиях и циклах, считаются пропущенными.
"""

from __future__ import annotations

import ast
import heapq
from dataclasses import dataclass, field

from archmap_scan import dialect, paths, pyast, sqlddl, texts
from archmap_scan.context import Context
from archmap_scan.model import Column, Findings, Hint, Loc, Table, TableSet
from archmap_scan.walk import Files

NAME = "alembic"

# Вызовы op, которые колонок таблиц не меняют: пропускаются без счётчика.
_NOOP = frozenset({
    "create_index", "drop_index", "create_unique_constraint", "drop_constraint",
    "create_check_constraint", "create_table_comment", "drop_table_comment", "bulk_insert",
    "get_bind", "get_context", "f", "inline_literal", "create_exclude_constraint",
    "invoke", "implementation_for",
})

# Типы SQLAlchemy → запись типа как в DDL.
_TYPES = {
    "string": "varchar", "unicode": "varchar", "varchar": "varchar", "autostring": "varchar",
    "nvarchar": "nvarchar", "char": "char", "text": "text", "unicodetext": "text",
    "integer": "integer", "int": "integer", "biginteger": "bigint", "bigint": "bigint",
    "smallinteger": "smallint", "smallint": "smallint", "boolean": "boolean", "date": "date",
    "time": "time", "interval": "interval", "float": "float", "real": "real",
    "numeric": "numeric", "decimal": "numeric", "uuid": "uuid", "json": "json",
    "jsonb": "jsonb", "largebinary": "bytea", "bytea": "bytea", "inet": "inet",
    "citext": "citext", "datetime": "timestamp", "timestamp": "timestamp",
}


def render_type(node: ast.AST | None) -> str | None:
    """sa.String(length=50) → varchar(50), sa.DateTime(timezone=True) → timestamp with
    time zone, postgresql.ARRAY(sa.Text()) → text[]; незнакомый тип — его имя."""
    if node is None:
        return None
    name = pyast.last_name(node)
    if name is None:
        return None
    low = name.lower()
    call = node if isinstance(node, ast.Call) else None
    args = list(call.args) if call else []
    kw = pyast.kwargs(call) if call else {}
    if low == "array" and args:
        inner = render_type(args[0])
        return f"{inner}[]" if inner else "array"
    if low == "enum":
        enum_name = pyast.value(kw.get("name"))
        return enum_name if isinstance(enum_name, str) else "enum"
    base = _TYPES.get(low, name)
    if low in ("datetime", "timestamp") and pyast.value(kw.get("timezone")) is True:
        return f"{base} with time zone"
    sizes = [pyast.value(a) for a in args[:2]]
    if not sizes or not all(isinstance(x, int) for x in sizes):
        length = pyast.value(kw.get("length"))
        precision = pyast.value(kw.get("precision"))
        scale = pyast.value(kw.get("scale"))
        sizes = [x for x in (length if length is not None else precision, scale)
                 if isinstance(x, int)]
    if sizes and low in ("string", "unicode", "varchar", "nvarchar", "char", "numeric",
                         "decimal", "autostring"):
        return f"{base}({', '.join(str(x) for x in sizes)})"
    return base


def column(call: ast.Call, loc: Loc) -> Column | None:
    """sa.Column("name", sa.Type(), sa.ForeignKey("t.c"), nullable=, primary_key=)."""
    if pyast.last_name(call) != "Column" or not call.args:
        return None
    name = pyast.value(call.args[0])
    if not isinstance(name, str):
        return None
    col = Column(name=name, locs=[loc])
    for arg in call.args[1:]:
        if isinstance(arg, ast.Call) and pyast.last_name(arg) == "ForeignKey":
            target = pyast.value(arg.args[0]) if arg.args else None
            if isinstance(target, str):
                col.references = target
        elif col.type is None:
            col.type = render_type(arg)
    kw = pyast.kwargs(call)
    if col.type is None and "type_" in kw:
        col.type = render_type(kw["type_"])
    col.pk = pyast.value(kw.get("primary_key")) is True
    nullable = pyast.value(kw.get("nullable"), default=True)
    col.required = True if col.pk else nullable is False
    return col


@dataclass
class _Revision:
    path: str
    revision: str
    parents: list[str]
    upgrade: ast.FunctionDef | None


@dataclass
class _State:
    schema: sqlddl.Schema = field(default_factory=sqlddl.Schema)


def _create_table(call: ast.Call, state: _State, loc: Loc) -> bool:
    name = pyast.value(call.args[0]) if call.args else None
    if not isinstance(name, str):
        return False
    kw = pyast.kwargs(call)
    schema = pyast.value(kw.get("schema"))
    table = Table(name=name, schema=schema if isinstance(schema, str) else None)
    names: set[str] = set()
    constraints: list[ast.Call] = []
    for arg in call.args[1:]:
        if not isinstance(arg, ast.Call):
            continue
        col = column(arg, loc)
        if col is not None:
            if col.name not in names:
                names.add(col.name)
                table.columns.append(col)
        else:
            constraints.append(arg)
    state.schema.create(table, loc)
    for con in constraints:
        _constraint(con, table)
    return True


def _constraint(call: ast.Call, table: Table) -> None:
    kind = pyast.last_name(call)
    if kind == "PrimaryKeyConstraint":
        for arg in call.args:
            col = table.column(str(pyast.value(arg, "")))
            if col is not None:
                col.pk, col.required = True, True
    elif kind == "ForeignKeyConstraint" and len(call.args) >= 2:
        local = pyast.value(call.args[0], [])
        remote = pyast.value(call.args[1], [])
        if isinstance(local, list) and isinstance(remote, list):
            for here, there in zip(local, remote, strict=False):
                col = table.column(str(here))
                if col is not None and isinstance(there, str):
                    col.references = there


def _alter_column(table: Table, call: ast.Call, args: list[ast.expr], loc: Loc) -> bool:
    name = pyast.value(args[0]) if args else None
    col = next((c for c in table.columns if c.name == name), None)
    kw = pyast.kwargs(call)
    if col is None:
        return isinstance(name, str)
    new_name = pyast.value(kw.get("new_column_name"))
    if isinstance(new_name, str):
        col.name = new_name
    nullable = pyast.value(kw.get("nullable"), default="keep")
    if nullable is True or nullable is False:
        col.required = not nullable
    if "type_" in kw:
        col.type = render_type(kw["type_"]) or col.type
    col.locs.append(loc)
    return True


def _table_op(op: str, call: ast.Call, args: list[ast.expr], table: Table, loc: Loc) -> bool:
    """Действие над таблицей: add_column, drop_column, alter_column и ключи. args — без
    имени таблицы и имени ограничения."""
    if op == "add_column":
        col = column(args[0], loc) if args and isinstance(args[0], ast.Call) else None
        if col is None:
            return False
        if table.column(col.name) is None:
            table.columns.append(col)
        table.locs.append(loc)
        return True
    if op == "drop_column":
        name = pyast.value(args[0]) if args else None
        if not isinstance(name, str):
            return False
        table.columns = [c for c in table.columns if c.name != name]
        table.locs.append(loc)
        return True
    if op == "alter_column":
        return _alter_column(table, call, args, loc)
    if op == "create_foreign_key":
        # (referent, local_cols, remote_cols)
        referent = pyast.value(args[0]) if args else None
        local = pyast.value(args[1], None) if len(args) > 1 else None
        remote = pyast.value(args[2], None) if len(args) > 2 else None
        if not (isinstance(referent, str) and isinstance(local, list)
                and isinstance(remote, list)):
            return False
        for here, there in zip(local, remote, strict=False):
            col = table.column(str(here))
            if col is not None:
                col.references = f"{referent}.{there}"
        return True
    if op == "create_primary_key":
        cols = pyast.value(args[0], None) if args else None
        if not isinstance(cols, list):
            return False
        for name in cols:
            col = table.column(str(name))
            if col is not None:
                col.pk, col.required = True, True
        return True
    return False


# Вызов op над существующей таблицей: (позиция имени таблицы, сколько аргументов срезать).
# create_primary_key(name, table, cols) и
# create_foreign_key(name, source, referent, local, remote).
_TABLE_ARG = {
    "add_column": (0, 1), "drop_column": (0, 1), "alter_column": (0, 1),
    "create_primary_key": (1, 2), "create_foreign_key": (1, 2),
}


def _on_table(
    op: str, call: ast.Call, state: _State, loc: Loc, batch: tuple[str | None, str | None] | None,
) -> bool:
    args = list(call.args)
    if batch is not None:
        name, schema = batch
        # У batch_op таблица задана блоком, а имя ограничения стоит первым.
        rest = args[1:] if op.startswith("create_") else args
    else:
        at, cut = _TABLE_ARG[op]
        if len(args) <= at:
            return False
        value = pyast.value(args[at])
        name = value if isinstance(value, str) else None
        kw = "source_schema" if op == "create_foreign_key" else "schema"
        found = pyast.value(pyast.kwargs(call).get(kw))
        schema = found if isinstance(found, str) else None
        rest = args[cut:]
    if name is None:
        return False
    table = state.schema.find(schema, name)
    if table is None:
        # Таблица создана не этой цепочкой: действие понятно, применять некуда.
        return True
    return _table_op(op, call, rest, table, loc)


def _op_call(
    call: ast.Call, state: _State, path: str, batch: tuple[str | None, str | None] | None,
) -> bool:
    """Один вызов op.* или batch_op.*; False — вызов не понят (считается пропущенным)."""
    op = call.func.attr if isinstance(call.func, ast.Attribute) else ""
    loc = Loc(path, call.lineno)
    args = list(call.args)
    if op in _NOOP:
        return True
    if op in _TABLE_ARG:
        return _on_table(op, call, state, loc, batch)
    if batch is not None:
        return False
    found = pyast.value(pyast.kwargs(call).get("schema"))
    schema = found if isinstance(found, str) else None
    if op == "create_table":
        return _create_table(call, state, loc)
    if op == "drop_table":
        name = pyast.value(args[0]) if args else None
        if not isinstance(name, str):
            return False
        state.schema.drop(schema, name)
        return True
    if op == "rename_table":
        old = pyast.value(args[0]) if args else None
        new = pyast.value(args[1]) if len(args) > 1 else None
        if not (isinstance(old, str) and isinstance(new, str)):
            return False
        state.schema.rename(schema, old, new, loc)
        return True
    if op == "execute":
        sql = args[0] if args else None
        if isinstance(sql, ast.Call) and pyast.last_name(sql) == "text" and sql.args:
            sql = sql.args[0]
        text = pyast.value(sql)
        if not isinstance(text, str):
            return False
        line = sql.lineno if isinstance(sql, ast.expr) else call.lineno
        sqlddl.apply_text(text, path, state.schema, line_offset=line - 1)
        return True
    return False


def _batch_target(item: ast.withitem) -> tuple[str | None, str | None] | None:
    call = item.context_expr
    if not (isinstance(call, ast.Call) and pyast.last_name(call) == "batch_alter_table"):
        return None
    name = pyast.value(call.args[0]) if call.args else None
    schema = pyast.value(pyast.kwargs(call).get("schema"))
    return (name if isinstance(name, str) else None, schema if isinstance(schema, str) else None)


def _call_of(stmt: ast.stmt, owners: tuple[str, ...]) -> ast.Call | None:
    """Вызов owner.x() как инструкция или правая часть присваивания (t = op.create_table)."""
    node = stmt.value if isinstance(stmt, (ast.Expr, ast.Assign, ast.AnnAssign)) else None
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        base = node.func.value
        if isinstance(base, ast.Name) and base.id in owners:
            return node
    return None


def _first_op(stmt: ast.stmt, owners: tuple[str, ...]) -> str:
    """Пример для подсказки: первый вызов op.x, иначе первая вызванная функция."""
    called = ""
    for sub in ast.walk(stmt):
        if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute):
            base = sub.func.value
            if isinstance(base, ast.Name) and base.id in owners:
                return f"{base.id}.{sub.func.attr}"
        if isinstance(sub, ast.Call) and not called:
            called = pyast.last_name(sub) or ""
    return called


def _uses(stmt: ast.stmt, owners: tuple[str, ...]) -> bool:
    """Упоминает ли инструкция op: вызов op.x или передача op в свою функцию."""
    return any(isinstance(sub, ast.Name) and sub.id in owners for sub in ast.walk(stmt))


def _apply_body(
    body: list[ast.stmt], state: _State, path: str, ops: tuple[str, ...],
    batch: tuple[str | None, str | None] | None,
) -> None:
    for stmt in body:
        if isinstance(stmt, ast.With):
            targets = [t for item in stmt.items if (t := _batch_target(item)) is not None]
            if targets:
                aliases = tuple(
                    item.optional_vars.id for item in stmt.items
                    if isinstance(item.optional_vars, ast.Name)
                )
                _apply_body(stmt.body, state, path, aliases or ("batch_op",), targets[0])
            else:
                # with op.get_context().autocommit_block(): — обычные вызовы внутри.
                _apply_body(stmt.body, state, path, ops, batch)
            continue
        call = _call_of(stmt, ops)
        if call is not None:
            if not _op_call(call, state, path, batch):
                state.schema.skip(Loc(path, call.lineno), _first_op(stmt, ops))
        elif _uses(stmt, ops):
            # Условие, цикл, вызов внутри выражения или op в своей функции: что и в каком
            # порядке применится, по тексту не известно.
            kind = "" if isinstance(stmt, ast.Expr) else type(stmt).__name__.lower()
            state.schema.skip(Loc(path, stmt.lineno), f"{kind} {_first_op(stmt, ops)}".strip())


def _revision(path: str, tree: ast.Module) -> _Revision | None:
    rev = pyast.value(pyast.module_assign(tree, "revision"))
    if not isinstance(rev, str):
        return None
    down = pyast.value(pyast.module_assign(tree, "down_revision"))
    if isinstance(down, str):
        parents = [down]
    elif isinstance(down, list):
        parents = [str(d) for d in down if isinstance(d, str)]
    else:
        parents = []
    upgrade = next(
        (s for s in tree.body if isinstance(s, ast.FunctionDef) and s.name == "upgrade"), None
    )
    return _Revision(path=path, revision=rev, parents=parents, upgrade=upgrade)


def order(revisions: list[_Revision]) -> tuple[list[_Revision], str | None]:
    """Порядок применения от корня к головам (Кан с порядком по пути файла)."""
    by_id: dict[str, _Revision] = {}
    for r in sorted(revisions, key=lambda r: r.path):
        by_id.setdefault(r.revision, r)
    for r in by_id.values():
        for parent in r.parents:
            if parent not in by_id:
                return [], texts.alembic_broken(r.revision, parent)
    pending = {rid: len(set(r.parents)) for rid, r in by_id.items()}
    children: dict[str, list[str]] = {}
    for rid, r in by_id.items():
        for parent in set(r.parents):
            children.setdefault(parent, []).append(rid)
    ready = [(by_id[rid].path, rid) for rid, n in pending.items() if n == 0]
    heapq.heapify(ready)
    out: list[_Revision] = []
    while ready:
        _, rid = heapq.heappop(ready)
        out.append(by_id[rid])
        for child in children.get(rid, []):
            pending[child] -= 1
            if pending[child] == 0:
                heapq.heappush(ready, (by_id[child].path, child))
    if len(out) < len(by_id):
        done = {r.revision for r in out}
        stuck = sorted(rid for rid in by_id if rid not in done)
        return [], texts.alembic_cycle(stuck)
    return out, None


def alembic_dirs(files: Files) -> list[str]:
    present = set(files.paths)
    dirs = set()
    for rel in files.paths:
        folder = paths.parent(rel)
        if paths.name(folder) == "versions" and rel.endswith(".py"):
            base = paths.parent(folder)
            env = f"{base}/env.py" if base else "env.py"
            if env in present:
                dirs.add(base)
    return sorted(dirs)


def _dialect(files: Files, base: str) -> tuple[str, Loc] | None:
    """Диалект набора: sqlalchemy.url в alembic.ini каталога миграций или выше по дереву,
    иначе адрес базы литералом в env.py."""
    present = set(files.paths)
    folder: str | None = base
    for _ in range(16):
        if folder is None:
            break
        ini = f"{folder}/alembic.ini" if folder else "alembic.ini"
        text = files.read(ini) if ini in present else None
        hit = dialect.alembic_url(text) if text else None
        if hit is not None:
            return hit[0], Loc(ini, hit[1])
        folder = paths.parent(folder) if folder else None
    env = f"{base}/env.py" if base else "env.py"
    text = files.read(env) if env in present else None
    hit = dialect.url_literal(text) if text else None
    return (hit[0], Loc(env, hit[1])) if hit else None


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for base in alembic_dirs(files):
        prefix = f"{base}/versions/" if base else "versions/"
        revisions: list[_Revision] = []
        for rel in [p for p in files.paths if p.startswith(prefix) and p.endswith(".py")]:
            if "/" in rel[len(prefix):] or paths.name(rel) == "__init__.py":
                continue
            text = files.read(rel)
            tree = pyast.parse(text) if text is not None else None
            if tree is None:
                if text is not None:
                    found.hints.append(Hint("unparsed", {
                        "path": rel, "reason": texts.REASON_BAD_PYTHON,
                    }))
                continue
            rev = _revision(rel, tree)
            if rev is not None:
                revisions.append(rev)
        if not revisions:
            continue
        ordered, error = order(revisions)
        if error is not None:
            found.table_sets.append(TableSet(parser=NAME, dir=base, error=error))
            continue
        state = _State()
        for rev in ordered:
            if rev.upgrade is not None:
                _apply_body(rev.upgrade.body, state, rev.path, ("op",), None)
        hit = _dialect(files, base)
        found.table_sets.append(TableSet(
            parser=NAME, dir=base, tables=list(state.schema.tables.values()),
            dropped=state.schema.dropped, skipped=state.schema.skipped,
            skipped_examples=list(state.schema.examples),
            dialect=hit[0] if hit else None, dialect_loc=hit[1] if hit else None,
        ))
    return found
