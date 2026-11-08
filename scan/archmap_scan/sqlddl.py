"""Ограниченная грамматика SQL DDL (ТЗ §6.3): таблицы и колонки после цепочки миграций.

CREATE TABLE с колонками и ограничениями таблицы, CREATE TABLE … AS SELECT (колонки по именам
списка SELECT: псевдоним «AS имя» или имя колонки, без типа; выражение без имени, «*» и запрос не
SELECT колонок не дают, таблица названа в подсказках; ТЗ §15 п. 14 З2), ALTER TABLE (ADD, DROP,
RENAME, ALTER и MODIFY колонок, ключи), DROP TABLE, RENAME TABLE. Кавычки «"», «`» и «[]»; имя
без кавычек складывается в нижний регистр, как в PostgreSQL (fold, у MySQL выключено).
Временные таблицы (TEMP) в схему не попадают. Инструкции, которые к структуре таблиц не
относятся (индексы, данные, функции, триггеры, имена ограничений), пропускаются молча;
непонятная инструкция пропускается со счётчиком. Разбор линейный: следующий особый символ ищется
регулярным выражением без перебора, строки и комментарии пропускаются поиском конца.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from archmap_scan.model import Column, Loc, Table

# Инструкция длиннее этого предела не разбирается: в настоящих миграциях таких нет, а
# разбор враждебно длинной строки занял бы заметное время.
MAX_STATEMENT = 256 * 1024
EXAMPLES = 3
# Сколько непонятых инструкций помнить ради выбора примеров: примеры берутся сначала из
# тех, чьи таблицы живы в конце цепочки (ТЗ §15 п. 10 А3).
MAX_SKIPS = 10_000
_TABLE_LEAD = frozenset({
    "CREATE", "OR", "REPLACE", "GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "UNLOGGED", "TABLE",
    "ALTER", "DROP", "RENAME", "IF", "NOT", "EXISTS", "ONLY",
})

_SPECIAL = re.compile(r"[;'\"`\[$/-]")
_WORDS = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")
_DOLLAR_TAG = re.compile(r"\$[A-Za-z0-9_]*\$")
_TOKEN = re.compile(
    r"\s+"
    r"|(?P<word>[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*)"
    r"|(?P<dq>\"(?:[^\"]|\"\")*\")"
    r"|(?P<bq>`[^`]*`)"
    r"|(?P<br>\[[^\]]*\])"
    r"|(?P<sq>'(?:[^']|'')*')"
    r"|(?P<num>[0-9]+(?:\.[0-9]+)?)"
    r"|(?P<op>.)",
    re.DOTALL,
)

# Начала инструкций, которые к колонкам таблиц не относятся: пропускаются без счётчика.
_IGNORED_STARTS: tuple[tuple[str, ...], ...] = tuple(
    tuple(s.split()) for s in (
        "CREATE INDEX", "CREATE UNIQUE INDEX", "DROP INDEX", "ALTER INDEX", "CREATE EXTENSION",
        "DROP EXTENSION", "CREATE SCHEMA", "DROP SCHEMA", "ALTER SCHEMA", "CREATE SEQUENCE",
        "ALTER SEQUENCE", "DROP SEQUENCE", "CREATE TYPE", "DROP TYPE", "ALTER TYPE",
        "CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", "DROP FUNCTION", "CREATE PROCEDURE",
        "CREATE OR REPLACE PROCEDURE", "DROP PROCEDURE", "CREATE TRIGGER",
        "CREATE OR REPLACE TRIGGER", "DROP TRIGGER", "CREATE VIEW", "CREATE OR REPLACE VIEW",
        "DROP VIEW", "CREATE MATERIALIZED VIEW", "DROP MATERIALIZED VIEW", "REFRESH",
        "CREATE RULE", "CREATE POLICY", "DROP POLICY", "CREATE DOMAIN", "COMMENT", "GRANT",
        "REVOKE", "INSERT", "UPDATE", "DELETE", "SELECT", "SET", "RESET", "BEGIN", "COMMIT",
        "ROLLBACK", "START", "END", "LOCK", "ANALYZE", "VACUUM", "USE", "PRAGMA", "DO", "CALL",
        "TRUNCATE", "REINDEX", "CLUSTER", "DECLARE", "WITH", "COPY", "DELIMITER", "SHOW",
        "CREATE ROLE", "CREATE USER", "ALTER ROLE", "ALTER USER", "DROP ROLE", "DROP USER",
        "CREATE DATABASE", "ALTER DATABASE", "DROP DATABASE", "SAVEPOINT", "RELEASE",
        "CREATE OR REPLACE RULE", "ALTER FUNCTION", "ALTER VIEW", "EXPLAIN", "NOTIFY",
        "LISTEN", "PREPARE", "EXECUTE", "DEALLOCATE", "CHECKPOINT", "DISCARD", "SECURITY",
        "ALTER DEFAULT PRIVILEGES", "CREATE PUBLICATION", "CREATE SUBSCRIPTION", "MERGE",
        "UPSERT", "REPLACE", "GO", "CREATE STATISTICS", "DROP STATISTICS", "ALTER STATISTICS",
        "ALTER TRIGGER",
    )
)
_COLUMN_STOP = frozenset({
    "CONSTRAINT", "NOT", "NULL", "PRIMARY", "REFERENCES", "DEFAULT", "UNIQUE", "CHECK",
    "COLLATE", "GENERATED", "AUTO_INCREMENT", "AUTOINCREMENT", "IDENTITY", "COMMENT", "ON",
    "CHARSET", "AS", "KEY",
})
# Слова, на которых кончается список SELECT в CREATE TABLE … AS.
_SELECT_STOP = frozenset({
    "FROM", "INTO", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "UNION", "EXCEPT",
    "INTERSECT", "WINDOW", "OFFSET", "FETCH",
})
# Значения, которые именем колонки списка SELECT не служат («SELECT NULL» — ?column?).
_SELECT_VALUES = frozenset({"NULL", "TRUE", "FALSE"})
_TABLE_CONSTRAINTS = frozenset({
    "CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "KEY", "INDEX", "FULLTEXT",
    "SPATIAL", "EXCLUDE", "LIKE", "PERIOD",
})
# Типы, по которым «key text», «index integer», «check boolean» — колонка с именем
# ключевого слова, а не ограничение таблицы.
_COLUMN_TYPES = frozenset({
    "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT", "SERIAL", "BIGSERIAL",
    "SMALLSERIAL", "TEXT", "VARCHAR", "VARCHAR2", "CHAR", "CHARACTER", "NVARCHAR", "NCHAR",
    "NTEXT", "TINYTEXT", "MEDIUMTEXT", "LONGTEXT", "CLOB", "BLOB", "BYTEA", "BINARY",
    "VARBINARY", "UUID", "UNIQUEIDENTIFIER", "JSON", "JSONB", "BOOLEAN", "BOOL", "BIT",
    "DATE", "TIME", "TIMESTAMP", "TIMESTAMPTZ", "DATETIME", "DATETIME2", "INTERVAL",
    "NUMERIC", "DECIMAL", "NUMBER", "REAL", "FLOAT", "DOUBLE", "MONEY", "INET", "CIDR",
    "CITEXT", "ENUM", "XML", "STRING", "INT2", "INT4", "INT8", "FLOAT4", "FLOAT8", "HSTORE",
})


@dataclass(frozen=True)
class Tok:
    kind: str  # word | ident (в кавычках) | str | num | op
    text: str  # значение (у ident без кавычек)
    start: int
    end: int

    @property
    def up(self) -> str:
        return self.text.upper() if self.kind == "word" else ""


def split_statements(text: str) -> list[tuple[int, str]]:
    """Инструкции текста с номером строки начала. Комментарии вырезаются, строки и
    идентификаторы в кавычках остаются как есть (точка с запятой внутри них не делит)."""
    out: list[tuple[int, str]] = []
    buf: list[str] = []
    first: list[int] = []  # позиция первого значимого символа инструкции в тексте
    # Номер строки считается от начала прошлой инструкции, а не от начала текста: иначе
    # тысячи инструкций в одном файле разбирались бы за квадрат длины.
    lines = _Lines(text)
    pos = 0
    n = len(text)

    def keep(chunk_start: int, chunk_end: int) -> None:
        chunk = text[chunk_start:chunk_end]
        if not first:
            stripped = len(chunk) - len(chunk.lstrip())
            if stripped < len(chunk):
                first.append(chunk_start + stripped)
        buf.append(chunk)

    while pos < n:
        m = _SPECIAL.search(text, pos)
        if m is None:
            keep(pos, n)
            break
        i = m.start()
        ch = text[i]
        keep(pos, i)
        if ch == ";":
            _flush(out, buf, lines, first)
            buf, first = [], []
            pos = i + 1
            continue
        if ch == "-" and text.startswith("--", i):
            end = text.find("\n", i)
            pos = n if end < 0 else end
            buf.append(" ")
            continue
        if ch == "/" and text.startswith("/*", i):
            end = text.find("*/", i + 2)
            pos = n if end < 0 else end + 2
            buf.append(" ")
            continue
        if ch == "$":
            tag = _DOLLAR_TAG.match(text, i)
            if tag is not None:
                end = text.find(tag.group(0), tag.end())
                stop = n if end < 0 else end + len(tag.group(0))
                keep(i, stop)
                pos = stop
                continue
        if ch in "'\"`[":
            close = "]" if ch == "[" else ch
            end = i + 1
            while True:
                end = text.find(close, end)
                if end < 0:
                    end = n
                    break
                if close in "'\"" and text.startswith(close * 2, end):
                    end += 2
                    continue
                end += 1
                break
            keep(i, end)
            pos = end
            continue
        keep(i, i + 1)
        pos = i + 1
    _flush(out, buf, lines, first)
    return out


class _Lines:
    """Номер строки по позиции для позиций по возрастанию: счёт от прошлой позиции."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0
        self.line = 1

    def at(self, pos: int) -> int:
        self.line += self.text.count("\n", self.pos, pos)
        self.pos = pos
        return self.line


