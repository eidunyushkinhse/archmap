"""Удаление пачкой с версией перед ним — HTTP (домен — app/deletions.py).

Путь агента и скриптов: личным токеном метод DELETE закрыт целиком (app/auth.py), а
здесь — POST, потому что перед удалением ArchMap сохраняет версию и удалённое
возвращается откатом к ней в интерфейсе. Токен «только для чтения» сюда не пускает то же
правило по методу. Интерфейс удаляет по-прежнему DELETE-ручками с отменой Ctrl+Z.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import deletions, versions
from app.database import get_db
from app.deps import commit_change, get_current_project, require_project_editor
from app.models.project import Project
from app.models.user import User
from app.schemas.deletions import DeletionOut, DeletionRequest

router = APIRouter(prefix="/deletions", tags=["deletions"])


@router.post("", response_model=DeletionOut)
def delete_batch(
    payload: DeletionRequest,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> DeletionOut:
    """Удалить объекты (с поддеревом), связи и схемы логики одной пачкой. dry_run —
    только посчитать, что уйдёт, и назвать срез версии."""
    try:
        plan = deletions.plan(db, project, payload.items)
    except deletions.DeletionError as e:
        raise HTTPException(status_code=404, detail=e.detail) from e
    if payload.dry_run:
        return deletions.preview(plan)
    try:
        out = deletions.apply(db, project, user, plan, payload.reason)
    except versions.VersionError as e:
        raise HTTPException(status_code=422, detail=e.detail) from e
    totals = out.totals
    commit_change(
        db,
        project,
        user.id,
        graph=bool(totals.nodes or totals.edges),
        meta=bool(totals.docs or totals.facts),
        process=bool(totals.process_links),
    )
    return out
