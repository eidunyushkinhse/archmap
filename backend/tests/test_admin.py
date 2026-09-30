"""Админка пользователей (docs/tasks/admin-users.md): серверная команда create-admin
и API администратора /admin/users с защитами от потери управления."""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import admin as admin_cmd
from app.admin import AdminCommandError, create_admin
from app.auth import create_access_token, hash_password, verify_password
from app.database import get_db
from app.main import app
from app.models.user import User
from app.routers.admin import update_user
from app.schemas.admin import AdminUserUpdate

# Хэш считается один раз: bcrypt медленный, а тестам нужен лишь известный пароль.
OLD_PW = "old-password-1"
OLD_HASH = hash_password(OLD_PW)


def _fake_getpass(monkeypatch, *answers: str) -> list[str]:
    """Подменить getpass: команда читает пароль из консоли дважды. Возвращает список
    заданных вопросов — по нему видно, спрашивала ли команда пароль вообще."""
    queue = list(answers)
    asked: list[str] = []

    def fake(prompt: str = "") -> str:
        asked.append(prompt)
        return queue.pop(0)

    monkeypatch.setattr(admin_cmd.getpass, "getpass", fake)
    return asked


def _user(db, username: str, **fields) -> User:
    user = User(username=username, hashed_password=OLD_HASH, **fields)
    db.add(user)
    db.commit()
    return user


# ── Команда create-admin ─────────────────────────────────────────────────────────


def test_create_admin_новый_пользователь(db, monkeypatch):
    asked = _fake_getpass(monkeypatch, "first-admin-pw", "first-admin-pw")
    итог = create_admin(db, "boss")
    user = db.query(User).filter(User.username == "boss").one()
    assert user.is_admin and user.is_active
    # новому по умолчанию — архитектор: первый админ обычно и ведёт документацию
    assert user.role == "architect"
    assert verify_password("first-admin-pw", user.hashed_password)
    assert len(asked) == 2  # пароль спрошен дважды
    assert "Создан администратор «boss»" in итог


def test_create_admin_новый_с_ролью_viewer(db, monkeypatch):
    _fake_getpass(monkeypatch, "first-admin-pw", "first-admin-pw")
    create_admin(db, "boss", role="viewer")
    assert db.query(User).filter(User.username == "boss").one().role == "viewer"


def test_create_admin_существующий_пароль_не_трогает(db, monkeypatch):
    _user(db, "ivan", role="viewer", is_active=False)
    asked = _fake_getpass(monkeypatch)  # пароль спрашивать не должна
    итог = create_admin(db, "ivan")
    db.expire_all()
    user = db.query(User).filter(User.username == "ivan").one()
    assert asked == []
    assert user.is_admin
    # путь восстановления доступа: блокировка снимается
    assert user.is_active
    # роль без --role не меняется
    assert user.role == "viewer"
    assert verify_password(OLD_PW, user.hashed_password)
    assert "пароль не менялся" in итог and "блокировка снята" in итог


def test_create_admin_существующий_с_ролью(db, monkeypatch):
    _user(db, "ivan", role="viewer")
    _fake_getpass(monkeypatch)
    create_admin(db, "ivan", role="architect")
    db.expire_all()
    assert db.query(User).filter(User.username == "ivan").one().role == "architect"


def test_create_admin_reset_password(db, monkeypatch):
    _user(db, "ivan", role="viewer")
    _fake_getpass(monkeypatch, "brand-new-pw", "brand-new-pw")
    итог = create_admin(db, "ivan", reset_password=True)
    db.expire_all()
    user = db.query(User).filter(User.username == "ivan").one()
    assert user.is_admin
    assert verify_password("brand-new-pw", user.hashed_password)
    assert not verify_password(OLD_PW, user.hashed_password)
    assert "пароль изменён" in итог


