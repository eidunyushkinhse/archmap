"""Раскладка видов (R3 вид-центричного движка): один батч-эндпоинт записи.

Вид = контейнер уровня ("root" — корневой вид проекта). Тело — карта
item_id → payload (null — удалить строку). Заменяет прежние три PUT
(ghost-positions / ghost-edge-handles / edge-waypoints) и PATCH-поля
раскладки узлов/рёбер: и позиции, и геометрия пучков идут одним путём.

Апсерт — на уровне приложения (SELECT существующих ключей + UPDATE/INSERT в
одной транзакции): ON CONFLICT с NULL view_id (корневой вид) вёл бы себя
по-разному в Postgres (NULLS NOT DISTINCT) и SQLite тестов.

Конкурентные сессии (этап 0, docs/archive/plan-concurrency.md): строка версии вида
берётся FOR UPDATE до применения батча — она и fence (устаревший base_version →
409, клиент ресинкается и переигрывает интент пользователя), и мьютекс
писателей вида (конкурентные батчи сериализуются, гонка INSERT одного ключа
view_layout исчезла). Успешная запись бампает версию вида и graph_rev проекта;
ответ отдаёт оба счётчика (клиент отслеживает их без рефетча).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.deps import get_current_project, require_project_editor, scoped_node
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.schemas.node import ViewLayoutBatch, ViewLayoutResult, ViewStateResponse
from app.view_state import bump_graph_rev, current_version, lock_view_state

router = APIRouter(prefix="/views", tags=["views"])


def parse_view_id(view_id: str) -> uuid.UUID | None:
    """"root" → None (корневой вид); иначе uuid контейнера уровня."""
    if view_id == "root":
        return None
    try:
        return uuid.UUID(view_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Некорректный id вида") from e


@router.get("/{view_id}/state", response_model=ViewStateResponse)
def get_view_state(
    view_id: str,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> ViewStateResponse:
    """Лёгкий опрос свежести (поллинг этапа 1): версия вида + курсор проекта.

    Доступен любой роли в проекте — читатель поллит наравне с редактором. Удалённый
    вид здесь не проверяется (версия просто 0): арбитр существования — рефетч
    графа, который на мёртвом виде отдаст 404.
    """
    vid = parse_view_id(view_id)
    return ViewStateResponse(
        version=current_version(db, project.id, vid),
        graph_rev=project.graph_rev,
        meta_rev=project.meta_rev,
        process_rev=project.process_rev,
    )


@router.put("/{view_id}/layout", response_model=ViewLayoutResult)
def save_view_layout(
    view_id: str,
    payload: ViewLayoutBatch,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> ViewLayoutResult:
    vid = parse_view_id(view_id)
    # Вид, чей контейнер уже удалён другой сессией, — 404 (раньше батч доходил до
    # INSERT с мёртвым view_id и падал 500 на FK).
    if vid is not None and not scoped_node(db, vid, project):
        raise HTTPException(status_code=404, detail="Вид не найден")
    state = lock_view_state(db, project.id, vid)
    if payload.base_version is not None and payload.base_version != state.version:
        raise HTTPException(status_code=409, detail="Вид изменён в другой сессии")
    if not payload.items:
        # пустой батч: мир вида не менялся — версию не двигаем, отдаём текущее
        return ViewLayoutResult(version=state.version, graph_rev=project.graph_rev)
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
    state.version += 1
    # раскладка — не смысловая правка: updated_at проекта не трогаем (touch_project
    # не зовём), но курсор graph_rev двигаем — поллинг этапа 1 должен её увидеть
    bump_graph_rev(db, project)
    db.commit()
    return ViewLayoutResult(version=state.version, graph_rev=project.graph_rev)
