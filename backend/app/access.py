"""Доступ к проектам по участникам (docs/tasks/project-access.md).

Права ВНУТРИ проекта определяет только действующая роль в нём, и считает её одна
функция effective_role. Глобальная роль architect/viewer внутрь проекта не
смотрит: она решает лишь, можно ли создавать новые проекты (require_architect).

Роли: owner — правит и управляет проектом (участники, видимость, архив, удаление,
передача владения); editor — правит схему, доки, процессы, факты, импорт в проект;
reader — только смотрит и экспортирует.

Модуль чистый: без HTTP. Отказы (404 «Проект не найден», 403 «нет прав») —
в app/deps.py и роутерах.
"""

import uuid
from collections.abc import Iterable
from typing import cast

from sqlalchemy import or_, select
from sqlalchemy.orm import Query, Session

from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User
from app.schemas.project import ProjectRole

# Порядок силы ролей: проверка «не ниже требуемой» — сравнение рангов.
_RANK: dict[str, int] = {"reader": 0, "editor": 1, "owner": 2}


def role_at_least(role: ProjectRole | None, need: ProjectRole) -> bool:
    """Достаточно ли роли для действия уровня need (None — доступа нет вовсе)."""
    return role is not None and _RANK[role] >= _RANK[need]


def effective_role(db: Session, user: User, project: Project) -> ProjectRole | None:
    """Действующая роль пользователя в проекте. Порядок проверок важен:

    1. администратор — owner в любом проекте («пусть может помочь с чем угодно»);
    2. участник — его роль;
    3. проект виден всем — reader;
    4. иначе доступа нет (None): для пользователя проекта не существует.
    """
    if user.is_admin:
        return "owner"
    member = db.get(ProjectMember, (project.id, user.id))
    if member is not None:
        return cast(ProjectRole, member.role)
    if project.visible_to_all:
        return "reader"
    return None


def effective_roles(
    db: Session, user: User, projects: Iterable[Project]
) -> dict[uuid.UUID, ProjectRole | None]:
    """То же, что effective_role, батчем для списка (один запрос участий, без N+1)."""
    projects = list(projects)
    if user.is_admin:
        return {p.id: "owner" for p in projects}
    ids = [p.id for p in projects]
    mine: dict[uuid.UUID, ProjectRole] = {}
    if ids:
        mine = {
            pid: cast(ProjectRole, role)
            for pid, role in db.query(ProjectMember.project_id, ProjectMember.role).filter(
                ProjectMember.user_id == user.id, ProjectMember.project_id.in_(ids)
            )
        }
    return {
        p.id: mine.get(p.id) or ("reader" if p.visible_to_all else None) for p in projects
    }


def visible_projects(q: Query[Project], user: User) -> Query[Project]:
    """Сузить запрос проектов до тех, что пользователь видит: администратор — все;
    остальные — где он участник, и проекты, видимые всем."""
    if user.is_admin:
        return q
    my_ids = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
    return q.filter(or_(Project.visible_to_all.is_(True), Project.id.in_(my_ids)))


def owner_member(db: Session, project_id: uuid.UUID) -> ProjectMember | None:
    """Строка владельца проекта. None — только у наследия миграции, когда на момент
    обновления в базе не было ни одного пользователя."""
    return (
        db.query(ProjectMember)
        .filter(ProjectMember.project_id == project_id, ProjectMember.role == "owner")
        .first()
    )


def owner_usernames(db: Session, project_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Логины владельцев проектов одним запросом (для карточек списка)."""
    if not project_ids:
        return {}
    rows = (
        db.query(ProjectMember.project_id, User.username)
        .join(User, User.id == ProjectMember.user_id)
        .filter(ProjectMember.project_id.in_(project_ids), ProjectMember.role == "owner")
        .all()
    )
    return {pid: username for pid, username in rows}


def add_owner(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Создатель нового проекта становится его владельцем. Зовётся ровно там, где
    рождается проект (POST /projects и единый импорт), коммит на вызывающей стороне."""
    db.add(ProjectMember(project_id=project_id, user_id=user_id, role="owner"))


def transfer_ownership(db: Session, project_id: uuid.UUID, new_owner_id: uuid.UUID) -> None:
    """Передать владение: новый владелец становится owner (если не был участником,
    добавляется), прежний остаётся в проекте редактором. Владелец после этого ровно
    один: инвариант держит код, а не индекс. Проверки (кто передаёт, кому можно) — на
    вызывающей стороне; коммит тоже."""
    old = owner_member(db, project_id)
    if old is not None and old.user_id != new_owner_id:
        old.role = "editor"
    target = db.get(ProjectMember, (project_id, new_owner_id))
    if target is None:
        db.add(ProjectMember(project_id=project_id, user_id=new_owner_id, role="owner"))
    else:
        target.role = "owner"
    db.flush()
