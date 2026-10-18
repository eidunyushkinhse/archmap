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
    SESSION_ENDED_DETAIL,
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


def test_auth_config_без_авторизации(client):
    # Вне демо он выключен и пределов нет; поля самостоятельной регистрации больше нет.
    assert client.get("/api/v1/auth/config").json() == {"demo_mode": False, "demo_limits": None}


def test_самостоятельной_регистрации_нет(client, db):
    """Учётки заводит только администратор: открытая регистрация позволяла выбрать себе
    роль архитектора. Первого администратора создаёт команда create-admin."""
    r = client.post(
        "/api/v1/auth/register",
        json={"username": "bob", "password": "long-enough-1", "role": "architect"},
    )
    assert r.status_code == 404
    assert db.query(User).count() == 0


def _create_by_admin(client: TestClient, db, password: str):
    boss = _add_user(db, "boss", role="architect", is_admin=True)
    return client.post(
        "/api/v1/admin/users",
        headers=_bearer(boss),
        json={"username": "bob", "password": password, "role": "viewer"},
    )


def test_новая_учётка_с_коротким_паролем_400(client, db):
    r = _create_by_admin(client, db, "short")
    assert r.status_code == 400
    assert r.json() == {"detail": "Пароль должен быть не короче 8 символов"}


def test_смена_пароля(client, db):
    user = _add_user(db, "alice", role="viewer")
    r = client.post(
        "/api/v1/auth/password",
        headers=_bearer(user),
        json={"old_password": PW, "new_password": "brand-new-pw"},
    )
    assert r.status_code == 200
    assert _login(client, "alice", "brand-new-pw").status_code == 200
    assert _login(client, "alice", PW).status_code == 401


def test_смена_пароля_закрывает_прежние_входы_но_не_эту_сессию(client, db):
    """Другой вход (например, того, кто узнал старый пароль) отбивается сразу, а эта
    сессия продолжает работать с новым токеном из ответа."""
    user = _add_user(db, "alice", role="viewer")
    другой_вход = _login(client, "alice", PW).json()["access_token"]
    r = client.post(
        "/api/v1/auth/password",
        headers=_bearer(user),
        json={"old_password": PW, "new_password": "brand-new-pw"},
    )
    новый = r.json()["access_token"]

    старый = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {другой_вход}"})
    assert старый.status_code == 401
    assert старый.json()["detail"] == SESSION_ENDED_DETAIL
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {новый}"}).status_code == 200
    assert client.get("/api/v1/auth/me", headers=_bearer(user)).status_code == 401


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


# ── Потолок bcrypt: 72 байта (аудит M1) ───────────────────────────────────────
# bcrypt 5 бросает ValueError на пароле длиннее 72 байт; без проверки это 500 на входе,
# регистрации и смене пароля. Считаются байты UTF-8: русская буква — два байта.
LONG_PW_DETAIL = "Пароль слишком длинный: не больше 72 латинских символов или 36 русских букв"


def test_verify_длинного_пароля_просто_неверный():
    assert verify_password("x" * 100, PW_HASH) is False


@pytest.mark.parametrize("password", ["x" * 73, "я" * 37])
def test_новая_учётка_с_паролем_длиннее_72_байт_400(client, db, password):
    r = _create_by_admin(client, db, password)
    assert r.status_code == 400
    assert r.json() == {"detail": LONG_PW_DETAIL}
    assert db.query(User).filter(User.username == "bob").first() is None


@pytest.mark.parametrize("password", ["x" * 72, "я" * 36])
def test_пароль_ровно_72_байта_проходит_и_входит(client, db, password):
    r = _create_by_admin(client, db, password)
    assert r.status_code == 201
    assert _login(client, "bob", password).status_code == 200


def test_login_с_длинным_паролем_401_а_не_500(client, db):
    _add_user(db, "alice", role="viewer")
    r = _login(client, "alice", "x" * 200)
    assert r.status_code == 401
    assert r.json() == {"detail": "Неверный логин или пароль"}


def test_смена_пароля_длинные_старый_и_новый(client, db):
    user = _add_user(db, "alice", role="viewer")
    r = client.post(
        "/api/v1/auth/password",
        headers=_bearer(user),
        json={"old_password": "x" * 100, "new_password": "brand-new-pw"},
    )
    assert r.status_code == 400
    assert r.json() == {"detail": "Неверный текущий пароль"}
    r = client.post(
        "/api/v1/auth/password",
        headers=_bearer(user),
        json={"old_password": PW, "new_password": "я" * 40},
    )
    assert r.status_code == 400
    assert r.json() == {"detail": LONG_PW_DETAIL}
    assert _login(client, "alice", PW).status_code == 200
