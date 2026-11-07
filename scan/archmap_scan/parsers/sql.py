"""SQL DDL миграций (ТЗ §6.3): *.sql в каталогах migrations, migrate, db, sql, schema,
database, Flyway V*__*.sql, golang-migrate *.up.sql, Diesel up.sql, sqlx.

Набор миграций — каталог файлов (у Diesel — каталог над up.sql). Файлы набора применяются
по порядку имён с числами по значению (V2 раньше V10), откаты *.down.sql и down.sql и
Flyway undo U*__ не читаются. Итог — таблицы после всей цепочки. Соседние каталоги наборов с
именами диалектов — одна база (_one_database).
"""

from __future__ import annotations

import re

from archmap_scan import dialect, paths, sqlddl, texts
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, Loc, TableSet
from archmap_scan.walk import Files

NAME = "sql"
SQL_DIRS = frozenset({"migrations", "migrate", "db", "sql", "schema", "database"})
_FLYWAY = re.compile(r"[VR][0-9][0-9._]*__.+\.sql", re.IGNORECASE)
_UNDO = re.compile(r"U[0-9][0-9._]*__.+\.sql", re.IGNORECASE)
_CHUNKS = re.compile(r"[0-9]+|[^0-9]+")
_KEEP_CASE = frozenset({dialect.MYSQL, dialect.MARIADB, dialect.SQLITE, dialect.SQLSERVER})


def is_migration(rel: str) -> bool:
    name = paths.name(rel)
    low = name.lower()
    if not low.endswith(".sql") or low.endswith(".down.sql") or low == "down.sql":
        return False
    if _UNDO.fullmatch(name):
        return False
    if _FLYWAY.fullmatch(name) or low.endswith(".up.sql") or low == "up.sql":
        return True
    return any(seg.lower() in SQL_DIRS for seg in rel.split("/")[:-1])


def set_dir(rel: str) -> str:
    """Каталог набора миграций: у Diesel (каталог/миграция/up.sql) — каталог над миграцией."""
    folder = paths.parent(rel)
    if paths.name(rel).lower() == "up.sql" and folder:
        return paths.parent(folder)
    return folder


def natural_key(rel: str) -> tuple[tuple[int, int | str], ...]:
    """Ключ сортировки, где числа сравниваются по значению: V2 раньше V10."""
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.lower())
        for part in _CHUNKS.findall(rel)
    )


# Каталоги наборов с именем диалекта (ТЗ §15 п. 12 С11): соседние каталоги описывают одну
# базу на разных диалектах (db/hsqldb и db/mysql у сервисов Petclinic). Встраиваемые —
# для разработки и тестов; серверный задаёт вид, если типы колонок его не выдали.
_EMBEDDED_DIRS = frozenset({"hsqldb", "h2", "sqlite", "derby"})
_SERVER_DIRS = {
    "mysql": dialect.MYSQL, "mariadb": dialect.MARIADB, "postgres": dialect.POSTGRESQL,
    "postgresql": dialect.POSTGRESQL, "pgsql": dialect.POSTGRESQL, "mssql": dialect.SQLSERVER,
    "sqlserver": dialect.SQLSERVER, "oracle": dialect.ORACLE,
}


def _dialect_dir(folder: str) -> str:
    return paths.name(folder).lower()


def _one_database(made: dict[str, TableSet], firsts: dict[str, str], found: Findings) -> None:
    """Соседние каталоги диалектов с серверным среди них — одна база: остаётся набор
    первого по алфавиту серверного диалекта, остальные уходят в подсказки."""
    groups: dict[str, list[str]] = {}
    for folder in made:
        name = _dialect_dir(folder)
        if name in _EMBEDDED_DIRS or name in _SERVER_DIRS:
            groups.setdefault(paths.parent(folder), []).append(folder)
    for folders in groups.values():
        servers = sorted((f for f in folders if _dialect_dir(f) in _SERVER_DIRS), key=_dialect_dir)
        if len(folders) < 2 or not servers:
            continue
        chosen = servers[0]
        ts = made[chosen]
        if ts.dialect is None:
            ts.dialect = _SERVER_DIRS[_dialect_dir(chosen)]
            ts.dialect_loc = Loc(firsts[chosen], 1)
        for folder in sorted(folders):
            if folder == chosen:
                continue
            del made[folder]
            reason = (
                texts.embedded_database(paths.show_dir(chosen))
                if _dialect_dir(folder) in _EMBEDDED_DIRS
                else texts.other_dialect(paths.show_dir(chosen))
            )
            found.hints.append(Hint("unassigned", {
                "kind": "database", "name": paths.show_dir(folder), "reason": reason,
                "source": f"{firsts[folder]}:1",
            }))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    made: dict[str, TableSet] = {}
    firsts: dict[str, str] = {}
    sets: dict[str, list[str]] = {}
    for rel in files.select(is_migration):
        sets.setdefault(set_dir(rel), []).append(rel)
    for folder in sorted(sets):
        chain = [(rel, files.read(rel)) for rel in sorted(sets[folder], key=natural_key)]
        found_dialect: tuple[str, Loc] | None = None
        for rel, text in chain:
            hit = dialect.sql_types(text) if text is not None else None
            if hit:
                found_dialect = (hit[0], Loc(rel, hit[1]))
                break
        # Имена без кавычек складываются в нижний регистр, как в PostgreSQL; MySQL и
        # MariaDB хранят их как написано.
        schema = sqlddl.Schema(fold=found_dialect is None or found_dialect[0] not in _KEEP_CASE)
        for rel, text in chain:
            if text is not None:
                sqlddl.apply_text(text, rel, schema)
        if not schema.tables and not schema.skipped and not schema.dropped:
            continue
        firsts[folder] = chain[0][0]
        made[folder] = TableSet(
            parser=NAME, dir=folder, tables=list(schema.tables.values()),
            dropped=schema.dropped, skipped=schema.skipped,
            skipped_examples=schema.examples, queried=schema.from_query(),
            dialect=found_dialect[0] if found_dialect else None,
            dialect_loc=found_dialect[1] if found_dialect else None,
        )
    _one_database(made, firsts, found)
    found.table_sets.extend(made.values())
    return found