def test_create_admin_пароли_не_совпадают(db, monkeypatch):
    _fake_getpass(monkeypatch, "first-admin-pw", "other-admin-pw")
    with pytest.raises(AdminCommandError, match="не совпадают"):
        create_admin(db, "boss")
    assert db.query(User).count() == 0


def test_create_admin_короткий_пароль(db, monkeypatch):
    _fake_getpass(monkeypatch, "short", "short")
    with pytest.raises(AdminCommandError, match="не короче 8"):
        create_admin(db, "boss")
    assert db.query(User).count() == 0


def test_create_admin_main_код_выхода(db, monkeypatch, capsys):
    # main — тонкая обёртка: разбор аргументов, сессия, печать итога и код выхода.
    class _Session:
        def __enter__(self):
            return db

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(admin_cmd, "SessionLocal", _Session)
    _fake_getpass(monkeypatch, "first-admin-pw", "first-admin-pw")
    assert admin_cmd.main(["create-admin", "boss", "--role", "viewer"]) == 0
    assert "Создан администратор" in capsys.readouterr().out

    _fake_getpass(monkeypatch, "a", "b")
    assert admin_cmd.main(["create-admin", "ghost"]) == 1
    assert "Пароли не совпадают" in capsys.readouterr().err


# ── API администратора /admin/users ──────────────────────────────────────────────


@pytest.fixture()
def client(db):
    """Настоящая авторизация (токен → get_current_user → require_admin); подменена
    только сессия БД."""
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _bearer(user: User) -> dict[str, str]:
    token = create_access_token({"sub": user.username, "role": user.role})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def boss(db) -> User:
    """Единственный администратор — и тот наблюдатель: право управлять людьми не
    связано с правом на документацию."""
    return _user(db, "boss", role="viewer", is_admin=True)


USERS = "/api/v1/admin/users"


def test_список_без_хэша(client, db, boss):
    _user(db, "ivan", role="architect")
    r = client.get(USERS, headers=_bearer(boss))
    assert r.status_code == 200
    rows = r.json()
    assert [row["username"] for row in rows] == ["boss", "ivan"]
    assert set(rows[0]) == {"id", "username", "role", "is_admin", "is_active", "created_at"}


def test_неадмин_получает_403_на_всё(client, db, boss):
    ivan = _user(db, "ivan", role="architect")
    h = _bearer(ivan)
    for r in (
        client.get(USERS, headers=h),
        client.post(USERS, headers=h, json={"username": "x", "password": "long-enough"}),
        client.patch(f"{USERS}/{boss.id}", headers=h, json={"is_active": False}),
        client.post(f"{USERS}/{boss.id}/password", headers=h, json={"new_password": "long-enough"}),
    ):
        assert r.status_code == 403
        assert r.json() == {"detail": "Требуются права администратора"}
    db.expire_all()
    assert boss.is_active


def test_без_токена_401(client):
    assert client.get(USERS).status_code == 401


def test_создать_пользователя(client, db, boss):
    r = client.post(
        USERS,
        headers=_bearer(boss),
        json={"username": "  ivan ", "role": "architect", "is_admin": True, "password": "temp-pass-1"},
    )
    assert r.status_code == 201
    body = r.json()
    assert "hashed_password" not in body
    assert body["username"] == "ivan"  # пробелы по краям срезаны
    assert body["role"] == "architect" and body["is_admin"] and body["is_active"]
    login = client.post("/api/v1/auth/login", data={"username": "ivan", "password": "temp-pass-1"})
    assert login.status_code == 200


def test_создать_дубль_409(client, db, boss):
    _user(db, "ivan", role="viewer")
    r = client.post(USERS, headers=_bearer(boss), json={"username": "ivan", "password": "temp-pass-1"})
    assert r.status_code == 409
    assert r.json() == {"detail": "Пользователь с таким логином уже есть"}


