"""Дозаливка доков от ИИ-агента: разбор пакета archmap-docs + план применения.

Пакет — САМОДОСТАТОЧНЫЕ файлы, файла-описи нет (docs/plan-docs-mmd.md):
схема логики приезжает .mmd-файлом с метаданными в шапке («%% archmap-*»,
разбирает mmd_header), спека — самим файлом OpenAPI. Оба вида превращаются в
PkgEntry — единую внутреннюю запись «этому узлу такие-то документы», — и дальше
работает общий конвейер: build_docs_plan мержит записи против ЖИВОГО дерева
проекта в действия (create | overwrite | skip | unchanged) + отчёт,
apply_docs_plan пишет их в БД. Разделение — ради общего dry-run превью.

Mermaid здесь НЕ валидируется (валидатора на бэке нет — проверяет фронт по
текстам из превью); OpenAPI проверяется советующе (yaml + эвристика
openapi/paths, серверное зеркало docValidate) — warnings, не блокеры.
"""

import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

import yaml
from sqlalchemy.orm import Session

from app.mmd_header import parse_mmd_header
from app.models.node import Node
from app.models.node_doc import NodeDoc

# Схем на объект. Поднято с 50 при переезде на .mmd: там схема — отдельный файл,
# и потолок пакета стал ближе (docs/plan-docs-mmd.md, таблица лимитов).
MAX_LOGIC_PER_NODE = 100
MAX_MERMAID_LEN = 200_000
MAX_SPEC_LEN = 2_000_000

_ORIGINS = ("found", "generated", "synthesized")


