import os

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    kafka_bootstrap: str = "events:9092"
    request_timeout: str = "30s"


settings = Settings()
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")
WORKERS = int(os.getenv("WORKERS", "4"))
