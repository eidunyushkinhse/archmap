"""Адреса зависимостей в значениях переменных окружения (ТЗ §6.1, уточнения §3).

Из значения берутся имена хостов: из адресов со схемой («postgres://user:pw@db:5432/x»,
несколько хостов через запятую), из «хост:порт» и из голого имени, если имя переменной
говорит об адресе (REDIS_HOST=redis). Петлевые адреса принадлежат машине, а не продукту,
и не берутся. Разбор ручной, без регулярных выражений с перебором: значения из чужого
репозитория бывают враждебными.
"""

from __future__ import annotations

import re

_LOOPBACK = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"})
_HOST = re.compile(r"[a-z0-9][a-z0-9._-]*", re.IGNORECASE)
_NAME_HINTS = (
    "HOST", "HOSTNAME", "HOSTS", "ADDR", "ADDRESS", "SERVER", "SERVERS", "BROKER", "BROKERS",
    "URL", "URI", "DSN", "ENDPOINT", "BOOTSTRAP",
)
_SCHEME_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789+.-")
_NETLOC_STOP = frozenset("/?# \t\r\n'\";")
_MAX_HOST = 253


def _hosty_name(name: str) -> bool:
    parts = [p for p in name.upper().replace("-", "_").split("_") if p]
    return any(p in _NAME_HINTS for p in parts)


def _clean_host(part: str) -> str | None:
    part = part.strip()
    if not part or len(part) > _MAX_HOST + 6:
        return None
    if part.startswith("["):
        return None  # IPv6 в скобках: адрес среды, не имя зависимости
    host = part.split(":", 1)[0].lower().rstrip(".")
    if not host or len(host) > _MAX_HOST or _HOST.fullmatch(host) is None:
        return None
    if host in _LOOPBACK:
        return None
    # Имя k8s Service полным адресом: orders.default.svc.cluster.local → orders.
    if ".svc" in host:
        host = host.split(".", 1)[0]
    return host


def hosts_in(name: str, value: str) -> list[tuple[str, str | None]]:
    """(хост, схема) из значения переменной name; без повторов, в порядке появления."""
    out: list[tuple[str, str | None]] = []
    text = value.strip()
    i = text.find("://")
    while i != -1:
        j = i
        while j > 0 and i - j < 32 and text[j - 1].lower() in _SCHEME_CHARS:
            j -= 1
        scheme = text[j:i].lower() or None
        k = i + 3
        end = k
        while end < len(text) and text[end] not in _NETLOC_STOP:
            end += 1
        netloc = text[k:end].rsplit("@", 1)[-1]
        for part in netloc.split(","):
            host = _clean_host(part)
            if host and (host, scheme) not in out:
                out.append((host, scheme))
        i = text.find("://", end)
    if out or "://" in text:
        return out
    parts = [p for p in text.split(",") if p.strip()]
    if not parts or len(parts) > 64:
        return out
    hinted = _hosty_name(name)
    for part in parts:
        p = part.strip()
        has_port = ":" in p and p.rsplit(":", 1)[1].isdigit()
        if not (has_port or hinted):
            continue
        host = _clean_host(p)
        if host and (host, None) not in out:
            out.append((host, None))
    return out


def link_technology(scheme: str | None) -> str | None:
    """Технология связи с сервисом по схеме адреса."""
    if scheme in ("http", "https", "ws", "wss"):
        return "HTTP"
    if scheme == "grpc":
        return "gRPC"
    return None
