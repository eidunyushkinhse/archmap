"""Пакет доков от агента: разбор .mmd со шапкой и файла OpenAPI-спеки во вклады
пакета (схемы логики и спека объекта). Вынесено из app/docs_import.py (аудит Q-19):
разбор не знает ни проекта, ни плана.
"""

import re
from dataclasses import dataclass

import yaml

from app.domain_types import NodeDocKind
from app.mmd_header import fix_unpaired_brackets, parse_mmd_header

_ORIGINS = ("found", "generated", "synthesized")


@dataclass
class LogicIn:
    name: str
    kind: NodeDocKind
    operation: str | None
    mermaid: str


@dataclass
class OpenapiIn:
    # Имя файла спеки среди загруженных. Инлайн-спеки не бывает: спека приезжает
    # файлом (её копирует инструмент агента, а не перепечатывает модель).
    file: str
    origin: str | None  # None — происхождение не указано (warning в плане)


@dataclass
class PkgEntry:
    # None — «объект, из окна которого открыта дозаливка»: так адресуют себя
    # файлы .mmd без строки «%% archmap-node».
    node_ref: str | None
    logic: list[LogicIn]
    openapi: OpenapiIn | None


@dataclass
class ParsedPkg:
    entries: list[PkgEntry]


@dataclass
class MmdOverride:
    """Правка строки превью пользователем: что он исправил руками перед записью."""

    name: str | None = None
    kind: NodeDocKind | None = None
    node: str | None = None


def _name_from_file(fname: str) -> str:
    """Имя схемы из имени файла: «orders-create.mmd» → «orders-create»."""
    stem = fname.rsplit("/", 1)[-1]
    for ext in (".mmd", ".mermaid", ".txt"):
        if stem.lower().endswith(ext):
            return stem[: -len(ext)] or stem
    return stem


_ORIGIN_COMMENT_RE = re.compile(r"^[#/ ]*archmap-origin:[ \t]*(\w+)[ \t]*$", re.MULTILINE)


def pkg_from_spec(fname: str, content: str) -> ParsedPkg:
    """Голый файл спеки → «манифест» из одной записи для объекта окна.

    Окно спеки открыто ДЛЯ узла, спека у него одна — конверт-манифест здесь не
    нёс ничего, кроме происхождения; его агент пишет комментарием в первых
    строках самой спеки («# archmap-origin: generated»)."""
    match = _ORIGIN_COMMENT_RE.search(content[:2000])
    origin = match.group(1) if match and match.group(1) in _ORIGINS else None
    return ParsedPkg(
        entries=[
            PkgEntry(
                node_ref=None,
                logic=[],
                openapi=OpenapiIn(file=fname, origin=origin),
            )
        ]
    )


def pkg_from_mmd(
    fname: str,
    content: str,
    override: MmdOverride | None = None,
) -> tuple[ParsedPkg, list[str]]:
    """Файл .mmd → «манифест» из одной схемы. (манифест, замечания).

    Так весь дальнейший конвейер (резолв узла, конфликты слотов, действия
    create/overwrite/skip) переиспользуется без изменений.

    Чем закрываем пропуски в шапке: имя — именем файла, вид — «операция», адрес —
    объектом окна. Ничего не блокирует импорт: слабая модель шапку забудет, а
    поправить имя и вид пользователь сможет прямо в превью (override).

    Содержимое сохраняем ЦЕЛИКОМ, вместе с шапкой: mermaid её игнорирует, зато
    метаданные не теряются при обратной выгрузке, а повторная заливка того же
    файла остаётся идемпотентной.
    """
    header = parse_mmd_header(content)
    notes = [f"{fname}: {p}" for p in header.problems]
    content, fixed = fix_unpaired_brackets(content)
    if fixed:
        notes.append(f"{fname}: исправлено фигур с непарной скобкой («{{…]» или «[…}}»): {fixed}")
    name = (override.name if override and override.name else None) or header.name or _name_from_file(fname)
    kind = (override.kind if override and override.kind else None) or header.kind or "operation"
    node_ref = (override.node if override and override.node else None) or header.node
    entry = PkgEntry(
        node_ref=node_ref,
        logic=[LogicIn(name=name, kind=kind, operation=header.operation, mermaid=content)],
        openapi=None,
    )
    return ParsedPkg(entries=[entry]), notes


def spec_check(content: str) -> tuple[bool, bool, str | None]:
    """(валидный YAML, похоже на OpenAPI, версия OAS) — серверное зеркало docValidate."""
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError:
        return False, False, None
    if not isinstance(doc, dict):
        return True, False, None
    ver = doc.get("openapi") or doc.get("swagger")
    looks = ver is not None and isinstance(doc.get("paths"), dict)
    return True, looks, str(ver) if looks else None
