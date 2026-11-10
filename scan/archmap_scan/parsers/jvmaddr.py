"""Адреса объектов литералами в коде Java и Kotlin (ТЗ §15 п. 17 С2).

Строковый литерал в коде src/main пакета Java или Kotlin, который весь адрес вида
«http://<хост>/путь», «https://<хост>» или «lb://<хост>», где хост без точек и порта: связь
контейнера-владельца файла к объекту с таким хостом или именем (PathLink с quiet: хост не
объект — ни связи, ни подсказки), технология HTTP, основание — строка литерала. Хост с точкой,
с портом, localhost, IP, шаблон Kotlin с «$» и литералы в каталогах тестов не связи. Больше
2000 адресов в файле (clike.MAX_READS) — файл непрочитан. Ограниченный вариант адресов
литералами в коде: для других языков правило не действует.
"""

from __future__ import annotations

import re

from archmap_scan import clike, jvm
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, PathLink
from archmap_scan.walk import Files

NAME = "jvm-address"
_NEEDLES = ("://",)
_ADDRESS = re.compile(r"(?:https?|lb)://([A-Za-z0-9][A-Za-z0-9_-]{0,62})(?:[/?#][^\s]*)?")
_SCHEME = re.compile(r'"(?:https?|lb)://')
_LOCAL = frozenset({"localhost"})


def _in_main(rel: str) -> bool:
    return rel.startswith("src/main/") or "/src/main/" in rel


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    if not jvm.stack_present(files, ctx):
        return found
    found.applied.add(NAME)
    for rel, code, _language in jvm.sources(files, ctx, None, _NEEDLES):
        if not _in_main(rel):
            continue
        seen: set[tuple[str, int]] = set()
        links: list[PathLink] = []
        for m in _SCHEME.finditer(code.text):
            # Кавычка в маске на том же месте: начало строки кода, а не комментарий и не
            # середина другой строки. Проверка до поиска закрытия: отрезки от начала литерала до
            # следующей кавычки маски не перекрываются, время линейно по файлу.
            if code.mask[m.start()] != '"':
                continue
            end = code.mask.find('"', m.start() + 1)
            if end < 0:
                continue
            value, dynamic = jvm.literal(code, m.start(), end + 1)
            hit = _ADDRESS.fullmatch(value)
            if dynamic or hit is None or hit.group(1).lower() in _LOCAL:
                continue
            line = code.line(m.start())
            key = (hit.group(1), line)
            if key in seen:
                continue
            seen.add(key)
            links.append(PathLink(hit.group(1), Loc(rel, line), NAME, quiet=True))
            if len(links) > clike.MAX_READS:
                # Враждебный вход: адресов в файле больше предела — файл непрочитан целиком.
                files.refuse(rel)
                links = []
                break
        found.path_links.extend(links)
    return found
