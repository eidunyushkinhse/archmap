import os

from app.settings.names import CACHE_URL_ENV
from app.settings.utils import get_from_env, str_to_bool

SITE_URL = get_from_env("SITE_URL", "https://example.com")
WORKERS = get_from_env("WORKERS", 4, type_cast=int)
SECURE = get_from_env("SECURE_COOKIES", default=False, type_cast=str_to_bool)
RATIO = get_from_env("SAMPLE_RATIO", type_cast=float)
REGION = get_from_env("REGION", "eu")
# Тот же параметр из os.getenv: одна запись с двумя местами.
REGION_AGAIN = os.getenv("REGION")
CACHE_URL = get_from_env(CACHE_URL_ENV, "")
# Ловушки: f-строка и выражение — подсказки, не параметры.
ZONE = get_from_env(f"ZONE_{REGION}", "a")
SHARD = get_from_env("SHARD_" + REGION)
