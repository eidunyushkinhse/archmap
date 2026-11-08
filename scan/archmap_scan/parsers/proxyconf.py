"""Файл конфигурации прокси, смонтированный в сервис compose (ТЗ §15 п. 14 Ж3).

У сервиса с образом прокси (nginx, HAProxy, Caddy, Traefik, Envoy) читаются файлы томов,
лежащие в репозитории (путь от каталога файла compose; том-каталог — его файлы без
подкаталогов), и многострочные значения environment (Caddyfile строками, как у PostHog).
Адреса берутся построчно:

- nginx: `server адрес;` внутри блока `upstream имя { … }` и `proxy_pass http://адрес;`
  (имя upstream адресом не считается: адреса дают его server);
- Caddy: `reverse_proxy [матчер] адрес [адрес…]`;
- HAProxy: `server имя адрес` в секции `backend` или `listen`.

Хост адреса — имя сервиса compose: из него сборка делает связь «использует» прокси → объект
с этим host и технологией HTTP, хост не объект — подсказка. IP-адреса, localhost и адреса с
подстановкой ($var, {…}) связей не дают. Модуль сам ничего не ищет в обходе: его зовёт
compose.py для сервиса прокси.
"""

from __future__ import annotations

import re
from bisect import bisect_left
from collections.abc import Iterator
from typing import Any

from archmap_scan import paths, texts, vocab
from archmap_scan.model import EnvVar, Hint, Loc, ManifestLink
from archmap_scan.walk import Files
from archmap_scan.yamlload import LineDict, LineList

_PROXY_NAMES = frozenset({"nginx", "nginx-unprivileged", "openresty", "haproxy", "caddy",
                          "traefik", "envoy"})
# Сколько файлов тома-каталога читается и сколько адресов берётся из одного файла.
_MAX_DIR_FILES = 50
_MAX_ADDRESSES = 200
_MAX_LINE = 2000

_UPSTREAM = re.compile(r"[ \t]*upstream[ \t]+([^\s{]{1,200})[ \t]*\{")
_NGINX_SERVER = re.compile(r"[ \t]*server[ \t]+[\"']?([^\s;\"']{1,300})")
_PROXY_PASS = re.compile(r"[ \t]*(?:proxy_pass|grpc_pass)[ \t]+[\"']?([^\s;\"']{1,300})")
_REVERSE_PROXY = re.compile(r"[ \t]*reverse_proxy\b([^{\n]{0,2000})")
_SECTION = re.compile(r"(backend|listen|frontend|defaults|global|resolvers|peers)\b")
_HAPROXY_SERVER = re.compile(r"[ \t]+server[ \t]+\S{1,200}[ \t]+([^\s]{1,300})")
_HOST = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,199}")
_SCHEME = re.compile(r"[a-z][a-z0-9+.-]{0,20}://")
_IPV4 = re.compile(r"[0-9]{1,3}(?:\.[0-9]{1,3}){3}")
_LOCAL = frozenset({"localhost", "unix"})


def is_proxy(image: str) -> bool:
    """Образ прокси по словарю (nginx, HAProxy, Traefik, Envoy) или имени (caddy)."""
    kind = vocab.image_kind(image)
    if kind is not None and kind.role == vocab.ROLE_PROXY:
        return True
    name = vocab.image_name(image)
    return name in _PROXY_NAMES or name.split("-", 1)[0] in _PROXY_NAMES


def host_of(address: str) -> str | None:
    """Имя хоста адреса прокси: «lemmy:8536», «http://lemmy», «h2c://capture:3000/x» →
    имя; IP, localhost, unix-сокет и подстановки — None."""
    if "$" in address or "{" in address or address.startswith(("/", "@", "*", "[")):
        return None
    scheme = _SCHEME.match(address)
    rest = address[scheme.end():] if scheme else address
    host = rest.split("/", 1)[0].split(":", 1)[0]
    if not _HOST.fullmatch(host) or _IPV4.fullmatch(host) or host.lower() in _LOCAL:
        return None
    return host


