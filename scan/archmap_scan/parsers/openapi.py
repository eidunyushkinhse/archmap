"""Файлы OpenAPI (ТЗ §6.1): openapi*.y(a)ml|json и swagger*.y(a)ml|json с ключом openapi или
swagger. Путь и число операций для hints.openapi_files; содержимое не импортируется. Для
маршрутов владельца (ТЗ §15 п. 14 З3) берутся операции (метод, путь как в файле, строка
ключа пути), info.title и адреса servers[].url (у Swagger 2.0 — host и basePath); кому они
достаются, решает assemble.
Пути, заданные ссылками $ref на файлы репозитория, считаются по целевым файлам (один
уровень, с пределом числа файлов); неразворачиваемая ссылка — операции не посчитаны. Файлы в исключённых каталогах
документации (docs/, api-docs/: Files.docs) тоже читаются ради подсказки с причиной
«найден в каталоге документации» (ТЗ §15 п. 13 Д2); каталоги тестов и примеров — нет."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from archmap_scan import paths, texts, yamlload
from archmap_scan.context import Context
from archmap_scan.model import Findings, Loc, OpenApi, unparsed_hint
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
# Сколько операций одного файла идёт в маршруты и адресов servers в разбор владельца.
MAX_OPS = 10_000
_MAX_SERVERS = 50
# Ключ пути в JSON: строка с «"/…":» (номер строки ключа для основания маршрута).
_JSON_PATH_KEY = re.compile(r'^[ \t]*"(/[^"\n]{0,2000})"[ \t]*:', re.MULTILINE)


def _methods(item: dict[object, object]) -> int:
    return sum(1 for key in item if isinstance(key, str) and key.lower() in _METHODS)


def _method_names(item: dict[object, object]) -> list[str]:
    return [key.upper() for key in item if isinstance(key, str) and key.lower() in _METHODS]


def key_lines(text: str) -> dict[str, int]:
    """Строка первого ключа-пути «"/…":» в тексте JSON."""
    out: dict[str, int] = {}
    count, last = 1, 0
    for m in _JSON_PATH_KEY.finditer(text):
        count += text.count("\n", last, m.start())
        last = m.start()
        out.setdefault(m.group(1), count)
    return out


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
        self.present = set(files.paths) | set(files.docs)
        self.loaded: dict[str, object] = {}
        self.texts: dict[str, str] = {}
        self.last = rel  # последний прочитанный по ссылке файл

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
        self.texts[target] = text
        self.last = target
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


@dataclass
class _Counted:
    """Число операций документа (None — не посчитаны, причина в reason) и сами операции."""

    total: int | None
    reason: str | None = None
    ops: list[tuple[str, str, Loc]] = field(default_factory=list)


def _line_of(items: dict[object, object], key: str, lines: dict[str, int] | None) -> int:
    """Строка ключа пути: у YAML — по разбору, у JSON — по тексту файла."""
    if isinstance(items, yamlload.LineDict):
        return items.line_of(key)
    return lines.get(key, 1) if lines is not None else 1


def _counted(files: Files, rel: str, text: str, doc: dict[object, object]) -> _Counted:
    """Число операций документа; пути и элементы путей ссылками $ref — по целевым файлам."""
    items = doc.get("paths")
    if not isinstance(items, dict):
        return _Counted(0)
    refs = _Refs(files, rel, doc)
    source, source_text = rel, text
    out = _Counted(0)
    try:
        if set(items) == {"$ref"}:
            items = refs.resolve(items["$ref"])
            if not isinstance(items, dict):
                raise _Unresolved
            if refs.texts:
                source = refs.last
                source_text = refs.texts[source]
        lines = None if isinstance(items, yamlload.LineDict) else key_lines(source_text)
        total = 0
        for key, item in items.items():
            if isinstance(item, dict) and "$ref" in item:
                item = refs.resolve(item["$ref"])
                if not isinstance(item, dict) or "$ref" in item:
                    raise _Unresolved
            if not isinstance(item, dict):
                continue
            total += _methods(item)
            if isinstance(key, str) and key.startswith("/") and len(out.ops) < MAX_OPS:
                loc = Loc(source, _line_of(items, key, lines))
                out.ops += [(method, key, loc) for method in _method_names(item)]
    except _Unresolved:
        return _Counted(None, texts.REASON_OPENAPI_REFS)
    out.total = total
    del out.ops[MAX_OPS:]
    return out


def _servers(doc: dict[object, object]) -> list[str]:
    """Адреса servers[].url (OpenAPI 3) или host с basePath (Swagger 2.0) как написаны."""
    out: list[str] = []
    servers = doc.get("servers")
    if isinstance(servers, list):
        for server in servers[:_MAX_SERVERS]:
            url = server.get("url") if isinstance(server, dict) else None
            if isinstance(url, str):
                out.append(url)
    host, base = doc.get("host"), doc.get("basePath")
    if isinstance(host, str):
        out.append("//" + host + (base if isinstance(base, str) else ""))
    elif isinstance(base, str):
        out.append(base)
    return out


def _title(doc: dict[object, object]) -> str | None:
    info = doc.get("info")
    title = info.get("title") if isinstance(info, dict) else None
    return title if isinstance(title, str) else None


def parse(files: Files, ctx: Context) -> Findings:
    found = Findings()
    docs = [rel for rel in files.docs if is_candidate(rel)]
    for rel in [*files.select(is_candidate), *docs]:
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
            counted = _counted(files, rel, text, doc)
            found.openapi.append(OpenApi(
                path=rel, operations=counted.total, reason=counted.reason, in_docs=rel in docs,
                ops=counted.ops, title=_title(doc), servers=_servers(doc),
            ))
    return found
