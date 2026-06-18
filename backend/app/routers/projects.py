"""API проектов: /api/v1/projects.

Управление изолированными схемами: список с метаданными (счётчики объектов/связей,
кто и когда менял), создание (пустой / шаблон / копия), переименование, мягкое
архивирование/восстановление и необратимое удаление. Доменные данные эти эндпоинты
НЕ скоупят через X-Project-Id — они оперируют самими проектами.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User
from app.projects import copy_project_schema
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from app.templates import seed_template

router = APIRouter(prefix="/projects", tags=["projects"])


def _counts(db: Session, project_ids: list[uuid.UUID]) -> tuple[dict, dict]:
    """Счётчики объектов и связей по проектам одним запросом на тип (без N+1)."""
    if not project_ids:
        return {}, {}
    node_counts = dict(
        db.query(Node.project_id, func.count(Node.id))
        .filter(Node.project_id.in_(project_ids))
        .group_by(Node.project_id)
        .all()
    )
    edge_counts = dict(
        db.query(Edge.project_id, func.count(Edge.id))
        .filter(Edge.project_id.in_(project_ids))
        .group_by(Edge.project_id)
        .all()
    )
    return node_counts, edge_counts


def _to_response(p: Project, node_counts: dict, edge_counts: dict, users: dict) -> ProjectResponse:
    return ProjectResponse(
        id=p.id,
        name=p.name,
        description=p.description,
        archived_at=p.archived_at,
        created_at=p.created_at,
        updated_at=p.updated_at,
        object_count=node_counts.get(p.id, 0),
        edge_count=edge_counts.get(p.id, 0),
        updated_by=users.get(p.updated_by_id) if p.updated_by_id else None,
    )


def _users_map(db: Session, projects: list[Project]) -> dict[uuid.UUID, str]:
    """id → username для редакторов проектов (одним запросом)."""
    ids = {p.updated_by_id for p in projects if p.updated_by_id is not None}
    if not ids:
        return {}
    return {u.id: u.username for u in db.query(User).filter(User.id.in_(ids)).all()}


@router.get("", response_model=list[ProjectResponse])
def list_projects(
    archived: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[ProjectResponse]:
    """Список проектов: активные (archived=false) или архив, сорт. по дате изменения."""
    q = db.query(Project)
    q = q.filter(Project.archived_at.isnot(None)) if archived else q.filter(Project.archived_at.is_(None))
    projects = q.order_by(Project.updated_at.desc()).all()
    nc, ec = _counts(db, [p.id for p in projects])
    users = _users_map(db, projects)
    return [_to_response(p, nc, ec, users) for p in projects]


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> ProjectResponse:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    nc, ec = _counts(db, [p.id])
    return _to_response(p, nc, ec, _users_map(db, [p]))


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_architect),
) -> ProjectResponse:
    """Создать проект. start: "blank" — пусто; "template:<id>" — каркас из шаблона;
    "copy:<projectId>" — глубокая копия схемы другого проекта."""
    project = Project(
        id=uuid.uuid4(),
        name=payload.name,
        description=payload.description,
        created_by_id=user.id,
        updated_by_id=user.id,
    )
    db.add(project)
    db.flush()  # нужен project.id для сидинга/копии

    start = payload.start or "blank"
    if start == "blank":
        pass
    elif start.startswith("template:"):
        if not seed_template(db, project.id, start.split(":", 1)[1]):
            raise HTTPException(status_code=404, detail="Шаблон не найден")
    elif start.startswith("copy:"):
        try:
            src_id = uuid.UUID(start.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Некорректный источник копии") from None
        src = db.get(Project, src_id)
        if src is None:
            raise HTTPException(status_code=404, detail="Исходный проект не найден")
        copy_project_schema(db, src_id, project.id)
    else:
        raise HTTPException(status_code=400, detail="Неизвестный способ старта проекта")

    db.commit()
    db.refresh(project)
    nc, ec = _counts(db, [project.id])
    return _to_response(project, nc, ec, _users_map(db, [project]))


@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project(
    project_id: uuid.UUID,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_architect),
) -> ProjectResponse:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(p, field, value)
    if data:
        p.updated_by_id = user.id
    db.commit()
    db.refresh(p)
    nc, ec = _counts(db, [p.id])
    return _to_response(p, nc, ec, _users_map(db, [p]))


@router.post("/{project_id}/archive", response_model=ProjectResponse)
def archive_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> ProjectResponse:
    """Мягкое удаление: проставляем archived_at. Данные сохраняются."""
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if p.archived_at is None:
        p.archived_at = datetime.now(UTC)
        db.commit()
        db.refresh(p)
    nc, ec = _counts(db, [p.id])
    return _to_response(p, nc, ec, _users_map(db, [p]))


@router.post("/{project_id}/restore", response_model=ProjectResponse)
def restore_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> ProjectResponse:
    """Вернуть из архива: archived_at = null."""
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    p.archived_at = None
    db.commit()
    db.refresh(p)
    nc, ec = _counts(db, [p.id])
    return _to_response(p, nc, ec, _users_map(db, [p]))


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: uuid.UUID,
    confirm: str = "",
    db: Session = Depends(get_db),
    _: User = Depends(require_architect),
) -> None:
    """Необратимое удаление со всей схемой (БД-каскад). Разрешено только из архива
    и с ?confirm=<точное имя проекта> — двойная защита от случайного сноса."""
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if p.archived_at is None:
        raise HTTPException(status_code=409, detail="Сначала отправьте проект в архив")
    if confirm != p.name:
        raise HTTPException(status_code=400, detail="Подтвердите удаление точным именем проекта")
    db.delete(p)  # каскад сносит узлы/связи/процессы и раскладку
    db.commit()
