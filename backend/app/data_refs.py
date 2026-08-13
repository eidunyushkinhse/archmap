"""Пометки обращений к данным в тексте схем логики (пивот §9 plan-db-docs.md).

Обращение «операция читает/пишет таблицу.колонку» живёт ОДИН раз — строкой в самой
диаграмме: A["Списать средства<br>пишет: accounts.balance"]. Здесь — разбор таких
пометок и их резолв в таблицы структуры. Паттерн doc-комментариев: проза для
человека, пометка в прозе — для машины; индекс из неё производен и разойтись с
текстом не может.

Обе функции ЧИСТЫЕ. Резолв зовётся на чтении (usage, превью, алерты), а не на
записи: он — функция от (пометки, каталог таблиц, пути узлов), и это убирает все
точки инвалидации (переименование таблицы/раздела/узла, удаление колонки).
"""

import re
import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy.orm import Session

from app.docs_import import _node_paths
from app.models.db_table import DbTable
from app.models.node import Node

Mode = Literal["read", "write"]
RefStatus = Literal["ok", "unknown_table", "ambiguous", "unknown_column"]

# Маркер пометки: слово + двоеточие. Русский и английский — проекты бывают и с
# латинскими подписями. \b отсекает «перечитает:» и подобные вхождения внутри слова.
_MARKER_MODE: dict[str, Mode] = {
    "читает": "read",
    "reads": "read",
    "пишет": "write",
    "writes": "write",
}
# Хвост — до терминатора: конец строки, кавычка подписи, закрывающая скобка
# mermaid-вершины или начало тега (<br>). mermaid НЕ парсим: пометка в подписи ребра
# или заголовке subgraph тоже считается — это дешевле и предсказуемее разбора
# синтаксиса, а слово «читает:» в прозе трактуем как обещание факта (spec.md).
_MENTION = re.compile(r"(?i)\b(читает|пишет|reads|writes)\s*:\s*([^\n\"\]\)\}<]*)")


@dataclass(frozen=True)
class DataRefIn:
    """Разобранная пометка: как написано в доке + режим."""

    ref: str
    mode: Mode


def parse_data_refs(content: str) -> list[DataRefIn]:
    """Извлечь пометки из текста дока. Дедуп по (ссылка, режим), порядок появления."""
    out: list[DataRefIn] = []
    seen: set[tuple[str, str]] = set()
    for m in _MENTION.finditer(content):
        mode = _MARKER_MODE[m.group(1).lower()]
        for raw in m.group(2).split(","):
            ref = " ".join(raw.split())  # схлопнуть переносы/двойные пробелы
            if not ref:
                continue
            key = (ref, mode)
            if key in seen:
                continue
            seen.add(key)
            out.append(DataRefIn(ref=ref, mode=mode))
    return out


@dataclass(frozen=True)
class CatalogTable:
    """Таблица структуры в виде, достаточном для резолва (без ORM)."""

    id: uuid.UUID
    node_id: uuid.UUID
    schema_name: str
    name: str
    columns: dict[str, uuid.UUID]  # имя колонки → id


@dataclass(frozen=True)
class ResolvedRef:
    ref: str
    mode: Mode
    status: RefStatus
    # Заполнены при status ok/unknown_column (unknown_column = таблица нашлась,
    # колонки нет — обращение считается к таблице целиком, но подсвечивается).
    table_id: uuid.UUID | None = None
    column_id: uuid.UUID | None = None
    column_name: str | None = None


# Голая часть ссылки — токен без пробелов: буквы/цифры/_/-/точки. Проза после
# маркера («читает: договор из архива») токеном не является и резолв не пройдёт —
# осознанно: маркер обещает факт, невыполненное обещание должно быть видно.
_TOKEN = re.compile(r"^[\w.\-]+$")


def _node_matches(path: str, qualifier: str) -> bool:
    """Квалификатор узла: полный путь, суффикс пути по границе « / » или голое имя."""
    if path == qualifier or path.endswith(f" / {qualifier}"):
        return True
    return path.rpartition(" / ")[2] == qualifier


