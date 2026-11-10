"""Файлы настроек Spring Boot и Quarkus (ТЗ §15 п. 17 К1, Е1, С1): чтение без исполнения.

Файл настроек модуля — src/main/resources/application.yml, application.yaml,
application.properties, bootstrap.yml, bootstrap.yaml или bootstrap.properties в каталоге
пакета Java или Kotlin (рядом с pom.xml или build.gradle). Файлы профилей
(application-<профиль>.yml, application.<профиль>.properties) не читаются: там значения
сред. YAML читает yamlload (пределы размера и ссылок), .properties — свой разбор по строкам
по правилам java.util.Properties: комментарии «#» и «!», ключ до «=», «:» или пробела,
продолжение строки «\\», экранирование «\\=» и «\\uXXXX». Файл .properties больше 1 МБ
непрочитан.

Документы: YAML с «---» и .properties с «#---» дают несколько документов; документ с
spring.config.activate.on-profile (или старым spring.profiles) — документ профиля: его ключи
параметрами не становятся, но адреса в нём идут в связи (С1). Ключ Quarkus с «%профиль.» —
значение профиля, параметром не становится.

Параметр — ключ через точку, как его пишет Spring (spring.application.name); список — одной
записью со значением одной строкой и типом array. Подстановка «${X:d}» в значении даёт ещё
параметр X с дефолтом d, «${X}» — обязательный параметр X (placeholders).
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, cast

from archmap_scan import codebase, jvm, paths, yamlload
from archmap_scan.context import Context
from archmap_scan.walk import Files

FILE_NAMES = frozenset({
    "application.yml", "application.yaml", "application.properties",
    "bootstrap.yml", "bootstrap.yaml", "bootstrap.properties",
})
RESOURCES = "src/main/resources"
MAX_PROPERTIES_BYTES = 1_000_000
MAX_DEPTH = 50
MAX_ENTRIES = 5000
_MAX_RENDER = 2000  # знаков значения списка одной строкой (дальше обрезается)
PROFILE_KEYS = frozenset({"spring.config.activate.on-profile", "spring.profiles"})
_INT = re.compile(r"-?[0-9]+")
_FLOAT = re.compile(r"-?[0-9]+\.[0-9]+(?:[eE][+-]?[0-9]+)?")
_BOOL = frozenset({"true", "false"})


@dataclass
class Entry:
    """Ключ документа: имя через точку, строка ключа, значение как написано (список одной
    строкой; None — пусто), тип по значению и само значение YAML (для адресов С1)."""

    key: str
    line: int
    value: str | None
    type: str | None
    raw: Any = None
    item_lines: list[int] = field(default_factory=list)


@dataclass
class Document:
    profile: bool
    entries: list[Entry]


class Unread(Exception):
    """Файл больше предела разбора: непрочитан."""


class BadFile(Exception):
    """Файл не разбирается (ошибка YAML или пределы ссылок): подсказка без записей."""


def is_settings_file(rel: str) -> bool:
    """Файл настроек модуля по имени и месту: <пакет>/src/main/resources/<имя>."""
    return paths.name(rel) in FILE_NAMES and paths.parent(rel).endswith(RESOURCES) and (
        paths.parent(rel) == RESOURCES or paths.parent(rel).endswith("/" + RESOURCES)
    )


def module_of(rel: str) -> str:
    """Каталог модуля файла настроек: каталог перед src/main/resources."""
    folder = paths.parent(rel)
    return folder[: -len(RESOURCES)].rstrip("/")


def settings_files(files: Files, ctx: Context, keys: tuple[str, ...]) -> list[str]:
    """Файлы настроек модулей Java и Kotlin, у пакета которых есть зависимость из keys (пакет —
    манифест сборки в каталоге модуля), кроме каталогов для разработки."""
    wanted = {p.dir for p in jvm.packages(files, ctx, keys)}
    out: list[str] = []
    for rel in files.select(is_settings_file):
        if module_of(rel) in wanted and not files.skip_dev_code(rel):
            out.append(rel)
    return out


def value_type(text: str | None) -> str | None:
    """Тип по значению: bool, int, float, duration, string (как у примеров окружения)."""
    if text is None:
        return None
    v = text.strip()
    if v.lower() in _BOOL:
        return "bool"
    if _INT.fullmatch(v):
        return "int"
    if _FLOAT.fullmatch(v):
        return "float"
    from archmap_scan import secrets  # noqa: PLC0415 — без цикла импортов
    return secrets.value_type(v)


def _render(value: Any, depth: int = 0) -> str:
    """Значение списка или отображения одной строкой: «[a, b]», «{id: x, uri: y}»."""
    if depth > MAX_DEPTH:
        raise Unread
    if isinstance(value, list):
        return "[" + ", ".join(_render(v, depth + 1) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{k}: {_render(v, depth + 1)}" for k, v in value.items()) + "}"
    return _scalar(value) or ""


def _scalar(value: Any) -> str | None:
    if value is None:
        return None
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _yaml_type(value: Any) -> str | None:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return value_type(value)
    return None


def _flatten(node: Any, prefix: str, depth: int, out: list[Entry], line: int) -> None:
    if depth > MAX_DEPTH:
        raise Unread
    if isinstance(node, yamlload.LineDict):
        for key, value in node.items():
            name = f"{prefix}.{key}" if prefix else str(key)
            key_line = node.line_of(key)
            if isinstance(value, dict) and value:
                _flatten(value, name, depth + 1, out, key_line)
                continue
            if len(out) >= MAX_ENTRIES:
                raise Unread
            if isinstance(value, dict):
                continue
            text = _render(value)[:_MAX_RENDER] if isinstance(value, list) else _scalar(value)
            items = list(value.item_lines) if isinstance(value, yamlload.LineList) else []
            out.append(Entry(name, key_line, text, _yaml_type(value), value, items))


def _yaml(text: str) -> list[Document]:
    try:
        docs = yamlload.load_all(text)
    except yamlload.YamlTooLarge as exc:
        raise Unread from exc
    except yamlload.BadYaml as exc:
        raise BadFile from exc
    out: list[Document] = []
    for doc in docs:
        if not isinstance(doc, yamlload.LineDict):
            continue
        entries: list[Entry] = []
        _flatten(doc, "", 0, entries, doc.line)
        profile = any(e.key in PROFILE_KEYS and e.type != "array" for e in entries)
        out.append(Document(profile, entries))
    return out


_ESCAPES = {"t": "\t", "n": "\n", "r": "\r", "f": "\f"}
_HEX = re.compile(r"[0-9a-fA-F]{4}")


def _unescape(raw: str) -> str:
    """Экранирование .properties: «\\t», «\\n», «\\uXXXX», иначе знак за «\\» как есть."""
    if "\\" not in raw:
        return raw
    out: list[str] = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch != "\\" or i + 1 == len(raw):
            out.append(ch)
            i += 1
            continue
        nxt = raw[i + 1]
        if nxt == "u" and _HEX.fullmatch(raw, i + 2, i + 6):
            out.append(chr(int(raw[i + 2:i + 6], 16)))
            i += 6
            continue
        out.append(_ESCAPES.get(nxt, nxt))
        i += 2
    return "".join(out)


def _logical_lines(text: str) -> Iterator[tuple[int, str]]:
    """(номер первой строки, логическая строка) .properties: продолжение «\\» склеивает
    строки, ведущие пробелы продолжения отбрасываются; комментарии и пустые строки
    пропускаются, разделитель документов «#---» отдаётся как есть."""
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        start = i
        line = lines[i].rstrip("\r")
        i += 1
        stripped = line.lstrip(" \t\f")
        if stripped in ("#---", "!---"):
            yield start + 1, "#---"
            continue
        if not stripped or stripped[0] in "#!":
            continue
        parts = [stripped]
        while _continues(parts[-1]) and i < len(lines):
            parts[-1] = parts[-1][:-1]
            parts.append(lines[i].rstrip("\r").lstrip(" \t\f"))
            i += 1
        if _continues(parts[-1]):
            parts[-1] = parts[-1][:-1]
        yield start + 1, "".join(parts)


