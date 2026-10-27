"""MCP-сервер ArchMap (stdio).

Тонкая обвязка: регистрирует каталог из tools.py и отдаёт результат текстом.
Отказы ArchMap возвращаются агенту как текст с isError, а не как исключение
протокола: агент должен ПРОЧИТАТЬ причину («проект не найден», «нет прав на
правку этого проекта») и исправиться, а не получить обрыв вызова. isError при этом
говорит клиенту и агенту, что вызов не удался, — отказ не принимается за результат
(docs/plan-remote-mcp.md, Р12).
"""

from __future__ import annotations

import asyncio
import sys
import traceback
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any, Literal

import mcp.server.stdio
import mcp.types as types
from mcp.server import NotificationOptions, Server
from mcp.server.models import InitializationOptions

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError, Config

SERVER_NAME = "archmap"
VERSION = "0.9.0"


def tool_defs(catalog: list[dict[str, Any]]) -> list[types.Tool]:
    """Каталог инструментов → определения протокола (общее у stdio и удалённого режима)."""
    return [types.Tool(name=t["name"], description=t["description"], inputSchema=t["schema"]) for t in catalog]


def build_server(client: ArchMapClient) -> Server:
    server: Server = Server(SERVER_NAME)

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return tool_defs(tools.TOOLS)

    @server.call_tool()
    async def call_tool(name: str, arguments: dict[str, Any] | None) -> types.CallToolResult:
        return (await answer(client, name, arguments or {})).result()

    return server


# Итог вызова: ok — ответ на вопрос (и «Проектов нет», и план превью «не пройдёт» —
# тоже ответ); refused — отказ, который агент может исправить (права, «не найдено»,
# конфликт версий, неверные данные, «не настроен»); failed — сбой самого сервера.
Outcome = Literal["ok", "refused", "failed"]


@dataclass(frozen=True)
class Reply:
    """Ответ инструмента: текст для агента и итог. Текст отказа агент читает так же, как
    успех; итог решает isError и строку журнала удалённого режима — один источник."""

    text: str
    outcome: Outcome = "ok"

    def result(self) -> types.CallToolResult:
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=self.text)],
            isError=self.outcome != "ok",
        )


async def answer(client: ArchMapClient, name: str, arguments: dict[str, Any]) -> Reply:
    """Ответ инструмента — и при успехе, и при отказе: агент читает текст как есть."""
    # С токеном настраивать нечего: учётка не нужна.
    missing = [] if client.uses_token else client.config.missing()
    if missing:
        return Reply(
            "ArchMap не настроен: не заданы " + ", ".join(missing) + ". "
            "Впишите их в mcp/.env (см. mcp/README.md) и перезапустите клиент.",
            "refused",
        )
    return await settle(name, tools.call(name, arguments, client))


async def settle(name: str, work: Awaitable[str], journal: str = "журнале MCP-клиента") -> Reply:
    """Исполнить инструмент и разложить исход по итогам: текст инструмента — ok, отказ
    ArchMap — refused, любое другое исключение — failed (общее у stdio и удалённого
    режима). journal — где искать стек сбоя: у stdio stderr уходит в журнал клиента, у
    удалённого режима — в журнал сервера ArchMap."""
    try:
        return Reply(await work)
    except ArchMapError as exc:
        return Reply(str(exc), "refused")
    except Exception as exc:
        # Не отказ ArchMap, а сбой самого сервера (неожиданный ответ, ошибка в коде):
        # голое «'id'» от KeyError модель приняла бы за ответ (аудит P-9). Стек — в
        # stderr, он уходит в журнал клиента.
        traceback.print_exc(file=sys.stderr)
        return Reply(
            f"Сбой MCP-сервера ArchMap в инструменте {name}: {type(exc).__name__}: {exc}. "
            f"Это не ответ ArchMap; подробности — в {journal}.",
            "failed",
        )


async def main() -> None:
    config = Config()
    missing = config.missing()
    if missing:
        # НЕ падаем: клиент показал бы «сервер не поднялся» вместо причины, а
        # инструменты вообще исчезли бы из списка. Предупреждаем в stderr (он
        # уходит в лог клиента) и отвечаем причиной на первый же вызов.
        print(
            "archmap-mcp: не заданы " + ", ".join(missing) + " — инструменты вернут ошибку. "
            "См. mcp/README.md.",
            file=sys.stderr,
        )
    client = ArchMapClient(config)
    server = build_server(client)
    try:
        async with mcp.server.stdio.stdio_server() as (read, write):
            await server.run(
                read,
                write,
                InitializationOptions(
                    server_name=SERVER_NAME,
                    server_version=VERSION,
                    capabilities=server.get_capabilities(
                        notification_options=NotificationOptions(),
                        experimental_capabilities={},
                    ),
                ),
            )
    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
