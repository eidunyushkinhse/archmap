"""Демо-режим публичного стенда (docs/tasks/demo-mode.md, шаг 1).

Всё через настоящие зависимости: /demo/start → токен гостя → get_current_user.
Подменена только сессия БД. Демо-режим включается подменой settings.demo_mode
на время теста; вне его поведение продукта обязано остаться прежним, и это
проверяется здесь же отдельными тестами.
"""

import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from conftest import make_project
from fastapi.testclient import TestClient

from app import demo
from app.admin import demo_cleanup, demo_stats
from app.auth import (
    GUEST_CLAIM,
    SANDBOX_GONE_DETAIL,
    create_access_token,
    hash_password,
)
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.node import Node
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User

START = "/api/v1/demo/start"
PROJECTS = "/api/v1/projects"


@pytest.fixture()
def client(db):
    def _db():
        try:
            yield db
        except Exception:
            # Отказ посреди записи: сессию тестов делят все запросы, откатываем её
            # так же, как прод закрывает свою.
            db.rollback()
            raise

    app.dependency_overrides[get_db] = _db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def demo_on(monkeypatch):
    monkeypatch.setattr(settings, "demo_mode", True)
    demo.start_limiter.reset()
    yield
    demo.start_limiter.reset()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _start(client: TestClient) -> str:
    res = client.post(START)
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


def _guest(db, username: str = "guest-old", last_active: datetime | None = None) -> User:
    now = datetime.now(UTC)
    u = User(
        id=uuid.uuid4(),
        username=username,
        hashed_password="x",
        role="architect",
        is_guest=True,
        last_active_at=last_active,
        created_at=now - timedelta(days=3),
    )
    db.add(u)
    db.flush()
    return u


def _user_token(user: User) -> str:
    return create_access_token({"sub": user.username, "role": user.role})


def _guest_token(user: User) -> str:
    return create_access_token({"sub": user.username, "role": user.role, GUEST_CLAIM: True})


# ── Старт песочницы ─────────────────────────────────────────────────────────


def test_старт_заводит_гостя_и_его_ярмарку(client, db, demo_on):
    token = _start(client)
    claims = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    assert claims[GUEST_CLAIM] is True
    # Токен гостя живёт заметно дольше суток.
    assert claims["exp"] - datetime.now(UTC).timestamp() > 7 * 24 * 3600

    guest = db.query(User).filter(User.username == claims["sub"]).one()
    assert guest.username.startswith("guest-")
    assert guest.is_guest and guest.role == "architect" and not guest.is_admin
    assert guest.last_active_at is not None

    res = client.get(PROJECTS, headers=_auth(token))
    assert res.status_code == 200
    [card] = res.json()
    assert card["name"] == demo.SANDBOX_PROJECT_NAME
    assert card["description"] == demo.SANDBOX_PROJECT_DESCRIPTION
    assert card["my_role"] == "owner"
    assert card["visible_to_all"] is False
    assert card["object_count"] >= 30

    me = client.get("/api/v1/auth/me", headers=_auth(token)).json()
    assert me["is_guest"] is True
    assert me["can_create_project"] is True


def test_песочницы_гостей_изолированы(client, db, demo_on):
    a, b = _start(client), _start(client)
    ids_a = {p["id"] for p in client.get(PROJECTS, headers=_auth(a)).json()}
    ids_b = {p["id"] for p in client.get(PROJECTS, headers=_auth(b)).json()}
    assert len(ids_a) == len(ids_b) == 1
    assert not ids_a & ids_b
    # Чужая песочница недоступна вовсе.
    [pid] = ids_b
    assert client.get(f"{PROJECTS}/{pid}", headers=_auth(a)).status_code == 404


def test_старт_вне_демо_404(client, db):
    assert client.post(START).status_code == 404
    assert db.query(User).count() == 0


