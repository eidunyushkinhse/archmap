"""DDL в тегированных шаблонах миграций на JavaScript и TypeScript (ТЗ §15 п. 14 З2).

Миграции Kysely (immich `server/src/schema/migrations/*.ts`) пишут SQL текстом:
``await sql`CREATE TABLE "users" (…)`.execute(db)``. Файлы `.ts` и `.js` в каталоге с именем
`migrations` любой глубины, где есть ``sql` ``, отдают содержимое шаблонов `sql` (и
`sql<Тип>`) и текстовых аргументов `sql.raw(`…`)` разборщику DDL (`sqlddl.py`) в порядке
имён файлов с числами по значению; набор — каталог файлов. Тело функции `down` (откат) не
читается. Вставка `${…}` заменяется заглушкой: если она стоит на месте имени таблицы или
колонки, запись идёт в `hints.dynamic_names`, а таблица или колонка с таким именем в схему
не попадает; в типе колонки остаётся текст вставки. Диалект — по драйверу в package.json
пакета файла (`pg`, `postgres` — PostgreSQL, `mysql2` — MySQL, `better-sqlite3` — SQLite),
иначе по типам колонок. Шаблоны ищутся по маске кода (`codetext`): шаблон в комментарии
или в строке не читается.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from dataclasses import dataclass, field

from archmap_scan import codebase, codetext, dialect, paths, sqlddl, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, Table, TableSet
from archmap_scan.parsers import sql
from archmap_scan.walk import Files

NAME = "kysely"
_DIR = "migrations"
_NEEDLE = "sql`"
_TAG = re.compile(
    r"\bsql(?:[ \t]{0,20}<[^<>`\n]{0,200}>)?[ \t]{0,20}`"
    r"|\bsql\.raw[ \t]{0,20}\([ \t\r\n]{0,200}`"
)
# Объявление отката: функция, свойство или переменная со стрелкой, метод класса. Совпадение
# кончается сразу за «(» параметров.
_DOWN = re.compile(
    r"\bfunction[ \t]{1,20}down[ \t]{0,20}\("
    r"|\bdown[ \t]{0,20}[:=][ \t]{0,20}(?:async[ \t]{1,20})?(?:function\b[^(\n]{0,100})?\("
    r"|\bdown[ \t]{0,20}\((?=[^()\n]{0,200}\)[ \t]{0,20}(?::[^{;\n]{0,200})?\{)"
)
# Инструкции шаблона, которые читаются: DDL. Прочее (запросы, фрагменты `now()` для
# построителя) структуры таблиц не меняет и в счёт пропусков не идёт.
_DDL = frozenset({"CREATE", "ALTER", "DROP", "RENAME"})
_FIRST_WORD = re.compile(r"[A-Za-z]{1,20}")
# Заглушка вставки: имя SQL, которое не встретится в настоящей схеме.
_STUB = "archmap_dyn_"
_STUB_NAME = re.compile(_STUB + r"[0-9]+")
_MAX_HOLE = 2000
# Пределы на файл: шаблонов, инструкций (по «;») и вставок. В настоящих миграциях их сотни
# (InitialMigration immich — 300 шаблонов); файл сверх предела — враждебный вход, он
# считается непрочитанным.
_MAX_TEMPLATES = 5000
_MAX_MARKS = 20_000
_DRIVERS = (
    ("pg", dialect.POSTGRESQL), ("postgres", dialect.POSTGRESQL),
    ("kysely-postgres-js", dialect.POSTGRESQL), ("mysql2", dialect.MYSQL),
    ("better-sqlite3", dialect.SQLITE),
)


def is_migration(rel: str) -> bool:
    """Файл кода JavaScript или TypeScript в каталоге migrations любой глубины."""
    if not codebase.is_code_file(rel, codebase.NODE) or rel.lower().endswith(".d.ts"):
        return False
    return any(seg.lower() == _DIR for seg in rel.split("/")[:-1])


@dataclass
class _Chain:
    """Набор миграций: состояние базы и вставки по заглушкам (текст выражения и место)."""

    schema: sqlddl.Schema
    stubs: dict[str, tuple[str, Loc]] = field(default_factory=dict)
    hints: list[Hint] = field(default_factory=list)
    seen: set[tuple[str, str]] = field(default_factory=set)
    # Диалект по типам колонок (dialect.sql_types) и его место: если драйвера в package.json нет.
    types: tuple[str, Loc] | None = None

    def hint(self, stub: str, loc: Loc | None = None) -> None:
        expr, where = self.stubs[stub]
        source = str(loc or where)
        if (expr, source) in self.seen:
            return
        self.seen.add((expr, source))
        self.hints.append(Hint("dynamic_names", {
            "kind": "table", "name": "${" + expr + "}", "reason": texts.REASON_DYNAMIC_TABLE,
            "source": source,
        }))


def _skip_parens(mask: str, pos: int) -> int:
    """Позиция после скобки, закрывающей открытую до pos (pos — сразу за «(»)."""
    depth = 1
    while pos < len(mask) and depth:
        ch = mask[pos]
        depth += 1 if ch == "(" else -1 if ch == ")" else 0
        pos += 1
    return pos


def _down_ranges(mask: str) -> list[tuple[int, int]]:
    """Участки маски с функцией down по возрастанию, без пересечений: от объявления до
    закрывающей скобки тела (у стрелки без фигурных скобок — до конца инструкции)."""
    out: list[tuple[int, int]] = []
    # Позиция, после которой «{» в маске нет: поиск не повторяется для каждого совпадения.
    no_brace = len(mask) + 1
    for m in _DOWN.finditer(mask):
        if out and m.start() < out[-1][1]:
            continue
        pos = _skip_parens(mask, m.end())
        brace = -1 if pos >= no_brace else mask.find("{", pos)
        if brace < 0:
            no_brace = min(no_brace, pos)
        arrow = mask.find("=>", pos, brace) if brace >= 0 else -1
        if brace < 0 or (arrow >= 0 and mask[arrow + 2:brace].strip()):
            stop = mask.find(";", pos)
            out.append((m.start(), len(mask) if stop < 0 else stop + 1))
            continue
        depth = 0
        end = len(mask)
        for i in range(brace, len(mask)):
            ch = mask[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        out.append((m.start(), end))
    return out


def _hole_end(raw: str, pos: int) -> int:
    """Позиция после «}», закрывающей вставку, которая начинается в pos (сразу за «${»)."""
    depth = 1
    limit = min(len(raw), pos + _MAX_HOLE)
    while pos < limit:
        ch = raw[pos]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return pos + 1
        pos += 1
    return limit


def _template_sql(raw: str, rel: str, line: int, chain: _Chain) -> str:
    """Текст шаблона для разбора DDL: вставки — заглушки той же высоты в строках,
    экранированные «`», «$» и «\\» — как написаны в SQL."""
    out: list[str] = []
    i = 0
    while True:
        j = raw.find("${", i)
        if j < 0:
            out.append(raw[i:])
            break
        out.append(raw[i:j])
        line += raw.count("\n", i, j)
        k = _hole_end(raw, j + 2)
        stub = f"{_STUB}{len(chain.stubs)}"
        expr = " ".join(raw[j + 2:k - 1].split())[:80]
        chain.stubs[stub] = (expr, Loc(rel, line))
        breaks = raw.count("\n", j, k)
        out.append(stub + "\n" * breaks)
        line += breaks
        i = k
    text = "".join(out)
    if "\\" in text:
        text = text.replace("\\`", "`").replace("\\$", "$").replace("\\\\", "\\")
    return text


def _apply(text: str, rel: str, offset: int, chain: _Chain) -> None:
    schema = chain.schema
    for line, stmt in sqlddl.split_statements(text):
        word = _FIRST_WORD.match(stmt)
        if word is None or word.group().upper() not in _DDL:
            continue
        loc = Loc(rel, line + offset)
        if _STUB in stmt:
            target = sqlddl.table_of(stmt, schema.fold)
            stub = _STUB_NAME.search(target[1]) if target is not None else None
            if stub is not None:
                chain.hint(stub.group(), loc)
        sqlddl.apply(stmt, loc, schema)


def _file(files: Files, rel: str, chain: _Chain) -> None:
    text = files.read(rel, keep=False)
    if text is None or _NEEDLE not in text:
        return
    if text.count(";") > _MAX_MARKS or text.count("${") > _MAX_MARKS:
        files.refuse(rel)
        return
    code = codetext.load(files, rel, text, codetext.JS)
    if code is None:
        return
    downs = _down_ranges(code.mask)
    starts = [a for a, _ in downs]
    for n, m in enumerate(_TAG.finditer(code.mask)):
        if n >= _MAX_TEMPLATES:
            files.refuse(rel)
            return
        start = m.end() - 1
        k = bisect_right(starts, start) - 1
        if k >= 0 and start < downs[k][1]:
            continue
        end = code.mask.find("`", start + 1)
        if end < 0:
            return
        line = code.line(start)
        body = _template_sql(text[start + 1:end], rel, line, chain)
        if chain.types is None:
            hit = dialect.sql_types(body)
            if hit is not None:
                chain.types = (hit[0], Loc(rel, line - 1 + hit[1]))
        _apply(body, rel, line - 1, chain)


def _dynamic(chain: _Chain) -> None:
    """Таблицы и колонки, имя которых — вставка, в схему не попадают: подсказка вместо них.
    В типе колонки заглушка заменяется текстом вставки."""
    schema = chain.schema
    for key, table in list(schema.tables.items()):
        stub = _STUB_NAME.search(table.name)
        if stub is not None:
            del schema.tables[key]
            chain.hint(stub.group())
            continue
        stub = _STUB_NAME.search(table.schema or "")
        if stub is not None:
            chain.hint(stub.group())
            table.schema = None
        _columns(table, chain)


def _columns(table: Table, chain: _Chain) -> None:
    kept = []
    for col in table.columns:
        stub = _STUB_NAME.search(col.name)
        if stub is not None:
            chain.hint(stub.group())
            continue
        ref = _STUB_NAME.search(col.references or "")
        if ref is not None:
            chain.hint(ref.group())
            col.references = None
        if col.type and _STUB in col.type:
            col.type = _STUB_NAME.sub(lambda m: "${" + chain.stubs[m.group()][0] + "}", col.type)
        kept.append(col)
    table.columns = kept


def _dialect(files: Files, ctx: Context, rel: str) -> tuple[str, Loc] | None:
    for pkg in codebase.owner_packages(files, ctx, rel, codebase.NODE):
        for dep, name in _DRIVERS:
            if dep in pkg.deps:
                text = files.read(pkg.path) or ""
                hit = text.find(f'"{dep}"')
                line = text.count("\n", 0, hit) + 1 if hit >= 0 else 1
                return name, Loc(pkg.path, line)
    return None


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not codebase.stack_present(files, ctx, codebase.NODE):
        return found
    found.applied.add(NAME)
    sets: dict[str, list[str]] = {}
    for rel in files.select(is_migration):
        if not files.skip_dev_code(rel):
            sets.setdefault(paths.parent(rel), []).append(rel)
    for folder in sorted(sets):
        chain_files = sorted(sets[folder], key=sql.natural_key)
        hit = _dialect(files, ctx, chain_files[0])
        keep_case = hit is not None and hit[0] in (dialect.MYSQL, dialect.SQLITE)
        chain = _Chain(sqlddl.Schema(fold=not keep_case))
        for rel in chain_files:
            _file(files, rel, chain)
        _dynamic(chain)
        schema = chain.schema
        found.hints += chain.hints
        if not schema.tables and not schema.skipped and not schema.dropped:
            continue
        ts = TableSet(
            parser=NAME, dir=folder, tables=list(schema.tables.values()),
            dropped=schema.dropped, skipped=schema.skipped,
            skipped_examples=schema.examples, queried=schema.from_query(),
        )
        hit = hit or chain.types
        if hit is not None:
            ts.dialect, ts.dialect_loc = hit
        found.table_sets.append(ts)
    return found
