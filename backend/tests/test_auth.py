"""Тесты auth-стека после миграции python-jose→PyJWT и passlib→pwdlib.

Ключевой — характеризационный: новый verify ОБЯЗАН принимать bcrypt-хэши,
сгенерированные старым passlib, иначе существующие пользователи не войдут.
Референс-хэш ниже сгенерирован старым стеком (passlib CryptContext bcrypt) для
пароля LEGACY_PASSWORD и зашит константой намеренно — он фиксирует контракт.
"""

import datetime as dt

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import (
    _get_current_user,
    create_access_token,
    hash_password,
    verify_password,
)
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.user import User

# Сгенерировано старым passlib (CryptContext schemes=["bcrypt"]) — НЕ менять.
LEGACY_PASSWORD = "archmap-legacy-pass-2026"
LEGACY_PASSLIB_HASH = "$2b$12$raPr/iqngxk7/iEyRWDHMOPVzOmUZqw6qPJSu2QAeyz2.Fk7mwXay"


def test_hash_verify_roundtrip():
    h = hash_password("s3cret-pw")
    assert h != "s3cret-pw"
    assert verify_password("s3cret-pw", h)
    assert not verify_password("wrong-pw", h)


def test_verify_legacy_passlib_hash():
    # Новый pwdlib-стек принимает старый passlib-хэш — иначе все юзеры залочены.
    assert verify_password(LEGACY_PASSWORD, LEGACY_PASSLIB_HASH)
    assert not verify_password("wrong-pw", LEGACY_PASSLIB_HASH)


def test_access_token_roundtrip():
    token = create_access_token({"sub": "alice", "role": "architect"})
    payload = jwt.decode(
        token, settings.secret_key, algorithms=[settings.algorithm]
    )
    assert payload["sub"] == "alice"
    assert payload["role"] == "architect"
    assert "exp" in payload