def test_старт_отказ_429_когда_стенд_полон(client, db, demo_on, monkeypatch):
    monkeypatch.setattr(settings, "demo_max_sandboxes", 1)
    _guest(db, "guest-busy", datetime.now(UTC))
    db.commit()
    res = client.post(START)
    assert res.status_code == 429
    assert res.json()["detail"] == demo.TOO_MANY_DETAIL
    assert db.query(User).count() == 1  # нового гостя нет


def test_старт_отказ_429_по_адресу(client, db, demo_on, monkeypatch):
    monkeypatch.setattr(settings, "demo_start_per_ip_per_hour", 2)
    _start(client)
    _start(client)
    res = client.post(START)
    assert res.status_code == 429
    assert res.json()["detail"] == demo.TOO_MANY_DETAIL
    assert db.query(User).filter(User.is_guest.is_(True)).count() == 2


def test_лимит_по_адресу_окно_час():
    lim = demo.StartLimiter()
    lim.record("1.2.3.4", now=0.0)
    lim.record("1.2.3.4", now=10.0)
    assert not lim.allowed("1.2.3.4", 2, now=20.0)
    assert lim.allowed("5.6.7.8", 2, now=20.0)  # другой адрес — свой счётчик
    assert lim.allowed("1.2.3.4", 2, now=3600.5)  # первый старт вышел из окна


# ── Отключения в демо-режиме ────────────────────────────────────────────────


def test_конфиг_в_демо(client, demo_on, monkeypatch):
    monkeypatch.setattr(settings, "allow_signup", True)
    cfg = client.get("/api/v1/auth/config").json()
    assert cfg["allow_signup"] is False
    assert cfg["demo_mode"] is True
    assert cfg["demo_limits"] == {
        "nodes": 100,
        "edges": 120,
        "docs": 75,
        "processes": 10,
        "text_bytes": 250 * 1024,
        "file_bytes": 250 * 1024,
    }


def test_логин_и_регистрация_закрыты_в_демо(client, db, demo_on):
    db.add(User(username="admin", hashed_password=hash_password("secret-pw"), role="architect"))
    db.commit()
    res = client.post("/api/v1/auth/login", data={"username": "admin", "password": "secret-pw"})
    assert res.status_code == 403
    assert res.json()["detail"] == demo.LOGIN_OFF_DETAIL
    res = client.post(
        "/api/v1/auth/register", json={"username": "bob", "password": "long-enough-pw"}
    )
    assert res.status_code == 403
    assert db.query(User).filter(User.username == "bob").first() is None


def test_удалённая_песочница_даёт_особый_401(client, db, demo_on):
    token = _start(client)
    username = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])["sub"]
    guest = db.query(User).filter(User.username == username).one()
    report = demo.cleanup_sandboxes(db, now=datetime.now(UTC) + timedelta(days=2))
    assert report.guests == 1 and guest.id not in {u.id for u in db.query(User)}

    res = client.get(PROJECTS, headers=_auth(token))
    assert res.status_code == 401
    assert res.json()["detail"] == SANDBOX_GONE_DETAIL


def test_токен_без_признака_гостя_для_пропавшей_учётки_обычный_401(client, demo_on):
    token = create_access_token({"sub": "nobody", "role": "architect"})
    res = client.get(PROJECTS, headers=_auth(token))
    assert res.status_code == 401
    assert res.json()["detail"] == "Недействительный токен"


# ── Активность и уборка ─────────────────────────────────────────────────────


def test_активность_гостя_продлевается_не_чаще_раза_в_минуту(client, db, demo_on):
    stale = datetime.now(UTC) - timedelta(minutes=5)
    guest = _guest(db, "guest-a", stale)
    db.commit()
    assert client.get(PROJECTS, headers=_auth(_guest_token(guest))).status_code == 200
    db.refresh(guest)
    first = demo_aware(guest.last_active_at)
    assert datetime.now(UTC) - first < timedelta(seconds=30)

    # Второй запрос сразу следом — запись не повторяется.
    assert client.get(PROJECTS, headers=_auth(_guest_token(guest))).status_code == 200
    db.refresh(guest)
    assert demo_aware(guest.last_active_at) == first