def _flush(out: list[tuple[int, str]], buf: list[str], lines: _Lines, first: list[int]) -> None:
    stmt = "".join(buf).strip()
    if stmt and first:
        out.append((lines.at(first[0]), stmt))


def tokenize(stmt: str) -> list[Tok]:
    toks: list[Tok] = []
    for m in _TOKEN.finditer(stmt):
        kind = m.lastgroup
        if kind is None:
            continue
        raw = m.group(0)
        if kind == "word":
            toks.append(Tok("word", raw, m.start(), m.end()))
        elif kind in ("dq", "bq", "br"):
            inner = raw[1:-1] if len(raw) >= 2 else raw
            toks.append(Tok("ident", inner.replace('""', '"'), m.start(), m.end()))
        elif kind == "sq":
            toks.append(Tok("str", raw[1:-1].replace("''", "'"), m.start(), m.end()))
        elif kind == "num":
            toks.append(Tok("num", raw, m.start(), m.end()))
        else:
            toks.append(Tok("op", raw, m.start(), m.end()))
    return toks


@dataclass
class Schema:
    """Состояние базы по ходу цепочки миграций. fold — складывать имена без кавычек в
    нижний регистр (PostgreSQL); у MySQL и прочих имя без кавычек хранится как написано."""

    tables: dict[tuple[str, str], Table] = field(default_factory=dict)
    dropped: int = 0
    skipped: int = 0
    created: set[tuple[str, str]] = field(default_factory=set)
    fold: bool = True
    # Непонятые инструкции: место, первые слова, ключ таблицы (если его видно).
    skips: list[tuple[Loc, str, tuple[str, str] | None]] = field(default_factory=list)
    # Таблицы из CREATE TABLE … AS, у которых не все колонки запроса получили имя.
    queried: list[tuple[Loc, Table]] = field(default_factory=list)

    @property
    def examples(self) -> list[tuple[Loc, str]]:
        """До EXAMPLES примеров непонятых инструкций: сначала те, чьи таблицы живы в конце
        цепочки (их структура и пострадала), затем остальные, каждая группа по порядку."""
        live = [s for s in self.skips if s[2] is not None and s[2] in self.tables]
        rest = [s for s in self.skips if s[2] is None or s[2] not in self.tables]
        return [(loc, text) for loc, text, _ in (live + rest)[:EXAMPLES]]

    def from_query(self) -> list[tuple[Loc, str]]:
        """Живые в конце цепочки таблицы из CREATE TABLE … AS: место и показ имени."""
        alive = {id(t) for t in self.tables.values()}
        out: list[tuple[Loc, str]] = []
        for loc, table in self.queried:
            if id(table) in alive:
                out.append((loc, f"{table.schema}.{table.name}" if table.schema else table.name))
        return out

    def find(self, schema: str | None, name: str) -> Table | None:
        return self.tables.get(_key(schema, name))

    def create(self, table: Table, loc: Loc) -> Table:
        key = _key(table.schema, table.name)
        old = self.tables.get(key)
        if old is not None:
            old.locs.append(loc)
            return old
        table.locs.append(loc)
        self.tables[key] = table
        self.created.add(key)
        return table

    def drop(self, schema: str | None, name: str) -> None:
        key = _key(schema, name)
        if self.tables.pop(key, None) is not None:
            self.dropped += 1

    def rename(self, schema: str | None, old: str, new: str, loc: Loc) -> None:
        table = self.tables.pop(_key(schema, old), None)
        if table is None:
            return
        table.name = new
        table.locs.append(loc)
        self.tables[_key(table.schema, new)] = table

    def skip(self, loc: Loc, stmt: str, target: tuple[str, str] | None = None) -> None:
        """Счётчик непонятых инструкций; пример — первые слова без строковых значений."""
        self.skipped += 1
        if len(self.skips) < MAX_SKIPS:
            words = _WORDS.findall(stmt[:200])[:3]
            self.skips.append((loc, " ".join(words)[:60] or "?", target))


