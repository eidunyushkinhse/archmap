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
"""

from __future__ import annotations

from archmap_scan import jvmconf, secrets, texts
from archmap_scan.context import Context
from archmap_scan.model import CodeParam, Findings, Loc, unparsed_hint
from archmap_scan.walk import Files

NAME = "spring-config"
STACK = ("spring-boot", "quarkus")
# Сколько подстановок одного значения становится параметрами (враждебный вход).
_MAX_PLACEHOLDERS = 50


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


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in jvmconf.settings_files(files, ctx, STACK):
        docs = jvmconf.load(files, rel)
        if docs is None:
            found.hints.append(unparsed_hint(rel, texts.REASON_BAD_SETTINGS))
            continue
        for doc in docs:
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
