"""Превью пометок обращений для редактора схемы логики (пивот §9 plan-db-docs.md).

Единственная ручка: разобрать присланный текст и сказать по каждой пометке, нашлась
ли её цель. Тот же резолв, что у обратного индекса базы (db_docs.list_usage) и у
алертов — три потребителя одной чистой функции, расходиться им не на чем.

Читают ОБЕ роли: плашка живёт в редакторе, но док открывает и наблюдатель.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.data_refs import (
    CatalogTable,
    catalog_for_project,
    parse_data_refs,
    resolve_data_refs,
)
from app.database import get_db
from app.deps import get_current_project
from app.models.project import Project
from app.models.user import User
from app.schemas.data_refs import DataRefPreviewIn, DataRefPreviewItem

router = APIRouter(prefix="/data-refs", tags=["data-refs"])


def _db_short_name(node_paths: dict[uuid.UUID, str], node_id: uuid.UUID) -> str:
    """Короткая подпись узла-БД — ПОСЛЕДНИЙ сегмент пути.

    Плашке нужен не адрес объекта в дереве, а имя базы: «Платформа / Хранилище» →
    «Хранилище». Полный путь остаётся языком САМОЙ пометки (квалификатор), но в
    подписи он только шумит.
    """
    return node_paths.get(node_id, "?").rpartition(" / ")[2]


@router.post("/preview", response_model=list[DataRefPreviewItem])
def preview_data_refs(
    payload: DataRefPreviewIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[DataRefPreviewItem]:
    """Что каждая пометка присланного текста означает прямо сейчас.

    Порядок ответа = порядок появления пометок в тексте (его задаёт parse_data_refs):
    плашка читается сверху вниз вместе с диаграммой.
    """
    tables, node_paths = catalog_for_project(db, project.id)
    by_id: dict[uuid.UUID, CatalogTable] = {t.id: t for t in tables}

    out: list[DataRefPreviewItem] = []
    for ref in resolve_data_refs(parse_data_refs(payload.content), tables, node_paths):
        table = by_id.get(ref.table_id) if ref.table_id is not None else None
        target: str | None = None
        if table is not None:
            # unknown_column: таблица-то нашлась — её и показываем (обращение считается
            # к таблице ЦЕЛИКОМ), а несуществующую колонку в подпись не тащим —
            # column_name у такого резолва пуст.
            label = f"{table.name}.{ref.column_name}" if ref.column_name else table.name
            target = f"{_db_short_name(node_paths, table.node_id)} · {label}"
        out.append(
            DataRefPreviewItem(
                ref=ref.ref, mode=ref.mode, status=ref.status, target=target
            )
        )
    return out
