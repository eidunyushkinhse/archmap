"""Маршруты HTTP Python (ТЗ §6.2): FastAPI, Starlette, Flask по фикстурам, отнесение к
контейнеру и стек по манифесту пакета."""

from __future__ import annotations

from pathlib import Path

from archmap_scan import texts
from archmap_scan.parsers import fastapi, flask
from archmap_scan.scan import Options, run
from tests.helpers import FIXTURES, files_of, model_of, tree


def _routes(parser: object, root: Path) -> list[tuple[str, str, bool, str]]:
    ctx, files = files_of(root)
    found = parser.parse(files, ctx)  # type: ignore[attr-defined]
    return sorted((r.method, r.path, r.prefix_unresolved, str(r.loc)) for r in found.routes)


def test_fastapi_fixture() -> None:
    assert _routes(fastapi, FIXTURES / "fastapi") == [
        ("DELETE", "/admin/cache", True, "shop/admin.py:7"),
        ("GET", "/", False, "shop/star.py:10"),
        ("GET", "/api/users", False, "shop/star.py:11"),
        ("GET", "/health", False, "shop/main.py:14"),
        ("GET", "/ping", False, "shop/main.py:19"),
        ("GET", "/sub/info", False, "shop/sub.py:6"),
        ("GET", "/v1/users/", False, "shop/api/users.py:7"),
        ("HEAD", "/ping", False, "shop/main.py:19"),
        ("POST", "/api/users", False, "shop/star.py:11"),
        ("POST", "/legacy", False, "shop/main.py:28"),
        ("POST", "/v1/users/{user_id}/block", False, "shop/api/users.py:12"),
        ("PUT", "/v1/items/{item_id}", False, "shop/api/items.py:6"),
    ]


def test_fastapi_traps() -> None:
    ctx, files = files_of(FIXTURES / "fastapi")
    found = fastapi.parse(files, ctx)
    paths = {r.path for r in found.routes}
    # tests/ исключён по соглашению, строка в комментарии маршрутом не стала.
    assert not any("test-only" in p or "commented" in p for p in paths)
    dynamic = [h.data for h in found.hints if h.section == "dynamic_names"]
    assert dynamic == [{
        "kind": "route", "name": "PREFIX + '/dyn'", "reason": texts.REASON_DYNAMIC_ROUTE,
        "source": "shop/api/users.py:18",
    }]


def test_flask_fixture() -> None:
    assert _routes(flask, FIXTURES / "flask") == [
        ("GET", "/", False, "web/app.py:11"),
        ("GET", "/api/v2/orders", False, "web/views.py:17"),
        ("GET", "/login", False, "web/app.py:16"),
        ("GET", "/old", False, "web/app.py:25"),
        ("GET", "/orphan/x", True, "web/orphan.py:6"),
        ("GET", "/shop/cart", False, "web/views.py:7"),
        ("POST", "/login", False, "web/app.py:16"),
        ("POST", "/shop/cart/<int:item_id>", False, "web/views.py:12"),
    ]


APP = 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/x")\ndef x():\n    return 1\n'


def test_files_of_packages_without_framework_are_not_read(tmp_path: Path) -> None:
    tree(tmp_path, {
        "api/requirements.txt": "fastapi\n",
        "api/main.py": APP,
        "tool/requirements.txt": "requests\n",
        "tool/main.py": APP,
        "loose.py": APP,  # без манифеста пакета: стек не известен
    })
    assert _routes(fastapi, tmp_path) == [("GET", "/x", False, "api/main.py:4")]
    tree(tmp_path / "other", {"requirements.txt": "requests\n", "main.py": APP})
    ctx, files = files_of(tmp_path / "other")
    found = fastapi.parse(files, ctx)
    assert found.applied == set() and found.routes == []


COMPOSE = """services:
  web:
    build: ./app
    command: gunicorn app.main:app
  worker:
    build: ./app
    command: celery -A app.tasks worker
"""


def test_route_goes_to_web_server_among_owners(tmp_path: Path) -> None:
    tree(tmp_path, {
        "docker-compose.yml": COMPOSE,
        "app/requirements.txt": "fastapi\ncelery\n",
        "app/main.py": APP,
        "lib/requirements.txt": "fastapi\n",
        "lib/shared.py": APP,
    })
    model = model_of(tmp_path)
    assert [(e.method, e.path) for e in model.http["web"]] == [("GET", "/x")]
    assert "worker" not in model.http
    assert model.hints["unassigned"] == [{
        "kind": "route", "name": "GET /x", "reason": texts.REASON_SHARED_LIB,
        "source": "lib/shared.py:4",
    }]


def test_framework_without_routes_is_empty(tmp_path: Path) -> None:
    tree(tmp_path / "repo", {
        "requirements.txt": "flask\n",
        "app.py": "from flask import Flask\napp = Flask(__name__)\n",
    })
    result = run(Options(path=str(tmp_path / "repo"), out=str(tmp_path / "out"), use_git=False))
    stat = result.coverage.families["http_routes"]
    assert stat.status == "empty" and stat.ran == ["flask"]
