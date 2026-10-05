"""Дозаливка каналов брокера от агента: промпт → превью → применение.

Тот же путь, что у структуры БД (data-import), но своя сущность и свой префикс:
каналы не «фильтр» таблиц, у них другой формат пакета и другая политика слияния.
Роутер тонкий: разбор и план живут в app/channels_import.py, промпт — в
app/channels_prompt.py.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import demo_limits
from app.channels_import import (
    ChannelsPlan,
    apply_channels_plan,
    build_channels_plan,
    edge_channel_minimum,
)
from app.channels_prompt import build_channels_prompt
from app.database import get_db
from app.deps import get_current_project, require_project_editor, touch_project
from app.docs_import import _node_paths
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.channels_import import (
    ChannelsImportIn,
    ChannelsImportReport,
    ChannelsPromptOut,
)
from app.skeptic_prompt import PromptVariant, prompt_for_variant
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/channels-import", tags=["channels-import"])


@router.get("/prompt", response_model=ChannelsPromptOut)
def channels_prompt(
    variant: PromptVariant = "builder",
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> ChannelsPromptOut:
    """Промпт агенту с узлами-брокерами ЭТОГО проекта: адрес владельца слабая модель
    без списка выдумывает, и пакет блокируется целиком (урок Н8). Плюс каналы,
    которые УЖЕ называют связи схемы, — минимум пакета (находка №4 полевого QA:
    канальная сессия не нашла очередь, в которую код только публикует).
    variant — строительный промпт (дефолт), обёртка с аудитом или один аудит
    (docs/plan-skeptic-audit.md)."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    flat, fulls, _by_bare, _by_path = _node_paths(nodes)
    broker_paths = [fulls[i] for i, n in enumerate(flat) if n.shape == "broker"]
    edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    return ChannelsPromptOut(
        prompt=prompt_for_variant(
            variant,
            "channels",
            build_channels_prompt(broker_paths, _edge_channels(flat, fulls, edges)),
        )
    )


def _edge_channels(
    flat: list[Node], fulls: list[str], edges: list[Edge]
) -> dict[str, list[str]]:
    """«Путь брокера → каналы, названные связями схемы» — минимум пакета для промпта.

    Сборка общая с превью (edge_channel_minimum): ТОТ ЖЕ перечень, который промпт
    просит описать, превью потом и сверяет (Ф8е). Разъехаться им нельзя — иначе с
    агента спросят не то, о чём просили.
    """
    broker_paths = {n.id: fulls[i] for i, n in enumerate(flat) if n.shape == "broker"}
    minimum = edge_channel_minimum(edges, set(broker_paths))
    return {broker_paths[node_id]: list(names) for node_id, names in minimum.items()}


def _plan(
    db: Session, project: Project, payload: ChannelsImportIn, window: uuid.UUID | None
) -> ChannelsPlan:
    # Демо-стенд: файл больше предела — 413 до разбора (docs/tasks/demo-mode.md).
    demo_limits.check_texts((f.name, f.content) for f in payload.files)
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    return build_channels_plan(
        db, nodes, [(f.name, f.content) for f in payload.files], window, payload.overwrite
    )


@router.post("/preview", response_model=ChannelsImportReport)
def channels_import_preview(
    payload: ChannelsImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_project_editor),
) -> ChannelsImportReport:
    """Dry-run: план без записи."""
    return _plan(db, project, payload, payload.node_id).report


@router.post("/apply", response_model=ChannelsImportReport)
def channels_import_apply(
    payload: ChannelsImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
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