def _key(schema: str | None, name: str) -> tuple[str, str]:
    return ((schema or "").lower(), name.lower())


class _Parser:
    def __init__(self, toks: list[Tok], stmt: str, fold: bool = True) -> None:
        self.toks = toks
        self.stmt = stmt
        self.fold = fold
        self.i = 0

    def peek(self, k: int = 0) -> Tok | None:
        j = self.i + k
        return self.toks[j] if j < len(self.toks) else None

    def up(self, k: int = 0) -> str:
        tok = self.peek(k)
        return tok.up if tok else ""

    def take(self, *words: str) -> bool:
        """Съесть последовательность ключевых слов, если она стоит следующей."""
        for k, word in enumerate(words):
            if self.up(k) != word:
                return False
        self.i += len(words)
        return True

    def op(self, ch: str) -> bool:
        tok = self.peek()
        if tok is not None and tok.kind == "op" and tok.text == ch:
            self.i += 1
            return True
        return False

    def name(self) -> str | None:
        tok = self.peek()
        if tok is None or tok.kind not in ("word", "ident"):
            return None
        self.i += 1
        # Имя без кавычек PostgreSQL складывает в нижний регистр: «LANGUAGE» это language.
        return tok.text.lower() if self.fold and tok.kind == "word" else tok.text

    def qualified(self) -> tuple[str | None, str] | None:
        """[база.][схема.]имя → (схема, имя)."""
        parts: list[str] = []
        first = self.name()
        if first is None:
            return None
        parts.append(first)
        while self.op("."):
            nxt = self.name()
            if nxt is None:
                break
            parts.append(nxt)
        return (parts[-2] if len(parts) >= 2 else None), parts[-1]

    def skip_group(self) -> None:
        """Пропустить сбалансированные скобки, начиная с «(»."""
        depth = 0
        while self.i < len(self.toks):
            tok = self.toks[self.i]
            self.i += 1
            if tok.kind == "op" and tok.text == "(":
                depth += 1
            elif tok.kind == "op" and tok.text == ")":
                depth -= 1
                if depth <= 0:
                    return

    def name_list(self) -> list[str]:
        """(a, b DESC, c(10)) → [a, b, c]; без скобок — пусто."""
        out: list[str] = []
        if not self.op("("):
            return out
        while self.i < len(self.toks):
            if self.op(")"):
                break
            if self.op(","):
                continue
            name = self.name()
            if name is not None:
                out.append(name)
            self.skip_item()
        return out

    def at_end_of_item(self) -> bool:
        tok = self.peek()
        return tok is None or (tok.kind == "op" and tok.text in (",", ")"))

    def skip_item(self) -> None:
        """До запятой или закрывающей скобки на своём уровне."""
        while not self.at_end_of_item():
            tok = self.peek()
            if tok is not None and tok.kind == "op" and tok.text == "(":
                self.skip_group()
            else:
                self.i += 1


