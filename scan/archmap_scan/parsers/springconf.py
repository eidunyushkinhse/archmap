"""Параметры из файлов настроек Spring Boot и Quarkus (ТЗ §15 п. 17 Е1).

Файл настроек модуля (jvmconf: src/main/resources/application.yml, .yaml, .properties,
bootstrap.*; не файлы профилей) у пакета Java или Kotlin со Spring Boot (spring-boot*) или
Quarkus (quarkus-*). Параметры даёт документ без профиля (spring.config.activate.on-profile,
spring.profiles); ключ Quarkus «%профиль.» параметром не становится. Параметр — ключ через
точку как написан, дефолт — значение как написано (список одной строкой, тип array), тип по
значению; запись CodeParam с from_file, как у appsettings.json. Подстановка «${X:d}» в
значении даёт ещё параметр X с дефолтом d, «${X}» — обязательный X; дефолт подстановкой
(«${A:${B}}») литералом не считается. Адреса и секреты дефолтом не пишутся по общему правилу
(secrets.safe_default), и значение с такой подстановкой («${ADDR:localhost:3550}») тоже.
Файл больше предела непрочитан, ошибка YAML — подсказка в unparsed.

Связи (С1), из всех документов, и профильных тоже: маршрут шлюза Spring Cloud Gateway
(spring.cloud.gateway.routes, .server.webflux.routes, .mvc.routes, .server.webmvc.routes:
uri элемента списка, у .properties — ключ routes[N].uri), сервер конфигурации
(spring.config.import с «configserver:», spring.cloud.config.uri) и Eureka
(eureka.client.serviceUrl.defaultZone и написания через «-»): связь контейнера модуля к объекту
по хосту адреса (PathLink, конец находит сборка), технология HTTP. Подстановка раскрывается
дефолтом, без дефолта — подсказка; localhost и IP не связь.
"""

from __future__ import annotations

import re

from archmap_scan import jvmconf, secrets, texts, yamlload
from archmap_scan.context import Context
from archmap_scan.links import hosts_in
from archmap_scan.model import CodeParam, Findings, Hint, Loc, PathLink, unparsed_hint
from archmap_scan.walk import Files

NAME = "spring-config"
STACK = ("spring-boot", "quarkus")
# Сколько подстановок одного значения становится параметрами (враждебный вход).
_MAX_PLACEHOLDERS = 50
_ROUTES = frozenset({
    "spring.cloud.gateway.routes", "spring.cloud.gateway.server.webflux.routes",
    "spring.cloud.gateway.mvc.routes", "spring.cloud.gateway.server.webmvc.routes",
})
_ROUTE_KEY = re.compile(
    r"(spring\.cloud\.gateway(?:\.server\.webflux|\.mvc|\.server\.webmvc)?\.routes)"
    r"\[[0-9]{1,6}\]\.uri"
)
_IMPORT = "spring.config.import"
_CONFIG_URI = "spring.cloud.config.uri"
_EUREKA = frozenset({
    "eureka.client.serviceUrl.defaultZone", "eureka.client.service-url.defaultZone",
    "eureka.client.service-url.default-zone", "eureka.client.serviceUrl.default-zone",
})
_IPV4 = re.compile(r"[0-9]{1,3}(?:\.[0-9]{1,3}){3}")
_MAX_LINKS = 2000  # адресов на файл (враждебный вход)


def _placeholders(found: Findings, rel: str, line: int, value: str) -> bool:
    """Параметры подстановок значения; False — дефолт подстановки адрес или секрет, и само
    значение с ним дефолтом не пишется (${ADDR:localhost:3550} — адрес среды)."""
    safe = True
    for ph in jvmconf.placeholders(value)[:_MAX_PLACEHOLDERS]:
        if ph.default is not None and secrets.safe_default(ph.name, ph.default) is None:
            safe = False
        found.code_params.append(CodeParam(
            name=ph.name, loc=Loc(rel, line), parser=NAME, default=ph.default,
            has_default=ph.has_default, required=not ph.has_default,
            type=jvmconf.value_type(ph.default), from_file=True,
        ))
    return safe


def _addresses(entry: jvmconf.Entry) -> list[tuple[str, int]]:
    """Адреса связей ключа (адрес, строка): uri маршрутов шлюза, сервер конфигурации, Eureka."""
    if entry.key in _ROUTES and isinstance(entry.raw, list):
        out: list[tuple[str, int]] = []
        for item in entry.raw:
            if isinstance(item, yamlload.LineDict) and isinstance(item.get("uri"), str):
                out.append((item["uri"], item.line_of("uri")))
        return out
    if not isinstance(entry.value, str) or entry.type == "array":
        return []
    if _ROUTE_KEY.fullmatch(entry.key) or entry.key == _CONFIG_URI or entry.key in _EUREKA:
        return [(part.strip(), entry.line) for part in entry.value.split(",") if part.strip()]
    if entry.key == _IMPORT:
        out = []
        for part in _split_import(entry.value):
            if part.startswith("optional:"):
                part = part[len("optional:"):]
            if part.startswith("configserver:"):
                out.append((part[len("configserver:"):], entry.line))
        return out
    return []


def _split_import(value: str) -> list[str]:
    """Элементы spring.config.import через запятую вне подстановок «${…}»."""
    out: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(value):
        if ch == "{":
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(value[start:i].strip())
            start = i + 1
    out.append(value[start:].strip())
    return [p for p in out if p]


def _links(found: Findings, rel: str, entry: jvmconf.Entry, budget: list[int]) -> None:
    for address, line in _addresses(entry):
        budget[0] -= 1
        if budget[0] < 0:
            return
        loc = Loc(rel, line)
        value = jvmconf.expand(address)
        if value is None:
            found.hints.append(Hint("unassigned", {
                "kind": "edge", "name": address[:80], "reason": texts.REASON_ADDRESS_PLACEHOLDER,
                "source": str(loc),
            }))
            continue
        for host, _scheme in hosts_in("URI", value):
            if not _IPV4.fullmatch(host):
                found.path_links.append(PathLink(host, loc, NAME))


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in jvmconf.settings_files(files, ctx, STACK):
        docs = jvmconf.load(files, rel)
        if docs is None:
            found.hints.append(unparsed_hint(rel, texts.REASON_BAD_SETTINGS))
            continue
        budget = [_MAX_LINKS]
        for doc in docs:
            for entry in doc.entries:
                if not jvmconf.profile_key(entry.key):
                    _links(found, rel, entry, budget)
            if doc.profile:
                continue
            for entry in doc.entries:
                if jvmconf.profile_key(entry.key):
                    continue
                default = entry.value
                if default is not None and entry.type != "array" and "${" in default:
                    if not _placeholders(found, rel, entry.line, default):
                        default = None
                found.code_params.append(CodeParam(
                    name=entry.key, loc=Loc(rel, entry.line), parser=NAME, default=default,
                    has_default=entry.value is not None, type=entry.type, from_file=True,
                ))
    return found
