"""Протокольный слой удалённого режима (remote.py): настоящий клиент SDK по Streamable HTTP.

Цепочка как в бэкенде, кроме клея: Starlette-приложение с Route("/mcp") → RemoteHost →
call_remote → ArchMapClient с токеном вызывающего → поддельный ArchMap (FakeApi). Клей
(демо, метод, Origin, лимиты, проверка токена) — бэкендовый, его держит
backend/tests/test_mcp_http.py.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import mcp.types as types
import pytest
from conftest import FakeApi
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from archmap_mcp import remote, tools

SECRET = "archmap_caller-secret-value"


def caller(read_only: bool = False) -> remote.Caller:
    return remote.Caller(
        bearer=SECRET, token_id="t1", username="arch", token="CI (archmap_calle…)", read_only=read_only, address="203.0.113.7"
    )


class Endpoint:
    """Вместо клея бэкенда: вызывающий уже проверен."""

    def __init__(self, host: remote.RemoteHost, who: remote.Caller) -> None:
        self.host, self.who = host, who

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await self.host.handle(scope, receive, send, self.who)


@asynccontextmanager
async def connect(
    api: FakeApi, who: remote.Caller, headers: dict[str, str] | None = None
) -> AsyncIterator[ClientSession]:
    archmap = httpx.AsyncClient(transport=httpx.MockTransport(api.handler()))
    host = remote.RemoteHost(archmap, "http://archmap.internal", max_body_bytes=1024 * 1024)
    app = Starlette(routes=[Route("/mcp", endpoint=Endpoint(host, who))])
    async with host.run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), headers=headers or {}) as http:
            async with streamable_http_client("http://mcp.test/mcp", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    yield session


def text(result: types.CallToolResult) -> str:
    block = result.content[0]
    assert isinstance(block, types.TextContent)
    return block.text


async def test_список_34_а_только_чтение_17(api: FakeApi) -> None:
    async with connect(api, caller()) as s:
        full = (await s.list_tools()).tools
    async with connect(api, caller(read_only=True)) as s:
        reader = (await s.list_tools()).tools
    assert [t.name for t in full] == [t["name"] for t in tools.remote_catalog(False)]
    assert [t.name for t in reader] == [t["name"] for t in tools.remote_catalog(True)]
    assert (len(full), len(reader)) == (34, 17)


async def test_вызов_идёт_с_токеном_вызывающего_и_без_логина(
    api: FakeApi, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Учётка в окружении процесса (в dev она лежит и в mcp/.env) не должна подхватиться.
    monkeypatch.setenv("ARCHMAP_USERNAME", "чужой")
    monkeypatch.setenv("ARCHMAP_PASSWORD", "пароль")
    monkeypatch.setenv("ARCHMAP_TOKEN", "archmap_env-token")
    async with connect(api, caller()) as s:
        result = await s.call_tool("archmap_projects", {})
    assert result.isError is False and "Ярмарка" in text(result)
    assert api.login_count == 0
    assert [c.url.path for c in api.calls] == ["/api/v1/projects"]
    assert {c.headers["Authorization"] for c in api.calls} == {f"Bearer {SECRET}"}
    assert str(api.calls[0].url).startswith("http://archmap.internal/")


@pytest.mark.parametrize(
    ("name", "args", "needle"),
    [
        ("archmap_export_archive", {"project": "Ярмарка", "out_path": "/data/k.zip"}, "работает с файлами"),
        ("archmap_projects", {"paths": ["/etc/passwd"]}, "Аргумент paths"),
    ],
)
async def test_диск_отказ_с_isError(api: FakeApi, name: str, args: dict, needle: str) -> None:
    async with connect(api, caller()) as s:
        result = await s.call_tool(name, args)
    assert result.isError is True and needle in text(result)
    assert api.calls == []


async def test_только_чтение_пишущий_отказ_с_isError(api: FakeApi) -> None:
    async with connect(api, caller(read_only=True)) as s:
        result = await s.call_tool("archmap_create_node", {"project": "Ярмарка", "name": "x"})
    assert result.isError is True
    assert text(result).startswith("Токен только для чтения: archmap_create_node")
    assert api.calls == []


async def test_кэш_SDK_общий_но_права_у_каждого_свои(api: FakeApi) -> None:
    """Кэш определений инструментов живёт на сервере SDK: список читателя (16) не
    мешает полному токену, а полный список не открывает запись читателю."""
    archmap = httpx.AsyncClient(transport=httpx.MockTransport(api.handler()))
    host = remote.RemoteHost(archmap, "http://archmap.internal", max_body_bytes=1024 * 1024)
    reader_app = Starlette(routes=[Route("/mcp", endpoint=Endpoint(host, caller(read_only=True)))])
    full_app = Starlette(routes=[Route("/mcp", endpoint=Endpoint(host, caller()))])
    api.post("/nodes", {"id": "n1", "name": "x"})

    async def call(app: Starlette, name: str, args: dict) -> types.CallToolResult:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as http:
            async with streamable_http_client("http://mcp.test/mcp", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    await session.list_tools()
                    return await session.call_tool(name, args)

    async with host.run():
        denied = await call(reader_app, "archmap_create_node", {"project": "Ярмарка", "name": "x"})
        allowed = await call(full_app, "archmap_create_node", {"project": "Ярмарка", "name": "x"})
    assert denied.isError is True
    assert allowed.isError is False, text(allowed)


async def test_отказ_ArchMap_с_isError(api: FakeApi) -> None:
    api.get("/projects", httpx.Response(403, json={"detail": "Нет доступа"}))
    async with connect(api, caller()) as s:
        result = await s.call_tool("archmap_projects", {})
    assert result.isError is True and text(result).startswith("Недостаточно прав: Нет доступа.")


async def test_журнал_строка_на_вызов_без_аргументов_и_секрета(
    api: FakeApi, caplog: pytest.LogCaptureFixture
) -> None:
    api.get("/search", {"hits": [], "total": 0})
    caplog.set_level(logging.INFO, logger="archmap.mcp")
    async with connect(api, caller()) as s:
        await s.call_tool("archmap_search", {"project": "Ярмарка\nподделка", "query": "секретный запрос"})
        await s.call_tool("archmap_export_archive", {"project": "Ярмарка", "out_path": "/x.zip"})
    lines = [r.getMessage() for r in caplog.records if r.name == "archmap.mcp"]
    assert len(lines) == 2
    assert lines[0].startswith("tools/call archmap_search: ")
    assert "токен CI (archmap_calle…)" in lines[0] and "пользователь arch" in lines[0]
    assert "проект Ярмарка?подделка" in lines[0] and "адрес 203.0.113.7" in lines[0]
    assert lines[1].startswith("tools/call archmap_export_archive: отказ")
    joined = "\n".join(lines)
    assert "секретный запрос" not in joined and SECRET not in joined and "/x.zip" not in joined
    assert SECRET not in repr(caller())


async def test_whoami_по_ответу_tokens_current(api: FakeApi) -> None:
    api.get("/tokens/current", {"id": "t1", "name": "CI", "prefix": "archmap_Ab3dEf", "read_only": True, "username": "arch"})
    http = httpx.AsyncClient(transport=httpx.MockTransport(api.handler()))
    who = await remote.whoami(http, "http://archmap.internal", SECRET, "198.51.100.1")
    assert (who.username, who.token, who.read_only, who.address) == ("arch", "CI (archmap_Ab3dEf…)", True, "198.51.100.1")
    assert api.calls[-1].headers["Authorization"] == f"Bearer {SECRET}"


async def test_whoami_отказ_несёт_текст_ArchMap(api: FakeApi) -> None:
    api.get("/tokens/current", httpx.Response(401, json={"detail": "Токен недействителен"}))
    http = httpx.AsyncClient(transport=httpx.MockTransport(api.handler()))
    with pytest.raises(remote.TokenRejected) as exc:
        await remote.whoami(http, "http://archmap.internal", SECRET, "198.51.100.1")
    assert (exc.value.status, exc.value.detail) == (401, "Токен недействителен")


def _slot() -> dict[str, object]:
    return {"id": "u1", "name": "r.yaml", "path": "/api/v1/uploads/u1/КЛЮЧ",
            "expires_at": "2026-10-28T12:10:00Z", "max_bytes": 2 * 1024 * 1024}


async def test_ссылка_на_загрузку_по_адресу_агента_а_не_внутреннему(api: FakeApi) -> None:
    """Удалённо запросы в API идут по внутреннему адресу, а ссылку агент откроет сам —
    она собирается из адреса, по которому он пришёл: Host без прокси, X-Forwarded-* за ним."""
    api.post("/uploads", _slot())
    async with connect(api, caller()) as s:
        out = text(await s.call_tool("archmap_upload_url", {"project": "Ярмарка", "name": "r.yaml"}))
    assert "http://mcp.test/api/v1/uploads/u1/КЛЮЧ" in out
    assert "archmap.internal" not in out

    forwarded = {"x-forwarded-proto": "https", "x-forwarded-host": "archmap.example.com"}
    async with connect(api, caller(), headers=forwarded) as s:
        out = text(await s.call_tool("archmap_upload_url", {"project": "Ярмарка", "name": "r.yaml"}))
    assert "https://archmap.example.com/api/v1/uploads/u1/КЛЮЧ" in out
    assert "curl -sS -T" in out and "upload_id: u1" in out
