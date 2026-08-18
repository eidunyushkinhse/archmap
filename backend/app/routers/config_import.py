"""Дозаливка конфигурации сервиса от агента: промпт → превью → применение.

Тот же путь, что у структуры БД и каналов, но своя сущность и свой префикс: параметры
не «фильтр» каналов, у них другой формат пакета. Роутер тонкий: разбор и план живут в
app/config_import.py, промпт — в app/config_prompt.py.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import require_architect
from app.config_import import ConfigPlan, apply_config_plan, build_config_plan
from app.config_prompt import build_config_prompt
from app.database import get_db
from app.deps import get_current_project, touch_project
from app.docs_import import _node_paths
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.config_import import (
    ConfigImportIn,
    ConfigImportReport,
    ConfigPromptOut,
)
from app.skeptic_prompt import PromptVariant, prompt_for_variant
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/config-import", tags=["config-import"])


@router.get("/prompt", response_model=ConfigPromptOut)
def config_prompt(
    variant: PromptVariant = "builder",
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> ConfigPromptOut:
    """Промпт агенту с узлами-сервисами ЭТОГО проекта: адрес владельца слабая модель
    без списка выдумывает, и пакет блокируется целиком (урок Н8).
    variant — строительный промпт (дефолт), обёртка с аудитом или один аудит
    (docs/plan-skeptic-audit.md)."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    flat, fulls, _by_bare, _by_path = _node_paths(nodes)
    service_paths = [fulls[i] for i, n in enumerate(flat) if n.shape == "service"]
    return ConfigPromptOut(
        prompt=prompt_for_variant(variant, "config", build_config_prompt(service_paths))
    )


def _plan(
    db: Session, project: Project, payload: ConfigImportIn, window: uuid.UUID | None
) -> ConfigPlan:
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    return build_config_plan(
        db, nodes, [(f.name, f.content) for f in payload.files], window, payload.overwrite
    )


@router.post("/preview", response_model=ConfigImportReport)
def config_import_preview(
    payload: ConfigImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> ConfigImportReport:
    """Dry-run: план без записи."""
    return _plan(db, project, payload, payload.node_id).report


@router.post("/apply", response_model=ConfigImportReport)
def config_import_apply(
    payload: ConfigImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ConfigImportReport:
    """Применение: план пересчитывается на живом состоянии; при errors не пишем ничего."""
    plan = _plan(db, project, payload, payload.node_id)
    if plan.report.errors:
        return plan.report  # applied=False — окно показывает ошибки
    apply_config_plan(db, plan, payload.overwrite)
    if plan.report.params_written:
        bump_meta_rev(db, project)  # конфигурация — мета узла
    touch_project(db, project, user.id)
    db.commit()
    return plan.report
