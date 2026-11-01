"""«Собрать с компонентов» (Р19 эпика docs/plan-c4-elements.md): параметры конфигурации
и спецификация компонентов переезжают их контейнеру. Домен — app/facts_transfer, здесь
только HTTP: отказы домена — в статус и {"detail": "…"}, коммит.

Обе ручки — редактору: превью нужно только тому, кто может собрать (страница
контейнера спрашивает его один раз, чтобы решить, показывать ли кнопку)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import facts_transfer
from app.database import get_db
from app.deps import (
    commit_change,
    get_current_project,
    node_or_404,
    require_project_editor,
)
from app.models.project import Project
from app.models.user import User
from app.schemas.node import CollectFactsIn, CollectFactsOut, CollectFactsPreview

router = APIRouter(prefix="/nodes/{node_id}/facts", tags=["facts"])


@router.get("/collect-preview", response_model=CollectFactsPreview)
def collect_preview(
    node_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> CollectFactsPreview:
    """Что соберёт «Собрать с компонентов», БЕЗ записи: компоненты с фактами процесса,
    одноимённые параметры (у контейнера своя запись — вопроса нет) и держатели
    спецификации. 422 — не контейнер с компонентами."""
    node = node_or_404(db, node_id, project)
    try:
        return facts_transfer.collect_preview(db, project, node)
    except facts_transfer.FactsTransferError as e:
        raise HTTPException(status_code=e.status, detail=e.detail) from None


@router.post("/collect", response_model=CollectFactsOut)
def collect(
    node_id: uuid.UUID,
    payload: CollectFactsIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> CollectFactsOut:
    """«Собрать с компонентов»: параметры и спецификация компонентов — контейнеру,
    знание контейнера в приоритете; одноимённые параметры только у компонентов и
    несколько спецификаций при пустом контейнере — по ответу, без ответа остаются у
    компонентов. Всё проверяется до записи."""
    node = node_or_404(db, node_id, project)
    try:
        out = facts_transfer.collect_facts(db, project, node, payload)
    except facts_transfer.FactsTransferError as e:
        # Домен проверяет всё до записи: откатывать нечего.
        raise HTTPException(status_code=e.status, detail=e.detail) from None
    commit_change(db, project, user.id)
    return out