def _type_text(p: _Parser, first: int, last: int) -> str | None:
    if last < first:
        return None
    raw = p.stmt[p.toks[first].start:p.toks[last].end]
    text = " ".join(raw.split())
    return text.replace(" (", "(").replace("( ", "(").replace(" )", ")") or None


def _references(p: _Parser, schema: Schema) -> str | None:
    """REFERENCES т [(к)] → «т.к»; без колонки — первичный ключ т, если он известен."""
    target = p.qualified()
    if target is None:
        return None
    cols = p.name_list()
    table_name = target[1]
    if cols:
        return f"{table_name}.{cols[0]}"
    known = schema.find(target[0], table_name)
    pks = [c.name for c in known.columns if c.pk] if known else []
    return f"{table_name}.{pks[0]}" if len(pks) == 1 else table_name


def _skip_fk_tail(p: _Parser) -> None:
    """Хвост после REFERENCES: ON DELETE и ON UPDATE, MATCH, DEFERRABLE."""
    while not p.at_end_of_item() and p.up() not in _COLUMN_STOP - {"ON"}:
        if p.up() == "ON" or p.up() in ("MATCH", "DEFERRABLE", "INITIALLY", "NOT"):
            p.i += 1
            continue
        tok = p.peek()
        if tok is not None and tok.kind == "op" and tok.text == "(":
            p.skip_group()
        else:
            p.i += 1