@pytest.mark.parametrize(
    ("username", "password", "detail"),
    [
        ("   ", "temp-pass-1", "Укажите логин"),
        ("x" * 65, "temp-pass-1", "Логин должен быть не длиннее 64 символов"),
        ("ivan", "short", "Пароль должен быть не короче 8 символов"),
    ],
)
def test_создать_с_ошибкой_400(client, db, boss, username, password, detail):
    r = client.post(USERS, headers=_bearer(boss), json={"username": username, "password": password})
    assert r.status_code == 400
    assert r.json() == {"detail": detail}
    assert db.query(User).count() == 1


def test_сменить_роль_действует_на_следующий_запрос(client, db, boss):
    ivan = _user(db, "ivan", role="architect")
    h = _bearer(ivan)  # токен выписан архитектору и несёт его роль
    prompt = "/api/v1/projects/import/prompt?system_name=Ярмарка"
    assert client.get(prompt, headers=h).status_code == 200

    r = client.patch(f"{USERS}/{ivan.id}", headers=_bearer(boss), json={"role": "viewer"})
    assert r.status_code == 200 and r.json()["role"] == "viewer"

    # тот же токен, следующий запрос: роль берётся из БД, архитекторское закрыто
    assert client.get(prompt, headers=h).status_code == 403
    assert client.get("/api/v1/auth/me", headers=h).json()["role"] == "viewer"


def test_выдать_и_снять_админа(client, db, boss):
    ivan = _user(db, "ivan", role="viewer")
    r = client.patch(f"{USERS}/{ivan.id}", headers=_bearer(boss), json={"is_admin": True})
    assert r.json()["is_admin"] is True
    # новый админ сразу проходит в админку
    assert client.get(USERS, headers=_bearer(ivan)).status_code == 200
    # админов двое — одного можно разжаловать
    r = client.patch(f"{USERS}/{ivan.id}", headers=_bearer(boss), json={"is_admin": False})
    assert r.status_code == 200 and r.json()["is_admin"] is False
    assert client.get(USERS, headers=_bearer(ivan)).status_code == 403


def test_заблокировать_и_разблокировать(client, db, boss):
    ivan = _user(db, "ivan", role="architect")
    h = _bearer(ivan)
    r = client.patch(f"{USERS}/{ivan.id}", headers=_bearer(boss), json={"is_active": False})
    assert r.status_code == 200 and r.json()["is_active"] is False
    # выданный токен перестал работать, войти нельзя
    assert client.get("/api/v1/auth/me", headers=h).status_code == 401
    login = client.post("/api/v1/auth/login", data={"username": "ivan", "password": OLD_PW})
    assert login.json() == {"detail": "Учётная запись заблокирована"}

    r = client.patch(f"{USERS}/{ivan.id}", headers=_bearer(boss), json={"is_active": True})
    assert r.json()["is_active"] is True
    assert client.get("/api/v1/auth/me", headers=h).status_code == 200


def test_заблокированный_админ_теряет_админку(client, db, boss):
    other = _user(db, "other", role="viewer", is_admin=True)
    h = _bearer(other)
    client.patch(f"{USERS}/{other.id}", headers=_bearer(boss), json={"is_active": False})
    assert client.get(USERS, headers=h).status_code == 401


def test_нельзя_заблокировать_себя(client, db, boss):
    _user(db, "other", role="viewer", is_admin=True)  # не последний админ — важна именно «себя»
    r = client.patch(f"{USERS}/{boss.id}", headers=_bearer(boss), json={"is_active": False})
    assert r.status_code == 400
    assert r.json() == {"detail": "Нельзя заблокировать себя"}
    db.expire_all()
    assert boss.is_active


def test_нельзя_снять_админа_с_себя(client, db, boss):
    _user(db, "other", role="viewer", is_admin=True)
    r = client.patch(f"{USERS}/{boss.id}", headers=_bearer(boss), json={"is_admin": False})
    assert r.status_code == 400
    assert r.json() == {"detail": "Нельзя снять права администратора с себя"}
    db.expire_all()
    assert boss.is_admin


