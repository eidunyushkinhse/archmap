"""Шапка сборщика фактов у входов (фаза 3 docs/tasks/fact-collector.md, раздел 5 о шапке
файлов).

Каждый файл вывода archmap-scan.pyz начинается шапкой: «# archmap-scan <версия>»,
«# repo: <адрес origin>», «# commit: <хэш HEAD>» (без git значения пустые); у файлов
фактов перед ней ещё строка «# archmap-node: …». Читается только начало текста (5 строк и
не больше 1 КБ), сам документ разбирает import_yaml.

Черновик схемы сборщика (schema.yaml как есть) ArchMap не принимает нигде: ни новым
проектом, ни догрузкой, ни обновлением из кода (золотое правило владельца 2026-11-21:
документацию пишет человек сам или с агентом, вывод сборщика человеку не показывается).
Черновик узнаётся по шапке и по отсутствию описаний: сборщик их не пишет. Агент по промпту
берёт schema.yaml за скелет и дописывает смысл; дописал прямо в этот файл, и шапка осталась,
зато появились описания: такой файл уже документ агента и проходит. Файлы фактов сборщика
агент по промпту подаёт как есть, у них пометка «собран сборщиком фактов» в отчёте.

Тексты живут здесь и только здесь: их показывают окна ввоза, отчёты фактов и MCP.
"""

import re
from dataclasses import dataclass

from app.identity import normalize_repo

# Сколько начала текста смотрим: шапка сборщика — первые строки файла.
HEAD_LINES = 5
HEAD_BYTES = 1024

_VERSION = re.compile(r"^# archmap-scan ([0-9A-Za-z.+-]{1,32})\s*$")
_REPO = re.compile(r"^# repo:(.*)$")
_COMMIT = re.compile(r"^# commit:(.*)$")
_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")
# Сколько знаков хэша показывать: как в замерах и в git log --oneline.
COMMIT_SHOWN = 8

# Отказ схеме сборщика: вход ввоза или обновления из кода с шапкой «# archmap-scan».
SCHEMA_REJECTED = (
    "Файл собран сборщиком фактов: это черновик для агента, а не документация. Добавьте "
    "YAML, который агент написал по этому черновику"
)
FACTS_TAIL = "у записей есть основание в манифестах и коде, описаний нет, их добавит агент или человек"


@dataclass(frozen=True)
class ScanOrigin:
    """Что сказала шапка: версия сборщика, адрес репозитория (нормализованный, как у
    источника объекта) и хэш коммита. Пустые repo и commit — запуск без git."""

    version: str
    repo: str
    commit: str

    def by(self) -> str:
        """«сборщиком фактов ArchMap 0.1.0 по коммиту 49ce20c3 репозитория …»: без коммита
        и репозитория короче, без этих слов."""
        parts = [f"сборщиком фактов ArchMap {self.version}"]
        if self.commit and self.repo:
            parts.append(f"по коммиту {self.commit} репозитория {self.repo}")
        elif self.commit:
            parts.append(f"по коммиту {self.commit}")
        elif self.repo:
            parts.append(f"по репозиторию {self.repo}")
        return " ".join(parts)


def scan_origin(text: str) -> ScanOrigin | None:
    """Шапка сборщика в начале текста или None (вход собран не сборщиком)."""
    head = text[:HEAD_BYTES].lstrip("﻿").splitlines()[:HEAD_LINES]
    version: str | None = None
    repo = commit = ""
    for line in head:
        if version is None:
            m = _VERSION.match(line)
            if m:
                version = m.group(1)
            continue
        m = _REPO.match(line)
        if m:
            repo = normalize_repo(m.group(1).strip()) or ""
            continue
        m = _COMMIT.match(line)
        if m:
            raw = m.group(1).strip()
            commit = raw[:COMMIT_SHOWN].lower() if _SHA.match(raw) else ""
    if version is None:
        return None
    return ScanOrigin(version=version, repo=repo, commit=commit)


# Строка с непустым описанием объекта или связи. [ \t]*, а не \s*: \s* под MULTILINE
# захватывал бы переводы строк, и на тексте из одних пустых строк поиск стал бы квадратичным.
_DESCRIPTION = re.compile(r"^[ \t]*(?:-[ \t]+)?description:[ \t]*\S", re.MULTILINE)


def is_scanner_schema(text: str) -> bool:
    """Вход схемы — черновик сборщика как есть: шапка в начале и ни одного описания.
    Такой вход отклоняется (SCHEMA_REJECTED)."""
    return scan_origin(text) is not None and _DESCRIPTION.search(text) is None


def facts_note(fname: str, text: str) -> str | None:
    """Строка пометки для файла фактов (таблицы, каналы, параметры) или None. Имя файла
    в строке: отчёт фактов один на весь пакет."""
    found = scan_origin(text)
    return f"Файл {fname} собран {found.by()}: {FACTS_TAIL}" if found else None