def column_def(p: _Parser, schema: Schema, loc: Loc) -> Column | None:
    name = p.name()
    if name is None:
        return None
    col = Column(name=name, required=False, locs=[loc])
    first = p.i
    last = p.i - 1
    while not p.at_end_of_item() and p.up() not in _COLUMN_STOP:
        if p.up() == "CHARACTER" and p.up(1) == "SET":
            break
        tok = p.peek()
        if tok is not None and tok.kind == "op" and tok.text == "(":
            p.skip_group()
        else:
            p.i += 1
        last = p.i - 1
    col.type = _type_text(p, first, last)
    while not p.at_end_of_item():
        if p.take("NOT", "NULL"):
            col.required = True
        elif p.take("NULL"):
            col.required = False
        elif p.take("PRIMARY", "KEY"):
            col.pk = True
            col.required = True
        elif p.take("REFERENCES"):
            col.references = _references(p, schema)
            _skip_fk_tail(p)
        else:
            tok = p.peek()
            if tok is not None and tok.kind == "op" and tok.text == "(":
                p.skip_group()
            else:
                p.i += 1
    return col


def _table_constraint(p: _Parser, table: Table, schema: Schema) -> None:
    if p.take("CONSTRAINT"):
        p.name()
    if p.take("PRIMARY", "KEY"):
        for name in p.name_list():
            col = table.column(name)
            if col is not None:
                col.pk = True
                col.required = True
    elif p.take("FOREIGN", "KEY"):
        cols = p.name_list()
        if p.take("REFERENCES"):
            target = p.qualified()
            refs = p.name_list()
            if target is not None:
                for i, name in enumerate(cols):
                    col = table.column(name)
                    if col is not None:
                        ref = refs[i] if i < len(refs) else None
                        col.references = f"{target[1]}.{ref}" if ref else target[1]
    p.skip_item()