def resolve_data_refs(
    refs: list[DataRefIn],
    tables: list[CatalogTable],
    node_paths: dict[uuid.UUID, str],
) -> list[ResolvedRef]:
    """Резолв пометок в таблицы каталога. Никакой магии предпочтений: неоднозначное
    имя требует квалификатора «БД / таблица», а не угадывается по связям."""
    out: list[ResolvedRef] = []
    for r in refs:
        out.append(_resolve_one(r, tables, node_paths))
    return out


def _resolve_one(
    r: DataRefIn, tables: list[CatalogTable], node_paths: dict[uuid.UUID, str]
) -> ResolvedRef:
    qualifier, _, bare = r.ref.rpartition(" / ")
    parts = bare.split(".")
    # Пустой сегмент («orders.», «.status», «a..b») — битая ссылка, а не «таблица
    # с неизвестной колонкой»: гадать о намерении не берёмся.
    if not _TOKEN.match(bare) or any(not p for p in parts):
        return ResolvedRef(ref=r.ref, mode=r.mode, status="unknown_table")

    scope = (
        [t for t in tables if _node_matches(node_paths.get(t.node_id, ""), qualifier)]
        if qualifier
        else tables
    )

    # Гипотезы (раздел, таблица, колонка). У «x.y» их ДВЕ: «таблица x, колонка y» и
    # «раздел x, таблица y» — обе сработали → неоднозначно, молча выбирать нельзя.
    hypos: list[tuple[str | None, str, str | None]]
    if len(parts) == 1:
        hypos = [(None, parts[0], None)]
    elif len(parts) == 2:
        hypos = [(None, parts[0], parts[1]), (parts[0], parts[1], None)]
    elif len(parts) == 3:
        hypos = [(parts[0], parts[1], parts[2])]
    else:
        return ResolvedRef(ref=r.ref, mode=r.mode, status="unknown_table")

    hits: list[tuple[CatalogTable, str | None]] = []
    for schema, name, column in hypos:
        for t in scope:
            if t.name == name and (schema is None or t.schema_name == schema):
                hits.append((t, column))

    if not hits:
        return ResolvedRef(ref=r.ref, mode=r.mode, status="unknown_table")
    if len(hits) > 1:
        return ResolvedRef(ref=r.ref, mode=r.mode, status="ambiguous")

    table, column = hits[0]
    if column is None:
        return ResolvedRef(ref=r.ref, mode=r.mode, status="ok", table_id=table.id)
    col_id = table.columns.get(column)
    if col_id is None:
        return ResolvedRef(
            ref=r.ref, mode=r.mode, status="unknown_column", table_id=table.id
        )
    return ResolvedRef(
        ref=r.ref,
        mode=r.mode,
        status="ok",
        table_id=table.id,
        column_id=col_id,
        column_name=column,
    )


# ── ORM-адаптер: каталог из БД ────────────────────────────────────────────────
# Единственное место, где чистый резолв встречается с базой. Кэша нет и не будет
# (§9.3 плана): каталог собирается на каждом чтении — сотни таблиц в памяти дешевле
# любой инвалидации (переименование таблицы/раздела/узла, удаление колонки).


def catalog_for_project(
    db: Session, project_id: uuid.UUID
) -> tuple[list[CatalogTable], dict[uuid.UUID, str]]:
    """Таблицы проекта в виде каталога + полные пути его узлов (материал резолва).

    Каталог — по ВСЕМУ проекту, а не по одному узлу: неоднозначность имени есть
    свойство проекта, и «orders» обязано считаться неоднозначным независимо от
    того, чью страницу сейчас читают. Пути — те же, что у импорта (`_node_paths`):
    квалификатор пометки пишется так же, как адрес узла в пакете агента.
    """
    nodes: list[Node] = db.query(Node).filter(Node.project_id == project_id).all()
    flat, fulls, _by_bare, _by_path = _node_paths(nodes)
    node_paths: dict[uuid.UUID, str] = {n.id: fulls[i] for i, n in enumerate(flat)}

    tables: list[DbTable] = (
        db.query(DbTable)
        .join(Node, Node.id == DbTable.node_id)
        .filter(Node.project_id == project_id)
        .all()
    )
    catalog = [
        CatalogTable(
            id=t.id,
            node_id=t.node_id,
            schema_name=t.schema_name,
            name=t.name,
            columns={c.name: c.id for c in t.columns},
        )
        for t in tables
    ]
    return catalog, node_paths
