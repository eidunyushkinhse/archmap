"""Личные токены доступа (docs/plan-remote-mcp.md, Р4): вход по токену на всём /api/v1.

Всё через настоящие зависимости: токен → get_current_user → действующая роль в проекте.
Подменена только сессия БД. Токен — это права владельца, суженные: без удалений, без
управления токенами, людьми и проектом на уровне владельца, «только чтение» пускает
лишь безопасные методы.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from conftest import make_project
from fastapi.testclient import TestClient

from app import personal_tokens
from app.auth import BLOCKED_DETAIL, create_access_token
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.node import Node
from app.models.personal_token import PersonalToken
from app.models.project_member import ProjectMember
from app.models.user import User

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


def _token(db, user: User, name: str = "Агент", read_only: bool = False, days=90) -> str:
    secret = personal_tokens.issue(db, user.id, name, read_only, days).secret
    db.commit()
    return secret


def _h(secret: str, project=None) -> dict[str, str]:
    h = {"Authorization": f"Bearer {secret}"}
    if project is not None:
        h["X-Project-Id"] = str(project.id)
    return h


def _jwt(user: User, project=None) -> dict[str, str]:
    return _h(create_access_token({"sub": user.username, "role": user.role}), project)


@pytest.fixture()
def scene(db):
    """Владелец проекта «Ярмарка», читатель в нём и чужой закрытый проект «Плёнка»."""
    owner = _user(db, "owner")
    reader = _user(db, "reader")
    stranger = _user(db, "stranger")
    p = make_project(db, "Ярмарка", owner=owner)
    db.add(ProjectMember(project_id=p.id, user_id=reader.id, role="reader"))
    hidden = make_project(db, "Плёнка", owner=stranger)
    db.commit()
    return {"owner": owner, "reader": reader, "stranger": stranger, "project": p, "hidden": hidden}


def test_секрет_не_хранится_только_хэш_и_префикс(db, scene):
    issued = personal_tokens.issue(db, scene["owner"].id, "Агент", False, 90)
    row = db.get(PersonalToken, issued.token.id)
    assert issued.secret.startswith("archmap_") and len(issued.secret) > 40
    assert row.token_hash == personal_tokens.secret_hash(issued.secret) != issued.secret
    assert row.prefix == issued.secret[:14]
    assert issued.secret not in {row.name, row.prefix, row.token_hash}


def test_токен_видит_те_же_проекты_и_роли_что_сессия(client, db, scene):
    secret = _token(db, scene["reader"])
    by_token = client.get(PROJECTS, headers=_h(secret))
    by_session = client.get(PROJECTS, headers=_jwt(scene["reader"]))
    assert by_token.status_code == 200
    assert [(x["name"], x["my_role"]) for x in by_token.json()] == [
        (x["name"], x["my_role"]) for x in by_session.json()
    ]
    assert [x["name"] for x in by_token.json()] == ["Ярмарка"]
    # чужой закрытый проект — 404, как у сессии
    assert client.get(f"{PROJECTS}/{scene['hidden'].id}", headers=_h(secret)).status_code == 404
    # роль «чтение» токеном не расширяется
    r = client.post(NODES, headers=_h(secret, scene["project"]), json={"name": "от читателя"})
    assert r.status_code == 403


def test_полный_токен_пишет_от_имени_владельца(client, db, scene):
    secret = _token(db, scene["owner"])
    r = client.post(NODES, headers=_h(secret, scene["project"]), json={"name": "Шлюз"})
    assert r.status_code == 201, r.text
    db.expire_all()
    assert db.query(Node).filter(Node.name == "Шлюз").one().project_id == scene["project"].id
    assert scene["project"].updated_by_id == scene["owner"].id


def test_только_чтение_пускает_лишь_безопасные_методы(client, db, scene):
    secret = _token(db, scene["owner"], read_only=True)
    p = scene["project"]
    assert client.get(PROJECTS, headers=_h(secret)).status_code == 200
    assert client.get(NODES, headers=_h(secret, p)).status_code == 200
    r = client.post(NODES, headers=_h(secret, p), json={"name": "нельзя"})
    assert r.status_code == 403
    assert r.json()["detail"] == personal_tokens.READ_ONLY_DETAIL
    node = Node(project_id=p.id, name="Есть")
    db.add(node)
    db.commit()
    r = client.patch(f"{NODES}/{node.id}", headers=_h(secret, p), json={"description": "x", "version": 1})
    assert r.status_code == 403


def test_удалять_токеном_нельзя_никаким(client, db, scene):
    secret = _token(db, scene["owner"])
    p = scene["project"]
    node = Node(project_id=p.id, name="Есть")
    db.add(node)
    db.commit()
    r = client.delete(f"{NODES}/{node.id}", headers=_h(secret, p))
    assert r.status_code == 403
    assert r.json()["detail"] == personal_tokens.NO_DELETE_DETAIL
    r = client.delete(f"{PROJECTS}/{p.id}", headers=_h(secret), params={"confirm": "Ярмарка"})
    assert r.status_code == 403
    db.expire_all()
    assert db.get(Node, node.id) is not None


def test_управление_проектом_пароль_и_админка_токеном_закрыты(client, db, scene):
    owner = scene["owner"]
    owner.is_admin = True
    db.commit()
    secret = _token(db, owner)
    p = scene["project"]
    other = scene["stranger"]
    attempts = [
        ("PATCH", f"{PROJECTS}/{p.id}", {"description": "токеном"}),
        ("POST", f"{PROJECTS}/{p.id}/archive", None),
        ("POST", f"{PROJECTS}/{p.id}/restore", None),
        ("PUT", f"{PROJECTS}/{p.id}/members/{other.id}", {"role": "editor"}),
        ("POST", f"{PROJECTS}/{p.id}/transfer", {"user_id": str(other.id)}),
        ("POST", f"{NODES}/transition", {"base_graph_rev": 0}),
        ("POST", "/api/v1/auth/password", {"old_password": "x", "new_password": "новый-пароль-1"}),
        ("GET", "/api/v1/admin/users", None),
    ]
    for method, url, body in attempts:
        r = client.request(method, url, headers=_h(secret, p), json=body)
        assert r.status_code == 403, (method, url, r.text)
        assert r.json()["detail"] == personal_tokens.SESSION_ONLY_DETAIL, (method, url)
    # сессией те же ручки открыты: запрет — именно токену
    assert client.get("/api/v1/admin/users", headers=_jwt(owner)).status_code == 200
    db.expire_all()
    assert p.archived_at is None and p.description != "токеном"


def test_истёкший_отозванный_и_выдуманный_токен_401(client, db, scene):
    expired = _token(db, scene["owner"], name="старый")
    row = db.query(PersonalToken).filter(PersonalToken.name == "старый").one()
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    revoked = _token(db, scene["owner"], name="отозванный")
    db.query(PersonalToken).filter(PersonalToken.name == "отозванный").delete()
    db.commit()
    for secret in (expired, revoked, "archmap_" + "x" * 43):
        r = client.get(PROJECTS, headers=_h(secret))
        assert r.status_code == 401
        assert r.json()["detail"] == personal_tokens.INVALID_DETAIL
        assert r.headers["www-authenticate"] == 'Bearer error="invalid_token"'


def test_бессрочный_токен_работает(client, db, scene):
    secret = _token(db, scene["owner"], days=None)
    assert client.get(PROJECTS, headers=_h(secret)).status_code == 200


def test_блокировка_учётки_гасит_токен_сразу(client, db, scene):
    secret = _token(db, scene["owner"])
    assert client.get(PROJECTS, headers=_h(secret)).status_code == 200
    scene["owner"].is_active = False
    db.commit()
    r = client.get(PROJECTS, headers=_h(secret))
    assert r.status_code == 401
    assert r.json()["detail"] == BLOCKED_DETAIL


def test_отметка_использования_не_чаще_минуты(client, db, scene):
    secret = _token(db, scene["owner"])
    row = db.query(PersonalToken).one()
    assert row.last_used_at is None
    assert client.get(PROJECTS, headers=_h(secret)).status_code == 200
    db.refresh(row)
    first = row.last_used_at
    assert first is not None
    assert client.get(PROJECTS, headers=_h(secret)).status_code == 200
    db.refresh(row)
    assert row.last_used_at == first
    row.last_used_at = datetime.now(UTC) - timedelta(minutes=2)
    db.commit()
    assert client.get(PROJECTS, headers=_h(secret)).status_code == 200
    db.refresh(row)
    assert row.last_used_at != first


def test_на_демо_стенде_вход_по_токену_закрыт(client, db, scene, monkeypatch):
    secret = _token(db, scene["owner"])
    monkeypatch.setattr(settings, "demo_mode", True)
    r = client.get(PROJECTS, headers=_h(secret))
    assert r.status_code == 401
    assert r.json()["detail"] == personal_tokens.INVALID_DETAIL


def test_предел_и_повтор_имени(db, scene):
    owner = scene["owner"]
    personal_tokens.issue(db, owner.id, "Агент", False, 90)
    with pytest.raises(personal_tokens.TokenError) as exc:
        personal_tokens.issue(db, owner.id, "Агент", True, 30)
    assert exc.value.detail == personal_tokens.NAME_TAKEN_DETAIL
    for i in range(personal_tokens.MAX_PER_USER - 1):
        personal_tokens.issue(db, owner.id, f"Агент {i}", False, None)
    with pytest.raises(personal_tokens.TokenError) as exc:
        personal_tokens.issue(db, owner.id, "лишний", False, 90)
    assert exc.value.detail == personal_tokens.LIMIT_DETAIL
    # у другого пользователя — свой счёт и свои имена
    personal_tokens.issue(db, scene["reader"].id, "Агент", False, 90)