def _create(p: _Parser, schema: Schema, loc: Loc) -> bool:
    p.take("IF", "NOT", "EXISTS")
    target = p.qualified()
    if target is None:
        return False
    if p.take("AS"):
        _create_as(p, schema, target, loc)
        return True
    if not p.op("("):
        return False
    table = Table(name=target[1], schema=target[0])
    names: set[str] = set()
    while p.peek() is not None:
        if p.op(")"):
            break
        if p.op(","):
            continue
        if p.up() in _TABLE_CONSTRAINTS and p.up(1) not in _COLUMN_TYPES:
            _table_constraint(p, table, schema)
            continue
        col = column_def(p, schema, loc)
        if col is None:
            p.skip_item()
            continue
        if col.name.lower() not in names:
            names.add(col.name.lower())
            table.columns.append(col)
    schema.create(table, loc)
    return True


def _create_as(p: _Parser, schema: Schema, target: tuple[str | None, str], loc: Loc) -> None:
    """CREATE TABLE … AS SELECT: колонки по именам списка SELECT, без типа (Lemmy
    comment_actions); не все колонки с именем — таблица в подсказках."""
    table = schema.create(Table(name=target[1], schema=target[0]), loc)
    names, complete = _select_names(p)
    if not table.columns:
        table.columns = [Column(name=name, required=False, locs=[loc]) for name in names]
    if not complete:
        schema.queried.append((loc, table))


def _select_names(p: _Parser) -> tuple[list[str], bool]:
    """Имена колонок списка SELECT после AS и признак, что имя есть у каждой: псевдоним «AS
    имя», иначе имя колонки («person_id», «c.comment_id»). Выражение без псевдонима, «*» и
    запрос не SELECT (TABLE, VALUES, WITH) имени не дают."""
    while p.op("("):
        pass
    if not p.take("SELECT"):
        return [], False
    if p.take("DISTINCT"):
        tok = p.peek(1)
        if p.up() == "ON" and tok is not None and tok.kind == "op" and tok.text == "(":
            p.i += 1
            p.skip_group()
    else:
        p.take("ALL")
    names: list[str] = []
    complete = True
    while p.peek() is not None:
        name = _item_name(p, _select_item(p))
        if name is None:
            complete = False
        elif name not in names:
            names.append(name)
        if not p.op(","):
            break
    return names, complete


def _select_item(p: _Parser) -> list[Tok]:
    """Токены одного элемента списка SELECT на его уровне (скобки — одним токеном group)."""
    toks: list[Tok] = []
    while True:
        tok = p.peek()
        if tok is None or (tok.kind == "op" and tok.text in (",", ")")) or tok.up in _SELECT_STOP:
            return toks
        if tok.kind == "op" and tok.text == "(":
            p.skip_group()
            toks.append(Tok("group", "", tok.start, tok.end))
            continue
        toks.append(tok)
        p.i += 1


def _item_name(p: _Parser, toks: list[Tok]) -> str | None:
    last = toks[-1] if toks else None
    if last is None or last.kind not in ("word", "ident"):
        return None
    aliased = len(toks) >= 2 and toks[-2].up == "AS"
    if not aliased and not _column_ref(toks):
        return None
    return last.text.lower() if p.fold and last.kind == "word" else last.text


