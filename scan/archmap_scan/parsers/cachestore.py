"""Свидетельства кэша на Redis в настройках (ТЗ §15 п. 18 В2): по ним брокер Redis получает
роль «брокер и кэш» (сборка, cacherole.py). Семьи у разборщика нет: записей он не даёт.

- Rails: `config.cache_store = :redis_cache_store` или `:redis_store` в
  config/environments/*.rb и config/application.rb (маска Ruby).
- Django: `"BACKEND": "django_redis.cache.RedisCache"` или
  `"django.core.cache.backends.redis.RedisCache"` в словаре файла настроек (каталог или имя со
  словом settings, каталог conf, как у разборщика django; по ast), первое на файл.
- Laravel: `CACHE_DRIVER=redis` или `CACHE_STORE=redis` в .env.example и `env('CACHE_STORE',
  'redis')` в config/cache.php.
- Node.js: пакет cache-manager-redis-store, cache-manager-redis-yet или
  cache-manager-ioredis-yet в зависимостях package.json (строка, где он назван).

Файлы разработки и тестов (walk.is_dev_path: development.rb, settings/test.py) не
свидетельство: кэш разработки не говорит о боевом Redis.
"""

from __future__ import annotations

import ast
import re

from archmap_scan import codebase, codetext, pyast, pycode, walk
from archmap_scan.context import Context
from archmap_scan.model import CacheUse, Findings, Loc
from archmap_scan.parsers import django
from archmap_scan.walk import Files

NAME = "cache-store"
_RAILS_FILE = re.compile(r"(?:^|/)config/(?:environments/[^/]+|application)\.rb$")
_RAILS = re.compile(r"\bconfig\.cache_store[ \t]*=[ \t]*(:redis_cache_store|:redis_store)\b")
_DJANGO = frozenset({
    "django_redis.cache.RedisCache", "django.core.cache.backends.redis.RedisCache",
})
_LARAVEL_ENV = re.compile(r"^[ \t]*(CACHE_DRIVER|CACHE_STORE)[ \t]*=[ \t]*[\"']?redis[\"']?[ \t]*$", re.M)
_LARAVEL_PHP = re.compile(
    r"\benv\([ \t]*['\"](CACHE_DRIVER|CACHE_STORE)['\"][ \t]*,[ \t]*['\"]redis['\"][ \t]*\)",
)
_NODE = ("cache-manager-redis-store", "cache-manager-redis-yet", "cache-manager-ioredis-yet")


def _line(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _rails(files: Files, rel: str, found: Findings) -> None:
    text = files.read(rel, keep=False)
    if text is None or "cache_store" not in text:
        return
    code = codetext.load(files, rel, text, codetext.RUBY)
    if code is None:
        return
    m = _RAILS.search(code.mask)
    if m is not None:
        found.caches.append(CacheUse(m.group(1), Loc(rel, code.line(m.start())), NAME))


def _django(files: Files, rel: str, found: Findings) -> None:
    text = files.read(rel, keep=False)
    if text is None or "RedisCache" not in text:
        return
    tree = pyast.parse(text)
    if tree is None:
        return
    hits: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values, strict=True):
            backend = pycode.string(value)
            if key is not None and pycode.string(key) == "BACKEND" and backend in _DJANGO:
                hits.append((key.lineno, backend or ""))
    if hits:
        line, backend = min(hits)
        found.caches.append(CacheUse(backend, Loc(rel, line), NAME))


def _laravel(files: Files, rel: str, pattern: re.Pattern[str], found: Findings) -> None:
    text = files.read(rel, keep=False)
    if text is None or "CACHE_" not in text:
        return
    m = pattern.search(text)
    if m is not None:
        found.caches.append(CacheUse(f"{m.group(1)}=redis", Loc(rel, _line(text, m.start())), NAME))


def _node(files: Files, ctx: Context, found: Findings) -> None:
    for pkg in codebase.packages(files, ctx):
        if pkg.language != codebase.NODE or walk.is_dev_path(pkg.path):
            continue
        names = [name for name in _NODE if name in pkg.deps]
        if not names:
            continue
        text = files.read(pkg.path) or ""
        at = text.find(f'"{names[0]}"')
        line = _line(text, at) if at >= 0 else 1
        found.caches.append(CacheUse(names[0], Loc(pkg.path, line), NAME))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    settings = set(django.settings_files(files))
    for rel in files.paths:
        if walk.is_dev_path(rel):
            continue
        if _RAILS_FILE.search(rel):
            _rails(files, rel, found)
        elif rel in settings:
            _django(files, rel, found)
        elif rel == ".env.example" or rel.endswith("/.env.example"):
            _laravel(files, rel, _LARAVEL_ENV, found)
        elif rel == "config/cache.php" or rel.endswith("/config/cache.php"):
            _laravel(files, rel, _LARAVEL_PHP, found)
    _node(files, ctx, found)
    return found