def _continues(line: str) -> bool:
    """Строка кончается нечётным числом «\\»: продолжается на следующей."""
    n = len(line) - len(line.rstrip("\\"))
    return n % 2 == 1


def _split(line: str) -> tuple[str, str]:
    """Ключ и значение логической строки .properties."""
    i = 0
    size = len(line)
    while i < size:
        ch = line[i]
        if ch == "\\":
            i += 2
            continue
        if ch in "=: \t\f":
            break
        i += 1
    key = line[:i]
    j = i
    while j < size and line[j] in " \t\f":
        j += 1
    if j < size and line[j] in "=:":
        j += 1
        while j < size and line[j] in " \t\f":
            j += 1
    return _unescape(key), _unescape(line[j:])


def _properties(text: str) -> list[Document]:
    docs: list[Document] = []
    entries: list[Entry] = []
    for line_no, line in _logical_lines(text):
        if line == "#---":
            docs.append(Document(any(e.key in PROFILE_KEYS for e in entries), entries))
            entries = []
            continue
        if len(entries) >= MAX_ENTRIES:
            raise Unread
        key, value = _split(line)
        if key:
            entries.append(Entry(key, line_no, value, value_type(value), value))
    docs.append(Document(any(e.key in PROFILE_KEYS for e in entries), entries))
    return docs