def demo_aware(moment: datetime | None) -> datetime:
    assert moment is not None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def test_активность_обычного_пользователя_не_пишется(client, db):
    user = User(id=uuid.uuid4(), username="alice", hashed_password="x", role="architect")
    db.add(user)
    db.commit()
    assert client.get(PROJECTS, headers=_auth(_user_token(user))).status_code == 200
    db.refresh(user)
    assert user.last_active_at is None


def test_уборка_снимает_только_просроченных_гостей(db):
    now = datetime.now(UTC)
    old = _guest(db, "guest-old", now - timedelta(hours=25))
    silent = _guest(db, "guest-silent", None)  # активности после создания не было
    fresh = _guest(db, "guest-fresh", now - timedelta(hours=2))
    person = User(
        id=uuid.uuid4(),
        username="alice",
        hashed_password="x",
        role="architect",
        created_at=now - timedelta(days=30),
    )
    db.add(person)
    db.flush()
    old_a = make_project(db, "Ярмарка", owner=old)
    old_b = make_project(db, "Свой", owner=old)
    db.add(Node(id=uuid.uuid4(), project_id=old_a.id, name="orders"))
    silent_p = make_project(db, "Тихий", owner=silent)
    fresh_p = make_project(db, "Свежий", owner=fresh)
    person_p = make_project(db, "Работа", owner=person)
    db.commit()
    gone = {old.id, silent.id}
    gone_projects = {old_a.id, old_b.id, silent_p.id}

    report = demo.cleanup_sandboxes(db, now=now)
    assert report.guests == 2 and report.projects == 3

    users = {u.id for u in db.query(User)}
    assert not users & gone
    assert {fresh.id, person.id} <= users
    projects = {p.id for p in db.query(Project)}
    assert not projects & gone_projects
    assert {fresh_p.id, person_p.id} <= projects
    # Схема убранного проекта ушла каскадом, участия — вместе с учёткой.
    assert db.query(Node).filter(Node.project_id == old_a.id).count() == 0
    assert db.query(ProjectMember).filter(ProjectMember.user_id.in_(gone)).count() == 0


def test_команды_демо_стенда(db):
    now = datetime.now(UTC)
    old = _guest(db, "guest-old", now - timedelta(hours=30))
    fresh = _guest(db, "guest-fresh", now)
    make_project(db, "Ярмарка", owner=old)
    make_project(db, "Ярмарка", owner=fresh)
    db.commit()

    stats = demo_stats(db)
    assert "Живых песочниц: 2" in stats
    assert "Проектов у гостей: 2" in stats
    assert stats.index("guest-old") < stats.index("guest-fresh")

    assert demo_cleanup(db) == "Убрано песочниц: 1, проектов: 1."
    assert demo_cleanup(db, idle_hours=0) == "Убрано песочниц: 1, проектов: 1."
    assert "Живых песочниц: 0" in demo_stats(db)


# ── Гостевые запреты ────────────────────────────────────────────────────────


@pytest.fixture()
def guest_scene(client, db, demo_on):
    token = _start(client)
    [card] = client.get(PROJECTS, headers=_auth(token)).json()
    other = User(id=uuid.uuid4(), username="other", hashed_password="x", role="architect")
    db.add(other)
    db.commit()
    return {"token": token, "pid": card["id"], "other": other}


