"""Эндпоинт /mcp (docs/plan-remote-mcp.md, Ф3): удалённый MCP-сервер в процессе бэкенда.

Всё через настоящее приложение и lifespan (`with TestClient(app)`): клей app/mcp_http →
RemoteHost → инструменты пакета archmap_mcp → HTTP API этого же процесса по
ASGITransport с токеном вызывающего. Подменена только сессия БД. Запросы — сырые
JSON-RPC POST: в режиме без состояния initialize не обязателен.
"""

import json
import uuid
from typing import Any

import pytest
from conftest import make_project
from fastapi.testclient import TestClient

from app import mcp_http, personal_tokens
from app.auth import create_access_token
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.node import Node
from app.models.personal_token import PersonalToken
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User

ACCEPT = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


@pytest.fixture(autouse=True)
def fresh_limits():
    """Счётчики лимитов живут в процессе: неудачи прошлого теста не должны копиться."""
    mcp_http.endpoint.auth_failures.reset()
    mcp_http.endpoint.requests.reset()


@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        with TestClient(app) as c:
            yield c
    finally:
        app.dependency_overrides.clear()


def _user(db, username: str, role: str = "architect") -> User:
    u = User(id=uuid.uuid4(), username=username, hashed_password="x", role=role)
    db.add(u)
    db.flush()
    return u


def _token(db, user: User, read_only: bool = False, name: str = "Агент") -> str:
    secret = personal_tokens.issue(db, user, name, read_only, 90).secret
    db.commit()
    return secret


@pytest.fixture()
def scene(db):
    """editor — редактор «Ярмарки» (владелец — owner); «Плёнка» — чужой закрытый проект.
    editor — архитектор: токен «Пользователя» только читает (отдельный тест ниже)."""
    owner = _user(db, "owner")
    editor = _user(db, "editor")
    stranger = _user(db, "stranger")
    p = make_project(db, "Ярмарка", owner=owner)
    db.add(ProjectMember(project_id=p.id, user_id=editor.id, role="editor"))
    make_project(db, "Плёнка", owner=stranger)
    db.commit()
    return {"owner": owner, "editor": editor, "project": p}


def rpc(client: TestClient, secret: str | None, method: str, params: dict[str, Any] | None = None, **headers: str):
    h = dict(ACCEPT)
    if secret is not None:
        h["Authorization"] = f"Bearer {secret}"
    h.update(headers)
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return client.post("/mcp", headers=h, content=json.dumps(body))


def call(client: TestClient, secret: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    r = rpc(client, secret, "tools/call", {"name": name, "arguments": args})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def text(result: dict[str, Any]) -> str:
    return result["content"][0]["text"]


def test_список_полным_токеном_32_только_чтение_16(client, db, scene):
    full = rpc(client, _token(db, scene["editor"], name="полный"), "tools/list", {})
    reader = rpc(client, _token(db, scene["editor"], read_only=True, name="чтение"), "tools/list", {})
    assert full.status_code == 200 and reader.status_code == 200
    assert len(full.json()["result"]["tools"]) == 32
    assert len(reader.json()["result"]["tools"]) == 16


def test_пользователю_набор_только_чтения_даже_редактору(client, db, scene):
    # токен выпущен архитектором, потом роль понизили до «Пользователя»
    secret = _token(db, scene["editor"])
    scene["editor"].role = "viewer"
    db.commit()
    tools = rpc(client, secret, "tools/list", {}).json()["result"]["tools"]
    assert len(tools) == 16
    result = call(client, secret, "archmap_create_node", {"project": str(scene["project"].id), "name": "Шлюз"})
    assert result["isError"] is True
    assert db.query(Node).count() == 0


def test_initialize_называет_сервер(client, db, scene):
    r = rpc(
        client,
        _token(db, scene["editor"]),
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}},
    )
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    assert r.json()["result"]["serverInfo"]["name"] == "archmap"


def test_проекты_глазами_владельца_токена(client, db, scene):
    result = call(client, _token(db, scene["editor"]), "archmap_projects", {})
    assert result["isError"] is False
    assert "Ярмарка" in text(result) and "[редактор]" in text(result)
    assert "Плёнка" not in text(result)


def test_запись_от_имени_владельца_токена(client, db, scene):
    p = scene["project"]
    result = call(client, _token(db, scene["editor"]), "archmap_create_node", {"project": str(p.id), "name": "Шлюз"})
    assert result["isError"] is False, text(result)
    db.expire_all()
    assert db.query(Node).filter(Node.name == "Шлюз", Node.project_id == p.id).count() == 1
    assert db.get(Project, p.id).updated_by_id == scene["editor"].id


def test_только_чтение_пишущий_отказ_и_бд_не_тронута(client, db, scene):
    p = scene["project"]
    secret = _token(db, scene["editor"], read_only=True)
    result = call(client, secret, "archmap_create_node", {"project": str(p.id), "name": "Шлюз"})
    assert result["isError"] is True
    assert text(result).startswith("Токен только для чтения")
    assert db.query(Node).count() == 0


