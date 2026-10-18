"""Эндпоинт /mcp: удалённый MCP-сервер ArchMap в процессе бэкенда (docs/plan-remote-mcp.md).

Клей между приложением и пакетом archmap_mcp: демо-режим, метод, Origin, лимиты,
проверка личного токена и запуск в lifespan. Протокол и инструменты — в
mcp/archmap_mcp/remote.py. Инструменты ходят в HTTP API этого же процесса
(httpx.ASGITransport) с токеном вызывающего: права, пределы демо, длины полей, CAS и
тексты отказов — ровно те же, что у интерфейса. Внутренние вызовы идут мимо Standalone
(без его предела тела и заголовков): предел стоит на внешнем входе.

Маршрут — starlette Route с ASGI-объектом, а не Mount: Mount("/mcp") ловит только
/mcp/…, а при redirect_slashes=False сам /mcp получил бы 404. В OpenAPI такой маршрут
не попадает. Lifespan подприложения Starlette не исполняет — менеджер SDK стартует в
lifespan app.main (running).
"""

import logging
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

from app.config import settings
from app.personal_tokens import TOKEN_PREFIX
from app.rate_limit import AddressLimiter, client_address

# Пакет archmap_mcp в поставках лежит рядом с app/ (образ, архив поставки) — импорт прямой.
# В репозитории он в mcp/: запасной путь — ОДНО место на все входы (uvicorn в dev,
# npm run gen:api, CI, scripts/*.py, pytest). Только при пропаже самого archmap_mcp:
# пропавший SDK или ошибка внутри пакета не должны маскироваться.
try:
    from archmap_mcp import remote
except ModuleNotFoundError as exc:
    if exc.name != "archmap_mcp":
        raise
    sys.path.append(str(Path(__file__).resolve().parents[2] / "mcp"))
    from archmap_mcp import remote

log = logging.getLogger("archmap.mcp")

# Адрес API для внутренних вызовов: запрос не покидает процесса (ASGITransport).
INTERNAL_BASE_URL = "http://archmap.internal"
# Неудачных проверок токена в минуту с одного адреса — дальше 429 (перебор токенов).
AUTH_FAILURES_PER_MINUTE = 30

DEMO_DETAIL = "На демо-стенде подключение агента недоступно"
NOT_STARTED_DETAIL = "MCP не запущен"
METHOD_DETAIL = "Метод не поддерживается: /mcp принимает только POST"
ORIGIN_DETAIL = "Запросы к /mcp с этой страницы не принимаются"
NEED_PAT_DETAIL = "Нужен личный токен: создайте его в меню профиля → «Токены для MCP»"
AUTH_LIMITED_DETAIL = "Слишком много неудачных проверок токена. Подождите минуту."
RATE_LIMITED_DETAIL = "Слишком много запросов по этому токену. Подождите минуту."


def allowed_origins() -> set[str]:
    return {o.strip().rstrip("/") for o in settings.mcp_allowed_origins.split(",") if o.strip()}


async def _reply(
    scope: Scope, receive: Receive, send: Send, status: int, detail: str, headers: dict[str, str] | None = None
) -> None:
    await JSONResponse({"detail": detail}, status_code=status, headers=headers)(scope, receive, send)


