"""Загрузка файла с машины агента по одноразовой ссылке (app/uploads.py, /api/v1/uploads;
docs/plan-mcp-upload.md). Через настоящие зависимости: токен → get_current_user; подменена
только сессия БД. Что сторожим: ссылка одноразовая и срочная, чужую загрузку не прочитать,
предел размера держится до чтения тела целиком, sha256 — тот, что посчитает агент у себя.
"""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import personal_tokens, uploads
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.upload import Upload
from app.models.user import User
from app.routers import uploads as uploads_router

UPLOADS = "/api/v1/uploads"
YAML = "nodes:\n  - name: Система\n    children:\n      - name: orders\n".encode()


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    uploads_router.put_failures.__init__(window_seconds=60)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _user(db, username: str, role: str = "architect") -> User:
    u = User(id=uuid.uuid4(), username=username, hashed_password="x", role=role)
    db.add(u)
    db.flush()
    return u


def _token(db, user: User, read_only: bool = False) -> str:
    secret = personal_tokens.issue(db, user, "Агент", read_only, 90).secret
    db.commit()
    return secret


def _h(secret: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret}"}


def _slot(client: TestClient, secret: str, name: str = "run.yaml") -> dict:
    r = client.post(UPLOADS, json={"name": name}, headers=_h(secret))
    assert r.status_code == 201, r.text
    return r.json()


def test_ссылка_приём_и_чтение_владельцем(client, db):
    """Полный путь: ссылка → PUT файла без токена → GET владельцем с тем же sha256."""
    user = _user(db, "arch")
    secret = _token(db, user)
    slot = _slot(client, secret)
    assert slot["path"].startswith(f"/api/v1/uploads/{slot['id']}/")
    assert slot["max_bytes"] == settings.upload_max_mb * 1024 * 1024

    put = client.put(slot["path"], content=YAML)
    assert put.status_code == 200, put.text
    assert put.json() == {
        "upload_id": slot["id"],
        "name": "run.yaml",
        "size": len(YAML),
        "sha256": hashlib.sha256(YAML).hexdigest(),
    }

    got = client.get(f"{UPLOADS}/{slot['id']}", headers=_h(secret))
    assert got.status_code == 200
    body = got.json()
    assert body["content"] == YAML.decode() and body["sha256"] == put.json()["sha256"]
    # Загрузка живёт до срока: превью и применение читают одни и те же входы.
    assert client.get(f"{UPLOADS}/{slot['id']}", headers=_h(secret)).status_code == 200


def test_ссылка_одноразовая(client, db):
    secret = _token(db, _user(db, "arch"))
    slot = _slot(client, secret)
    assert client.put(slot["path"], content=YAML).status_code == 200
    again = client.put(slot["path"], content="другое".encode())
    assert again.status_code == 409 and uploads.ALREADY_DETAIL in again.text
    # Содержимое не подменилось.
    got = client.get(f"{UPLOADS}/{slot['id']}", headers=_h(secret)).json()
    assert got["content"] == YAML.decode()


def test_неверный_ключ_и_чужой_id_отвечают_одинаково(client, db):
    secret = _token(db, _user(db, "arch"))
    slot = _slot(client, secret)
    wrong = client.put(f"{UPLOADS}/{slot['id']}/не-тот-ключ", content=YAML)
    missing = client.put(f"{UPLOADS}/{uuid.uuid4()}/ключ", content=YAML)
    assert (wrong.status_code, missing.status_code) == (404, 404)
    assert wrong.json() == missing.json()


def test_просроченная_ссылка_и_загрузка(client, db):
    secret = _token(db, _user(db, "arch"))
    slot = _slot(client, secret)
    row = db.get(Upload, uuid.UUID(slot["id"]))
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    assert client.put(slot["path"], content=YAML).status_code == 410
    assert client.get(f"{UPLOADS}/{slot['id']}", headers=_h(secret)).status_code == 410
    # Новая ссылка убирает просроченные строки.
    _slot(client, secret)
    assert db.get(Upload, uuid.UUID(slot["id"])) is None


def test_предел_размера_по_заголовку_и_по_потоку(client, db, monkeypatch):
    monkeypatch.setattr(settings, "upload_max_mb", 1)
    secret = _token(db, _user(db, "arch"))
    slot = _slot(client, secret)
    big = b"x" * (1024 * 1024 + 1)
    r = client.put(slot["path"], content=big)
    assert r.status_code == 413 and "1 МБ" in r.text
    # Без Content-Length (chunked) предел держит чтение потока.
    r = client.put(slot["path"], content=iter([big[: 600 * 1024], big[600 * 1024 :]]))
    assert r.status_code == 413
    # Ссылка после отказов цела: файл по размеру принимается.
    assert client.put(slot["path"], content=YAML).status_code == 200


