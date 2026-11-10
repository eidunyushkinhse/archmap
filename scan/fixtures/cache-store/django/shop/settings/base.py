import os

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/1")

CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": REDIS_URL,
    },
    "local": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    },
}