class McpEndpoint:
    """ASGI-обработчик /mcp: проверки по порядку, затем запрос — хозяину удалённого режима
    (app.state.mcp_host, его заводит running)."""

    def __init__(self) -> None:
        # Счётчики в памяти процесса, как у входа: защита от злоупотреблений, не учёт.
        self.auth_failures = AddressLimiter(window_seconds=60)
        self.requests = AddressLimiter(window_seconds=60)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if settings.demo_mode:
            await _reply(scope, receive, send, 404, DEMO_DETAIL)
            return
        # Без состояния SSE-потока нет: GET держал бы висящее соединение до таймаута
        # прокси, а сессий для DELETE не бывает. Спецификация MCP такое разрешает.
        if scope["method"] != "POST":
            await _reply(scope, receive, send, 405, METHOD_DETAIL, {"Allow": "POST"})
            return
        headers = Headers(scope=scope)
        # Агенты Origin не шлют. Есть — значит, запрос из браузера: чужая страница (DNS
        # rebinding) отклоняется, как требует спецификация MCP.
        origin = headers.get("origin")
        if origin is not None and origin.rstrip("/") not in allowed_origins():
            await _reply(scope, receive, send, 403, ORIGIN_DETAIL)
            return
        address = client_address(scope)
        if not self.auth_failures.allowed(address, AUTH_FAILURES_PER_MINUTE):
            await _reply(scope, receive, send, 429, AUTH_LIMITED_DETAIL)
            return
        scheme, _, bearer = headers.get("authorization", "").partition(" ")
        bearer = bearer.strip()
        if scheme.lower() != "bearer" or not bearer.startswith(TOKEN_PREFIX):
            # Без токена или с JWT сессии интерфейса: /mcp — только личным токеном.
            self.auth_failures.record(address)
            log.warning("/mcp: запрос без личного токена, адрес %s", remote.clean(address))
            await _reply(scope, receive, send, 401, NEED_PAT_DETAIL, {"WWW-Authenticate": "Bearer"})
            return
        host = getattr(scope["app"].state, "mcp_host", None)
        if not isinstance(host, remote.RemoteHost):
            await _reply(scope, receive, send, 503, NOT_STARTED_DETAIL)
            return
        try:
            caller = await remote.whoami(host.http, INTERNAL_BASE_URL, bearer, address)
        except remote.TokenRejected as exc:
            if exc.status == 401:
                self.auth_failures.record(address)
            log.warning("/mcp: токен отклонён (%s), адрес %s", remote.clean(exc.detail), remote.clean(address))
            await _reply(
                scope, receive, send, exc.status, exc.detail, {"WWW-Authenticate": 'Bearer error="invalid_token"'}
            )
            return
        limit = settings.mcp_requests_per_minute
        if limit > 0:
            if not self.requests.allowed(caller.token_id, limit):
                await _reply(scope, receive, send, 429, RATE_LIMITED_DETAIL)
                return
            self.requests.record(caller.token_id)
        await host.handle(scope, receive, send, caller)


# Один на процесс: в нём счётчики лимитов (main.py ставит его маршрутом /mcp).
endpoint = McpEndpoint()


def _ensure_log_handler() -> None:
    """uvicorn настраивает только свои логгеры: без обработчика INFO из archmap.mcp
    пропал бы. Обработчик в stderr (его соберут journald и docker logs) — только если
    журнал больше некому принять (под pytest его принимает caplog).

    Свой обработчик — без передачи корню: SDK зовёт модульный logging.debug(), и Python
    при пустом корневом логгере сам вешает на него basicConfig — каждая строка журнала
    иначе печаталась бы дважды (полевая находка живого прогона)."""
    if log.level == logging.NOTSET:
        log.setLevel(logging.INFO)
    if log.handlers or logging.getLogger().handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(handler)
    log.propagate = False


@asynccontextmanager
async def running(app: FastAPI) -> AsyncIterator[None]:
    """Удалённый режим на время жизни приложения: внутренний клиент API, хозяин (в run()
    менеджера SDK можно войти один раз — поэтому новый на каждый запуск lifespan), журнал.
    В демо-режиме не стартует: /mcp там отвечает 404."""
    if settings.demo_mode:
        yield
        return
    _ensure_log_handler()
    # raise_app_exceptions=False: 500 бэкенда — ответ, а не исключение внутри инструмента.
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url=INTERNAL_BASE_URL) as http:
        host = remote.RemoteHost(http, INTERNAL_BASE_URL, max_body_bytes=settings.max_request_mb * 1024 * 1024)
        async with host.run():
            app.state.mcp_host = host
            try:
                yield
            finally:
                app.state.mcp_host = None
