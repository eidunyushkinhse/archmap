"""Превью пометок обращений для редактора схемы логики (пивот §9 plan-db-docs.md).

Единственная ручка: разобрать присланный текст и сказать по каждой пометке, нашлась
ли её цель — у данных («читает:/пишет:» → таблица), у событий
(«публикует:/потребляет:» → канал брокера) и у конфигурации («зависит от:» → параметр
самого узла). Тот же резолв, что у обратных индексов базы и брокера и у алертов —
потребители одной чистой функции, расходиться им не на чем; новые семьи плашка
понимает автоматически, ровно поэтому резолвер и един.

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
    tables, channels, params_by_node, node_paths = catalog_for_project(db, project.id)
    by_id: dict[uuid.UUID, CatalogTable] = {t.id: t for t in tables}
    ch_by_id: dict[uuid.UUID, CatalogChannel] = {c.id: c for c in channels}
    # Конфигурация ВЛАДЕЛЬЦА дока. Владельца может не быть (старый клиент не шлёт
    # node_id) — тогда конфигурационные пометки из ответа выпадают: см. ниже.
    owner_params = (
        params_by_node.get(payload.node_id, {}) if payload.node_id is not None else {}
    )

    out: list[DataRefPreviewItem] = []
    for ref in resolve_data_refs(
        parse_data_refs(payload.content),
        tables,
        channels,
        node_paths,
        owner_params=owner_params,
    ):
        if ref.mode == "config" and payload.node_id is None:
            # Владельца не назвали — судить не о чем. Промолчать честнее, чем сказать
            # «параметра нет»: мы его не искали.
            continue
        table = by_id.get(ref.table_id) if ref.table_id is not None else None
        channel = ch_by_id.get(ref.channel_id) if ref.channel_id is not None else None
        target: str | None = None
        if ref.param_id is not None:
            # Владелец параметра — сам узел, чей док открыт: его имя в подписи было бы
            # шумом, а вот РАЗДЕЛ, куда идти сверяться, назвать полезно.
            target = f"Конфигурация · {ref.ref}"
        elif table is not None:
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
