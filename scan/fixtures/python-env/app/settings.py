import os
from datetime import timedelta
from os import environ, getenv

import environ as django_environ
from decouple import config
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

env = django_environ.Env(DEBUG=(bool, False), ALLOWED_HOSTS=(list, []))

DEBUG = env("DEBUG")
CACHE_TTL = env.int("CACHE_TTL", default=60)
DATABASE_URL = env.db("DATABASE_URL")
SENTRY_DSN = config("SENTRY_DSN", default="")
WORKERS = config("WORKERS", cast=int)
FAST = config("FAST_MODE", default=True, cast=bool)
HOME = getenv("HOME_DIR", "/srv")
REGION = environ.get("REGION")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "app.settings")
SECRET_KEY = os.environ["SECRET_KEY"]
os.environ["WRITTEN_NOT_READ"] = "1"
# os.getenv("COMMENTED") — строка в комментарии параметром не считается.
DYN = os.getenv("PREFIX_" + REGION)


class Base(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_")

    port: int = 8000
    timeout: timedelta = timedelta(seconds=5)
    api_key: str = Field(default="dev-key-not-for-output")
    name: str = Field(..., alias="SERVICE_NAME")
    tags: list[str] = Field(default_factory=list)
    _private: int = 1


class Child(Base):
    debug: bool = False
