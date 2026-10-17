"""Стенд MCP-сервера: настоящий клиент поверх подменённого транспорта httpx.

Живой ArchMap для этих тестов не нужен и вреден — они про КЛИЕНТА и про то, во
что инструменты сворачивают ответ. Контракты самих эндпоинтов держит pytest
бэкенда.
"""

from __future__ import annotations

import importlib
import sys
from collections.abc import Callable, Iterator
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import httpx
import pytest

from archmap_mcp import tools
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


# Инструмент, который сейчас исполняется (ставит обёртка tools.call ниже), — для журнала
# «какой инструмент каким методом ходил» в FakeApi.
CURRENT_TOOL: ContextVar[str | None] = ContextVar("CURRENT_TOOL", default=None)
# Все FakeApi теста: сторож методов смотрит и в те, что тест завёл сам.
_INSTANCES: list[FakeApi] = []


class FakeApi:
    """Маршрутизатор поддельного ArchMap: путь → ответ. Пишет журнал запросов,
    чтобы тест мог проверить заголовки и тело, а не только результат."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Any] = {}
        self.calls: list[httpx.Request] = []
        # (инструмент, метод) каждого запроса, сделанного внутри tools.call.
        self.tool_methods: list[tuple[str, str]] = []
        _INSTANCES.append(self)
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
            tool = CURRENT_TOOL.get()
            # Ленивый вход логином (POST) — не запрос инструмента: с токеном его нет.
            if tool is not None and path != "/auth/login":
                self.tool_methods.append((tool, request.method))
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


@pytest.fixture(autouse=True)
def reads_send_only_get(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Сторож флага writes (docs/plan-remote-mcp.md, Р6): инструмент без права записи
    шлёт ТОЛЬКО GET. На этом держится «только чтение» удалённого режима: токену без
    записи список отдаёт такие инструменты, а бэкенд отказывает ему во всём, кроме
    безопасных методов. Проверка идёт в каждом тесте, где инструмент чтения
    исполняется до конца, — новый POST в нём уронит тест, а не всплывёт у агента."""
    _INSTANCES.clear()
    original = tools.call

    async def tracked(name: str, args: dict[str, Any], client: ArchMapClient) -> str:
        token = CURRENT_TOOL.set(name)
        try:
            return await original(name, args, client)
        finally:
            CURRENT_TOOL.reset(token)

    original_remote = tools.call_remote

    async def tracked_remote(name: str, args: dict[str, Any], client: ArchMapClient, read_only: bool) -> str:
        token = CURRENT_TOOL.set(name)
        try:
            return await original_remote(name, args, client, read_only)
        finally:
            CURRENT_TOOL.reset(token)

    monkeypatch.setattr(tools, "call", tracked)
    monkeypatch.setattr(tools, "call_remote", tracked_remote)
    yield
    readers = {t["name"] for t in tools.TOOLS if not t["writes"]}
    wrong = sorted(
        {(tool, method) for fake in _INSTANCES for tool, method in fake.tool_methods if tool in readers and method != "GET"}
    )
    assert wrong == [], f"инструмент чтения (writes=False) шлёт не GET: {wrong}"


@pytest.fixture
def api() -> FakeApi:
    fake = FakeApi()
    fake.get("/projects", [{"id": PROJECT_ID, "name": "Ярмарка", "object_count": 3}])
    return fake


@pytest.fixture
def client(api: FakeApi) -> ArchMapClient:
    # Настройки явные, а не из окружения и mcp/.env: токен в .env разработчика
    # молча перевёл бы весь стенд в режим токена.
    config = Config(
        {"ARCHMAP_URL": "http://archmap.test", "ARCHMAP_USERNAME": "arch", "ARCHMAP_PASSWORD": "secret"}
    )
    # Редиректы не следуем — как настоящий клиент (2026-09-05): коллекции без
    # хвостового слэша, промах формы пути обязан быть виден отказом, а не тихо
    # исправляться по дороге.
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
