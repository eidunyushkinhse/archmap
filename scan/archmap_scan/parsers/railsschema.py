"""Схема Rails `db/schema.rb` (ТЗ §15 п. 14 З1): таблицы после всех миграций Active Record.

Файл генерирует сама Rails, и он регулярен, поэтому читается построчно, без исполнения
Ruby: `create_table "имя", опции do |t|` … `end`, строки `t.тип "колонка", опции` (тип как
написан; `null: false` — обязательна), `t.references`/`t.belongs_to "x"` — колонка `x_id`
bigint (`polymorphic: true` — ещё `x_type`), `t.timestamps` — `created_at` и `updated_at`,
первичный ключ `id` bigint, если нет `id: false` (`id: :uuid` — тип, `primary_key:` —
другое имя или список колонок), `add_foreign_key "из", "в", column:, primary_key:` —
ссылка колонки. Индексы, ограничения, представления (`create_view` с текстом SQL до
терминатора heredoc), типы и функции структуры таблиц не меняют и пропускаются;
`enable_extension` и `create_schema` идут в подсказки. Прочая инструкция внутри define —
пропуск со счётчиком.

Диалект — по драйверу в Gemfile пакета файла (`pg` — PostgreSQL, `mysql2` и `trilogy` —
MySQL, `sqlite3` — SQLite), иначе не известен. Если рядом лежит `db/structure.sql`, схема
Rails не читается: структуру даёт SQL-разборщик (один источник). `db/migrate/*.rb` не
читаются, тестовое приложение `spec/dummy/` исключено обходом по соглашению.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from archmap_scan import codebase, dialect, paths, texts
from archmap_scan.context import Context
from archmap_scan.model import Column, Findings, Hint, Loc, Table, TableSet
from archmap_scan.walk import Files

NAME = "rails-schema"
_SCHEMA = "db/schema.rb"
_STRUCTURE = "structure.sql"
_Q = r"[\"']([^\"'\n]{1,200})[\"']"
_DEFINE = re.compile(r"[ \t]*ActiveRecord::Schema(?:\[[0-9.]{1,10}\])?\.define\b")
_CREATE = re.compile(
    rf"[ \t]*create_table[ \t]+{_Q}(.{{0,1000}}?)[ \t]+do[ \t]*\|[ \t]*(\w{{1,40}})[ \t]*\|"
)
_FOREIGN = re.compile(rf"[ \t]*add_foreign_key[ \t]+{_Q}[ \t]*,[ \t]*{_Q}(.{{0,1000}})")
_EXTENSION = re.compile(rf"[ \t]*(enable_extension|create_schema)[ \t]+{_Q}")
_HEREDOC = re.compile(r"<<[-~]?([A-Z_]{1,40})\b")
_END = re.compile(r"[ \t]*end\b")
# Конец строки, после которого инструкция продолжается, и открытие блока do … end.
_CONTINUE = (".", ",", "(", "\\")
_OPENER = re.compile(r"\bdo(?:[ \t]*\|[^|\n]{0,200}\|)?$")
_STATEMENT = re.compile(r"[ \t]*([a-z_]{1,60})\b")
_OPTION = re.compile(
    r"\b(\w{1,40}):[ \t]*"
    r"(\"[^\"\n]{0,200}\"|'[^'\n]{0,200}'|:\w{1,40}|\[[^\]\n]{0,1000}\]|\w{1,40})"
)
_STR = re.compile(r"[\"']([^\"'\n]{1,200})[\"']")
# Инструкции define, которые колонок таблиц не меняют: пропускаются без счётчика.
_IGNORED = frozenset({
    "add_index", "create_view", "create_enum", "create_function", "create_trigger",
    "create_virtual_table", "add_check_constraint", "execute", "create_join_table",
    "remove_index", "end",
})
# Строки внутри create_table, которые колонок не дают.
_TABLE_IGNORED = frozenset({
    "index", "check_constraint", "exclusion_constraint", "unique_constraint", "foreign_key",
})
_DRIVERS = (("pg", dialect.POSTGRESQL), ("mysql2", dialect.MYSQL), ("trilogy", dialect.MYSQL),
            ("sqlite3", dialect.SQLITE))
_MAX_LINES = 200_000


def _options(text: str) -> dict[str, str]:
    return {m.group(1): m.group(2) for m in _OPTION.finditer(text)}


def _strings(value: str) -> list[str]:
    return [m.group(1) for m in _STR.finditer(value)]


def _singular(name: str) -> str:
    """Единственное число имени таблицы по правилам Rails для внешнего ключа: accounts →
    account, statuses → status, policies → policy, boxes → box."""
    for tail, repl in (("ies", "y"), ("sses", "ss"), ("uses", "us"), ("xes", "x"),
                       ("ches", "ch"), ("shes", "sh")):
        if name.endswith(tail):
            return name[: -len(tail)] + repl
    return name[:-1] if name.endswith("s") and not name.endswith("ss") else name


@dataclass
class _Open:
    """Таблица между create_table и end: переменная блока и имена первичного ключа."""

    table: Table
    row: re.Pattern[str]
    keys: list[str] = field(default_factory=list)


def _open(name: str, opts: dict[str, str], var: str, loc: Loc) -> _Open:
    table = Table(name=name, locs=[loc])
    row = re.compile(rf"[ \t]*{re.escape(var)}\.(\w{{1,40}})\b[ \t]*(.{{0,2000}})")
    keys = _strings(opts["primary_key"]) if "primary_key" in opts else []
    id_opt = opts.get("id", "")
    if id_opt == "false" or len(keys) > 1:
        # Без своего id или составной ключ: колонки ключа помечаются, когда встретятся.
        return _Open(table, row, keys)
    kind = id_opt.lstrip(":") if id_opt.startswith(":") else "bigint"
    table.columns.append(Column(
        name=keys[0] if keys else "id", type=kind, pk=True, required=True, locs=[loc],
    ))
    return _Open(table, row, keys)


def _column(cur: _Open, name: str, kind: str, opts: dict[str, str], loc: Loc) -> None:
    if cur.table.column(name) is not None:
        return
    pk = name in cur.keys
    cur.table.columns.append(Column(
        name=name, type=kind, pk=pk, required=True if pk else opts.get("null") == "false",
        locs=[loc],
    ))


def _row(cur: _Open, line: str, loc: Loc) -> bool:
    """Строка внутри create_table: колонка, ссылка, timestamps или пропуск. False — строка
    не понята."""
    m = cur.row.match(line)
    if m is None:
        return False
    kind, rest = m.group(1), m.group(2)
    if kind in _TABLE_IGNORED:
        return True
    opts = _options(rest)
    if kind == "timestamps":
        for col in ("created_at", "updated_at"):
            _column(cur, col, "datetime", {"null": opts.get("null", "false")}, loc)
        return True
    head, _, tail = rest.partition(",")
    names = _strings(head)
    if not names:
        return False
    if kind == "column":
        # t.column "имя", :тип — тип вторым аргументом.
        sym = re.match(r"[ \t]*:(\w{1,40})", tail)
        kind = sym.group(1) if sym else "column"
    if kind in ("references", "belongs_to"):
        ref = opts.get("type", ":bigint").lstrip(":").strip("\"'")
        _column(cur, names[0] + "_id", ref, opts, loc)
        if opts.get("polymorphic") == "true":
            _column(cur, names[0] + "_type", "string", opts, loc)
        return True
    for name in names:
        _column(cur, name, kind, opts, loc)
    return True


def _foreign(tables: dict[str, Table], m: re.Match[str]) -> None:
    source, target = tables.get(m.group(1)), m.group(2)
    if source is None:
        return
    opts = _options(m.group(3))
    column = _strings(opts["column"])[0] if "column" in opts and _strings(opts["column"]) \
        else _singular(target) + "_id"
    key = _strings(opts["primary_key"])[0] if "primary_key" in opts and \
        _strings(opts["primary_key"]) else "id"
    col = source.column(column)
    if col is not None and col.references is None:
        col.references = f"{target}.{key}"


def _dialect(files: Files, ctx: Context, rel: str) -> tuple[str, Loc] | None:
    for pkg in codebase.owner_packages(files, ctx, rel, codebase.RUBY):
        for dep, name in _DRIVERS:
            if dep in pkg.deps:
                text = files.read(pkg.path) or ""
                hit = re.search(rf"^[ \t]*gem[ \t]+[\"']{re.escape(dep)}[\"']", text, re.MULTILINE)
                line = text.count("\n", 0, hit.start()) + 1 if hit else 1
                return name, Loc(pkg.path, line)
    return None


@dataclass
class _State:
    """Разбор define по строкам: открытая таблица, heredoc, продолжение инструкции через
    «.» или «,» в конце строки и вложенный блок do … end прочей инструкции."""

    ts: TableSet
    tables: dict[str, Table] = field(default_factory=dict)
    current: _Open | None = None
    heredoc: str | None = None
    inside: bool = False
    cont: bool = False
    block: int = 0

    def skip(self, loc: Loc, stripped: str) -> None:
        self.ts.skipped += 1
        if len(self.ts.skipped_examples) < 3:
            self.ts.skipped_examples.append((loc, stripped[:60]))


def _in_table(st: _State, cur: _Open, line: str, stripped: str, loc: Loc) -> None:
    if _END.match(line):
        st.tables.setdefault(cur.table.name, cur.table)
        st.current = None
    elif not _row(cur, line, loc):
        st.skip(loc, stripped)


def _statement(st: _State, line: str, stripped: str, loc: Loc, found: Findings) -> None:
    """Строка верхнего уровня define. Прочая инструкция (create_trigger с цепочкой вызовов
    и блоком do … end у Forem) пропускается целиком: со счётчиком, если её нет в _IGNORED."""
    doc = _HEREDOC.search(line)
    if doc is not None:
        st.heredoc = doc.group(1)
    if st.block:
        if _OPENER.search(stripped):
            st.block += 1
        elif _END.match(line):
            st.block -= 1
        return
    opener = _OPENER.search(stripped) is not None
    if st.cont:
        st.cont = stripped.endswith(_CONTINUE)
        st.block = 1 if opener else 0
        return
    m = _CREATE.match(line)
    if m is not None:
        st.current = _open(m.group(1), _options(m.group(2)), m.group(3), loc)
        return
    fk = _FOREIGN.match(line)
    if fk is not None:
        _foreign(st.tables, fk)
        return
    ext = _EXTENSION.match(line)
    if ext is not None:
        found.hints.append(Hint("unassigned", {
            "kind": NAME, "name": f"{ext.group(1)} {ext.group(2)}",
            "reason": texts.REASON_RAILS_NOT_TABLE, "source": str(loc),
        }))
        return
    word = _STATEMENT.match(line)
    if word is None or word.group(1) not in _IGNORED:
        st.skip(loc, stripped)
    st.cont = stripped.endswith(_CONTINUE)
    st.block = 1 if opener else 0


def _parse(text: str, rel: str, found: Findings) -> TableSet:
    st = _State(TableSet(parser=NAME, dir=paths.parent(rel)))
    for no, line in enumerate(text.split("\n")[:_MAX_LINES], start=1):
        stripped = line.strip()
        if st.heredoc is not None:
            if stripped == st.heredoc:
                st.heredoc = None
            continue
        if not stripped or stripped.startswith("#"):
            continue
        loc = Loc(rel, no)
        if st.current is not None:
            _in_table(st, st.current, line, stripped, loc)
        elif not st.inside:
            st.inside = _DEFINE.match(line) is not None
        else:
            _statement(st, line, stripped, loc, found)
    st.ts.tables = list(st.tables.values())
    return st.ts


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    present = set(files.paths)
    for rel in files.paths:
        if rel != _SCHEMA and not rel.endswith("/" + _SCHEMA):
            continue
        if paths.join(paths.parent(rel), _STRUCTURE) in present:
            continue
        text = files.read(rel)
        if text is None:
            continue
        ts = _parse(text, rel, found)
        if not ts.tables and not ts.skipped:
            continue
        hit = _dialect(files, ctx, rel)
        if hit is not None:
            ts.dialect, ts.dialect_loc = hit
        found.table_sets.append(ts)
    return found