def read(text: str, rel: str) -> list[Document]:
    """Документы файла настроек. Unread — больше предела, BadFile — не разбирается."""
    if rel.endswith(".properties"):
        if len(text.encode("utf-8", "replace")) > MAX_PROPERTIES_BYTES:
            raise Unread
        return _properties(text)
    return _yaml(text)


def load(files: Files, rel: str) -> list[Document] | None:
    """Документы файла по кэшу запуска (файл читают несколько разборщиков); None — файл
    непрочитан (отмечен в Files) или не разбирается."""
    memo = cast(
        dict[str, list[Document] | None], files.memo.setdefault("jvm-settings", {}),
    )
    if rel in memo:
        return memo[rel]
    text = files.read(rel, keep=False)
    docs: list[Document] | None = None
    if text is not None:
        try:
            docs = read(text, rel)
        except Unread:
            files.refuse(rel)
        except BadFile:
            docs = None
    memo[rel] = docs
    return docs


def profile_key(key: str) -> bool:
    """Ключ Quarkus со значением профиля: «%dev.quarkus.log.level»."""
    return key.startswith("%")


def first_value(files: Files, rels: list[str], keys: tuple[str, ...]) -> tuple[str, str] | None:
    """Значение одного из ключей keys в документах без профиля файлов rels (по порядку) и
    файл; None — ключа нет."""
    for rel in rels:
        for doc in load(files, rel) or []:
            if doc.profile:
                continue
            for entry in doc.entries:
                if entry.key in keys and entry.value is not None and entry.type != "array":
                    return entry.value, rel
    return None


def module_files(files: Files, ctx: Context, module: str, keys: tuple[str, ...]) -> list[str]:
    """Файлы настроек модуля module (каталога пакета) по порядку имён."""
    return sorted(
        r for r in settings_files(files, ctx, keys) if module_of(r) == module
    )


def package_dir(files: Files, ctx: Context, rel: str, language: str) -> str:
    """Каталог пакета (модуля) файла кода: ближайший вверх каталог с манифестом языка."""
    pkgs = codebase.owner_packages(files, ctx, rel, language)
    return pkgs[0].dir if pkgs else ""


# Подстановки «${имя}» и «${имя:дефолт}» (ТЗ §15 п. 17 Е1).
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-\[\]]{0,199}")


@dataclass(frozen=True)
class Placeholder:
    name: str
    default: str | None  # дефолт литералом; None — нет или не литерал
    has_default: bool


def placeholders(value: str) -> list[Placeholder]:
    """Подстановки в значении по порядку, вложенные тоже: «${A:${B:c}}» — A с дефолтом не
    литералом и B с дефолтом c. Проход один, глубина и число ограничены."""
    out: list[Placeholder] = []
    _scan(value, 0, out, 0)
    return out


def _scan(value: str, start: int, out: list[Placeholder], depth: int) -> int:
    """Подстановки value начиная с start; возвращает позицию после разобранного (у вложенного
    уровня — после закрывающей «}»)."""
    i = start
    size = len(value)
    while i < size and len(out) < 200:
        if value.startswith("${", i):
            close = _close(value, i + 2)
            if close < 0 or depth > 20:
                return size
            body = value[i + 2:close]
            name, sep, default = body.partition(":")
            nested = "${" in default
            if nested:
                _scan(default, 0, out, depth + 1)
            if _NAME.fullmatch(name):
                literal = default if sep and not nested else None
                out.insert(len(out), Placeholder(name, literal, bool(sep)))
            i = close + 1
            continue
        if depth and value[i] == "}":
            return i + 1
        i += 1
    return size


def _close(value: str, start: int) -> int:
    """Позиция «}», закрывающей подстановку, тело которой начинается на start (вложенные
    «${…}» и «{…}» учитываются); -1 — не закрыта."""
    depth = 0
    for i in range(start, min(len(value), start + 4000)):
        ch = value[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            if depth == 0:
                return i
            depth -= 1
    return -1
