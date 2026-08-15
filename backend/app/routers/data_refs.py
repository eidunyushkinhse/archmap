"""Превью пометок обращений для редактора схемы логики (пивот §9 plan-db-docs.md).

Единственная ручка: разобрать присланный текст и сказать по каждой пометке, нашлась
ли её цель — и у данных («читает:/пишет:» → таблица), и у событий
(«публикует:/потребляет:» → канал брокера). Тот же резолв, что у обратных индексов
базы и брокера и у алертов — потребители одной чистой функции, расходиться им не на
чем; каналы плашка понимает автоматически, ровно поэтому резолвер и един.

Читают ОБЕ роли: плашка живёт в редакторе, но док открывает и наблюдатель.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.data_refs import (
    CatalogChannel,
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


def _owner_short_name(node_paths: dict[uuid.UUID, str], node_id: uuid.UUID) -> str:
    """Короткая подпись узла-владельца (БД или брокера) — ПОСЛЕДНИЙ сегмент пути.

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
    tables, channels, node_paths = catalog_for_project(db, project.id)
    by_id: dict[uuid.UUID, CatalogTable] = {t.id: t for t in tables}
    ch_by_id: dict[uuid.UUID, CatalogChannel] = {c.id: c for c in channels}

    out: list[DataRefPreviewItem] = []
    for ref in resolve_data_refs(
        parse_data_refs(payload.content), tables, channels, node_paths
    ):
        table = by_id.get(ref.table_id) if ref.table_id is not None else None
        channel = ch_by_id.get(ref.channel_id) if ref.channel_id is not None else None
        target: str | None = None
        if table is not None:
            # unknown_column: таблица-то нашлась — её и показываем (обращение считается
            # к таблице ЦЕЛИКОМ), а несуществующую колонку в подпись не тащим —
            # column_name у такого резолва пуст.
            label = f"{table.name}.{ref.column_name}" if ref.column_name else table.name
            target = f"{_owner_short_name(node_paths, table.node_id)} · {label}"
        elif channel is not None:
            # Зеркало табличной ветки: unknown_field показывает канал целиком —
            # поля-то нет, а канал есть, и сверяться человеку нужно с ним.
            label = f"{channel.name}.{ref.field_name}" if ref.field_name else channel.name
            target = f"{_owner_short_name(node_paths, channel.node_id)} · {label}"
        out.append(
            DataRefPreviewItem(
                ref=ref.ref, mode=ref.mode, status=ref.status, target=target
            )
        )
    return out
