import os


def get_from_env(key, default=None, *, optional=False, type_cast=None):
    """Обёртка чтения: первый параметр уходит в os.getenv."""
    value = os.getenv(key)
    if value is None or value == "":
        return default
    return type_cast(value) if type_cast else value


def str_to_bool(value):
    return str(value).lower() in ("1", "true", "yes")


# Ловушка: литерал внутри функции, это не обёртка, а обычное чтение APP_DEBUG.
def debug_enabled():
    return os.getenv("APP_DEBUG", "false") == "true"