def test_пустой_файл_и_не_текст(client, db):
    secret = _token(db, _user(db, "arch"))
    slot = _slot(client, secret)
    assert client.put(slot["path"], content=b"").status_code == 422
    assert client.put(slot["path"], content=b"\xff\xfe\x00binary").status_code == 200
    got = client.get(f"{UPLOADS}/{slot['id']}", headers=_h(secret))
    assert got.status_code == 422 and uploads.NOT_TEXT_DETAIL in got.text


def test_чужую_загрузку_не_прочитать(client, db):
    owner = _token(db, _user(db, "arch"))
    other = _token(db, _user(db, "other"))
    slot = _slot(client, owner)
    client.put(slot["path"], content=YAML)
    assert client.get(f"{UPLOADS}/{slot['id']}", headers=_h(other)).status_code == 404
    assert client.get(f"{UPLOADS}/{slot['id']}", headers=_h(owner)).status_code == 200


def test_непринятая_загрузка_читается_как_409(client, db):
    secret = _token(db, _user(db, "arch"))
    slot = _slot(client, secret)
    r = client.get(f"{UPLOADS}/{slot['id']}", headers=_h(secret))
    assert r.status_code == 409 and uploads.NOT_UPLOADED_DETAIL in r.text


def test_только_чтение_и_демо_не_выпускают_ссылку(client, db, monkeypatch):
    reader = _token(db, _user(db, "reader"), read_only=True)
    assert client.post(UPLOADS, json={"name": "a.yaml"}, headers=_h(reader)).status_code == 403
    full = _token(db, _user(db, "arch"))
    monkeypatch.setattr(settings, "demo_mode", True)
    # На демо-стенде токенов нет вовсе — вход по токену отвечает 401, как на чужой.
    assert client.post(UPLOADS, json={"name": "a.yaml"}, headers=_h(full)).status_code in (401, 403)


def test_предел_ссылок_без_файла(client, db):
    secret = _token(db, _user(db, "arch"))
    for _ in range(uploads.MAX_PENDING_PER_USER):
        _slot(client, secret)
    r = client.post(UPLOADS, json={"name": "x.yaml"}, headers=_h(secret))
    assert r.status_code == 429 and uploads.TOO_MANY_DETAIL in r.text


def test_принятые_файлы_штуками_не_считаются(client, db):
    """Полевой репорт 2026-10-28: пакет документации — десятки .mmd по ссылке каждый, и
    несколько агентов под одним токеном упирались в «16 живых» за минуты. Принятые файлы
    ограничены байтами, а не штуками; использование строку не освобождает — превью и
    применение читают одни и те же входы."""
    secret = _token(db, _user(db, "arch"))
    for i in range(uploads.MAX_PENDING_PER_USER):
        slot = _slot(client, secret, f"{i}.mmd")
        assert client.put(slot["path"], content=YAML).status_code == 200
    r = client.post(UPLOADS, json={"name": "ещё.mmd"}, headers=_h(secret))
    assert r.status_code == 201, r.text


def test_предел_байтов_принятых(client, db, monkeypatch):
    secret = _token(db, _user(db, "arch"))
    monkeypatch.setattr(uploads, "MAX_LIVE_BYTES_PER_USER", len(YAML))
    slot = _slot(client, secret)
    assert client.put(slot["path"], content=YAML).status_code == 200
    r = client.post(UPLOADS, json={"name": "x.yaml"}, headers=_h(secret))
    assert r.status_code == 429 and uploads.TOO_MUCH_DETAIL in r.text


def test_неудачные_put_ограничены_по_адресу(client, db):
    secret = _token(db, _user(db, "arch"))
    slot = _slot(client, secret)
    for _ in range(uploads_router.PUT_FAILURES_PER_MINUTE):
        assert client.put(f"{UPLOADS}/{slot['id']}/мимо", content=YAML).status_code == 404
    assert client.put(f"{UPLOADS}/{slot['id']}/мимо", content=YAML).status_code == 429
    # Лимит общий на адрес — верный ключ тоже ждёт минуту.
    assert client.put(slot["path"], content=YAML).status_code == 429


def test_ключ_в_базе_не_хранится(client, db):
    secret = _token(db, _user(db, "arch"))
    slot = _slot(client, secret)
    key = slot["path"].rsplit("/", 1)[1]
    row = db.get(Upload, uuid.UUID(slot["id"]))
    assert key not in (row.key_hash or "") and len(row.key_hash) == 64