def test_гостю_закрыты_участники_видимость_пользователи_пароль(client, guest_scene):
    h = _auth(guest_scene["token"])
    pid = guest_scene["pid"]
    other = guest_scene["other"]
    assert client.get("/api/v1/users", headers=h).status_code == 403
    assert client.get(f"{PROJECTS}/{pid}/members", headers=h).status_code == 403
    res = client.put(f"{PROJECTS}/{pid}/members/{other.id}", json={"role": "editor"}, headers=h)
    assert res.status_code == 403
    assert client.delete(f"{PROJECTS}/{pid}/members/{other.id}", headers=h).status_code == 403
    res = client.post(f"{PROJECTS}/{pid}/transfer", json={"user_id": str(other.id)}, headers=h)
    assert res.status_code == 403
    res = client.patch(f"{PROJECTS}/{pid}", json={"visible_to_all": True}, headers=h)
    assert res.status_code == 403
    res = client.post(
        "/api/v1/auth/password",
        json={"old_password": "x", "new_password": "long-enough-pw"},
        headers=h,
    )
    assert res.status_code == 403
    assert client.get("/api/v1/admin/users", headers=h).status_code == 403
    # Своё править можно: имя и описание проекта.
    res = client.patch(f"{PROJECTS}/{pid}", json={"name": "Моя ярмарка"}, headers=h)
    assert res.status_code == 200
    assert res.json()["visible_to_all"] is False


def test_гостю_не_больше_двух_проектов_включая_архив(client, db, guest_scene):
    h = _auth(guest_scene["token"])
    res = client.post(PROJECTS, json={"name": "Мой сервис доставки"}, headers=h)
    assert res.status_code == 201
    mine = res.json()["id"]
    me = client.get("/api/v1/auth/me", headers=h).json()
    assert me["can_create_project"] is False

    res = client.post(PROJECTS, json={"name": "Третий"}, headers=h)
    assert res.status_code == 409
    assert res.json()["detail"] == demo.GUEST_PROJECTS_DETAIL
    res = client.post(
        f"{PROJECTS}/import-unified",
        files=[("files", ("a.yaml", b"nodes:\n  - name: X\n", "text/yaml"))],
        data={"name": "Третий"},
        headers=h,
    )
    assert res.status_code == 409
    assert res.json()["detail"] == demo.GUEST_PROJECTS_DETAIL

    # Архивный проект тоже считается: место освобождает только удаление.
    assert client.post(f"{PROJECTS}/{mine}/archive", headers=h).status_code == 200
    assert client.post(PROJECTS, json={"name": "Третий"}, headers=h).status_code == 409
    res = client.delete(f"{PROJECTS}/{mine}", params={"confirm": "Мой сервис доставки"}, headers=h)
    assert res.status_code == 204
    assert client.get("/api/v1/auth/me", headers=h).json()["can_create_project"] is True
    assert client.post(PROJECTS, json={"name": "Другой"}, headers=h).status_code == 201


# ── Вне демо-режима всё как раньше ──────────────────────────────────────────


def test_вне_демо_конфиг_и_вход_прежние(client, db, monkeypatch):
    monkeypatch.setattr(settings, "allow_signup", True)
    assert client.get("/api/v1/auth/config").json() == {
        "allow_signup": True,
        "demo_mode": False,
        "demo_limits": None,
    }
    db.add(User(username="alice", hashed_password=hash_password("secret-pw"), role="architect"))
    db.commit()
    res = client.post("/api/v1/auth/login", data={"username": "alice", "password": "secret-pw"})
    assert res.status_code == 200
    h = _auth(res.json()["access_token"])
    me = client.get("/api/v1/auth/me", headers=h).json()
    assert me["is_guest"] is False and me["can_create_project"] is True
    assert client.get("/api/v1/users", headers=h).status_code == 200
    # Архитектор вне демо не ограничен числом проектов.
    for i in range(3):
        assert client.post(PROJECTS, json={"name": f"П{i}"}, headers=h).status_code == 201


def test_вне_демо_наблюдатель_не_создаёт_проекты(client, db):
    viewer = User(id=uuid.uuid4(), username="vic", hashed_password="x", role="viewer")
    db.add(viewer)
    db.commit()
    me = client.get("/api/v1/auth/me", headers=_auth(_user_token(viewer))).json()
    assert me["can_create_project"] is False
