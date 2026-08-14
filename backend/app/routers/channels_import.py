"""Дозаливка каналов брокера от агента: промпт → превью → применение.

Тот же путь, что у структуры БД (data-import), но своя сущность и свой префикс:
каналы не «фильтр» таблиц, у них другой формат пакета и другая политика слияния.
Роутер тонкий: разбор и план живут в app/channels_import.py, промпт — в
app/channels_prompt.py.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import require_architect
from app.channels_import import ChannelsPlan, apply_channels_plan, build_channels_plan
from app.channels_prompt import build_channels_prompt
from app.database import get_db
from app.deps import get_current_project, touch_project
from app.docs_import import _node_paths
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.channels_import import (
    ChannelsImportIn,
    ChannelsImportReport,
    ChannelsPromptOut,
)
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/channels-import", tags=["channels-import"])


@router.get("/prompt", response_model=ChannelsPromptOut)
def channels_prompt(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> ChannelsPromptOut:
    """Промпт агенту с узлами-брокерами ЭТОГО проекта: адрес владельца слабая модель
    без списка выдумывает, и пакет блокируется целиком (урок Н8)."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    flat, fulls, _by_bare, _by_path = _node_paths(nodes)
    broker_paths = [fulls[i] for i, n in enumerate(flat) if n.shape == "broker"]
    return ChannelsPromptOut(prompt=build_channels_prompt(broker_paths))


def _plan(
    db: Session, project: Project, payload: ChannelsImportIn, window: uuid.UUID | None
) -> ChannelsPlan:
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    return build_channels_plan(
        db, nodes, [(f.name, f.content) for f in payload.files], window, payload.overwrite
    )


@router.post("/preview", response_model=ChannelsImportReport)
def channels_import_preview(
    payload: ChannelsImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> ChannelsImportReport:
    """Dry-run: план без записи."""
    return _plan(db, project, payload, payload.node_id).report


@router.post("/apply", response_model=ChannelsImportReport)
def channels_import_apply(
    payload: ChannelsImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ChannelsImportReport:
    """Применение: план пересчитывается на живом состоянии; при errors не пишем ничего."""
    plan = _plan(db, project, payload, payload.node_id)
    if plan.report.errors:
        return plan.report  # applied=False — окно показывает ошибки
    apply_channels_plan(db, plan, payload.overwrite)
    if plan.report.channels_written or plan.report.fields_written:
        bump_meta_rev(db, project)  # структура — мета узла
    touch_project(db, project, user.id)
    db.commit()
    return plan.report
