from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Значение-заглушка из .env.example: прод обязан заменить его реальным ключом.
_PLACEHOLDER_SECRET = "change-me-in-production-needs-32-bytes"


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
    # Открытая регистрация (POST /auth/register). По умолчанию включена — публичная
    # версия и dev ведут себя как раньше. В закрытом контуре ставят ALLOW_SIGNUP=false:
    # учётки заводит администратор на экране «Пользователи», регистрация отвечает 403.
    allow_signup: bool = True
    # Демо-режим публичного стенда (docs/tasks/demo-mode.md): вход только гостем через
    # «Попробовать без регистрации», у каждого гостя своя песочница с копией демо-проекта.
    # Вход по логину и регистрация выключены, проекты ограничены пределами app/demo.py.
    demo_mode: bool = False
    # Сколько живых песочниц держит стенд разом; дальше /demo/start отвечает 429.
    demo_max_sandboxes: int = 300
    # Сколько песочниц в час можно завести с одного адреса (счётчик в памяти процесса).
    demo_start_per_ip_per_hour: int = 10

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
