"""Сигнал CI о слиянии в репозитории — HTTP (домен — app/code_changes.py).

POST — от CI после слияния в основную ветку: токен «только сигнал CI» пускает только
сюда (app/auth.get_ci_user). DELETE — кнопка «Документация актуальна» в интерфейсе: личным
токеном метод DELETE закрыт целиком, агент напоминание снимает обновлением из кода.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import code_changes
from app.auth import get_ci_user
from app.config import settings
from app.database import get_db
from app.deps import get_current_project, require_project_editor
from app.models.project import Project
from app.models.user import User
from app.schemas.code_changes import CodeChangeIn, CodeChangeOut

router = APIRouter(prefix="/code-changes", tags=["code-changes"])

DEMO_DETAIL = "На демо-стенде сигналы CI недоступны"


@router.post("", response_model=CodeChangeOut)
def report_merge(
    payload: CodeChangeIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_ci_user),
) -> CodeChangeOut:
    """В основную ветку репозитория слиты изменения: напомнить проектам с объектами из
    этого репозитория, что документацию пора обновить. Проектов нет — 200 с пустым
    списком: CI не падает из-за репозитория, который ещё не описан."""
    if settings.demo_mode:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=DEMO_DETAIL)
    try:
        out = code_changes.record_merge(db, user, payload)
        db.commit()
    except code_changes.CodeChangeError as e:
        raise HTTPException(status_code=422, detail=e.detail) from e
    except IntegrityError:
        # Два сигнала об одном репозитории разом: второй споткнулся о строку первого.
        # Повтор находит её и копит слияние в ней.
        db.rollback()
        out = code_changes.record_merge(db, user, payload)
        db.commit()
    return out


@router.delete("/{change_id}", status_code=status.HTTP_204_NO_CONTENT)
def dismiss(
    change_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_project_editor),
) -> Response:
    """«Документация актуальна»: снять напоминание о слиянии вручную."""
    try:
        code_changes.dismiss(db, project.id, change_id)
    except code_changes.CodeChangeError as e:
        raise HTTPException(status_code=404, detail=e.detail) from e
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