def test_диск_сервера_недоступен(client, db, scene):
    secret = _token(db, scene["editor"])
    result = call(client, secret, "archmap_import_preview", {"files": [], "paths": ["/etc/passwd"]})
    assert result["isError"] is True and "Аргумент paths" in text(result)
    result = call(client, secret, "archmap_export_archive", {"project": "Ярмарка", "out_path": "/data/x.zip"})
    assert result["isError"] is True and "работает с файлами" in text(result)


def test_без_личного_токена_401(client, db, scene):
    jwt = create_access_token({"sub": "editor", "role": "viewer"})
    for secret in (None, jwt):
        r = rpc(client, secret, "tools/list", {})
        assert r.status_code == 401
        assert r.json() == {"detail": mcp_http.NEED_PAT_DETAIL}
        assert r.headers["www-authenticate"].startswith("Bearer")


def test_отозванный_токен_401_текстом_бэкенда(client, db, scene):
    secret = _token(db, scene["editor"])
    db.query(PersonalToken).delete()
    db.commit()
    r = rpc(client, secret, "tools/list", {})
    assert r.status_code == 401
    assert r.json() == {"detail": personal_tokens.INVALID_DETAIL}
    assert r.headers["www-authenticate"] == 'Bearer error="invalid_token"'


def test_origin_чужой_403_разрешённый_200(client, db, scene, monkeypatch):
    secret = _token(db, scene["editor"])
    assert rpc(client, secret, "tools/list", {}, Origin="https://evil.example").status_code == 403
    monkeypatch.setattr(settings, "mcp_allowed_origins", "https://archmap.example.com")
    assert rpc(client, secret, "tools/list", {}, Origin="https://archmap.example.com").status_code == 200
    assert rpc(client, secret, "tools/list", {}, Origin="https://evil.example").status_code == 403


def test_метод_путь_и_демо(client, db, scene, monkeypatch):
    secret = _token(db, scene["editor"])
    r = client.get("/mcp", headers={"Authorization": f"Bearer {secret}", **ACCEPT})
    assert r.status_code == 405 and r.headers["allow"] == "POST"
    assert client.delete("/mcp").status_code == 405
    assert client.post("/mcp/", headers=ACCEPT, content="{}").status_code == 404
    monkeypatch.setattr(settings, "demo_mode", True)
    r = rpc(client, secret, "tools/list", {})
    assert r.status_code == 404 and r.json() == {"detail": mcp_http.DEMO_DETAIL}


def test_без_lifespan_503(db, scene):
    app.dependency_overrides[get_db] = lambda: db
    try:
        bare = TestClient(app)  # без with: lifespan не исполнялся
        r = rpc(bare, _token(db, scene["editor"]), "tools/list", {})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 503 and r.json() == {"detail": mcp_http.NOT_STARTED_DETAIL}


def test_предел_запросов_по_токену_429(client, db, scene, monkeypatch):
    monkeypatch.setattr(settings, "mcp_requests_per_minute", 2)
    secret = _token(db, scene["editor"])
    other = _token(db, scene["owner"])
    assert rpc(client, secret, "tools/list", {}).status_code == 200
    assert rpc(client, secret, "tools/list", {}).status_code == 200
    r = rpc(client, secret, "tools/list", {})
    assert r.status_code == 429 and r.json() == {"detail": mcp_http.RATE_LIMITED_DETAIL}
    # у другого токена свой счёт
    assert rpc(client, other, "tools/list", {}).status_code == 200


def test_перебор_токенов_429_с_адреса(client, db, scene, monkeypatch):
    monkeypatch.setattr(mcp_http, "AUTH_FAILURES_PER_MINUTE", 3)
    good = _token(db, scene["editor"])
    for _ in range(3):
        assert rpc(client, "archmap_" + "x" * 43, "tools/list", {}).status_code == 401
    r = rpc(client, good, "tools/list", {})
    assert r.status_code == 429 and r.json() == {"detail": mcp_http.AUTH_LIMITED_DETAIL}


def test_тело_больше_предела_413(db, scene, monkeypatch):
    # Предел SDK выставляется при старте хозяина: подменяем ДО входа в lifespan.
    monkeypatch.setattr(settings, "max_request_mb", 1)
    app.dependency_overrides[get_db] = lambda: db
    try:
        with TestClient(app) as c:
            big = {"name": "a.yaml", "content": "x" * (1024 * 1024 + 10)}
            r = rpc(c, _token(db, scene["editor"]), "tools/call", {"name": "archmap_import_preview", "arguments": {"files": [big]}})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 413


def test_журнал_пишет_вызов(client, db, scene, caplog):
    caplog.set_level("INFO", logger="archmap.mcp")
    secret = _token(db, scene["editor"], name="CI")
    call(client, secret, "archmap_projects", {})
    lines = [r.getMessage() for r in caplog.records if r.name == "archmap.mcp"]
    assert any(line.startswith("tools/call archmap_projects: ок, пользователь editor, токен CI (") for line in lines)
    assert all(secret not in line for line in lines)
