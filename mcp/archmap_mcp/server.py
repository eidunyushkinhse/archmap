"""MCP-сервер ArchMap (stdio).

Тонкая обвязка: регистрирует каталог из tools.py и отдаёт результат текстом.
Отказы ArchMap возвращаются агенту как текст с isError, а не как исключение
протокола: агент должен ПРОЧИТАТЬ причину («проект не найден», «нужна роль
архитектора») и исправиться, а не получить обрыв вызова.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

import mcp.server.stdio
import mcp.types as types
from mcp.server import NotificationOptions, Server
from mcp.server.models import InitializationOptions

from archmap_mcp import tools
from archmap_mcp.client import ArchMapClient, ArchMapError, Config

SERVER_NAME = "archmap"
VERSION = "0.2.0"


def build_server(client: ArchMapClient) -> Server:  # type: ignore[type-arg]
    server: Server = Server(SERVER_NAME)

    @server.list_tools()  # type: ignore[no-untyped-call, misc]
    async def list_tools() -> list[types.Tool]:
        return [
            types.Tool(
                name=t["name"],
                description=t["description"],
                inputSchema=t["schema"],
            )
            for t in tools.TOOLS
        ]

    @server.call_tool()  # type: ignore[no-untyped-call, misc]
    async def call_tool(name: str, arguments: dict[str, Any] | None) -> list[types.TextContent]:
        missing = client.config.missing()
        if missing:
            return [
                types.TextContent(
                    type="text",
                    text=(
                        "ArchMap не настроен: не заданы " + ", ".join(missing) + ". "
                        "Впишите их в mcp/.env (см. mcp/README.md) и перезапустите клиент."
                    ),
                )
            ]
        try:
            text = await tools.call(name, arguments or {}, client)
        except ArchMapError as exc:
            return [types.TextContent(type="text", text=str(exc))]
        return [types.TextContent(type="text", text=text)]

    return server


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
