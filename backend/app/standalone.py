"""ArchMap одним процессом: бэкенд сам отдаёт собранный фронт (образ из Dockerfile).

На сервере перед бэкендом стоит nginx (deploy/install.sh). В контейнере его нет:
снаружи Gateway/Ingress Kubernetes (или ничего — Docker Compose), за ним сразу этот
модуль, и он делает то же, что делал nginx:

- в API уходят только /api/…, /health и /ready; остальное — файлы сборки фронта, а неизвестный
  путь отдаёт index.html: маршруты интерфейса живут в браузере. Swagger и openapi.json
  наружу не выставлены;
- /assets/… кэшируются навсегда (в имени файла хэш сборки), остальное — без кэша;
- ответы от 1 КБ сжимаются gzip;
- запрос больше MAX_REQUEST_MB отклоняется (413);
- неудачные попытки входа ограничены LOGIN_ATTEMPTS_PER_MINUTE с адреса (429);
- у каждого ответа заголовки безопасности SECURITY_HEADERS (их же пишет nginx).

Запуск: uvicorn app.standalone:create_app --factory; каталог сборки — в FRONTEND_DIR.
"""

from pathlib import Path

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import settings
from app.main import app as api_app
from app.rate_limit import AddressLimiter, client_address

LOGIN_PATH = "/api/v1/auth/login"
# Тот же текст отдавал nginx: форма входа показывает detail из ответа
LOGIN_LIMITED_DETAIL = "Слишком много попыток входа. Подождите минуту и попробуйте снова."
IMMUTABLE = "public, max-age=31536000, immutable"

# Заголовки безопасности (аудит M3, R-4): те же значения пишет nginx серверной поставки
# (render_nginx в deploy/install.sh; расхождение ловит тест). Встраивать ArchMap в чужие
# страницы нельзя (frame-ancestors), подмены <base> и плагинов нет. Полная политика
# источников пока только наблюдает (Report-Only): mermaid и swagger вставляют стили, и
# нарушения сначала надо увидеть в консоли браузера, а не сломать ими страницу. HSTS —
# забота того, кто держит TLS (Gateway/Ingress, nginx в TLS-ветке).
SECURITY_HEADERS: tuple[tuple[str, str], ...] = (
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "same-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
    ("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"),
    (
        "Content-Security-Policy-Report-Only",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
        "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; "
        "object-src 'none'; form-action 'self'",
    ),
)
_SECURITY_RAW = [(k.lower().encode(), v.encode()) for k, v in SECURITY_HEADERS]


def too_large_detail(limit_mb: int) -> str:
    return f"Запрос больше {limit_mb} МБ: ArchMap принимает файлы до этого размера."


def is_api_path(path: str) -> bool:
    return path.startswith("/api/") or path in ("/health", "/ready")


class FrontendFiles(StaticFiles):
    """Сборка фронта: файл по пути, иначе index.html. Под /assets/ подмены нет:
    пропавший файл сборки — честный 404, а не страница вместо скрипта."""

    def __init__(self, directory: Path) -> None:
        super().__init__(directory=directory)
        self.index = (directory / "index.html").read_bytes()

    async def get_response(self, path: str, scope: Scope) -> Response:
        assets = scope["path"].startswith("/assets/")
        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404 or assets:
                raise
            return self.index_response()
        if path == "index.html":
            return self.index_response()
        response.headers["Cache-Control"] = IMMUTABLE if assets else "no-cache"
        return response

    def index_response(self) -> Response:
        # Без ETag и Last-Modified: после обновления браузер обязан взять новый
        # index.html со ссылками на новые файлы сборки, даже если размер и время совпали
        return Response(self.index, media_type="text/html", headers={"Cache-Control": "no-cache"})


class Standalone:
    """Разводит запросы между API и сборкой фронта; служебные события (lifespan)
    уходят в API."""

    def __init__(
        self,
        api: ASGIApp,
        frontend_dir: Path,
        *,
        max_request_mb: int,
        login_attempts_per_minute: int,
    ) -> None:
        self.api = api
        self.frontend = FrontendFiles(frontend_dir)
        self.max_request_mb = max_request_mb
        self.max_body = max_request_mb * 1024 * 1024
        self.login_attempts_per_minute = login_attempts_per_minute
        self.login_failures = AddressLimiter(window_seconds=60)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.api(scope, receive, send)
            return
        send = self.with_security_headers(send)
        if is_api_path(scope["path"]):
            await self.to_api(scope, receive, send)
        else:
            await self.to_frontend(scope, receive, send)

    async def to_frontend(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            response = await self.frontend.get_response(self.frontend.get_path(scope), scope)
        except HTTPException as exc:
            response = PlainTextResponse(exc.detail, status_code=exc.status_code)
        await response(scope, receive, send)

    async def to_api(self, scope: Scope, receive: Receive, send: Send) -> None:
        length = Headers(scope=scope).get("content-length", "")
        if length.isdigit() and int(length) > self.max_body:
            await self.reply(scope, receive, send, 413, too_large_detail(self.max_request_mb))
            return
        if (
            scope["method"] == "POST"
            and scope["path"] == LOGIN_PATH
            and self.login_attempts_per_minute > 0
        ):
            address = client_address(scope)
            if not self.login_failures.allowed(address, self.login_attempts_per_minute):
                await self.reply(scope, receive, send, 429, LOGIN_LIMITED_DETAIL)
                return
            send = self.count_failure(send, address)
        await self.api(scope, self.limited(receive), send)

    @staticmethod
    def with_security_headers(send: Send) -> Send:
        async def sending(message: Message) -> None:
            if message["type"] == "http.response.start":
                present = {k.lower() for k, _ in message.get("headers", [])}
                extra = [(k, v) for k, v in _SECURITY_RAW if k not in present]
                message = {**message, "headers": [*message.get("headers", []), *extra]}
            await send(message)

        return sending

    def limited(self, receive: Receive) -> Receive:
        """Тело без Content-Length (chunked) считаем по ходу чтения: исключение
        FastAPI превратит в ответ 413 с detail."""
        received = 0

        async def guarded() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body:
                    raise HTTPException(413, too_large_detail(self.max_request_mb))
            return message

        return guarded

    def count_failure(self, send: Send, address: str) -> Send:
        """Попытка входа засчитывается адресу сразу, пока проверяется пароль: иначе
        параллельные запросы проскочили бы лимит. Если вход удался (не 401), попытка
        списывается — удачные входы людей за одним адресом лимит не съедают."""
        moment = self.login_failures.record(address)

        async def counting(message: Message) -> None:
            if message["type"] == "http.response.start" and message["status"] != 401:
                self.login_failures.forget(address, moment)
            await send(message)

        return counting

    @staticmethod
    async def reply(scope: Scope, receive: Receive, send: Send, status: int, detail: str) -> None:
        await JSONResponse({"detail": detail}, status_code=status)(scope, receive, send)


def create_app() -> ASGIApp:
    root = Path(settings.frontend_dir)
    if not settings.frontend_dir or not (root / "index.html").is_file():
        raise RuntimeError(
            f"FRONTEND_DIR={settings.frontend_dir!r}: нужен каталог сборки фронта с index.html"
        )
    standalone = Standalone(
        api_app,
        root,
        max_request_mb=settings.max_request_mb,
        login_attempts_per_minute=settings.login_attempts_per_minute,
    )
    return GZipMiddleware(standalone, minimum_size=1024, compresslevel=6)
