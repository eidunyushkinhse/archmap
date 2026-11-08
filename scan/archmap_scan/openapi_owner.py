"""Операции файла OpenAPI как маршруты объекта, который его отдаёт (ТЗ §15 п. 14 З3).

Владелец определяется механически и только среди контейнеров с ролью «сервис»: файл лежит в
каталоге кода ровно одного из них, иначе среди тех, чей каталог кода содержит файл (а если
таких нет, среди всех сервисов), ровно у одного имя или слово команды входит в путь файла,
info.title или servers[].url. Файл в исключённом каталоге документации (Д2) и файл чужого
API (все адреса servers на внешнем домене) владельца не получают. Маршрут из файла с тем же
методом и путём, что уже найден в коде у владельца, не дублируется: у записи кода появляется
второе основание. Остальное остаётся подсказкой hints.openapi_files с причиной.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from archmap_scan import owners, texts, vocab
from archmap_scan.model import OpenApi
from archmap_scan.objects import HttpEntry, Model, Obj

NAME = "openapi"
_WORD = re.compile(r"[a-z0-9]+")
# Слова команды, которые о процессе ничего не говорят: интерпретатор, путь, запуск.
_COMMON_WORDS = frozenset({
    "bin", "usr", "local", "sbin", "opt", "app", "apps", "src", "dist", "build", "main", "run",
    "start", "exec", "serve", "sh", "bash", "env", "python", "python3", "node", "npm", "npx",
    "yarn", "pnpm", "java", "jar", "dotnet", "ruby", "bundle", "api", "http", "https", "www",
    "com", "org", "net", "json", "yaml", "yml", "openapi", "swagger",
})
_SCHEME_HOST = re.compile(r"(?:[a-z][a-z0-9+.-]{0,20}:)?//([^/:?#\s]{1,300})", re.IGNORECASE)
_IPV4 = re.compile(r"[0-9]{1,3}(?:\.[0-9]{1,3}){3}")
# Параметр пути в коде и в файле: {id}, :id, <int:id> — для сравнения одно и то же.
_PARAM = re.compile(r"\{[^}/]{0,200}\}|:[A-Za-z_][A-Za-z0-9_]{0,100}|<[^>/]{0,200}>")
_MAX_NAMES = 10


def _external(url: str) -> bool:
    """Адрес на внешнем домене: схема и хост с точкой, не localhost, не IP и без переменных
    {…}. Относительный адрес («/api») и имя сервиса compose («http://orders:8080») — свои."""
    if "{" in url:
        return False
    m = _SCHEME_HOST.match(url.strip())
    if m is None:
        return False
    host = m.group(1).lower()
    return "." in host and _IPV4.fullmatch(host) is None and host != "localhost"


def foreign(spec: OpenApi) -> bool:
    """Файл описывает чужой API: все адреса servers на внешних доменах."""
    return bool(spec.servers) and all(_external(url) for url in spec.servers)


def _words(obj: Obj) -> set[str]:
    out: set[str] = set()
    for unit in obj.units:
        for word in _WORD.findall((unit.command or "").lower()):
            if len(word) >= 3 and word not in _COMMON_WORDS:
                out.add(word)
    return out


def _mentions(obj: Obj, text: str, words: set[str]) -> bool:
    name = obj.name.lower()
    if re.search(rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])", text):
        return True
    return bool(_words(obj) & words)


def owner(spec: OpenApi, containers: Sequence[Obj]) -> tuple[Obj | None, list[Obj]]:
    """Владелец файла и сервисы, среди которых он искался (для причины подсказки)."""
    services = [o for o in containers if o.role == vocab.ROLE_SERVICE]
    found = [o for o in owners.code_owners(spec.path, containers) if o.role == vocab.ROLE_SERVICE]
    if len(found) == 1:
        return found[0], found
    pool = found or services
    text = " ".join([spec.path, spec.title or "", *spec.servers]).lower()
    words = set(_WORD.findall(text))
    named = [o for o in pool if _mentions(o, text, words)]
    return (named[0] if len(named) == 1 else None), pool


def no_owner_reason(pool: Sequence[Obj]) -> str:
    names = sorted(o.name for o in pool)
    return texts.openapi_no_owner(names[:_MAX_NAMES], len(names) - _MAX_NAMES)


def _key(method: str, path: str) -> tuple[str, str]:
    path = _PARAM.sub("{}", path)
    if len(path) > 1:
        path = path.rstrip("/") or "/"
    return method.upper(), path


def _prefixes(spec: OpenApi) -> list[str]:
    """Префиксы путей файла: пусто, путь относительного адреса servers и basePath."""
    out = [""]
    for url in spec.servers:
        m = _SCHEME_HOST.match(url.strip())
        rest = url[m.end():] if m else url
        rest = rest.split("?", 1)[0].rstrip("/")
        if rest.startswith("/") and "{" not in rest and rest not in out:
            out.append(rest)
    return out


def attach(model: Model, spec: OpenApi, obj: Obj) -> int:
    """Операции файла в маршруты obj; число новых записей."""
    entries = model.http.setdefault(obj.name, [])
    known: dict[tuple[str, str], HttpEntry] = {}
    for entry in entries:
        known.setdefault(_key(entry.method, entry.path), entry)
    added = 0
    prefixes = _prefixes(spec)
    for method, path, loc in spec.ops:
        hit = next(
            (known[k] for k in (_key(method, p + path) for p in prefixes) if k in known), None,
        )
        if hit is not None:
            if hit.openapi is None and hit.parser != NAME:
                hit.openapi = loc
            continue
        entry = HttpEntry(method=method, path=path, framework=NAME, loc=loc, parser=NAME)
        entries.append(entry)
        known[_key(method, path)] = entry
        added += 1
    entries.sort(key=lambda e: (e.path, e.method, e.loc))
    return added
