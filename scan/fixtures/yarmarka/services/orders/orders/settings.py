import os

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    kafka_bootstrap: str = "events:9092"
    request_timeout: str = "30s"


settings = Settings()
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")
WORKERS = int(os.getenv("WORKERS", "4"))
# Секрет с дефолтом в коде: имя говорит о секрете, дефолт в вывод не попадает.
JWT_SECRET = os.getenv("JWT_SECRET", "dev-jwt-signing-secret-in-code")
PAYMENT_API_TOKEN = os.environ["PAYMENT_API_TOKEN"]


def feature(name: str) -> bool:
    # Имя параметра собирается при запуске: в подсказки, а не в параметры.
    return os.getenv(f"FEATURE_{name.upper()}", "false") == "true"
