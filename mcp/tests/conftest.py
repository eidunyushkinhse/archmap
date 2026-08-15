"""Стенд MCP-сервера: настоящий клиент поверх подменённого транспорта httpx.

Живой ArchMap для этих тестов не нужен и вреден — они про КЛИЕНТА и про то, во
что инструменты сворачивают ответ. Контракты самих эндпоинтов держит pytest
бэкенда.
"""

from __future__ import annotations

import importlib
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from archmap_mcp.client import ArchMapClient, Config

PROJECT_ID = "11111111-1111-1111-1111-111111111111"


def backend(module: str) -> Any:
    """Модуль БЭКЕНДА по имени («schemas.project», «skeptic_prompt»).

    Зачем в тестах MCP: подменённый транспорт тело запроса НЕ валидирует, поэтому
    инструмент может годами слать словари туда, где контракт ждёт строки, — тесты
    зелёные, живой сервер отвечает 422 (ровно это было у /projects/import/preview).
    Единственный честный судья формы — схема самого бэкенда; сравнивать с ней
    дешевле, чем поднимать сервис: схемы и промпт-литералы тянут только pydantic
    и стандартную библиотеку.

    Ломается импорт — тест обязан упасть, а не «пропуститься»: молчаливый скип
    вернул бы ту же слепоту, ради которой всё это и написано.
    """
    root = Path(__file__).resolve().parents[2] / "backend"
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    return importlib.import_module(f"app.{module}")


class FakeApi:
    """Маршрутизатор поддельного ArchMap: путь → ответ. Пишет журнал запросов,
    чтобы тест мог проверить заголовки и тело, а не только результат."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Any] = {}
        self.calls: list[httpx.Request] = []
        self.login_count = 0
        self.expire_first_call = False
        self._expired_once = False

    def get(self, path: str, payload: Any) -> None:
        self.routes[("GET", path)] = payload

    def post(self, path: str, payload: Any) -> None:
        self.routes[("POST", path)] = payload

    def patch(self, path: str, payload: Any) -> None:
        self.routes[("PATCH", path)] = payload

    def handler(self) -> Callable[[httpx.Request], httpx.Response]:
        def handle(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            path = request.url.path.replace("/api/v1", "", 1)
            if path == "/auth/login":
                self.login_count += 1
                return httpx.Response(200, json={"access_token": f"tok-{self.login_count}"})
            if self.expire_first_call and not self._expired_once:
                self._expired_once = True
                return httpx.Response(401, json={"detail": "Токен истёк"})
            payload = self.routes.get((request.method, path))
            if payload is None:
                return httpx.Response(404, json={"detail": f"нет маршрута {request.method} {path}"})
            if isinstance(payload, httpx.Response):
                return payload
            return httpx.Response(200, json=payload)

        return handle


@pytest.fixture
def api() -> FakeApi:
    fake = FakeApi()
    fake.get("/projects/", [{"id": PROJECT_ID, "name": "Ярмарка", "object_count": 3}])
    return fake


@pytest.fixture
def client(api: FakeApi) -> ArchMapClient:
    config = Config()
    config.username, config.password = "arch", "secret"
    config.base_url = "http://archmap.test"
    http = httpx.AsyncClient(transport=httpx.MockTransport(api.handler()))
    return ArchMapClient(config, http=http)


def node(
    node_id: str, name: str, parent: str | None = None, **over: Any
) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": node_id,
        "name": name,
        "parent_id": parent,
        "shape": "service",
        "status": "existing",
        "is_external": False,
        "role": None,
        "technology": None,
        "description": None,
        "openapi_spec": None,
    }
    base.update(over)
    return base
