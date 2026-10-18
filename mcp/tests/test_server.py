"""Сервер: отказ инструмента приходит агенту текстом С isError (docs/plan-remote-mcp.md, Р12).

Через настоящий Server SDK и клиент в памяти: проверяется то, что увидит агент, а не
только что вернула answer(). Тексты отказов не меняются — меняется лишь пометка.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import mcp.types as types
import pytest
from conftest import FakeApi
from mcp.client.session import ClientSession
from mcp.shared.memory import create_connected_server_and_client_session

from archmap_mcp import server, tools
from archmap_mcp.client import ArchMapClient


@asynccontextmanager
async def session(client: ArchMapClient) -> AsyncIterator[ClientSession]:
    async with create_connected_server_and_client_session(server.build_server(client)) as s:
        yield s


def text(result: types.CallToolResult) -> str:
    block = result.content[0]
    assert isinstance(block, types.TextContent)
    return block.text


async def test_успех_без_isError(client: ArchMapClient) -> None:
    async with session(client) as s:
        result = await s.call_tool("archmap_projects", {})
    assert result.isError is False
    assert "Ярмарка" in text(result)


async def test_пустой_ответ_это_ответ_а_не_отказ(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/projects", [])
    async with session(client) as s:
        result = await s.call_tool("archmap_projects", {})
    assert result.isError is False
    assert text(result) == "Проектов нет."


async def test_отказ_ArchMap_с_isError_и_прежним_текстом(client: ArchMapClient, api: FakeApi) -> None:
    api.get("/projects", httpx.Response(403, json={"detail": "Нет прав на правку этого проекта"}))
    async with session(client) as s:
        result = await s.call_tool("archmap_projects", {})
    assert result.isError is True
    assert text(result).startswith("Недостаточно прав: Нет прав на правку этого проекта.")


async def test_неизвестный_инструмент_с_isError(client: ArchMapClient) -> None:
    async with session(client) as s:
        result = await s.call_tool("archmap_nope", {})
    assert result.isError is True
    assert text(result) == "Неизвестный инструмент: archmap_nope"


async def test_не_настроен_с_isError(client: ArchMapClient) -> None:
    client.config.password = ""
    async with session(client) as s:
        result = await s.call_tool("archmap_projects", {})
    assert result.isError is True
    assert text(result).startswith("ArchMap не настроен: не заданы ARCHMAP_PASSWORD.")


async def test_сбой_в_коде_с_isError(client: ArchMapClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(_name: str, _args: dict, _client: ArchMapClient) -> str:
        raise KeyError("id")

    monkeypatch.setattr(tools, "call", broken)
    async with session(client) as s:
        result = await s.call_tool("archmap_projects", {})
    assert result.isError is True
    assert text(result).startswith("Сбой MCP-сервера ArchMap в инструменте archmap_projects: KeyError")
