"""Дозаливка структуры БД от агента: промпт → превью → применение.

Тот же путь, что у доков (BYOA), но своя сущность. Роутер тонкий: разбор и план живут
в app/data_import.py, промпт — в app/data_prompt.py.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import require_architect
from app.data_import import apply_data_plan, build_data_plan
from app.data_prompt import build_data_prompt
from app.database import get_db
from app.deps import get_current_project, touch_project
from app.docs_import import _node_paths
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.schemas.data_import import DataImportIn, DataImportReport, DataPromptOut
from app.skeptic_prompt import PromptVariant, prompt_for_variant
from app.view_state import bump_meta_rev

router = APIRouter(prefix="/data-import", tags=["data-import"])


@router.get("/prompt", response_model=DataPromptOut)
def data_prompt(
    variant: PromptVariant = "builder",
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> DataPromptOut:
    """Промпт агенту с узлами-БД ЭТОГО проекта: адрес владельца записей слабая
    модель без списка выдумывает, и пакет блокируется целиком (находка QA).
    variant — строительный промпт (дефолт), обёртка с аудитом или один аудит
    (docs/plan-skeptic-audit.md)."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    flat, fulls, _by_bare, _by_path = _node_paths(nodes)
    db_paths = [fulls[i] for i, n in enumerate(flat) if n.shape == "database"]
    return DataPromptOut(prompt=prompt_for_variant(variant, "data", build_data_prompt(db_paths)))


def _plan(db: Session, project: Project, payload: DataImportIn, window: uuid.UUID | None):
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    return build_data_plan(
        db, nodes, [(f.name, f.content) for f in payload.files], window, payload.overwrite
    )


@router.post("/preview", response_model=DataImportReport)
def data_import_preview(
    payload: DataImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(require_architect),
) -> DataImportReport:
    """Dry-run: план без записи."""
    return _plan(db, project, payload, payload.node_id).report


@router.post("/apply", response_model=DataImportReport)
def data_import_apply(
    payload: DataImportIn,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> DataImportReport:
    """Применение: план пересчитывается на живом состоянии; при errors не пишем ничего."""
    plan = _plan(db, project, payload, payload.node_id)
    if plan.report.errors:
        return plan.report  # applied=False — окно показывает ошибки
    apply_data_plan(db, plan, payload.overwrite)
    if plan.report.tables_written or plan.report.columns_written:
        bump_meta_rev(db, project)  # структура — мета узла
    touch_project(db, project, user.id)
    db.commit()
    return plan.report
