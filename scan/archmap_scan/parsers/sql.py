"""SQL DDL миграций (ТЗ §6.3): *.sql в каталогах migrations, migrate, db, sql, schema,
database, Flyway V*__*.sql, golang-migrate *.up.sql, Diesel up.sql, sqlx.

Набор миграций — каталог файлов (у Diesel — каталог над up.sql). Файлы набора применяются
по порядку имён с числами по значению (V2 раньше V10), откаты *.down.sql и down.sql и
Flyway undo U*__ не читаются. Итог — таблицы после всей цепочки.
"""

from __future__ import annotations

import re

from archmap_scan import paths, sqlddl
from archmap_scan.context import Context
from archmap_scan.model import Findings, TableSet
from archmap_scan.walk import Files

NAME = "sql"
SQL_DIRS = frozenset({"migrations", "migrate", "db", "sql", "schema", "database"})
_FLYWAY = re.compile(r"[VR][0-9][0-9._]*__.+\.sql", re.IGNORECASE)
_UNDO = re.compile(r"U[0-9][0-9._]*__.+\.sql", re.IGNORECASE)
_CHUNKS = re.compile(r"[0-9]+|[^0-9]+")


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


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    sets: dict[str, list[str]] = {}
    for rel in files.select(is_migration):
        sets.setdefault(set_dir(rel), []).append(rel)
    for folder in sorted(sets):
        schema = sqlddl.Schema()
        for rel in sorted(sets[folder], key=natural_key):
            text = files.read(rel)
            if text is None:
                continue
            sqlddl.apply_text(text, rel, schema)
        if not schema.tables and not schema.skipped and not schema.dropped:
            continue
        found.table_sets.append(TableSet(
            parser=NAME, dir=folder, tables=list(schema.tables.values()),
            dropped=schema.dropped, skipped=schema.skipped,
            skipped_examples=list(schema.examples),
        ))
    return found
