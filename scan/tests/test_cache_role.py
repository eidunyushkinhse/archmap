"""Роль «брокер и кэш» у брокера Redis (ТЗ §15 п. 18 В2): свидетельства кэша Rails, Django,
Laravel и Node.js (parsers/cachestore.py) и выбор объекта Redis (cacherole.py)."""

from __future__ import annotations

from functools import partial
from pathlib import Path

import pytest

from archmap_scan import texts
from archmap_scan.objects import BROKER, DATABASE
from archmap_scan.parsers import cachestore
from tests.helpers import FIXTURES, files_of, model_of, time_limit, timed, tree


def _caches(root: Path) -> list[tuple[str, str]]:
    ctx, files = files_of(root)
    return [(c.marker, str(c.loc)) for c in cachestore.parse(files, ctx).caches]


def test_cache_store_fixture() -> None:
    """Rails production.rb, Django CACHES и пакет кэша Node.js. Ловушки: строка в
    комментарии, development.rb и settings/test.py (файлы разработки), :null_store, LocMemCache."""
    assert _caches(FIXTURES / "cache-store") == [
        ("django_redis.cache.RedisCache", "django/shop/settings/base.py:7"),
        (":redis_cache_store", "rails/config/environments/production.rb:4"),
        ("cache-manager-redis-yet", "node/package.json:6"),
    ]


def test_broker_gets_cache_role() -> None:
    """Брокер redis (Sidekiq у web и jobs) получает роль «брокер и кэш» по Rails и Django,
    основания объекта пополняются строками свидетельств; node связан с двумя Redis без
    переменной кэша: подсказка, роль по ней не меняется; кэш sessions остаётся базой."""
    model = model_of(FIXTURES / "cache-store")
    redis = next(o for o in model.objects if o.name == "redis")
    sessions = next(o for o in model.objects if o.name == "sessions")
    assert (redis.shape, redis.role, redis.technology) == (BROKER, "брокер и кэш", "Redis")
    assert {"rails/config/environments/production.rb:4", "django/shop/settings/base.py:7"} <= {
        str(loc) for loc in redis.locs
    }
    assert (sessions.shape, sessions.role) == (DATABASE, "кэш")
    hints = [h for h in model.hints["unassigned"] if h["kind"] == "cache"]
    assert hints == [{
        "kind": "cache", "name": "cache-manager-redis-yet", "reason": texts.cache_ambiguous(2),
        "source": "node/package.json:6", "objects": ["redis", "sessions"],
    }]


def _node_tree(root: Path, cache_host: str) -> Path:
    return tree(root, {
        "docker-compose.yml": (
            "services:\n  app:\n    build: .\n    environment:\n"
            "      CELERY_BROKER_URL: redis://redis:6379/0\n"
            f"      CACHE_REDIS_URL: redis://{cache_host}:6379/0\n"
            "  redis:\n    image: redis:7\n  sessions:\n    image: valkey/valkey:8\n"
        ),
        "Dockerfile": "FROM node:20\n",
        "package.json": '{"name": "app", "dependencies": {"cache-manager-ioredis-yet": "*"}}',
    })


@pytest.mark.parametrize(("cache_host", "role"), [("redis", "брокер и кэш"), ("sessions", "брокер")])
def test_cache_variable_picks_object(tmp_path: Path, cache_host: str, role: str) -> None:
    """Переменная со словом CACHE называет объект: свидетельство ложится на него, подсказки о
    двух Redis нет. На кэш-базу sessions роль брокера не переносится."""
    model = model_of(_node_tree(tmp_path, cache_host))
    redis = next(o for o in model.objects if o.name == "redis")
    sessions = next(o for o in model.objects if o.name == "sessions")
    assert (redis.shape, redis.role) == (BROKER, role)
    assert (sessions.shape, sessions.role) == (DATABASE, "кэш")
    assert not [h for h in model.hints.get("unassigned", []) if h["kind"] == "cache"]


def test_laravel_and_database_cache(tmp_path: Path) -> None:
    """Laravel CACHE_STORE=redis в .env.example и env('CACHE_DRIVER', 'redis') в config/cache.php
    дают свидетельства; у Monica CACHE_STORE=database ничего. Redis без брокерских
    свидетельств остаётся базой «кэш»."""
    root = tree(tmp_path / "a", {
        "docker-compose.yml": (
            "services:\n  app:\n    build: .\n    environment:\n      REDIS_HOST: redis\n"
            "  redis:\n    image: redis:7\n"
        ),
        "Dockerfile": "FROM php:8.3\n",
        "composer.json": '{"require": {"laravel/framework": "*"}}',
        ".env.example": "APP_NAME=x\nCACHE_STORE=redis\n",
        "config/cache.php": "<?php\nreturn ['default' => env('CACHE_DRIVER', 'redis')];\n",
    })
    assert _caches(root) == [
        ("CACHE_STORE=redis", ".env.example:2"), ("CACHE_DRIVER=redis", "config/cache.php:2"),
    ]
    model = model_of(root)
    redis = next(o for o in model.objects if o.name == "redis")
    assert (redis.shape, redis.role) == (DATABASE, "кэш")
    monica = tree(tmp_path / "b", {
        ".env.example": "CACHE_STORE=database\n",
        "config/cache.php": "<?php\n'default' => env('CACHE_STORE', env('CACHE_DRIVER', 'database')),\n",
    })
    assert _caches(monica) == []


A = "a" * 2_000_000


@pytest.mark.parametrize("name", ["rails", "django", "laravel", "node"])
def test_hostile(tmp_path: Path, name: str) -> None:
    """Строка в 2 МБ после правдоподобного начала в каждом виде файла."""
    files = {
        "rails": {"config/environments/production.rb": "config.cache_store = :" + A + "\n"},
        "django": {"settings.py": 'CACHES = {"default": {"BACKEND": "RedisCache' + A + '"}}\n'},
        "laravel": {".env.example": "CACHE_STORE=" + A + "\n", "config/cache.php": "env('CACHE_" + A},
        "node": {"package.json": '{"dependencies": {"cache-manager-redis-yet' + A + '": "*"}}'},
    }[name]
    ctx, parsed = files_of(tree(tmp_path, dict(files)))
    _found, took = timed(partial(cachestore.parse, parsed, ctx), time_limit())
    assert took < time_limit(), f"{took:.2f} с"
