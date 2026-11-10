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

Часть 5 (ТЗ §15 п. 16 С1). Сервис — прокси и по базовому образу последней стадии своего
Dockerfile (envoyproxy/envoy, nginx, haproxy, caddy, traefik), когда образ в compose задан
переменной или своим тегом. Файлы конфигурации берутся и из COPY и ADD Dockerfile внутри
контекста сборки: у Envoy *.yaml и *.yml, у nginx *.conf, у Caddy Caddyfile, у HAProxy
haproxy.cfg (у Traefik не читаются). Envoy читается по формату: адреса
static_resources.clusters[].load_assignment.endpoints[].lb_endpoints[].endpoint.address
.socket_address.address и старые clusters[].hosts[].socket_address.address; listeners
адресами не считаются. Подстановки ${VAR}, ${VAR:-x} и ${VAR-x} в адресе Envoy раскрываются
окружением единицы; запись «- VAR» без значения берёт значение из закоммиченного .env рядом
с файлом compose, как docker compose.
"""

from __future__ import annotations

import re
from bisect import bisect_left
from collections.abc import Iterator, Mapping
from typing import Any

from archmap_scan import paths, texts, vocab
from archmap_scan.model import EnvVar, Hint, Loc, ManifestLink
from archmap_scan.parsers import dockerfile as dockerfiles
from archmap_scan.walk import Files
from archmap_scan.yamlload import BadYaml, LineDict, LineList, YamlTooLarge, load_all

_PROXY_NAMES = frozenset({"nginx", "nginx-unprivileged", "openresty", "haproxy", "caddy",
                          "traefik", "envoy"})
# Сколько файлов тома-каталога читается и сколько адресов берётся из одного файла; сколько
# источников COPY и ADD одного Dockerfile смотрится (враждебный Dockerfile, С1).
_MAX_DIR_FILES = 50
_MAX_ADDRESSES = 200
_MAX_COPIES = 200
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


# Вид прокси по технологии словаря образов или по имени образа (С1).
_KIND_BY_TECH = {"Envoy": "envoy", "nginx": "nginx", "HAProxy": "haproxy", "Traefik": "traefik"}
_KIND_BY_NAME = {
    "envoy": "envoy", "nginx": "nginx", "nginx-unprivileged": "nginx", "openresty": "nginx",
    "haproxy": "haproxy", "caddy": "caddy", "traefik": "traefik",
}


def is_proxy(image: str) -> bool:
    """Образ прокси по словарю (nginx, HAProxy, Traefik, Envoy) или имени (caddy)."""
    kind = vocab.image_kind(image)
    if kind is not None and kind.role == vocab.ROLE_PROXY:
        return True
    name = vocab.image_name(image)
    return name in _PROXY_NAMES or name.split("-", 1)[0] in _PROXY_NAMES


def proxy_kind(image: str) -> str | None:
    """Вид прокси образа: envoy, nginx, haproxy, caddy, traefik или proxy (прокси без
    известного вида); None — образ не прокси."""
    if not is_proxy(image):
        return None
    kind = vocab.image_kind(image)
    if kind is not None and kind.technology in _KIND_BY_TECH:
        return _KIND_BY_TECH[kind.technology]
    name = vocab.image_name(image)
    return _KIND_BY_NAME.get(name) or _KIND_BY_NAME.get(name.split("-", 1)[0]) or "proxy"


def dockerfile_kind(files: Files, docker: str) -> str | None:
    """Вид прокси по базовому образу последней стадии Dockerfile (С1); None — не прокси."""
    if not _has_file(files, docker):
        return None
    text = files.read(docker)
    parsed = dockerfiles.parse_text(docker, text) if text is not None else None
    return proxy_kind(parsed.images[-1]) if parsed is not None else None


def _is_config(rel: str, kind: str) -> bool:
    """Файл конфигурации прокси вида kind по имени (для файлов из COPY Dockerfile)."""
    name = paths.name(rel).lower()
    if kind == "envoy":
        return name.endswith((".yaml", ".yml"))
    nginx = name.endswith(".conf")
    caddy = name.startswith("caddyfile")
    haproxy = name == "haproxy.cfg"
    return {"nginx": nginx, "caddy": caddy, "haproxy": haproxy, "traefik": False}.get(
        kind, nginx or caddy or haproxy,
    )


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


def _get(node: Any, *keys: str) -> Any:
    for key in keys:
        if not isinstance(node, LineDict):
            return None
        node = node.get(key)
    return node


def _socket(holder: Any) -> tuple[str, int] | None:
    """Адрес socket_address узла и строка ключа address."""
    sock = _get(holder, "socket_address")
    if isinstance(sock, LineDict) and isinstance(sock.get("address"), str):
        return sock["address"], sock.line_of("address")
    return None


def _cluster_addresses(cluster: LineDict) -> Iterator[tuple[str, int]]:
    """Адреса кластера Envoy: load_assignment и старые hosts."""
    endpoints = _get(cluster, "load_assignment", "endpoints")
    for endpoint in endpoints if isinstance(endpoints, LineList) else []:
        lbs = _get(endpoint, "lb_endpoints")
        for lb in lbs if isinstance(lbs, LineList) else []:
            found = _socket(_get(lb, "endpoint", "address"))
            if found is not None:
                yield found
    hosts = cluster.get("hosts")
    for host in hosts if isinstance(hosts, LineList) else []:
        found = _socket(host)
        if found is not None:
            yield found


def _envoy_links(
    name: str, text: str, rel: str, files: Files, values: Mapping[str, str], hints: list[Hint],
) -> list[ManifestLink]:
    """Связи из конфигурации Envoy (С1): адреса кластеров с подстановками окружения. Файл
    больше предела YAML непрочитан, ошибка разбора — подсказка."""
    # Подстановки — по правилам compose (compose.expand); импорт внутри функции: compose сам
    # импортирует этот модуль.
    from archmap_scan.parsers.compose import expand

    try:
        docs = load_all(text)
    except YamlTooLarge:
        files.refuse(rel)
        return []
    except BadYaml:
        hints.append(Hint("unparsed", {
            "kind": "file", "name": rel, "reason": texts.REASON_BAD_YAML, "source": rel,
            "object": name,
        }))
        return []
    out: list[ManifestLink] = []
    for address, line in envoy_addresses(docs):
        host = host_of(expand(address, env=values))
        if host is not None and host != name:
            out.append(ManifestLink(
                name, host, Loc(rel, line), "compose", technology="HTTP", by_host=True,
            ))
            if len(out) >= _MAX_ADDRESSES:
                break
    return out


def envoy_addresses(docs: list[Any]) -> Iterator[tuple[str, int]]:
    """(адрес, строка) кластеров static_resources документов Envoy; слушатели (listeners) и
    admin адресами не считаются."""
    for doc in docs:
        clusters = _get(doc, "static_resources", "clusters")
        for cluster in clusters if isinstance(clusters, LineList) else []:
            if isinstance(cluster, LineDict):
                yield from _cluster_addresses(cluster)


def _file_links(
    name: str, rel: str, files: Files, kind: str | None, values: Mapping[str, str],
    hints: list[Hint],
) -> list[ManifestLink]:
    text = files.read(rel)
    if text is None:
        return []
    if kind == "envoy" and paths.name(rel).lower().endswith((".yaml", ".yml")):
        return _envoy_links(name, text, rel, files, values, hints)
    return _links(name, text, rel, 1)


def _values(env: list[EnvVar], dotenv: Mapping[str, str] | None) -> dict[str, str]:
    """Окружение единицы для подстановок: «- VAR» без значения — из .env рядом с compose."""
    out: dict[str, str] = {}
    for var in env:
        value = var.value if var.value is not None else (dotenv or {}).get(var.name)
        if value is not None and "${" not in value:
            out[var.name] = value
    return out


def _copied(
    name: str, files: Files, docker: str, context: str, kind: str, values: Mapping[str, str],
    hints: list[Hint],
) -> list[ManifestLink]:
    """Связи из файлов конфигурации, которые Dockerfile кладёт COPY или ADD из контекста
    сборки (С1); файл конфигурации, которого нет в обходе, даёт подсказку."""
    text = files.read(docker)
    seen: set[str] = set()
    wanted: dict[str, None] = {}  # файлы конфигурации по порядку, без повторов
    for count, (line, source) in enumerate(
        dockerfiles.copy_sources(text) if text is not None else [], start=1,
    ):
        if count > _MAX_COPIES:
            break
        target = paths.join(context, source.lstrip("/") or ".")
        if target is None or target in seen:
            continue
        seen.add(target)
        if _has_file(files, target):
            members = [target] if _is_config(target, kind) else []
        elif files.has_dir(target) or target == context:
            members = [m for m in _dir_files(files, target) if _is_config(m, kind)]
        else:
            if _is_config(target, kind):
                hints.append(Hint("unparsed", {
                    "kind": "file", "name": target, "reason": texts.REASON_PROXY_COPY_MISSING,
                    "source": str(Loc(docker, line)), "object": name,
                }))
            continue
        wanted.update(dict.fromkeys(members))
    out: list[ManifestLink] = []
    for member in wanted:
        out += _file_links(name, member, files, kind, values, hints)
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
    prefix = folder + "/" if folder else ""
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
    kind: str | None = None, docker: str | None = None, context: str | None = None,
    dotenv: Mapping[str, str] | None = None,
) -> list[ManifestLink]:
    """Связи прокси name вида kind из файлов томов, файлов COPY и ADD его Dockerfile (docker,
    контекст сборки context) и многострочных значений environment."""
    values = _values(env, dotenv)
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
            out += _file_links(name, member, files, kind, values, hints)
    if docker is not None and context is not None and kind is not None and _has_file(files, docker):
        out += _copied(name, files, docker, context, kind, values, hints)
    for var in env:
        if var.value is not None and "\n" in var.value.strip():
            # Значение блоком «|» начинается со строки после ключа.
            out += _links(name, var.value, var.loc.path, var.loc.line + 1)
    return out
