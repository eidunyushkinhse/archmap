# Реестр очередей Celery: имя CamelCase, последнее слово «Queue».
from enum import Enum


class CeleryQueue(Enum):
    DEFAULT = "celery"
    EMAIL = "email"
    LONG_RUNNING = "long_running"
