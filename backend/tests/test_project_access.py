"""Доступ к проектам по участникам (docs/tasks/project-access.md).

Всё через настоящие зависимости: токен → get_current_user → действующая роль в
проекте (app/access.py). Подменена только сессия БД. Тестовые пользователи НЕ
администраторы по умолчанию: админ «видит всё» и спрятал бы любой баг прав.

Сцена: проект «Ярмарка» с владельцем owner, редактором editor (глобально viewer —
viewer может быть редактором чужого проекта) и читателем reader (глобально
architect — architect без роли редактора проект не правит). stranger — architect
без участия, admin — администратор (глобально viewer) без участия, blocked —
заблокированный.
"""

import uuid

import pytest
from conftest import make_project
from fastapi.testclient import TestClient

from app.access import effective_role, effective_roles
from app.auth import create_access_token
from app.database import get_db
from app.deps import ProjectAccess, require_project_editor, require_project_owner
from app.main import app
from app.models.node import Node
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User
from app.unified_apply import apply_unified_plan
from app.unified_import import build_unified_plan

PROJECTS = "/api/v1/projects"
NODES = "/api/v1/nodes"


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _user(db, username: str, role: str = "architect", **fields) -> User:
    u = User(id=uuid.uuid4(), username=username, hashed_password="x", role=role, **fields)
    db.add(u)
    db.flush()
    return u


def _h(user: User, project: Project | None = None) -> dict[str, str]:
    """Заголовки запроса от имени пользователя (и в контексте проекта)."""
    token = create_access_token({"sub": user.username, "role": user.role})
    h = {"Authorization": f"Bearer {token}"}
    if project is not None:
        h["X-Project-Id"] = str(project.id)
    return h


def _member(db, project: Project, user: User, role: str) -> None:
    db.add(ProjectMember(project_id=project.id, user_id=user.id, role=role))
    db.flush()


@pytest.fixture()
def scene(db) -> dict:
    owner = _user(db, "owner")
    editor = _user(db, "editor", role="viewer")
    reader = _user(db, "reader")
    stranger = _user(db, "stranger")
    admin = _user(db, "admin", role="viewer", is_admin=True)
    blocked = _user(db, "blocked", is_active=False)
    p = make_project(db, "Ярмарка", owner=owner)
    _member(db, p, editor, "editor")
    _member(db, p, reader, "reader")
    db.add(Node(id=uuid.uuid4(), project_id=p.id, name="orders"))
    db.commit()
    return {
        "p": p,
        "owner": owner,
        "editor": editor,
        "reader": reader,
        "stranger": stranger,
        "admin": admin,
        "blocked": blocked,
    }


def _roles(db, project_id: uuid.UUID) -> dict[str, str]:
    rows = (
        db.query(User.username, ProjectMember.role)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .filter(ProjectMember.project_id == project_id)
        .all()
    )
    return dict(rows)


# ── Действующая роль: порядок проверок ───────────────────────────────────────


def test_effective_role_порядок_проверок(db, scene):
    p = scene["p"]
    assert effective_role(db, scene["admin"], p) == "owner"  # админ без участия
    assert effective_role(db, scene["owner"], p) == "owner"
    assert effective_role(db, scene["editor"], p) == "editor"
    assert effective_role(db, scene["reader"], p) == "reader"
    assert effective_role(db, scene["stranger"], p) is None
    p.visible_to_all = True
    assert effective_role(db, scene["stranger"], p) == "reader"
    # Участник остаётся при своей роли и в видимом всем проекте.
    assert effective_role(db, scene["editor"], p) == "editor"
    # Батч-версия списка считает то же самое.
    for name in ("admin", "owner", "editor", "reader", "stranger"):
        assert effective_roles(db, scene[name], [p])[p.id] == effective_role(db, scene[name], p)


def test_зависимости_записи_и_управления(db, scene):
    p = scene["p"]
    owner_access = ProjectAccess(project=p, user=scene["owner"], role="owner")
    editor_access = ProjectAccess(project=p, user=scene["editor"], role="editor")
    reader_access = ProjectAccess(project=p, user=scene["reader"], role="reader")
    assert require_project_editor(owner_access) is scene["owner"]
    assert require_project_editor(editor_access) is scene["editor"]
    assert require_project_owner(owner_access) is scene["owner"]
    from fastapi import HTTPException

    for access, dep in (
        (reader_access, require_project_editor),
        (editor_access, require_project_owner),
        (reader_access, require_project_owner),
    ):
        with pytest.raises(HTTPException) as ei:
            dep(access)
        assert ei.value.status_code == 403


# ── Чтение закрыто одним местом: get_current_project ─────────────────────────


@pytest.mark.parametrize(
    ("who", "code"),
    [("owner", 200), ("editor", 200), ("reader", 200), ("admin", 200), ("stranger", 404)],
)
def test_чтение_только_с_доступом(client, db, scene, who, code):
    r = client.get(NODES, headers=_h(scene[who], scene["p"]))
    assert r.status_code == code, r.text
    if code == 404:
        assert r.json() == {"detail": "Проект не найден"}


def test_visible_to_all_даёт_чтение(client, db, scene):
    p = scene["p"]
    p.visible_to_all = True
    db.commit()
    assert client.get(NODES, headers=_h(scene["stranger"], p)).status_code == 200


def test_чужой_архивный_404_а_не_409(client, db, scene):
    from datetime import UTC, datetime

    p = scene["p"]
    p.archived_at = datetime.now(UTC)
    db.commit()
    # Участник видит, что проект в архиве; чужой — что проекта нет.
    assert client.get(NODES, headers=_h(scene["reader"], p)).status_code == 409
    r = client.get(NODES, headers=_h(scene["stranger"], p))
    assert r.status_code == 404 and r.json() == {"detail": "Проект не найден"}


def test_создатель_становится_владельцем(client, db, scene):
    r = client.post(PROJECTS, headers=_h(scene["stranger"]), json={"name": "Новый"})
    assert r.status_code == 201
    assert _roles(db, uuid.UUID(r.json()["id"])) == {"stranger": "owner"}


def test_единый_импорт_делает_создателя_владельцем(db, scene):
    plan = build_unified_plan([("a.yaml", "nodes:\n  - name: Ярмарка\n".encode())])
    project, _ = apply_unified_plan(db, plan, {}, "Из файла", None, scene["stranger"].id)
    db.commit()
    assert _roles(db, project.id) == {"stranger": "owner"}
