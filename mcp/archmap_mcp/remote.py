"""Удалённый MCP-сервер ArchMap: протокольный слой Streamable HTTP (docs/plan-remote-mcp.md).

Живёт в процессе бэкенда: клей app/mcp_http.py проверяет демо-режим, метод, Origin,
лимиты и токен и отдаёт запрос сюда вместе с вызывающим (Caller). Этот модуль знает
только SDK MCP и HTTP API ArchMap: кода бэкенда не импортирует, в API ходит переданным
httpx-клиентом (в бэкенде — ASGITransport того же приложения) с токеном ВЫЗЫВАЮЩЕГО.
Учётки из окружения и mcp/.env здесь нет и быть не может (Config.remote).

Без состояния и с JSON-ответами: процессов и реплик несколько, липких сессий нет,
уведомлений у инструментов нет — запрос → ответ (Р2).
"""

from __future__ import annotations

import logging
import time
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Any

import httpx
import mcp.types as types
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.types import Receive, Scope, Send

from archmap_mcp import tools
from archmap_mcp.client import API_PREFIX, ArchMapClient, Config, detail_text
from archmap_mcp.server import SERVER_NAME, VERSION, Outcome, settle, tool_defs

# Журнал «чей токен что сделал»: строка на каждый tools/call. Аргументов не пишем — там
# документы целиком; секрета — тем более.
log = logging.getLogger("archmap.mcp")

OUTCOME_WORDS: dict[Outcome, str] = {"ok": "ок", "refused": "отказ", "failed": "сбой"}

# Ключ вызывающего в scope["state"] запроса: обработчики SDK видят его через
# request_context.request.state.
STATE_KEY = "archmap_mcp_caller"


@dataclass(frozen=True)
class Caller:
    """Кто вызывает: личный токен и его владелец — по ответу GET /tokens/current."""

    # Секрет — только для запросов в API; в repr (а значит, и в журнал) не попадает.
    bearer: str = field(repr=False)
    username: str
    # Метка для журнала: имя токена и префикс.
    token: str
    read_only: bool
    address: str


class TokenRejected(Exception):
    """ArchMap не признал токен: status — ответ клея (401, или 503 — ArchMap не ответил)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


async def whoami(http: httpx.AsyncClient, base_url: str, bearer: str, address: str) -> Caller:
    """Владелец и вид токена через GET /tokens/current — тот же путь аутентификации,
    что у любого запроса API (срок, отзыв, блокировка учётки)."""
    try:
        resp = await http.get(
            f"{base_url.rstrip('/')}{API_PREFIX}/tokens/current",
            headers={"Authorization": f"Bearer {bearer}"},
        )
    except httpx.RequestError as exc:
        raise TokenRejected(503, f"ArchMap не ответил на проверку токена: {exc}") from exc
    if resp.status_code != 200:
        raise TokenRejected(503 if resp.status_code >= 500 else 401, detail_text(resp))
    body = resp.json()
    return Caller(
        bearer=bearer,
        username=str(body["username"]),
        token=f"{body['name']} ({body['prefix']}…)",
        read_only=bool(body["read_only"]),
        address=address,
    )


def clean(value: object, limit: int = 80) -> str:
    """Значение для строки журнала: без управляющих символов (перевод строки подделал бы
    чужую строку журнала) и не длиннее limit."""
    text = "".join(ch if ch.isprintable() else "?" for ch in str(value))
    return text if len(text) <= limit else text[: limit - 1] + "…"


class RemoteHost:
    """Хозяин удалённого режима на ОДИН запуск lifespan: в run() менеджера SDK можно
    войти лишь раз, поэтому новый запуск — новый хозяин.

    Сервер SDK общий для всех запросов (и его кэш определений инструментов тоже), поэтому
    ни список, ни кэш не защита: права решают call_remote и бэкенд.
    """

    def __init__(self, http: httpx.AsyncClient, base_url: str, max_body_bytes: int) -> None:
        # Общий клиент на все вызовы; закрывает его тот, кто передал.
        self.http = http
        self.config = Config.remote(base_url)
        self.server: Server = Server(SERVER_NAME, version=VERSION)
        self.server.list_tools()(self._list_tools)
        self.server.call_tool()(self._call_tool)
        self.manager = StreamableHTTPSessionManager(
            self.server,
            stateless=True,
            json_response=True,
            # Host и Origin сверяет клей (app/mcp_http.py): Host не сверяем вовсе — эндпоинт
            # публичный, доступ решает токен в заголовке, а не cookie.
            security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
            max_request_body_size=max_body_bytes,
        )

    def run(self) -> AbstractAsyncContextManager[None]:
        return self.manager.run()

    async def handle(self, scope: Scope, receive: Receive, send: Send, caller: Caller) -> None:
        scope.setdefault("state", {})[STATE_KEY] = caller
        await self.manager.handle_request(scope, receive, send)

    def _caller(self) -> Caller:
        request = self.server.request_context.request
        caller = getattr(request.state, STATE_KEY, None) if request is not None else None
        if not isinstance(caller, Caller):
            # Запрос пришёл мимо handle — значит, мимо проверки токена. Не исполнять.
            raise RuntimeError("Вызов MCP без проверенного токена")
        return caller

    async def _list_tools(self) -> list[types.Tool]:
        return tool_defs(tools.remote_catalog(self._caller().read_only))

    async def _call_tool(self, name: str, arguments: dict[str, Any] | None) -> types.CallToolResult:
        caller = self._caller()
        args = arguments or {}
        client = ArchMapClient(self.config, http=self.http, bearer=caller.bearer)
        started = time.monotonic()
        reply = await settle(
            name, tools.call_remote(name, args, client, caller.read_only), journal="журнале сервера ArchMap"
        )
        log.info(
            "tools/call %s: %s, пользователь %s, токен %s, проект %s, %d мс, адрес %s",
            clean(name),
            OUTCOME_WORDS[reply.outcome],
            clean(caller.username),
            clean(caller.token),
            clean(args.get("project", "—")),
            round((time.monotonic() - started) * 1000),
            clean(caller.address),
        )
        return reply.result()