@dataclass
class LogicIn:
    name: str
    kind: str
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
    kind: str | None = None
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

    Чем закрываем пропуски в шапке: имя — именем файла, вид — «обзор», адрес —
    объектом окна. Ничего не блокирует импорт: слабая модель шапку забудет, а
    поправить имя и вид пользователь сможет прямо в превью (override).

    Содержимое сохраняем ЦЕЛИКОМ, вместе с шапкой: mermaid её игнорирует, зато
    метаданные не теряются при обратной выгрузке, а повторная заливка того же
    файла остаётся идемпотентной.
    """
    header = parse_mmd_header(content)
    notes = [f"{fname}: {p}" for p in header.problems]
    name = (override.name if override and override.name else None) or header.name or _name_from_file(fname)
    kind = (override.kind if override and override.kind else None) or header.kind or "overview"
    node_ref = (override.node if override and override.node else None) or header.node
    entry = PkgEntry(
        node_ref=node_ref,
        logic=[LogicIn(name=name, kind=kind, operation=header.operation, mermaid=content)],
        openapi=None,
    )
    return ParsedPkg(entries=[entry]), notes


@dataclass
class LogicAction:
    node_id: uuid.UUID
    node_path: str
    # Файл-источник: по нему превью привязывает правку пользователя к файлу
    # (правка едет обратно полем overrides — файла-описи больше нет).
    source: str
    name: str
    kind: str
    operation: str | None
    mermaid: str
    action: str  # create | overwrite | skip | unchanged
    doc_id: uuid.UUID | None  # существующий док (для overwrite)


@dataclass
class SpecAction:
    node_id: uuid.UUID
    node_path: str
    source: str  # имя файла спеки
    origin: str | None
    content: str
    action: str  # create | overwrite | skip | unchanged
    valid_yaml: bool
    looks_openapi: bool
    oas_version: str | None


@dataclass
class DocsPlan:
    logic: list[LogicAction] = field(default_factory=list)
    specs: list[SpecAction] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)


def _node_paths(nodes: list[Node]) -> tuple[list[Node], list[str], dict[str, list[int]], dict[str, list[int]]]:
    """Полные пути живых узлов (родители раньше детей, сиблинги по имени) +
    карты резолва — зеркало ref_name экспорта / resolve импорта."""
    by_id = {n.id: n for n in nodes}
    kids: dict[uuid.UUID | None, list[Node]] = {}
    for n in nodes:
        parent = n.parent_id if n.parent_id in by_id else None
        kids.setdefault(parent, []).append(n)
    for group in kids.values():
        group.sort(key=lambda n: n.name)

    flat: list[Node] = []
    fulls: list[str] = []
    by_bare: dict[str, list[int]] = {}
    by_path: dict[str, list[int]] = {}

    def walk(n: Node, prefix: str) -> None:
        full = f"{prefix} / {n.name}" if prefix else n.name
        idx = len(flat)
        flat.append(n)
        fulls.append(full)
        by_bare.setdefault(n.name, []).append(idx)
        by_path.setdefault(full, []).append(idx)
        for kid in kids.get(n.id, []):
            walk(kid, full)

    for root in kids.get(None, []):
        walk(root, "")
    return flat, fulls, by_bare, by_path


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


def _resolve_entry(
    entry: PkgEntry,
    fname: str,
    resolve: Callable[[str, str], int | None],
    flat: list[Node],
    by_node_id: dict[uuid.UUID, int],
    window_node_id: uuid.UUID | None,
    scope_ids: set[uuid.UUID] | None,
    plan: DocsPlan,
) -> int | None:
    """Какому узлу принадлежит запись. Без адреса — объект окна; с адресом из
    .mmd — он же, но не дальше своего поддерева."""
    if entry.node_ref is None:
        if window_node_id is None or window_node_id not in by_node_id:
            plan.errors.append(f"{fname}: не указан объект, а окно не сказало, к какому применять")
            return None
        return by_node_id[window_node_id]
    idx = resolve(entry.node_ref, fname)
    if idx is None:
        return None
    if scope_ids is not None and flat[idx].id not in scope_ids:
        plan.errors.append(
            f'{fname}: объект «{entry.node_ref}» не относится к тому, для которого открыто окно'
        )
        return None
    return idx


def build_docs_plan(
    nodes: list[Node],
    entries: list[tuple[str, ParsedPkg]],
    assets: dict[str, str],
    overwrite: bool,
    window_node_id: uuid.UUID | None = None,
    scope_ids: set[uuid.UUID] | None = None,
) -> DocsPlan:
    """Мердж записей пакета против живого дерева → действия + отчёт. Чистая функция
    (БД не трогает; nodes несут свои docs через relationship). Идентичность
    дока = (узел, точное имя схемы), спеки = узел; дубль слота внутри ОДНОГО
    файла — ошибка, из РАЗНЫХ файлов — первый побеждает + конфликт.

    window_node_id — объект, из окна которого открыта дозаливка: к нему уезжают
    записи без адреса (файлы .mmd без «%% archmap-node»). scope_ids — его
    поддерево: адрес в шапке дальше него не действует, иначе схема тихо приехала
    бы чужому сервису."""
    plan = DocsPlan()
    flat, fulls, by_bare, by_path = _node_paths(nodes)
    by_node_id = {n.id: i for i, n in enumerate(flat)}

    def resolve(ref: str, where: str) -> int | None:
        hits = by_path.get(ref)
        if not hits:
            hits = by_bare.get(ref)
        if not hits and " / " in ref:
            tail = f" / {ref}"
            hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        if not hits and "/" in ref:
            # Слабые модели пишут путь слэшем без пробелов («microblog/api»,
            # стресс-тест) — нормализуем в канонический разделитель « / » и
            # повторяем точный путь + однозначный хвост. Фолбэк последний:
            # настоящие имена с «/» (редкость) он не задевает — те матчатся выше.
            norm = " / ".join(part.strip() for part in ref.split("/") if part.strip())
            hits = by_path.get(norm)
            if not hits:
                tail = f" / {norm}"
                hits = [i for i, full in enumerate(fulls) if full.endswith(tail)]
        if not hits:
            plan.errors.append(f'{where}: узел "{ref}" не найден в проекте')
            return None
        if len(hits) > 1:
            plan.errors.append(f'{where}: имя "{ref}" неоднозначно, укажите путь через " / "')
            return None
        return hits[0]

    logic_owner: dict[tuple[uuid.UUID, str], str] = {}  # слот → имя файла-первоисточника
    spec_owner: dict[uuid.UUID, str] = {}
    used_assets: set[str] = set()

    for fname, pkg in entries:
        for entry in pkg.entries:
            idx = _resolve_entry(
                entry, fname, resolve, flat, by_node_id, window_node_id, scope_ids, plan
            )
            if idx is None:
                continue
            node, path = flat[idx], fulls[idx]
            existing = {d.name: d for d in node.docs}

            for logic in entry.logic:
                slot = (node.id, logic.name)
                owner = logic_owner.get(slot)
                if owner == fname:
                    plan.errors.append(
                        f'{fname}: дубль схемы "{logic.name}" у узла «{path}» в одном файле'
                    )
                    continue
                if owner is not None:
                    plan.conflicts.append(
                        f'схема "{logic.name}" узла «{path}» уже задана файлом {owner} — '
                        f"вход из {fname} пропущен"
                    )
                    continue
                logic_owner[slot] = fname
                if logic.kind == "operation" and not logic.operation:
                    plan.warnings.append(
                        f'{fname}: схема "{logic.name}" узла «{path}» — kind=operation '
                        f"без поля operation"
                    )
                cur = existing.get(logic.name)
                if cur is None:
                    action, doc_id = "create", None
                elif (
                    cur.content == logic.mermaid
                    and cur.kind == logic.kind
                    and (cur.operation or None) == (logic.operation or None)
                ):
                    action, doc_id = "unchanged", cur.id
                else:
                    action, doc_id = ("overwrite" if overwrite else "skip"), cur.id
                plan.logic.append(
                    LogicAction(
                        node_id=node.id,
                        node_path=path,
                        source=fname,
                        name=logic.name,
                        kind=logic.kind,
                        operation=logic.operation,
                        mermaid=logic.mermaid,
                        action=action,
                        doc_id=doc_id,
                    )
                )

            if entry.openapi is None:
                continue
            owner = spec_owner.get(node.id)
            if owner == fname:
                plan.errors.append(f"{fname}: дубль OpenAPI-спеки у узла «{path}» в одном файле")
                continue
            if owner is not None:
                plan.conflicts.append(
                    f"OpenAPI-спека узла «{path}» уже задана файлом {owner} — "
                    f"вход из {fname} пропущен"
                )
                continue
            spec_owner[node.id] = fname
            content = assets.get(entry.openapi.file)
            if content is None:
                plan.errors.append(
                    f'{fname}: файл спеки "{entry.openapi.file}" не найден среди загруженных'
                )
                continue
            used_assets.add(entry.openapi.file)
            source = entry.openapi.file
            if entry.openapi.origin is None:
                plan.warnings.append(
                    f"{fname}: у спеки узла «{path}» не указано происхождение (origin)"
                )
            valid_yaml, looks, ver = spec_check(content)
            if not valid_yaml:
                plan.warnings.append(f"спека узла «{path}» ({source}) не разбирается как YAML")
            elif not looks:
                plan.warnings.append(
                    f"спека узла «{path}» ({source}) не похожа на OpenAPI: нет openapi/paths"
                )
            cur_spec = node.openapi_spec or ""
            if not cur_spec.strip():
                action = "create"
            elif cur_spec == content:
                action = "unchanged"
            else:
                action = "overwrite" if overwrite else "skip"
            plan.specs.append(
                SpecAction(
                    node_id=node.id,
                    node_path=path,
                    source=source,
                    origin=entry.openapi.origin,
                    content=content,
                    action=action,
                    valid_yaml=valid_yaml,
                    looks_openapi=looks,
                    oas_version=ver,
                )
            )

    for name in sorted(set(assets) - used_assets):
        plan.warnings.append(f'файл "{name}" не пригодился — ни схема, ни спека')
    return plan


def apply_docs_plan(db: Session, plan: DocsPlan) -> tuple[int, int, int]:
    """Записать действия плана: (создано доков, перезаписано доков, спек записано).
    Вызывать только при пустых errors; skip/unchanged не трогаются. Бампы
    graph_rev/touch_project и commit — на вызывающей стороне (как seed_import)."""
    created = updated = specs = 0
    for act in plan.logic:
        if act.action == "create":
            db.add(
                NodeDoc(
                    node_id=act.node_id,
                    name=act.name,
                    kind=act.kind,
                    operation=act.operation,
                    content=act.mermaid,
                )
            )
            created += 1
        elif act.action == "overwrite":
            doc = db.get(NodeDoc, act.doc_id)
            if doc is None:
                continue  # удалён между превью и применением — план пересчитывается, но страхуемся
            doc.name = act.name
            doc.kind = act.kind
            doc.operation = act.operation
            doc.content = act.mermaid
            doc.version += 1
            updated += 1
    for spec in plan.specs:
        if spec.action not in ("create", "overwrite"):
            continue
        node = db.get(Node, spec.node_id)
        if node is None:
            continue
        node.openapi_spec = spec.content
        node.version += 1
        specs += 1
    return created, updated, specs
