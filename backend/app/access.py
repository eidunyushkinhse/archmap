"""Доступ к проектам по участникам (docs/tasks/project-access.md).

Права ВНУТРИ проекта определяет только действующая роль в нём, и считает её одна
функция effective_role. Глобальная роль решает, кем человек МОЖЕТ быть в проектах:
«Архитектор» (architect) создаёт проекты и бывает владельцем, редактором и читателем;
«Пользователь» (viewer) только смотрит — в проекте он лишь читатель. Инвариант держат
записи участий (can_edit в назначении, передаче владения и смене глобальной роли),
а не effective_role: роль в строке участия всегда честная.

Роли: owner — правит и управляет проектом (участники, видимость, архив, удаление,
передача владения); editor — правит схему, доки, процессы, факты, импорт в проект;
reader — только смотрит и экспортирует.

Модуль чистый: без HTTP. Отказы (404 «Проект не найден», 403 «нет прав») —
в app/deps.py и роутерах.
"""

import uuid
from collections.abc import Iterable

from sqlalchemy import or_, select
from sqlalchemy.orm import Query, Session

from app.domain_types import UserRole
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
        return member.role
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
            pid: role
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


VIEWER_EDITOR_DETAIL = "«Пользователь» только смотрит: в проекте он может быть лишь читателем"
VIEWER_OWNER_DETAIL = "Передать проект можно только архитектору"


class AccessError(Exception):
    """Отказ по правилу ролей; текст — для пользователя как есть."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def can_edit(user: User) -> bool:
    """Может ли пользователь быть редактором или владельцем проекта: только архитектор."""
    return user.role == "architect"


def set_global_role(db: Session, user: User, role: UserRole) -> None:
    """Сменить глобальную роль. Понижение до «Пользователя»: его редакторства
    становятся чтением, а владельцу проектов понижение закрыто — сначала передать
    проекты (владелец без права правки — проект без хозяина). Коммит — на вызывающей
    стороне."""
    if role == "viewer" and user.role != "viewer":
        owned = [
            name
            for (name,) in db.query(Project.name)
            .join(ProjectMember, ProjectMember.project_id == Project.id)
            .filter(ProjectMember.user_id == user.id, ProjectMember.role == "owner")
            .order_by(Project.name)
        ]
        if owned:
            shown = ", ".join(f"«{n}»" for n in owned[:3])
            more = f" и ещё {len(owned) - 3}" if len(owned) > 3 else ""
            raise AccessError(
                f"{user.username} — владелец проектов {shown}{more}. "
                "Сначала передайте их другому архитектору"
            )
        db.query(ProjectMember).filter(
            ProjectMember.user_id == user.id, ProjectMember.role == "editor"
        ).update({"role": "reader"}, synchronize_session="fetch")
    user.role = role


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