def test_expired_token_rejected(db):
    # Токен с exp в прошлом → _get_current_user отвергает 401 (ловит PyJWTError).
    expired = jwt.encode(
        {
            "sub": "alice",
            "role": "architect",
            "exp": dt.datetime.now(dt.UTC) - dt.timedelta(minutes=1),
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    with pytest.raises(HTTPException) as exc:
        _get_current_user(expired, db)
    assert exc.value.status_code == 401


def test_valid_token_resolves_user(db):
    # Сквозной путь: создаём юзера, токен на его username, _get_current_user находит.
    user = User(
        username="alice",
        hashed_password=hash_password("pw"),
        role="architect",
    )
    db.add(user)
    db.commit()

    token = create_access_token({"sub": "alice", "role": "architect"})
    resolved = _get_current_user(token, db)
    assert resolved.username == "alice"
    assert resolved.role == "architect"


# ── Админка пользователей: вход, блокировка, /auth/me, смена пароля, ALLOW_SIGNUP ──
# (docs/tasks/admin-users.md). HTTP-уровень через TestClient с настоящей зависимостью
# авторизации: подменена только сессия БД.

# Хэш считается один раз: bcrypt медленный, а тестам нужен лишь известный пароль.
PW = "correct-horse-1"
PW_HASH = hash_password(PW)


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _add_user(db, username: str, **fields) -> User:
    user = User(username=username, hashed_password=PW_HASH, **fields)
    db.add(user)
    db.commit()
    return user


def _bearer(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token({'sub': user.username, 'role': user.role})}"}


def _login(client: TestClient, username: str, password: str):
    return client.post("/api/v1/auth/login", data={"username": username, "password": password})


def test_login_ok(client, db):
    _add_user(db, "alice", role="architect")
    r = _login(client, "alice", PW)
    assert r.status_code == 200
    assert r.json()["access_token"]


def test_login_заблокированного_401(client, db):
    _add_user(db, "alice", role="architect", is_active=False)
    r = _login(client, "alice", PW)
    assert r.status_code == 401
    assert r.json() == {"detail": "Учётная запись заблокирована"}


def test_login_заблокированного_с_неверным_паролем_не_выдаёт_блокировку(client, db):
    # О блокировке узнаёт только знающий пароль: посторонний видит обычный отказ.
    _add_user(db, "alice", role="architect", is_active=False)
    r = _login(client, "alice", "wrong-password")
    assert r.status_code == 401
    assert r.json() == {"detail": "Неверный логин или пароль"}


def test_токен_заблокированного_перестаёт_работать_сразу(client, db):
    user = _add_user(db, "alice", role="architect")
    headers = _bearer(user)
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 200
    user.is_active = False
    db.commit()
    r = client.get("/api/v1/auth/me", headers=headers)
    assert r.status_code == 401
    assert r.json() == {"detail": "Учётная запись заблокирована"}
    # и на доменных эндпоинтах тоже: проверка в общей зависимости
    assert client.get("/api/v1/projects", headers=headers).status_code == 401


def test_me(client, db):
    user = _add_user(db, "alice", role="viewer", is_admin=True)
    r = client.get("/api/v1/auth/me", headers=_bearer(user))
    assert r.status_code == 200
    assert r.json() == {
        "id": str(user.id),
        "username": "alice",
        "role": "viewer",
        "is_admin": True,
        # Поля демо-режима (docs/tasks/demo-mode.md) — аддитивно: обычный
        # пользователь не гость, а наблюдатель проекты не создаёт.
        "is_guest": False,
        "can_create_project": False,
    }


def test_me_без_токена_401(client):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_роль_из_бд_а_не_из_токена(client, db):
    # Токен выписан архитектору; роль сменили — /auth/me отдаёт новую без перелогина.
    user = _add_user(db, "alice", role="architect")
    headers = _bearer(user)
    user.role = "viewer"
    db.commit()
    assert client.get("/api/v1/auth/me", headers=headers).json()["role"] == "viewer"


def test_auth_config_без_авторизации(client, monkeypatch):
    # Поля демо-режима аддитивны: вне демо он выключен и пределов нет.
    off = {"demo_mode": False, "demo_limits": None}
    monkeypatch.setattr(settings, "allow_signup", True)
    assert client.get("/api/v1/auth/config").json() == {"allow_signup": True, **off}
    monkeypatch.setattr(settings, "allow_signup", False)
    assert client.get("/api/v1/auth/config").json() == {"allow_signup": False, **off}


def test_register_при_allow_signup_true(client, db, monkeypatch):
    monkeypatch.setattr(settings, "allow_signup", True)
    r = client.post(
        "/api/v1/auth/register",
        json={"username": "bob", "password": "long-enough-1", "role": "architect"},
    )
    assert r.status_code == 201
    assert r.json() == {"username": "bob", "role": "architect"}


def test_register_при_allow_signup_false_403(client, db, monkeypatch):
    monkeypatch.setattr(settings, "allow_signup", False)
    r = client.post(
        "/api/v1/auth/register",
        json={"username": "bob", "password": "long-enough-1", "role": "architect"},
    )
    assert r.status_code == 403
    assert "Регистрация отключена" in r.json()["detail"]
    assert db.query(User).count() == 0


def test_register_не_даёт_админа(client, db, monkeypatch):
    monkeypatch.setattr(settings, "allow_signup", True)
    r = client.post(
        "/api/v1/auth/register",
        json={"username": "bob", "password": "long-enough-1", "role": "architect", "is_admin": True},
    )
    assert r.status_code == 201
    assert db.query(User).filter(User.username == "bob").one().is_admin is False


def test_register_короткий_пароль_400(client, db, monkeypatch):
    monkeypatch.setattr(settings, "allow_signup", True)
    r = client.post(
        "/api/v1/auth/register", json={"username": "bob", "password": "short", "role": "viewer"}
    )
    assert r.status_code == 400
    assert r.json() == {"detail": "Пароль должен быть не короче 8 символов"}


def test_смена_пароля(client, db):
    user = _add_user(db, "alice", role="viewer")
    r = client.post(
        "/api/v1/auth/password",
        headers=_bearer(user),
        json={"old_password": PW, "new_password": "brand-new-pw"},
    )
    assert r.status_code == 204
    assert _login(client, "alice", "brand-new-pw").status_code == 200
    assert _login(client, "alice", PW).status_code == 401


def test_смена_пароля_неверный_старый(client, db):
    user = _add_user(db, "alice", role="viewer")
    r = client.post(
        "/api/v1/auth/password",
        headers=_bearer(user),
        json={"old_password": "wrong-password", "new_password": "brand-new-pw"},
    )
    assert r.status_code == 400
    assert r.json() == {"detail": "Неверный текущий пароль"}
    assert _login(client, "alice", PW).status_code == 200


def test_смена_пароля_короткий_новый(client, db):
    user = _add_user(db, "alice", role="viewer")
    r = client.post(
        "/api/v1/auth/password",
        headers=_bearer(user),
        json={"old_password": PW, "new_password": "short"},
    )
    assert r.status_code == 400
    assert r.json() == {"detail": "Пароль должен быть не короче 8 символов"}
    assert _login(client, "alice", PW).status_code == 200


def test_смена_пароля_без_токена_401(client):
    r = client.post(
        "/api/v1/auth/password", json={"old_password": PW, "new_password": "brand-new-pw"}
    )
    assert r.status_code == 401
