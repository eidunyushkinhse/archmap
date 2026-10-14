"""Общие FastAPI-зависимости.

get_current_project — скоуп доменных запросов текущим проектом. Идентификатор
проекта приходит заголовком X-Project-Id (наименее инвазивно для существующих
роутеров: добавляется один Depends + фильтр по project_id, без path-префикса).

Доступ (docs/tasks/project-access.md): get_current_project пускает только того,
у кого есть действующая роль в проекте (app/access.py), поэтому ЧТЕНИЕ закрыто во
всех роутерах проекта одним местом. Запись — require_project_editor. Проекты,
адресуемые ПУТЁМ (/projects/{id}/...), проверяет project_for с той же логикой; им же
закрыто управление проектом (need="owner").
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import ColumnElement
from sqlalchemy.orm import InstrumentedAttribute, Session

from app.access import ProjectRole, effective_role, role_at_least
from app.auth import get_current_user
from app.database import Base, get_db
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.models.user import User

# Недоступный проект неотличим от несуществующего: существование не выдаём.
PROJECT_NOT_FOUND = "Проект не найден"
# Отказы тем, кто проект видит, но прав на действие не имеет.
NOT_EDITOR_DETAIL = "Нет прав на правку этого проекта"
NOT_OWNER_DETAIL = "Это может только владелец проекта"


@dataclass(frozen=True)
class ProjectAccess:
    """Проект запроса, пользователь и его действующая роль в этом проекте."""

    project: Project
    user: User
    role: ProjectRole


def _require_role(role: ProjectRole, need: ProjectRole) -> None:
    """403, если роли не хватает на действие уровня need (доступ к проекту уже есть)."""
    if not role_at_least(role, need):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=NOT_OWNER_DETAIL if need == "owner" else NOT_EDITOR_DETAIL,
        )


def project_for(
    db: Session, user: User, project_id: uuid.UUID, need: ProjectRole = "reader"
) -> tuple[Project, ProjectRole]:
    """Проект, адресованный путём, с проверкой прав: 404 — проекта нет или он
    пользователю не виден, 403 — виден, но роли не хватает на действие need."""
    project = db.get(Project, project_id)
    role = effective_role(db, user, project) if project is not None else None
    if project is None or role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=PROJECT_NOT_FOUND)
    _require_role(role, need)
    return project, role


def get_project_access(
    x_project_id: str | None = Header(default=None, alias="X-Project-Id"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ProjectAccess:
    """Текущий проект из заголовка X-Project-Id и роль в нём. 400 — нет/битый
    заголовок, 404 — проект не найден ИЛИ недоступен, 409 — проект в архиве.
    Доступ проверяется ДО архива: чужой архивный проект — 404, а не 409."""
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
    project = db.get(Project, pid)
    role = effective_role(db, user, project) if project is not None else None
    if project is None or role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=PROJECT_NOT_FOUND)
    if project.archived_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Проект в архиве — сначала восстановите его",
        )
    return ProjectAccess(project=project, user=user, role=role)


def get_current_project(access: ProjectAccess = Depends(get_project_access)) -> Project:
    """Текущий проект, доступный пользователю хотя бы на чтение."""
    return access.project


def require_project_editor(access: ProjectAccess = Depends(get_project_access)) -> User:
    """Запись в текущий проект: роль editor или owner. Возвращает пользователя —
    подменяет прежний require_architect в роутерах проекта один в один."""
    _require_role(access.role, "editor")
    return access.user


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


# ── Общее у CRUD-ручек записей узла (аудит Q-15: копии в db_docs, broker_channels,
# config_params и node_docs) ────────────────────────────────────────────────────

NODE_NOT_FOUND = "Узел не найден"


def node_or_404(db: Session, node_id: uuid.UUID, project: Project) -> Node:
    """Узел проекта (scoped_node) или 404."""
    node = scoped_node(db, node_id, project)
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NODE_NOT_FOUND)
    return node


def owned_or_404[R: Base](
    db: Session, model: type[R], row_id: uuid.UUID, owner: str, owner_id: uuid.UUID, detail: str
) -> R:
    """Строка model, принадлежащая владельцу (owner — колонка: «node_id», «table_id»),
    иначе 404 с detail. db.get по PK владельца не видит — сверяем явно, как scoped_node:
    чужая таблица по прямому id недоступна так же, как отсутствующая."""
    row = db.get(model, row_id)
    if row is None or getattr(row, owner) != owner_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return row


def name_taken(
    db: Session,
    id_column: InstrumentedAttribute[uuid.UUID],
    except_id: uuid.UUID | None,
    *where: ColumnElement[bool],
) -> bool:
    """Пре-чек уникальности имени в контуре — 409 вместо IntegrityError-500. where —
    условия контура и имени; except_id — сама правимая строка (её имя «занятым» не
    считается)."""
    q = db.query(id_column).filter(*where)
    if except_id is not None:
        q = q.filter(id_column != except_id)
    return db.query(q.exists()).scalar() or False


def check_cas(version: int, base_version: int | None, detail: str) -> None:
    """Версия, с которой клиент начинал правку, устарела — 409 с detail. Без
    base_version проверки нет (старые клиенты и скрипты)."""
    if base_version is not None and base_version != version:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def touch_project(db: Session, project: Project, user_id: uuid.UUID | None) -> None:
    """Отметить смысловую правку схемы проекта: обновить updated_at/updated_by_id.

    Зовётся в конце каждой успешной доменной мутации (узлы/связи/процессы).
    Раскладочные апдейты (позиции/хэндлы/изломы/label_t) сюда НЕ входят — они не
    версионируются, дата изменения отражает смысл, а не геометрию. Сам commit —
    на вызывающей стороне (мутация и touch коммитятся вместе)."""

    project.updated_at = datetime.now(UTC)
    project.updated_by_id = user_id
    db.add(project)
