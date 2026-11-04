"""Файлы OpenAPI (ТЗ §6.1): openapi*.y(a)ml|json и swagger*.y(a)ml|json с ключом openapi или
swagger. Только путь и число операций для hints.openapi_files; содержимое не импортируется.
Пути, заданные ссылками $ref на файлы репозитория, считаются по целевым файлам (один
уровень, с пределом числа файлов); неразворачиваемая ссылка — операции не посчитаны."""

from __future__ import annotations

import json
import re

from archmap_scan import paths, texts, yamlload
from archmap_scan.context import Context
from archmap_scan.model import Findings, OpenApi, unparsed_hint
from archmap_scan.walk import Files

NAME = "openapi"

_FILE = re.compile(r"(openapi|swagger)[^/]*\.(ya?ml|json)", re.IGNORECASE)
# Ключ версии в начале строки: дешёвая проверка до разбора YAML.
_VERSION_KEY = re.compile(r"^[\"']?(openapi|swagger)[\"']?\s*:", re.MULTILINE)
_METHODS = frozenset({"get", "put", "post", "delete", "options", "head", "patch", "trace"})


def is_candidate(rel: str) -> bool:
    return _FILE.fullmatch(paths.name(rel)) is not None


# Сколько файлов по ссылкам $ref читается ради одного документа: больше — пути считаются
# заданными ссылками, операции не посчитаны.
MAX_REF_FILES = 500


def _methods(item: dict[object, object]) -> int:
    return sum(1 for key in item if isinstance(key, str) and key.lower() in _METHODS)


def operations(doc: dict[object, object]) -> int:
    items = doc.get("paths")
    if not isinstance(items, dict):
        return 0
    return sum(_methods(item) for item in items.values() if isinstance(item, dict))


class _Unresolved(Exception):
    """Ссылку $ref не удалось развернуть: файл вне обхода, не разбирается, нет фрагмента."""


class _Refs:
    """Разворачивание $ref на файлы репозитория на один уровень, без рекурсии (находка
    фазы 1а на Sentry: api-docs/openapi.json, 0 операций, пути — ссылки на paths/*.json)."""

    def __init__(self, files: Files, rel: str, doc: dict[object, object]) -> None:
        self.files = files
        self.rel = rel
        self.doc = doc
        self.present = set(files.paths)
        self.loaded: dict[str, object] = {}

    def _load(self, target: str) -> object:
        if target in self.loaded:
            return self.loaded[target]
        if len(self.loaded) >= MAX_REF_FILES or target not in self.present:
            raise _Unresolved
        text = self.files.read(target)
        if text is None:
            raise _Unresolved
        try:
            data = json.loads(text) if target.lower().endswith(".json") else yamlload.load(text)
        except (ValueError, RecursionError, yamlload.BadYaml, yamlload.YamlTooLarge) as exc:
            raise _Unresolved from exc
        self.loaded[target] = data
        return data

    def resolve(self, ref: object) -> object:
        """Значение по ссылке «файл», «файл#/a/b» или «#/a/b» (внутри документа)."""
        if not isinstance(ref, str) or "://" in ref:
            raise _Unresolved
        file_part, _, fragment = ref.partition("#")
        if file_part:
            target = paths.join(paths.parent(self.rel), file_part)
            if target is None:
                raise _Unresolved
            value = self._load(target)
        else:
            value = self.doc
        for key in [k for k in fragment.split("/") if k]:
            key = key.replace("~1", "/").replace("~0", "~")
            if not isinstance(value, dict) or key not in value:
                raise _Unresolved
            value = value[key]
        return value


def _counted(files: Files, rel: str, doc: dict[object, object]) -> tuple[int | None, str | None]:
    """Число операций документа; пути и элементы путей ссылками $ref — по целевым файлам."""
    items = doc.get("paths")
    if not isinstance(items, dict):
        return 0, None
    refs = _Refs(files, rel, doc)
    try:
        if set(items) == {"$ref"}:
            items = refs.resolve(items["$ref"])
            if not isinstance(items, dict):
                raise _Unresolved
        total = 0
        for item in items.values():
            if isinstance(item, dict) and "$ref" in item:
                item = refs.resolve(item["$ref"])
                if not isinstance(item, dict) or "$ref" in item:
                    raise _Unresolved
            if isinstance(item, dict):
                total += _methods(item)
    except _Unresolved:
        return None, texts.REASON_OPENAPI_REFS
    return total, None


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    for rel in files.select(is_candidate):
        text = files.read(rel)
        if text is None:
            continue
        is_json = rel.lower().endswith(".json")
        if not is_json and _VERSION_KEY.search(text) is None:
            continue
        try:
            doc = json.loads(text) if is_json else yamlload.load(text)
        except yamlload.YamlTooLarge:
            found.openapi.append(OpenApi(path=rel, operations=None))
            continue
        except (ValueError, RecursionError, yamlload.BadYaml):
            found.hints.append(unparsed_hint(rel, texts.REASON_BAD_OPENAPI))
            continue
        if isinstance(doc, dict) and ("openapi" in doc or "swagger" in doc):
            count, reason = _counted(files, rel, doc)
            found.openapi.append(OpenApi(path=rel, operations=count, reason=reason))
    return found
