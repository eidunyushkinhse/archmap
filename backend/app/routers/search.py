"""Поиск по знанию проекта: GET /api/v1/search (логика — app/search.py).

Читать могут обе роли: поиск — чтение знания, а не действие. Скоуп — проект из
X-Project-Id, как у всех доменных ручек.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.deps import get_current_project
from app.models.project import Project
from app.models.user import User
from app.schemas.search import SearchKind, SearchResponse
from app.search import SearchQueryError, search

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=SearchResponse)
def search_project(
    q: str = Query(
        default="",
        description="Строка лога, текст ошибки или слова. Переменные части (пути, id) не мешают.",
    ),
    limit: int = Query(default=20, ge=1, le=100),
    kinds: list[SearchKind] | None = Query(
        default=None, description="Фильтр по видам единиц; повторяемый параметр."
    ),
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> SearchResponse:
    try:
        return search(db, project.id, q, limit=limit, kinds=set(kinds) if kinds else None)
    except SearchQueryError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
