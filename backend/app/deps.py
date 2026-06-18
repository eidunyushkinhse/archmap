"""Общие FastAPI-зависимости.

get_current_project — скоуп доменных запросов текущим проектом. Идентификатор
проекта приходит заголовком X-Project-Id (наименее инвазивно для существующих
роутеров: добавляется один Depends + фильтр по project_id, без path-префикса).
"""

import uuid

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project


def get_current_project(
    x_project_id: str | None = Header(default=None, alias="X-Project-Id"),
    db: Session = Depends(get_db),
) -> Project:
    """Текущий проект из заголовка X-Project-Id. 400 — нет/битый заголовок,
    404 — проект не найден, 409 — проект в архиве (работать с архивным нельзя)."""
    if not x_project_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Не указан проект (заголовок X-Project-Id)",
        )
    try:
        pid = uuid.UUID(x_project_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Некорректный идентификатор проекта",
        ) from None
    project = db.query(Project).filter(Project.id == pid).first()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Проект не найден")
    if project.archived_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Проект в архиве — сначала восстановите его",
        )
    return project


def scoped_node(db: Session, node_id: uuid.UUID, project: Project) -> Node | None:
    """Узел, принадлежащий проекту, иначе None (для 404). db.get по PK игнорирует
    скоуп — проверяем project_id явно, чтобы чужой узел был недоступен (изоляция)."""
    node = db.get(Node, node_id)
    if node is None or node.project_id != project.id:
        return None
    return node


def scoped_edge(db: Session, edge_id: uuid.UUID, project: Project) -> Edge | None:
    """Связь, принадлежащая проекту, иначе None (см. scoped_node)."""
    edge = db.get(Edge, edge_id)
    if edge is None or edge.project_id != project.id:
        return None
    return edge


def touch_project(db: Session, project: Project, user_id: uuid.UUID | None) -> None:
    """Отметить смысловую правку схемы проекта: обновить updated_at/updated_by_id.

    Зовётся в конце каждой успешной доменной мутации (узлы/связи/процессы).
    Раскладочные апдейты (позиции/хэндлы/изломы/label_t) сюда НЕ входят — они не
    версионируются, дата изменения отражает смысл, а не геометрию. Сам commit —
    на вызывающей стороне (мутация и touch коммитятся вместе)."""
    from datetime import UTC, datetime

    project.updated_at = datetime.now(UTC)
    project.updated_by_id = user_id
    db.add(project)
