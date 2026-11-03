"""Файлы OpenAPI (ТЗ §6.1): openapi*.y(a)ml|json и swagger*.y(a)ml|json с ключом openapi или
swagger. Только путь и число операций для hints.openapi_files; содержимое не импортируется."""

from __future__ import annotations

import json
import re

from archmap_scan import paths, texts, yamlload
from archmap_scan.context import Context
from archmap_scan.model import Findings, Hint, OpenApi
from archmap_scan.walk import Files

NAME = "openapi"

_FILE = re.compile(r"(openapi|swagger)[^/]*\.(ya?ml|json)", re.IGNORECASE)
# Ключ версии в начале строки: дешёвая проверка до разбора YAML.
_VERSION_KEY = re.compile(r"^[\"']?(openapi|swagger)[\"']?\s*:", re.MULTILINE)
_METHODS = frozenset({"get", "put", "post", "delete", "options", "head", "patch", "trace"})


def is_candidate(rel: str) -> bool:
    return _FILE.fullmatch(paths.name(rel)) is not None


def operations(doc: dict[object, object]) -> int:
    items = doc.get("paths")
    if not isinstance(items, dict):
        return 0
    return sum(
        sum(1 for key in item if isinstance(key, str) and key.lower() in _METHODS)
        for item in items.values() if isinstance(item, dict)
    )


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
            found.hints.append(Hint("unparsed", {"path": rel, "reason": texts.REASON_BAD_OPENAPI}))
            continue
        if isinstance(doc, dict) and ("openapi" in doc or "swagger" in doc):
            found.openapi.append(OpenApi(path=rel, operations=operations(doc)))
    return found
