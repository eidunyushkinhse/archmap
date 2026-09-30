"""Админка пользователей (docs/tasks/admin-users.md): серверная команда create-admin
и API администратора /admin/users с защитами от потери управления."""

import pytest

from app import admin as admin_cmd
from app.admin import AdminCommandError, create_admin
from app.auth import hash_password, verify_password
from app.models.user import User


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
    user = User(username=username, hashed_password=hash_password("old-password-1"), **fields)
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
    assert verify_password("old-password-1", user.hashed_password)
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
    assert not verify_password("old-password-1", user.hashed_password)
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