def test_себе_можно_сменить_роль(client, db, boss):
    r = client.patch(f"{USERS}/{boss.id}", headers=_bearer(boss), json={"role": "architect"})
    assert r.status_code == 200 and r.json()["role"] == "architect"


def _гонка(db, target: User, actor: User, payload: AdminUserUpdate):
    """Правка от админа, которого другой админ разжаловал, пока шёл его запрос.

    Через HTTP «последний администратор» недостижим последовательно: сам действующий
    админ активен, так что цель, отличная от него, не последняя, а себя трогать
    запрещено отдельно. Защита нужна против гонки: два админа одновременно снимают
    права друг с друга. Моделируем проигравшего: require_admin его уже пропустил,
    а в БД он больше не админ."""
    actor.is_admin = False
    db.commit()
    return update_user(target.id, payload, db, actor)


def test_нельзя_снять_права_с_последнего_админа(db, boss):
    other = _user(db, "other", role="viewer", is_admin=True)
    with pytest.raises(HTTPException) as exc:
        _гонка(db, boss, other, AdminUserUpdate(is_admin=False))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Нельзя снять права с последнего администратора"
    db.expire_all()
    assert boss.is_admin


def test_нельзя_заблокировать_последнего_админа(db, boss):
    other = _user(db, "other", role="viewer", is_admin=True)
    with pytest.raises(HTTPException) as exc:
        _гонка(db, boss, other, AdminUserUpdate(is_active=False))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Нельзя заблокировать последнего администратора"
    db.expire_all()
    assert boss.is_active


def test_заблокированный_админ_не_считается_активным(db, boss):
    # Второй админ есть, но заблокирован: «последний активный» — всё равно boss.
    blocked = _user(db, "blocked", role="viewer", is_admin=True, is_active=False)
    actor = _user(db, "actor", role="viewer", is_admin=True)
    with pytest.raises(HTTPException) as exc:
        _гонка(db, boss, actor, AdminUserUpdate(is_admin=False))
    assert exc.value.detail == "Нельзя снять права с последнего администратора"
    assert blocked.is_admin  # заблокированный админ остаётся с признаком, но не в счёт


def test_последний_админ_можно_снять_роль(db, boss):
    # Защита только от потери управления: роль последнего админа менять можно.
    other = _user(db, "other", role="viewer", is_admin=True)
    user = _гонка(db, boss, other, AdminUserUpdate(role="architect"))
    assert user.role == "architect" and user.is_admin


def test_сброс_пароля(client, db, boss):
    ivan = _user(db, "ivan", role="viewer")
    r = client.post(f"{USERS}/{ivan.id}/password", headers=_bearer(boss), json={"new_password": "reset-pass-1"})
    assert r.status_code == 204
    assert client.post("/api/v1/auth/login", data={"username": "ivan", "password": "reset-pass-1"}).status_code == 200
    assert client.post("/api/v1/auth/login", data={"username": "ivan", "password": OLD_PW}).status_code == 401


def test_сброс_пароля_короткий_400(client, db, boss):
    ivan = _user(db, "ivan", role="viewer")
    r = client.post(f"{USERS}/{ivan.id}/password", headers=_bearer(boss), json={"new_password": "short"})
    assert r.status_code == 400
    assert r.json() == {"detail": "Пароль должен быть не короче 8 символов"}


def test_неизвестный_пользователь_404(client, db, boss):
    missing = "00000000-0000-0000-0000-000000000000"
    h = _bearer(boss)
    for r in (
        client.patch(f"{USERS}/{missing}", headers=h, json={"is_active": False}),
        client.post(f"{USERS}/{missing}/password", headers=h, json={"new_password": "long-enough"}),
    ):
        assert r.status_code == 404
        assert r.json() == {"detail": "Пользователь не найден"}


def test_коллекция_без_хвостового_слэша(client, db, boss):
    assert client.get(f"{USERS}/", headers=_bearer(boss)).status_code == 404