def _addresses(text: str) -> Iterator[tuple[int, str]]:
    """(номер строки с 0, адрес) по правилам модуля."""
    upstreams: set[str] = set()
    found: list[tuple[int, str]] = []
    passes: list[tuple[int, str]] = []
    depth = 0
    upstream_depth: int | None = None
    section: str | None = None
    for no, raw in enumerate(text.split("\n")):
        line = raw.split("#", 1)[0][:_MAX_LINE]
        if not line.strip():
            continue
        m = _UPSTREAM.match(line)
        if m is not None:
            upstreams.add(m.group(1))
            upstream_depth = depth
        elif upstream_depth is not None:
            server = _NGINX_SERVER.match(line)
            if server is not None:
                found.append((no, server.group(1)))
        if not line[:1].isspace():
            head = _SECTION.match(line)
            section = head.group(1) if head is not None else None
        elif section in ("backend", "listen"):
            server = _HAPROXY_SERVER.match(line)
            if server is not None:
                found.append((no, server.group(1)))
        target = _PROXY_PASS.match(line)
        if target is not None:
            passes.append((no, target.group(1)))
        caddy = _REVERSE_PROXY.match(line)
        if caddy is not None:
            for token in caddy.group(1).split()[:20]:
                if not token.startswith(("@", "/", "*")):
                    found.append((no, token))
        depth += line.count("{") - line.count("}")
        if upstream_depth is not None and depth <= upstream_depth:
            upstream_depth = None
        if len(found) + len(passes) >= _MAX_ADDRESSES:
            break
    for no, url in passes:
        host = host_of(url)
        if host is not None and host not in upstreams:
            found.append((no, url))
    yield from sorted(found)[:_MAX_ADDRESSES]


def _links(name: str, text: str, rel: str, first_line: int) -> list[ManifestLink]:
    out: list[ManifestLink] = []
    for no, address in _addresses(text):
        host = host_of(address)
        if host is not None and host != name:
            out.append(ManifestLink(
                name, host, Loc(rel, first_line + no), "compose", technology="HTTP",
                by_host=True,
            ))
    return out


def _sources(volumes: Any) -> Iterator[tuple[str, int]]:
    """Пути томов bind на хосте и строки: «./nginx.conf:/etc/nginx/nginx.conf:ro» и
    длинная форма {type: bind, source: …}. Именованный том и путь только в контейнере
    («/root/.caddy») — не файлы репозитория."""
    if not isinstance(volumes, LineList):
        return
    for i, item in enumerate(volumes):
        source: Any = None
        if isinstance(item, str) and ":" in item:
            source = item.split(":", 1)[0]
        elif isinstance(item, LineDict) and item.get("type", "bind") == "bind":
            source = item.get("source")
        if isinstance(source, str) and source.startswith((".", "/", "~")):
            yield source, volumes.line_at(i)


def _dir_files(files: Files, folder: str) -> list[str]:
    """Файлы каталога без подкаталогов (обход отсортирован: диапазон по префиксу)."""
    prefix = folder + "/"
    start = bisect_left(files.paths, prefix)
    out: list[str] = []
    for rel in files.paths[start:]:
        if not rel.startswith(prefix):
            break
        if "/" not in rel[len(prefix):]:
            out.append(rel)
            if len(out) == _MAX_DIR_FILES:
                break
    return out


def _has_file(files: Files, rel: str) -> bool:
    i = bisect_left(files.paths, rel)
    return i < len(files.paths) and files.paths[i] == rel


def links(
    name: str, svc: LineDict, rel: str, env: list[EnvVar], files: Files, hints: list[Hint],
) -> list[ManifestLink]:
    """Связи прокси name из файлов томов и многострочных значений environment."""
    out: list[ManifestLink] = []
    for source, line in _sources(svc.get("volumes")):
        loc = str(Loc(rel, line))
        target = None if source.startswith(("/", "~")) else paths.join(paths.parent(rel), source)
        if target is None:
            hints.append(Hint("unparsed", {
                "kind": "file", "name": source, "reason": texts.REASON_PROXY_OUTSIDE,
                "source": loc, "object": name,
            }))
            continue
        if _has_file(files, target):
            members = [target]
        elif files.has_dir(target):
            members = _dir_files(files, target)
        else:
            hints.append(Hint("unparsed", {
                "kind": "file", "name": target, "reason": texts.REASON_PROXY_MISSING,
                "source": loc, "object": name,
            }))
            continue
        for member in members:
            text = files.read(member)
            if text is not None:
                out += _links(name, text, member, 1)
    for var in env:
        if var.value is not None and "\n" in var.value.strip():
            # Значение блоком «|» начинается со строки после ключа.
            out += _links(name, var.value, var.loc.path, var.loc.line + 1)
    return out