def _column_ref(toks: list[Tok]) -> bool:
    """«имя» или «т.имя»: имена через точку; NULL, TRUE и FALSE — значения, не колонки."""
    if len(toks) == 1:
        return toks[0].up not in _SELECT_VALUES
    return len(toks) % 2 == 1 and all(
        t.kind in ("word", "ident") if k % 2 == 0 else (t.kind == "op" and t.text == ".")
        for k, t in enumerate(toks)
    )


def _alter_action(p: _Parser, table: Table, schema: Schema, loc: Loc) -> bool:
    """Одно действие ALTER TABLE; False — действие не понято."""
    if p.take("ADD"):
        if p.up() in ("CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "INDEX", "KEY") \
                and p.up(1) not in _COLUMN_TYPES:
            _table_constraint(p, table, schema)
            return True
        p.take("COLUMN")
        p.take("IF", "NOT", "EXISTS")
        col = column_def(p, schema, loc)
        if col is None:
            return False
        if table.column(col.name) is None:
            table.columns.append(col)
        table.locs.append(loc)
        return True
    if p.take("DROP"):
        if p.take("CONSTRAINT") or p.take("INDEX") or p.take("PRIMARY", "KEY") \
                or p.take("FOREIGN", "KEY"):
            p.skip_item()
            return True
        p.take("COLUMN")
        p.take("IF", "EXISTS")
        name = p.name()
        if name is None:
            return False
        table.columns = [c for c in table.columns if c.name.lower() != name.lower()]
        table.locs.append(loc)
        p.skip_item()
        return True
    if p.take("RENAME"):
        if p.take("CONSTRAINT"):
            # Имя ограничения на колонки не влияет.
            p.skip_item()
            return True
        if p.take("TO") or p.take("AS"):
            renamed = p.qualified()
            if renamed is None:
                return False
            schema.rename(table.schema, table.name, renamed[1], loc)
            return True
        p.take("COLUMN")
        old = p.name()
        if old is None or not p.take("TO"):
            return False
        new_name = p.name()
        col = _col(table, old)
        if col is not None and new_name:
            col.name = new_name
            col.locs.append(loc)
        return True
    if p.take("ALTER"):
        p.take("COLUMN")
        name = p.name()
        col = _col(table, name) if name else None
        if p.take("SET", "NOT", "NULL"):
            if col:
                col.required = True
        elif p.take("DROP", "NOT", "NULL"):
            if col:
                col.required = False
        elif p.take("SET", "DATA", "TYPE") or p.take("TYPE"):
            first = p.i
            while not p.at_end_of_item() and p.up() not in ("USING", "COLLATE"):
                tok = p.peek()
                if tok is not None and tok.kind == "op" and tok.text == "(":
                    p.skip_group()
                else:
                    p.i += 1
            if col:
                col.type = _type_text(p, first, p.i - 1)
        p.skip_item()
        if col:
            col.locs.append(loc)
        return True
    if p.take("MODIFY") or p.up() == "CHANGE":
        previous = None
        if p.take("CHANGE"):
            p.take("COLUMN")
            previous = p.name()
        else:
            p.take("COLUMN")
        changed = column_def(p, schema, loc)
        if changed is None:
            return False
        target = _col(table, previous or changed.name)
        if target is not None:
            target.name, target.type = changed.name, changed.type
            target.required = changed.required
            target.locs.append(loc)
        return True
    if p.up() in ("OWNER", "SET", "ENABLE", "DISABLE", "FORCE", "NO", "CLUSTER", "INHERIT",
                  "ATTACH", "DETACH", "REPLICA", "VALIDATE", "ENGINE", "AUTO_INCREMENT",
                  "DEFAULT", "CONVERT", "COMMENT", "ALGORITHM", "LOCK", "OF", "NOT"):
        p.skip_item()
        return True
    return False


def _col(table: Table, name: str | None) -> Column | None:
    if name is None:
        return None
    return next((c for c in table.columns if c.name.lower() == name.lower()), None)


def _alter(p: _Parser, schema: Schema, loc: Loc) -> bool:
    p.take("IF", "EXISTS")
    p.take("ONLY")
    target = p.qualified()
    if target is None:
        return False
    table = schema.find(*target)
    understood = True
    while p.peek() is not None:
        if table is None:
            # Таблицы нет в цепочке (создана не здесь): действие понятно, применять некуда.
            return True
        start = p.i
        if not _alter_action(p, table, schema, loc):
            understood = False
            p.i = start
            p.skip_item()
        table = schema.find(table.schema, table.name) or table
        if not p.op(","):
            break
    return understood


def _drop(p: _Parser, schema: Schema) -> bool:
    p.take("IF", "EXISTS")
    while True:
        target = p.qualified()
        if target is None:
            return False
        schema.drop(*target)
        if not p.op(","):
            return True


def _rename_tables(p: _Parser, schema: Schema, loc: Loc) -> bool:
    while True:
        old = p.qualified()
        if old is None or not p.take("TO"):
            return False
        new = p.qualified()
        if new is None:
            return False
        schema.rename(old[0], old[1], new[1], loc)
        if not p.op(","):
            return True


def _ignored(p: _Parser) -> bool:
    for start in _IGNORED_STARTS:
        if all(p.up(k) == w for k, w in enumerate(start)):
            return True
    return False


def _target(toks: list[Tok], fold: bool) -> tuple[str, str] | None:
    """Ключ таблицы непонятой инструкции CREATE, ALTER, DROP или RENAME TABLE: имя после
    вводных слов. Нужен только для выбора примеров."""
    i = 0
    while i < len(toks) and toks[i].up in _TABLE_LEAD:
        i += 1
    if i == 0 or "TABLE" not in {t.up for t in toks[:i]}:
        return None
    p = _Parser(toks[i:], "", fold)
    target = p.qualified()
    return None if target is None else _key(*target)


def table_of(stmt: str, fold: bool = True) -> tuple[str, str] | None:
    """Ключ таблицы инструкции CREATE, ALTER, DROP или RENAME TABLE (схема, имя) или None."""
    if len(stmt) > MAX_STATEMENT:
        return None
    return _target(tokenize(stmt), fold)


def apply(stmt: str, loc: Loc, schema: Schema) -> None:
    """Применить одну инструкцию к состоянию базы."""
    if len(stmt) > MAX_STATEMENT:
        schema.skip(loc, stmt[:200])
        return
    toks = tokenize(stmt)
    if not toks:
        return
    p = _Parser(toks, stmt, schema.fold)
    if toks[0].kind == "op":
        return
    ok = True
    if p.take("CREATE"):
        p.take("OR", "REPLACE")
        temporary = False
        while p.up() in ("GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "UNLOGGED"):
            temporary = temporary or p.up() in ("TEMP", "TEMPORARY")
            p.i += 1
        if p.take("TABLE"):
            # Временная таблица живёт до конца сеанса: в схему базы она не попадает.
            ok = True if temporary else _create(p, schema, loc)
        else:
            p.i = 0
            ok = _ignored(p)
    elif p.take("ALTER", "TABLE"):
        ok = _alter(p, schema, loc)
    elif p.take("DROP", "TABLE"):
        ok = _drop(p, schema)
    elif p.take("RENAME", "TABLE"):
        ok = _rename_tables(p, schema, loc)
    else:
        ok = _ignored(p)
    if not ok:
        schema.skip(loc, stmt, _target(toks, schema.fold))


def apply_text(text: str, path: str, schema: Schema, line_offset: int = 0) -> None:
    for line, stmt in split_statements(text):
        apply(stmt, Loc(path, line + line_offset), schema)
