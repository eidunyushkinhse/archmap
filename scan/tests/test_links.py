"""Адреса зависимостей в значениях переменных."""

from __future__ import annotations

import time

import pytest

from archmap_scan.links import hosts_in, link_technology
from tests.helpers import time_limit


@pytest.mark.parametrize(
    ("name", "value", "expected"),
    [
        ("DATABASE_URL", "postgres://u:p@orders-db:5432/orders", [("orders-db", "postgres")]),
        ("MONGO", "mongodb://a:1,b:2/db", [("a", "mongodb"), ("b", "mongodb")]),
        ("API_URL", "http://orders:8080/api", [("orders", "http")]),
        ("REDIS_HOST", "redis", [("redis", None)]),
        ("KAFKA_BOOTSTRAP_SERVERS", "k1:9092,k2:9092", [("k1", None), ("k2", None)]),
        ("SOMETHING", "events:9092", [("events", None)]),
        ("LOG_LEVEL", "info", []),
        ("DB_HOST", "localhost", []),
        ("DB_URL", "postgres://127.0.0.1/x", []),
        ("SVC_URL", "http://orders.default.svc.cluster.local:80", [("orders", "http")]),
        ("X_HOST", "[::1]:80", []),
        ("X_HOST", "bad host!", []),
        ("URL", "http://", []),
        ("A_URL", "http://a/x and https://b/y", [("a", "http"), ("b", "https")]),
    ],
)
def test_hosts(name: str, value: str, expected: list[tuple[str, str | None]]) -> None:
    assert hosts_in(name, value) == expected


def test_link_technology() -> None:
    assert link_technology("https") == "HTTP"
    assert link_technology("grpc") == "gRPC"
    assert link_technology(None) is None


def test_hostile_values_are_fast() -> None:
    started = time.perf_counter()
    hosts_in("X_URL", "a" * 2_000_000)
    hosts_in("X_URL", "://" * 300_000)
    hosts_in("X_HOST", ("a," * 1_000_000))
    hosts_in("X", "a" * 2_000_000 + ":1")
    # Под замером покрытия предел шире (helpers.time_limit): трассировка замедляет разбор.
    assert time.perf_counter() - started < time_limit()
