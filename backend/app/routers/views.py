"""Раскладка видов (R3 вид-центричного движка): один батч-эндпоинт записи.

Вид = контейнер уровня ("root" — корневой вид проекта). Тело — карта
item_id → payload (null — удалить строку). Заменяет прежние три PUT
(ghost-positions / ghost-edge-handles / edge-waypoints) и PATCH-поля
раскладки узлов/рёбер: и позиции, и геометрия пучков идут одним путём.

Апсерт — на уровне приложения (SELECT существующих ключей + UPDATE/INSERT в
одной транзакции): ON CONFLICT с NULL view_id (корневой вид) вёл бы себя
по-разному в Postgres (NULLS NOT DISTINCT) и SQLite тестов. Редактор один
(MVP, last-write-wins) — гонки не разруливаем.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import require_architect
from app.database import get_db
from app.deps import get_current_project
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.schemas.node import ViewLayoutBatch

router = APIRouter(prefix="/views", tags=["views"])


def parse_view_id(view_id: str) -> uuid.UUID | None:
    """"root" → None (корневой вид); иначе uuid контейнера уровня."""
    if view_id == "root":
        return None
    try:
        return uuid.UUID(view_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Некорректный id вида") from e


@router.put("/{view_id}/layout", status_code=204)
def save_view_layout(
    view_id: str,
    payload: ViewLayoutBatch,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> None:
    vid = parse_view_id(view_id)
    if not payload.items:
        return
    item_ids = list(payload.items.keys())
    q = db.query(ViewLayoutItem).filter(
        ViewLayoutItem.project_id == project.id,
        ViewLayoutItem.item_id.in_(item_ids),
        ViewLayoutItem.view_id.is_(None) if vid is None else ViewLayoutItem.view_id == vid,
    )
    existing = {r.item_id: r for r in q.all()}
    for item_id, item in payload.items.items():
        row = existing.get(item_id)
        if item is None:
            # null — сброс: строка удаляется (объект возвращается к авто-геометрии)
            if row is not None:
                db.delete(row)
            continue
        data = item.model_dump(exclude_none=True, mode="json")
        if row is not None:
            row.payload = data
        else:
            db.add(
                ViewLayoutItem(
                    project_id=project.id, view_id=vid, item_id=item_id, payload=data
                )
            )
    # раскладка — не смысловая правка: updated_at проекта не трогаем
    # (то же поведение, что у прежних PUT ghost-positions/edge-waypoints)
    db.commit()
