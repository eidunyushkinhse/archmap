from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Значение-заглушка из .env.example: прод обязан заменить его реальным ключом.
_PLACEHOLDER_SECRET = "change-me-in-production-needs-32-bytes"  # noqa: S105 — заглушка, с ней сверяют настоящий ключ


class Settings(BaseSettings):
    # Секреты и адрес БД без дефолтов: приложение падает при старте, если окружение
    # не настроено (fail-fast), а не работает молчком на заглушках.
    database_url: str
    secret_key: str
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7  # 7 дней
    # Разрешённые CORS-источники: строка через запятую (JSON-списки в .env неудобны
    # для Railway). Парсится в список в main.py.
    cors_origins: str = "http://localhost:5173"
    # Демо-режим публичного стенда (docs/tasks/demo-mode.md): вход только гостем через
    # «Попробовать без регистрации», у каждого гостя своя песочница с копией демо-проекта.
    # Вход по логину и регистрация выключены, проекты ограничены пределами app/demo.py.
    demo_mode: bool = False
    # Сколько живых песочниц держит стенд разом; дальше /demo/start отвечает 429.
    demo_max_sandboxes: int = 300
    # Сколько песочниц в час можно завести с одного адреса (счётчик в памяти процесса).
    demo_start_per_ip_per_hour: int = 10
    # Режим одного процесса (app/standalone.py, образ без nginx): каталог сборки
    # фронта, предел размера запроса в МБ и сколько неудачных попыток входа в минуту
    # пропускать с одного адреса (0 — без ограничения).
    frontend_dir: str = ""
    max_request_mb: int = 64
    login_attempts_per_minute: int = 10
    # Адрес клиента для лимитов брать из X-Forwarded-For (его дописывает прокси перед
    # ArchMap: nginx поставки, Gateway/Ingress в Kubernetes). Без прокси (docker compose) — false:
    # заголовок тогда присылает сам клиент и обходит им лимиты.
    trust_forwarded_for: bool = True
    # Удалённый MCP-сервер (/mcp, docs/plan-remote-mcp.md): сколько запросов в минуту
    # пропускать по одному личному токену (0 — без предела; счётчик в памяти процесса,
    # поэтому предел приблизительный) и с каких Origin пускать запросы из браузера
    # (через запятую; пусто — ни с каких: агенты Origin не шлют, а запрос с чужой
    # страницы отклоняется, как требует спецификация MCP против DNS rebinding).
    mcp_requests_per_minute: int = 300
    mcp_allowed_origins: str = ""
    # Загрузка файла с машины агента по одноразовой ссылке (app/uploads.py,
    # docs/plan-mcp-upload.md): предел одного файла в МБ. Файл живёт 10 минут в БД.
    upload_max_mb: int = 2

    model_config = SettingsConfigDict(env_file=".env")

    @field_validator("secret_key")
    @classmethod
    def _check_secret_key(cls, value: str) -> str:
        if not value or value == _PLACEHOLDER_SECRET:
            raise ValueError(
                "SECRET_KEY не задан: скопируйте .env.example в .env и установите "
                "случайный ключ, например `openssl rand -hex 32`."
            )
        if len(value) < 32:
            raise ValueError("SECRET_KEY слишком короткий: нужно не менее 32 символов.")
        return value


settings = Settings()
