"""Секреты не пишутся (инвариант 6 ТЗ): что можно записать дефолтом параметра.

Файлы окружения без суффикса example, sample, template или dist сборщик не открывает вовсе
(walk и envexample). Из примеров берётся имя; значение становится дефолтом, только если имя
не похоже на секрет, а значение не похоже на ключ, адрес или строку подключения. ArchMap
хранит перечень параметров, а не значения сред, поэтому сомнение решается в пользу пустого
дефолта.
"""

from __future__ import annotations

import re

_SECRET_WORDS = ("PASSWORD", "PASSWD", "SECRET", "TOKEN", "KEY", "DSN", "PRIVATE", "CREDENTIAL")
_KEY_PREFIXES = ("sk_", "pk_", "rk_", "ghp_", "gho_", "github_pat_", "xox", "akia", "aiza")
_TOKEN_CHARS = re.compile(r"[A-Za-z0-9+/=_.-]+")
_INT = re.compile(r"-?[0-9]+")
_DURATION = re.compile(r"(?:[0-9]+(?:\.[0-9]+)?(?:ms|s|m|h|d))+")
_BOOL = frozenset({"true", "false", "yes", "no", "on", "off"})
_MAX_DEFAULT = 200


def secret_name(name: str) -> bool:
    upper = name.upper()
    return any(word in upper for word in _SECRET_WORDS)


def looks_like_key(value: str) -> bool:
    """Длинная случайная строка или ключ известного вида."""
    v = value.strip()
    if v.lower().startswith(_KEY_PREFIXES):
        return True
    if len(v) >= 20 and _TOKEN_CHARS.fullmatch(v) is not None:
        return any(c.isdigit() for c in v) and any(c.isalpha() for c in v)
    return False


def looks_like_address(value: str) -> bool:
    """Строка подключения, адрес или хост с портом: значение среды, а не дефолт кода."""
    v = value.strip()
    if "://" in v or "@" in v:
        return True
    host, sep, port = v.rpartition(":")
    return bool(sep and host and port.isdigit())


def safe_default(name: str, value: str | None) -> str | None:
    """Значение, которое можно записать дефолтом, или None."""
    if value is None:
        return None
    v = value.strip()
    if not v or len(v) > _MAX_DEFAULT or "\n" in v:
        return None
    if secret_name(name) or looks_like_key(v) or looks_like_address(v):
        return None
    return v


def value_type(value: str | None) -> str | None:
    """Тип по виду значения: bool, int, duration, string."""
    if value is None or not value.strip():
        return None
    v = value.strip()
    if len(v) > 64:
        return "string"
    if v.lower() in _BOOL:
        return "bool"
    if _INT.fullmatch(v):
        return "int"
    if _DURATION.fullmatch(v):
        return "duration"
    return "string"
