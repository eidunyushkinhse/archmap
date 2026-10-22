"""Дельта двух снимков версии документации: семантическая проекция, элементы дельты и
три представления элемента (docs/tasks/doc-versions.md §4).

Одна правда для хэша и для дельты. content_hash (app/versions_snapshot.py) считается
по semantic(), и элементы дельты сравнивают те же самые проекции: каждое поле
проекции принадлежит ровно одному виду элемента, и разница в нём даёт элемент. Поэтому
«есть изменения с vN» (хэши разные) и перечень изменённого не расходятся никогда —
сторож этого в tests/test_versions_diff.py.

Сопоставление — по id (объекты, связи, схемы, таблицы, колонки, каналы, поля,
параметры, процессы, шаги): переименование — изменение, а не удаление с созданием.
Модуль чистый: снимки на входе, схемы ответа на выходе, без БД.
"""

import difflib
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from app.domain_types import (
    NODE_APPROVAL_LABELS,
    NODE_DOC_KIND_LABELS,
    NODE_SHAPE_LABELS,
    NODE_STATUS_LABELS,
    VERSION_CATEGORIES,
    DiffMark,
    VersionCategory,
    VersionItemStatus,
)
from app.schemas.process import FragmentOut, MessageOut, ParticipantOut
from app.schemas.restore import (
    BrokerChannelSnapshot,
    ChannelFieldSnapshot,
    ConfigParamSnapshot,
    DbColumnSnapshot,
    DbTableSnapshot,
    NodeDocSnapshot,
    NodeSnapshot,
)
from app.schemas.versions import (
    CellChange,
    DiffLine,
    ProcessVersion,
    VersionEdge,
    VersionItem,
    VersionItemDetail,
    VersionRow,
    VersionSnapshot,
    VersionView,
)
from app.text import plural, plural_word

# ── Семантическая проекция ─────────────────────────────────────────────────────

# Пути концов связи — для показа: переименование чужого узла, связанного с объектом,
# не правка его документации (связь опознаётся id концов, они в проекции).
_EDGE_DISPLAY = {"source_path", "target_path"}

# Поля шага процесса, которые несут смысл. Остальное в MessageOut — производное для
# показа: technology и edge_synchronous — свойства связи, а не шага (связь вне среза
# правится чужой документацией); doc_name, doc_node_id и doc_node_path — живые имя и
# путь схемы, в том числе чужого узла; invalid_reason раскрывает valid; version —
# счётчик CAS-правок, к версиям документации не относится (ТЗ §11).
_STEP_FIELDS = {
    "id",
    "order",
    "from_participant_id",
    "to_participant_id",
    "leg",
    "kind",
    "edge_id",
    "caption",
    "doc_id",
    "valid",
}


def _semantic_participant(p: ParticipantOut) -> dict[str, Any]:
    """Участник процесса: привязка и порядок. Имя — только у непривязанного: у
    привязанного оно живёт в узле, и переименование узла вне поддерева иначе меняло бы
    хэш листа через общий процесс. Роль, форма, статус — тоже свойства узла."""
    out = p.model_dump(mode="json", include={"id", "node_id", "order"})
    out["name"] = p.name if p.node_id is None else None
    return out


def _semantic_step(m: MessageOut) -> dict[str, Any]:
    return m.model_dump(mode="json", include=_STEP_FIELDS)


def semantic_process(proc: ProcessVersion) -> dict[str, Any]:
    """Проекция процесса: имя, область, участники, шаги и фрагменты без производного
    для показа (scope_name, живые имена узлов, mermaid)."""
    detail = proc.detail
    return {
        "id": str(proc.id),
        "name": proc.name,
        "scope_node_id": None if proc.scope_node_id is None else str(proc.scope_node_id),
        "participants": [_semantic_participant(p) for p in detail.participants],
        "messages": [_semantic_step(m) for m in detail.messages],
        "fragments": [f.model_dump(mode="json") for f in detail.fragments],
    }


def semantic(snapshot: VersionSnapshot) -> dict[str, Any]:
    """Семантическая проекция снимка — то, по чему считается content_hash и что
    сравнивает дельта. Узлы, схемы, таблицы, колонки, каналы, поля и параметры — как
    есть; связи — без путей концов; процессы — semantic_process."""
    data = snapshot.model_dump(
        mode="json", exclude={"edges": {"__all__": _EDGE_DISPLAY}, "processes": True}
    )
    data["processes"] = [semantic_process(p) for p in snapshot.processes]
    return data


def restorable(snapshot: VersionSnapshot) -> dict[str, Any]:
    """Проекция того, что возвращает откат к версии (app/versions_restore), — semantic
    без процессов и без статуса страницы у объектов. Оба в снимок входят, но не
    откатываются (ТЗ §5): процессы общие с другими объектами, статусом страницы
    управляет человек. По этой проекции сторож отката сравнивает итог со снимком
    версии; сравнение пересчётом, а не колонкой content_hash, переживает уточнение
    самой проекции."""
    data = semantic(snapshot)
    del data["processes"]
    for node in data["nodes"]:
        del node["approval"]
    return data


def empty_snapshot(root_id: uuid.UUID | None) -> VersionSnapshot:
    """Пустой срез того же объекта — база первой версии: всё в ней «добавлено»."""
    return VersionSnapshot(
        root_id=root_id,
        nodes=[],
        edges=[],
        node_docs=[],
        db_tables=[],
        db_columns=[],
        broker_channels=[],
        channel_fields=[],
        config_params=[],
        processes=[],
    )


# ── Индекс снимка ──────────────────────────────────────────────────────────────


class _HasId(Protocol):
    @property
    def id(self) -> uuid.UUID: ...


def _group[T](rows: Iterable[T], key: Callable[[T], uuid.UUID]) -> dict[uuid.UUID, list[T]]:
    out: dict[uuid.UUID, list[T]] = {}
    for row in rows:
        out.setdefault(key(row), []).append(row)
    return out


@dataclass(frozen=True)
class _Side:
    """Одна сторона сравнения: снимок, разложенный по id для поиска."""

    root_id: uuid.UUID | None
    nodes: dict[uuid.UUID, NodeSnapshot]
    edges: dict[uuid.UUID, VersionEdge]
    docs: dict[uuid.UUID, NodeDocSnapshot]
    tables: dict[uuid.UUID, DbTableSnapshot]
    columns: dict[uuid.UUID, DbColumnSnapshot]
    columns_of: dict[uuid.UUID, list[DbColumnSnapshot]]
    channels: dict[uuid.UUID, BrokerChannelSnapshot]
    fields_of: dict[uuid.UUID, list[ChannelFieldSnapshot]]
    params_of: dict[uuid.UUID, list[ConfigParamSnapshot]]
    processes: dict[uuid.UUID, ProcessVersion]

    @classmethod
    def of(cls, snap: VersionSnapshot) -> "_Side":
        return cls(
            root_id=snap.root_id,
            nodes={n.id: n for n in snap.nodes},
            edges={e.id: e for e in snap.edges},
            docs={d.id: d for d in snap.node_docs},
            tables={t.id: t for t in snap.db_tables},
            columns={c.id: c for c in snap.db_columns},
            columns_of=_group(snap.db_columns, lambda c: c.table_id),
            channels={c.id: c for c in snap.broker_channels},
            fields_of=_group(snap.channel_fields, lambda f: f.channel_id),
            params_of=_group(snap.config_params, lambda p: p.node_id),
            processes={p.id: p for p in snap.processes},
        )

    def _chain(self, node_id: uuid.UUID, *, with_root: bool) -> str:
        """Имена от верха среза до узла. Обход — с seen: снимок, собранный из
        испорченных данных, мог бы нести цикл родителей."""
        names: list[str] = []
        seen: set[uuid.UUID] = set()
        cur: uuid.UUID | None = node_id
        while cur is not None and cur in self.nodes and cur not in seen:
            if cur == self.root_id and not with_root:
                break
            seen.add(cur)
            node = self.nodes[cur]
            names.append(node.name)
            cur = node.parent_id
        return " / ".join(reversed(names))

    def rel_path(self, node_id: uuid.UUID) -> str:
        """Путь объекта ВНУТРИ среза: без самого корня («Заказы / Сервис заказов»),
        у корня — пустая строка. У среза всего проекта — путь от верхнего уровня."""
        return self._chain(node_id, with_root=False)

    def full_path(self, node_id: uuid.UUID) -> str:
        """Путь объекта с корнем среза — подпись родителя в таблице свойств."""
        return self._chain(node_id, with_root=True)


@dataclass(frozen=True)
class _Pair:
    b: _Side  # «было»
    t: _Side  # «стало»
    # Пути объектов вне среза (родитель корня) — подписи переноса; пусто — нет данных.
    outside: Mapping[uuid.UUID, str]

    def node_path(self, node_id: uuid.UUID) -> str:
        """Путь объекта элемента: по «стало», а у исчезнувшего — по «было»."""
        side = self.t if node_id in self.t.nodes else self.b
        return side.rel_path(node_id)


# ── Общие кирпичи представлений ────────────────────────────────────────────────

_NONE = "—"
# Элемента на этой стороне нет: все четыре формы пусты.
_ABSENT = VersionView(text=None, lines=None, columns=None, rows=None)


def _val(value: object) -> str:
    """Значение ячейки словами: пусто — прочерк, булево — да/нет."""
    if value is None or value == "":
        return _NONE
    if isinstance(value, bool):
        return "да" if value else "нет"
    return str(value)


def _compared(mark: DiffMark, old: list[str], new: list[str]) -> VersionRow:
    """Строка «изменений», сравнённая с другой стороной (связь, член таблицы, канала,
    конфигурации, процесса): отличающаяся ячейка — текстом «было → стало» и по частям
    в changed. Одно место на обе формы — расходиться им негде."""
    cells: list[str] = []
    changed: list[CellChange] = []
    for index, (was, now) in enumerate(zip(old, new, strict=True)):
        if was == now:
            cells.append(was)
        else:
            cells.append(f"{was} → {now}")
            changed.append(CellChange(index=index, was=was, now=now))
    return VersionRow(mark=mark, cells=cells, changed=changed)


def _table(columns: list[str], rows: list[VersionRow]) -> VersionView:
    return VersionView(text=None, lines=None, columns=columns, rows=rows)


def _text(text: str | None) -> VersionView:
    """Полный текст на стороне; None — элемента на ней нет."""
    if text is None:
        return _ABSENT
    return VersionView(text=text, lines=None, columns=None, rows=None)


def _plain(rows: Iterable[list[str]]) -> list[VersionRow]:
    """Строки «было/стало»: метка всегда пустая."""
    return [VersionRow(mark="", cells=cells) for cells in rows]


def _status(before: bool, after: bool) -> VersionItemStatus:
    if not before:
        return "added"
    return "removed" if not after else "changed"


def _one[T](old: T | None, new: T | None) -> T:
    """Сторона, где элемент есть: «стало», иначе «было». Ключи сборщиков —
    объединение сторон, так что хотя бы одна есть всегда."""
    found = new if new is not None else old
    if found is None:
        raise ValueError("Элемента дельты нет ни на одной стороне")
    return found


def _counts(
    added: int, changed: int, removed: int, noun: tuple[str, str, str] | None = None
) -> str:
    """«+1 ~2 −1» без нулевых частей; noun — счётное слово по сумме («+2 ~1 шага»)."""
    parts = [
        f"{sign}{n}" for sign, n in (("+", added), ("~", changed), ("−", removed)) if n
    ]
    if parts and noun is not None:
        parts.append(plural_word(added + changed + removed, *noun))
    return " ".join(parts)


def _summary(parts: Iterable[str], fallback: str) -> str:
    text = ", ".join(p for p in parts if p)
    return text or fallback


@dataclass(frozen=True)
class _Entry:
    """Элемент дельты и ленивая сборка трёх представлений: списку они не нужны."""

    item: VersionItem
    views: Callable[[], tuple[VersionView, VersionView, VersionView]]


def _item(
    item_id: str,
    category: VersionCategory,
    node_path: str,
    name: str,
    status: VersionItemStatus,
    summary: str,
) -> VersionItem:
    return VersionItem(
        item_id=item_id,
        category=category,
        node_path=node_path,
        name=name,
        status=status,
        summary=summary,
    )


# ── Построчная дельта текстов ──────────────────────────────────────────────────


@dataclass(frozen=True)
class _TextDelta:
    lines: list[DiffLine]
    added: int
    removed: int


def _text_delta(old: str, new: str) -> _TextDelta:
    """unified_diff с контекстом 2. Две первые строки вывода — заголовки файлов («---»,
    «+++»), их отбрасываем по позиции: строка текста «-- …» в дельте тоже начинается
    с «---». Заголовок куска «@@» — метка mod."""
    raw = list(difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=2))
    lines: list[DiffLine] = []
    added = removed = 0
    for line in raw[2:]:
        head, body = line[:1], line[1:]
        if line.startswith("@@"):
            lines.append(DiffLine(mark="mod", text=line))
        elif head == "+":
            added += 1
            lines.append(DiffLine(mark="add", text=body))
        elif head == "-":
            removed += 1
            lines.append(DiffLine(mark="del", text=body))
        else:
            lines.append(DiffLine(mark="", text=body))
    return _TextDelta(lines=lines, added=added, removed=removed)


def _line_count(text: str) -> int:
    return len(text.splitlines())


def _text_summary(old: str | None, new: str | None, delta: _TextDelta) -> str:
    """«+3 −2» у изменённого текста, «+N» у нового, «−N» у удалённого (None — текста на
    этой стороне нет); пустой новый или удалённый текст — «пустая»."""
    if old is not None and new is not None:
        return _counts(delta.added, 0, delta.removed)
    lines = _line_count(new if new is not None else old or "")
    if not lines:
        return "пустая"
    return f"+{lines}" if old is None else f"−{lines}"


# ── Свойства объекта и статус страницы ─────────────────────────────────────────

# Поле снимка узла → подпись в элементе «Свойства». openapi_spec и approval — свои
# элементы («OpenAPI», «Статус страницы»).
_PROP_LABELS: dict[str, str] = {
    "name": "имя",
    "description": "описание",
    "role": "роль",
    "technology": "технология",
    "shape": "форма",
    "status": "статус",
    "is_external": "внешний",
    "parent_id": "родитель",
    "source_ref": "источник",
}
_PROPS_BEFORE_AFTER = ["Поле", "Значение"]
_PROPS_CHANGES = ["Поле", "Было", "Стало"]


def _parent_label(
    side: _Side, outside: Mapping[uuid.UUID, str], parent_id: uuid.UUID | None
) -> str:
    if parent_id is None:
        return "верхний уровень"
    if parent_id in side.nodes:
        return side.full_path(parent_id)
    return outside.get(parent_id, "объект вне среза")


def _prop_value(pair: _Pair, side: _Side, node: NodeSnapshot, field: str) -> str:
    if field == "shape":
        return NODE_SHAPE_LABELS[node.shape]
    if field == "status":
        return NODE_STATUS_LABELS[node.status]
    if field == "parent_id":
        return _parent_label(side, pair.outside, node.parent_id)
    return _val(getattr(node, field))


def _prop_rows(pair: _Pair, side: _Side, node: NodeSnapshot | None) -> VersionView:
    if node is None:
        return _ABSENT
    rows = [[label, _prop_value(pair, side, node, f)] for f, label in _PROP_LABELS.items()]
    return _table(_PROPS_BEFORE_AFTER, _plain(rows))


def _prop_changes(
    pair: _Pair, old: NodeSnapshot | None, new: NodeSnapshot | None, fields: list[str]
) -> VersionView:
    rows: list[VersionRow] = []
    for f in fields:
        was = _NONE if old is None else _prop_value(pair, pair.b, old, f)
        now = _NONE if new is None else _prop_value(pair, pair.t, new, f)
        mark: DiffMark = "add" if old is None else "del" if new is None else "mod"
        rows.append(VersionRow(mark=mark, cells=[_PROP_LABELS[f], was, now]))
    return _table(_PROPS_CHANGES, rows)


def _props_summary(old: NodeSnapshot, new: NodeSnapshot, fields: list[str]) -> str:
    parts = [
        f"переименован: {old.name} → {new.name}" if f == "name" else _PROP_LABELS[f]
        for f in fields
    ]
    return ", ".join(parts)


def _props(pair: _Pair) -> list[_Entry]:
    out: list[_Entry] = []
    for nid in sorted(pair.b.nodes.keys() | pair.t.nodes.keys(), key=str):
        old, new = pair.b.nodes.get(nid), pair.t.nodes.get(nid)
        if old is not None and new is not None:
            fields = [f for f in _PROP_LABELS if getattr(old, f) != getattr(new, f)]
            if not fields:
                continue
            summary = _props_summary(old, new, fields)
        else:
            fields = list(_PROP_LABELS)
            summary = "объект"
        node = _one(old, new)

        def views(
            old: NodeSnapshot | None = old,
            new: NodeSnapshot | None = new,
            fields: list[str] = fields,
        ) -> tuple[VersionView, VersionView, VersionView]:
            return (
                _prop_changes(pair, old, new, fields),
                _prop_rows(pair, pair.b, old),
                _prop_rows(pair, pair.t, new),
            )

        status = _status(old is not None, new is not None)
        item = _item(f"props:{nid}", "props", pair.node_path(nid), node.name, status, summary)
        out.append(_Entry(item, views))
    return out


_APPROVAL_LABEL = "статус страницы"


def _approval(pair: _Pair) -> list[_Entry]:
    """Статус страницы — свой элемент, только у объекта, живого на обеих сторонах: у
    нового или удалённого объекта он часть элемента «Свойства · объект»."""
    out: list[_Entry] = []
    for nid in sorted(pair.b.nodes.keys() & pair.t.nodes.keys(), key=str):
        old, new = pair.b.nodes[nid], pair.t.nodes[nid]
        if old.approval == new.approval:
            continue
        was, now = NODE_APPROVAL_LABELS[old.approval], NODE_APPROVAL_LABELS[new.approval]

        def views(was: str = was, now: str = now) -> tuple[VersionView, VersionView, VersionView]:
            return (
                _table(_PROPS_CHANGES, [VersionRow(mark="mod", cells=[_APPROVAL_LABEL, was, now])]),
                _table(_PROPS_BEFORE_AFTER, _plain([[_APPROVAL_LABEL, was]])),
                _table(_PROPS_BEFORE_AFTER, _plain([[_APPROVAL_LABEL, now]])),
            )

        summary = f"{was.lower()} → {now.lower()}"
        path = pair.node_path(nid)
        item = _item(f"approval:{nid}", "approval", path, new.name, "changed", summary)
        out.append(_Entry(item, views))
    return out


# ── Связи ──────────────────────────────────────────────────────────────────────

_EDGE_COLUMNS = ["Связь", "Подпись", "Технология", "Канал"]
_EDGE_FIELDS: dict[str, str] = {
    "label": "подпись",
    "technology": "технология",
    "channel": "канал",
    "is_synchronous": "синхронность",
    "source_id": "концы",
    "target_id": "концы",
}


def _last(path: str) -> str:
    """Последний сегмент пути — короткое имя конца связи."""
    return path.rsplit(" / ", 1)[-1] or _NONE


def _edge_ends(e: VersionEdge) -> str:
    return f"{_last(e.source_path)} → {_last(e.target_path)}"


def _edge_cells(e: VersionEdge) -> list[str]:
    # null синхронности — дефолт: синхронный канал (CLAUDE.md, Edge.is_synchronous).
    mode = "асинхронный" if e.is_synchronous is False else "синхронный"
    channel = f"{mode} · {e.channel}" if e.channel else mode
    return [_edge_ends(e), _val(e.label), _val(e.technology), channel]


def _edge_list(side: _Side) -> VersionView:
    return _table(_EDGE_COLUMNS, _plain(sorted(_edge_cells(e) for e in side.edges.values())))


def _edge_row(old: VersionEdge | None, new: VersionEdge | None) -> VersionRow:
    if old is None:
        return VersionRow(mark="add", cells=_edge_cells(_one(old, new)))
    if new is None:
        return VersionRow(mark="del", cells=_edge_cells(old))
    return _compared("mod", _edge_cells(old), _edge_cells(new))


def _edge_summary(old: VersionEdge, new: VersionEdge) -> str:
    parts: list[str] = []
    for f, label in _EDGE_FIELDS.items():
        if getattr(old, f) == getattr(new, f) or label in parts:
            continue
        parts.append(label)
    if "подпись" in parts:
        parts[parts.index("подпись")] = f"подпись: {_val(old.label)} → {_val(new.label)}"
    return ", ".join(parts)


def _edge_where(pair: _Pair, e: VersionEdge) -> str:
    """Путь связи — по её концу внутри среза (у связи наружу другой конец чужой)."""
    for nid in (e.source_id, e.target_id):
        if nid in pair.t.nodes or nid in pair.b.nodes:
            return pair.node_path(nid)
    return ""


def _edges(pair: _Pair) -> list[_Entry]:
    out: list[_Entry] = []
    for eid in sorted(pair.b.edges.keys() | pair.t.edges.keys(), key=str):
        old, new = pair.b.edges.get(eid), pair.t.edges.get(eid)
        if old is not None and new is not None:
            if old.model_dump(exclude=_EDGE_DISPLAY) == new.model_dump(exclude=_EDGE_DISPLAY):
                continue
            summary = _edge_summary(old, new)
        else:
            summary = ""
        edge = _one(old, new)
        name = f"{_edge_ends(edge)}: {edge.label}" if edge.label else _edge_ends(edge)

        def views(
            old: VersionEdge | None = old, new: VersionEdge | None = new
        ) -> tuple[VersionView, VersionView, VersionView]:
            row = _edge_row(old, new)
            return _table(_EDGE_COLUMNS, [row]), _edge_list(pair.b), _edge_list(pair.t)

        status = _status(old is not None, new is not None)
        item = _item(f"edge:{eid}", "edges", _edge_where(pair, edge), name, status, summary)
        out.append(_Entry(item, views))
    return out


# ── Схемы логики и спека ───────────────────────────────────────────────────────


def _doc_meta(old: NodeDocSnapshot, new: NodeDocSnapshot) -> list[str]:
    """Смена свойств схемы словами — строки summary и строки mod над дельтой текста."""
    parts: list[str] = []
    if old.name != new.name:
        parts.append(f"переименована: {old.name} → {new.name}")
    if old.kind != new.kind:
        was, now = NODE_DOC_KIND_LABELS[old.kind], NODE_DOC_KIND_LABELS[new.kind]
        parts.append(f"вид: {was.lower()} → {now.lower()}")
    if old.operation != new.operation:
        parts.append(f"операция: {_val(old.operation)} → {_val(new.operation)}")
    if old.node_id != new.node_id:
        parts.append("перенесена к другому объекту")
    return parts


def _text_views(
    old: str | None, new: str | None, meta: list[str]
) -> tuple[VersionView, VersionView, VersionView]:
    delta = _text_delta(old or "", new or "")
    lines = [DiffLine(mark="mod", text=m) for m in meta] + delta.lines
    changes = VersionView(text=None, lines=lines, columns=None, rows=None)
    return changes, _text(old), _text(new)


def _docs(pair: _Pair) -> list[_Entry]:
    out: list[_Entry] = []
    for did in sorted(pair.b.docs.keys() | pair.t.docs.keys(), key=str):
        old, new = pair.b.docs.get(did), pair.t.docs.get(did)
        meta: list[str] = []
        if old is not None and new is not None:
            if old == new:
                continue
            meta = _doc_meta(old, new)
        old_text = None if old is None else old.content
        new_text = None if new is None else new.content
        delta = _text_delta(old_text or "", new_text or "")
        content = _text_summary(old_text, new_text, delta) if old_text != new_text else ""
        summary = _summary([*meta, content], "изменена")
        doc = _one(old, new)

        def views(
            old_text: str | None = old_text, new_text: str | None = new_text, meta: list[str] = meta
        ) -> tuple[VersionView, VersionView, VersionView]:
            return _text_views(old_text, new_text, meta)

        status = _status(old is not None, new is not None)
        item = _item(f"doc:{did}", "doc", pair.node_path(doc.node_id), doc.name, status, summary)
        out.append(_Entry(item, views))
    return out


def _spec_of(side: _Side, nid: uuid.UUID) -> str | None:
    node = side.nodes.get(nid)
    return None if node is None else node.openapi_spec


def _specs(pair: _Pair) -> list[_Entry]:
    """Спека OpenAPI — элемент на объект. Пустая спека и её отсутствие для человека
    одно и то же («спеки нет»), но для хэша разные значения — разница всё равно даёт
    элемент, чтобы перечень не разошёлся с хэшем."""
    out: list[_Entry] = []
    for nid in sorted(pair.b.nodes.keys() | pair.t.nodes.keys(), key=str):
        old, new = _spec_of(pair.b, nid), _spec_of(pair.t, nid)
        if old == new:
            continue
        old_text, new_text = old or None, new or None
        delta = _text_delta(old or "", new or "")
        summary = _summary([_text_summary(old_text, new_text, delta)], "изменена")

        def views(
            old_text: str | None = old_text, new_text: str | None = new_text
        ) -> tuple[VersionView, VersionView, VersionView]:
            return _text_views(old_text, new_text, [])

        # None и «» — обе «спеки нет»: такая разница — изменение, а не появление.
        both_empty = old_text is None and new_text is None
        status = "changed" if both_empty else _status(old_text is not None, new_text is not None)
        item = _item(f"spec:{nid}", "spec", pair.node_path(nid), "OpenAPI", status, summary)
        out.append(_Entry(item, views))
    return out


# ── Члены: колонки, поля, параметры, шаги ──────────────────────────────────────


@dataclass(frozen=True)
class _Members:
    """Сравнение упорядоченных членов по id: строки «изменений» и счётчики."""

    rows: list[VersionRow]
    added: int
    changed: int
    removed: int
    moved: int


def _moved_ids(old: Sequence[_HasId], new: Sequence[_HasId]) -> set[uuid.UUID]:
    """Члены, переставленные относительно друг друга. Сдвиг из-за вставки или удаления
    соседа перестановкой не считается: сравниваются только общие члены.

    Два прочтения, берётся то, что помечает меньше: вне наибольшей общей
    подпоследовательности (шаг унесли в конец — помечен он один, а не все, кого он
    обогнал) или со сменой места среди общих (два шага поменялись местами вокруг
    третьего — помечены они, а не третий, чей номер не менялся). При равенстве —
    второе: оно не зависит от того, какую из равных подпоследовательностей выбрал
    difflib."""
    common = {m.id for m in old} & {m.id for m in new}
    a = [m.id for m in old if m.id in common]
    b = [m.id for m in new if m.id in common]
    by_place = {x for x, y in zip(a, b, strict=True) if x != y} | {
        y for x, y in zip(a, b, strict=True) if x != y
    }
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    kept = {a[blk.a + i] for blk in matcher.get_matching_blocks() for i in range(blk.size)}
    off_lcs = common - kept
    return off_lcs if len(off_lcs) < len(by_place) else by_place


def _members[M: _HasId](
    old: Sequence[M],
    new: Sequence[M],
    *,
    key: Callable[[M], Any],
    old_cells: Callable[[M], list[str]],
    new_cells: Callable[[M], list[str]],
    ordered: bool = True,
) -> _Members:
    """old и new — в порядке показа. key — смысл члена без порядка: разница в нём — mod,
    перестановка без смены смысла — move. Удалённые — в конце, в старом порядке."""
    by_old = {m.id: m for m in old}
    new_ids = {m.id for m in new}
    moved = _moved_ids(old, new) if ordered else set()
    rows: list[VersionRow] = []
    added = changed = 0
    for m in new:
        prev = by_old.get(m.id)
        if prev is None:
            added += 1
            rows.append(VersionRow(mark="add", cells=new_cells(m)))
            continue
        mod = key(prev) != key(m)
        if not mod and m.id not in moved:
            continue
        changed += int(mod)
        rows.append(_compared("mod" if mod else "move", old_cells(prev), new_cells(m)))
    gone = [m for m in old if m.id not in new_ids]
    rows.extend(VersionRow(mark="del", cells=old_cells(m)) for m in gone)
    return _Members(rows=rows, added=added, changed=changed, removed=len(gone), moved=len(moved))


@dataclass(frozen=True)
class _Meta:
    """Смена свойств самой таблицы или канала: слова для summary («описание») и
    строки для «изменений» («таблица · описание: A → B»)."""

    words: list[str]
    rows: list[str]


def _meta_changes(prefix: str, old: Any, new: Any, labels: Mapping[str, str]) -> _Meta:
    changed = [(f, label) for f, label in labels.items() if getattr(old, f) != getattr(new, f)]
    return _Meta(
        words=[label for _f, label in changed],
        rows=[
            f"{prefix} · {label}: {_val(getattr(old, f))} → {_val(getattr(new, f))}"
            for f, label in changed
        ],
    )


def _meta_rows(texts: Iterable[str], width: int, mark: DiffMark) -> list[VersionRow]:
    """Свойства самой таблицы или канала — первыми строками той же таблицы: текст в
    первой ячейке, остальные пусты (колонки таблицы — про её колонки или поля)."""
    return [VersionRow(mark=mark, cells=[t, *[""] * (width - 1)]) for t in texts]


def _meta_values(prefix: str, row: Any, labels: Mapping[str, str]) -> list[str]:
    return [
        f"{prefix} · {label}: {_val(getattr(row, f))}"
        for f, label in labels.items()
        if _val(getattr(row, f)) != _NONE
    ]


def _members_summary(m: _Members, noun_moved: str) -> list[str]:
    return [_counts(m.added, m.changed, m.removed), noun_moved if m.moved else ""]


# ── Структура БД ───────────────────────────────────────────────────────────────

_COLUMN_COLUMNS = ["Колонка", "Тип", "NULL", "PK", "FK", "Описание"]
# Свойства таблицы, кроме имени (оно — в имени элемента и в «переименована»). В
# «было/стало» объект не показываем: это всегда объект-БД самого элемента.
_TABLE_META: dict[str, str] = {"description": "описание", "node_id": "объект"}
_TABLE_META_SHOW: dict[str, str] = {"description": "описание"}


def _table_label(t: DbTableSnapshot) -> str:
    return f"{t.schema_name}.{t.name}" if t.schema_name else t.name


def _fk_label(side: _Side, column_id: uuid.UUID | None) -> str:
    if column_id is None:
        return _NONE
    target = side.columns.get(column_id)
    if target is None:
        return "колонка вне среза"
    table = side.tables.get(target.table_id)
    return f"{_table_label(table)}.{target.name}" if table is not None else target.name


def _column_order(side: _Side, table_id: uuid.UUID) -> list[DbColumnSnapshot]:
    return sorted(side.columns_of.get(table_id, []), key=lambda c: (c.order, c.name, str(c.id)))


def _column_cells(side: _Side) -> Callable[[DbColumnSnapshot], list[str]]:
    def cells(c: DbColumnSnapshot) -> list[str]:
        return [
            c.name,
            _val(c.type),
            _val(c.nullable),
            _val(c.is_primary_key),
            _fk_label(side, c.references_column_id),
            _val(c.description),
        ]

    return cells


def _column_key(c: DbColumnSnapshot) -> dict[str, Any]:
    return c.model_dump(exclude={"order"})


def _table_full(side: _Side, t: DbTableSnapshot | None) -> VersionView:
    if t is None:
        return _ABSENT
    cells = _column_cells(side)
    rows = _meta_rows(_meta_values("таблица", t, _TABLE_META_SHOW), len(_COLUMN_COLUMNS), "")
    rows += _plain(cells(c) for c in _column_order(side, t.id))
    return _table(_COLUMN_COLUMNS, rows)


def _tables(pair: _Pair) -> list[_Entry]:
    out: list[_Entry] = []
    for tid in sorted(pair.b.tables.keys() | pair.t.tables.keys(), key=str):
        old, new = pair.b.tables.get(tid), pair.t.tables.get(tid)
        old_cols, new_cols = _column_order(pair.b, tid), _column_order(pair.t, tid)
        if old == new and old_cols == new_cols:
            continue
        members = _members(
            old_cols,
            new_cols,
            key=_column_key,
            old_cells=_column_cells(pair.b),
            new_cells=_column_cells(pair.t),
        )
        meta = _Meta(words=[], rows=[])
        if old is not None and new is not None:
            meta = _meta_changes("таблица", old, new, _TABLE_META)
            if _table_label(old) != _table_label(new):
                renamed = f"переименована: {_table_label(old)} → {_table_label(new)}"
                meta.words.insert(0, renamed)
                meta.rows.insert(0, renamed)
        table = _one(old, new)
        if old is None or new is None:
            noun = ("колонка", "колонки", "колонок")
            summary = plural(len(new_cols or old_cols), *noun)
        else:
            moved = _members_summary(members, "порядок колонок")
            summary = _summary([*meta.words, *moved], "изменена")

        def views(
            old: DbTableSnapshot | None = old,
            new: DbTableSnapshot | None = new,
            meta: _Meta = meta,
            members: _Members = members,
        ) -> tuple[VersionView, VersionView, VersionView]:
            rows = _meta_rows(meta.rows, len(_COLUMN_COLUMNS), "mod") + members.rows
            return (
                _table(_COLUMN_COLUMNS, rows),
                _table_full(pair.b, old),
                _table_full(pair.t, new),
            )

        status = _status(old is not None, new is not None)
        path = pair.node_path(table.node_id)
        item = _item(f"table:{tid}", "db", path, _table_label(table), status, summary)
        out.append(_Entry(item, views))
    return out


# ── Каналы брокера ─────────────────────────────────────────────────────────────

_FIELD_COLUMNS = ["Поле", "Тип", "Обязательное", "Описание"]
_CHANNEL_META: dict[str, str] = {
    "group_name": "группа",
    "kind": "вид",
    "partition_key": "ключ",
    "delivery": "доставка",
    "retention": "хранение",
    "description": "описание",
    "node_id": "объект",
}
_CHANNEL_META_SHOW = {k: v for k, v in _CHANNEL_META.items() if k != "node_id"}


def _field_order(side: _Side, channel_id: uuid.UUID) -> list[ChannelFieldSnapshot]:
    return sorted(side.fields_of.get(channel_id, []), key=lambda f: (f.order, f.name, str(f.id)))


def _field_cells(f: ChannelFieldSnapshot) -> list[str]:
    return [f.name, _val(f.type), _val(f.required), _val(f.description)]


def _field_key(f: ChannelFieldSnapshot) -> dict[str, Any]:
    return f.model_dump(exclude={"order"})


def _channel_full(side: _Side, c: BrokerChannelSnapshot | None) -> VersionView:
    if c is None:
        return _ABSENT
    rows = _meta_rows(_meta_values("канал", c, _CHANNEL_META_SHOW), len(_FIELD_COLUMNS), "")
    rows += _plain(_field_cells(f) for f in _field_order(side, c.id))
    return _table(_FIELD_COLUMNS, rows)


def _channels(pair: _Pair) -> list[_Entry]:
    out: list[_Entry] = []
    for cid in sorted(pair.b.channels.keys() | pair.t.channels.keys(), key=str):
        old, new = pair.b.channels.get(cid), pair.t.channels.get(cid)
        old_fields, new_fields = _field_order(pair.b, cid), _field_order(pair.t, cid)
        if old == new and old_fields == new_fields:
            continue
        members = _members(
            old_fields, new_fields, key=_field_key, old_cells=_field_cells, new_cells=_field_cells
        )
        meta = _Meta(words=[], rows=[])
        if old is not None and new is not None:
            meta = _meta_changes("канал", old, new, _CHANNEL_META)
            if old.name != new.name:
                renamed = f"переименован: {old.name} → {new.name}"
                meta.words.insert(0, renamed)
                meta.rows.insert(0, renamed)
        channel = _one(old, new)
        if old is None or new is None:
            summary = plural(len(new_fields or old_fields), "поле", "поля", "полей")
        else:
            moved = _members_summary(members, "порядок полей")
            summary = _summary([*meta.words, *moved], "изменён")

        def views(
            old: BrokerChannelSnapshot | None = old,
            new: BrokerChannelSnapshot | None = new,
            meta: _Meta = meta,
            members: _Members = members,
        ) -> tuple[VersionView, VersionView, VersionView]:
            rows = _meta_rows(meta.rows, len(_FIELD_COLUMNS), "mod") + members.rows
            return (
                _table(_FIELD_COLUMNS, rows),
                _channel_full(pair.b, old),
                _channel_full(pair.t, new),
            )

        status = _status(old is not None, new is not None)
        path = pair.node_path(channel.node_id)
        item = _item(f"channel:{cid}", "channels", path, channel.name, status, summary)
        out.append(_Entry(item, views))
    return out


# ── Конфигурация ───────────────────────────────────────────────────────────────

_PARAM_COLUMNS = ["Параметр", "Тип", "Обязателен", "Дефолт", "Описание"]
_PARAM_NOUN = ("параметр", "параметра", "параметров")


def _param_order(side: _Side, node_id: uuid.UUID) -> list[ConfigParamSnapshot]:
    return sorted(side.params_of.get(node_id, []), key=lambda p: (p.name, str(p.id)))


def _param_cells(p: ConfigParamSnapshot) -> list[str]:
    return [
        p.name,
        _val(p.value_type),
        _val(p.required),
        _val(p.default_value),
        _val(p.description),
    ]


def _param_full(params: list[ConfigParamSnapshot]) -> VersionView:
    if not params:
        return _ABSENT
    return _table(_PARAM_COLUMNS, _plain(_param_cells(p) for p in params))


def _configs(pair: _Pair) -> list[_Entry]:
    """Конфигурация — один элемент на объект: параметры читаются списком, по одному
    элементу на параметр экран версии зарос бы строками."""
    out: list[_Entry] = []
    for nid in sorted(pair.b.params_of.keys() | pair.t.params_of.keys(), key=str):
        old, new = _param_order(pair.b, nid), _param_order(pair.t, nid)
        if old == new:
            continue
        members = _members(
            old,
            new,
            key=lambda p: p,
            old_cells=_param_cells,
            new_cells=_param_cells,
            ordered=False,
        )
        summary = _summary([_counts(members.added, members.changed, members.removed)], "изменена")

        def views(
            old: list[ConfigParamSnapshot] = old,
            new: list[ConfigParamSnapshot] = new,
            members: _Members = members,
        ) -> tuple[VersionView, VersionView, VersionView]:
            return _table(_PARAM_COLUMNS, members.rows), _param_full(old), _param_full(new)

        status = _status(bool(old), bool(new))
        name = plural(len(new or old), *_PARAM_NOUN)
        item = _item(f"config:{nid}", "config", pair.node_path(nid), name, status, summary)
        out.append(_Entry(item, views))
    return out


# ── Процессы ───────────────────────────────────────────────────────────────────

_STEP_COLUMNS = ["№", "Кто → кому", "Подпись"]
_STEP_NOUN = ("шаг", "шага", "шагов")
_KIND_NOTE = {"return": "ответ", "async": "событие", "self": "внутренний шаг"}
_BROKEN_NOTE = {"edge_deleted": "связь удалена", "leg_gone": "плеча канала нет"}


def _step_cells(proc: ProcessVersion) -> Callable[[MessageOut], list[str]]:
    """Ячейки шага на своей стороне: имена участников — из detail этой же версии."""
    names = {p.id: p.name for p in proc.detail.participants}

    def cells(m: MessageOut) -> list[str]:
        who = f"{names.get(m.from_participant_id, '?')} → {names.get(m.to_participant_id, '?')}"
        notes = [m.caption or _NONE, _KIND_NOTE.get(m.kind, "")]
        if m.doc_id is not None:
            notes.append(f"схема «{m.doc_name}»" if m.doc_name else "схема")
        if m.invalid_reason is not None:
            notes.append(_BROKEN_NOTE[m.invalid_reason])
        return [str(m.order + 1), who, " · ".join(n for n in notes if n)]

    return cells


def _step_key(m: MessageOut) -> dict[str, Any]:
    key = _semantic_step(m)
    del key["order"]
    return key


# Участники и фрагменты в «изменениях» — строками той же таблицы шагов: что это за
# строка, говорит первая ячейка (у шага в ней номер).
def _participant_cells(p: ParticipantOut) -> list[str]:
    return ["участник", p.name, "не привязан" if p.node_id is None else ""]


def _fragment_cells(f: FragmentOut) -> list[str]:
    span = f"шаги {f.from_order + 1}–{f.to_order + 1}"
    guards = [g for g in [f.guard, *(b.guard for b in f.branches)] if g]
    return ["фрагмент", f.kind, " · ".join([span, *guards])]


def _proc_members(old: ProcessVersion | None, new: ProcessVersion | None) -> list[_Members]:
    """Шаги, участники и фрагменты процесса — три сравнения по id."""
    # У отсутствующей стороны шагов нет, и её ячейки не понадобятся: берём сторону,
    # которая есть, чтобы не заводить пустышку.
    steps = _members(
        [] if old is None else old.detail.messages,
        [] if new is None else new.detail.messages,
        key=_step_key,
        old_cells=_step_cells(old if old is not None else _one(old, new)),
        new_cells=_step_cells(new if new is not None else _one(new, old)),
    )
    parts = _members(
        [] if old is None else old.detail.participants,
        [] if new is None else new.detail.participants,
        key=_semantic_participant,
        old_cells=_participant_cells,
        new_cells=_participant_cells,
    )
    frags = _members(
        [] if old is None else old.detail.fragments,
        [] if new is None else new.detail.fragments,
        key=lambda f: f,
        old_cells=_fragment_cells,
        new_cells=_fragment_cells,
        ordered=False,
    )
    return [steps, parts, frags]


def _proc_full(proc: ProcessVersion | None) -> VersionView:
    if proc is None:
        return _ABSENT
    cells = _step_cells(proc)
    return _table(_STEP_COLUMNS, _plain(cells(m) for m in proc.detail.messages))


def _proc_summary(old: ProcessVersion, new: ProcessVersion, members: list[_Members]) -> str:
    steps, parts, frags = members
    return _summary(
        [
            f"переименован: {old.name} → {new.name}" if old.name != new.name else "",
            "область" if old.scope_node_id != new.scope_node_id else "",
            _counts(steps.added, steps.changed, steps.removed, _STEP_NOUN),
            "порядок шагов" if steps.moved else "",
            "участники" if parts.rows else "",
            "фрагменты" if frags.rows else "",
        ],
        "изменён",
    )


def _same_process(old: ProcessVersion | None, new: ProcessVersion | None) -> bool:
    if old is None or new is None:
        return False
    return semantic_process(old) == semantic_process(new)


def _processes(pair: _Pair) -> list[_Entry]:
    """Процесс — элемент целиком; «изменился ли» решает только semantic_process, чтобы
    не разойтись с хэшем (живые имена чужих узлов в detail — не изменение)."""
    out: list[_Entry] = []
    for pid in sorted(pair.b.processes.keys() | pair.t.processes.keys(), key=str):
        old, new = pair.b.processes.get(pid), pair.t.processes.get(pid)
        if _same_process(old, new):
            continue
        members = _proc_members(old, new)
        proc = _one(old, new)
        if old is None or new is None:
            summary = plural(len(proc.detail.messages), *_STEP_NOUN)
        else:
            summary = _proc_summary(old, new, members)

        def views(
            old: ProcessVersion | None = old,
            new: ProcessVersion | None = new,
            members: list[_Members] = members,
        ) -> tuple[VersionView, VersionView, VersionView]:
            rows = [r for m in members for r in m.rows]
            return _table(_STEP_COLUMNS, rows), _proc_full(old), _proc_full(new)

        status = _status(old is not None, new is not None)
        item = _item(f"process:{pid}", "process", "", proc.name, status, summary)
        out.append(_Entry(item, views))
    return out


# ── Вход ───────────────────────────────────────────────────────────────────────

# Префикс item_id → сборщик элементов его категории: элемент по адресу считается без
# остальных категорий.
_BUILDERS: dict[str, Callable[[_Pair], list[_Entry]]] = {
    "props": _props,
    "edge": _edges,
    "doc": _docs,
    "spec": _specs,
    "table": _tables,
    "channel": _channels,
    "config": _configs,
    "approval": _approval,
    "process": _processes,
}


def _order(item: VersionItem) -> tuple[int, str, str, str]:
    return (VERSION_CATEGORIES.index(item.category), item.node_path, item.name, item.item_id)


def diff_items(base: VersionSnapshot, target: VersionSnapshot) -> list[VersionItem]:
    """Элементы дельты от base к target: по категории в порядке VersionCategory, внутри
    — по пути объекта и имени (id — последним ключом: порядок детерминирован)."""
    pair = _Pair(_Side.of(base), _Side.of(target), {})
    items = [e.item for build in _BUILDERS.values() for e in build(pair)]
    return sorted(items, key=_order)


def diff_item(
    base: VersionSnapshot,
    target: VersionSnapshot,
    item_id: str,
    *,
    outside_paths: Mapping[uuid.UUID, str] | None = None,
) -> VersionItemDetail | None:
    """Один элемент с тремя представлениями; None — такого элемента в дельте нет.
    outside_paths — пути объектов вне среза (родитель корня) для подписи переноса."""
    prefix, sep, _rest = item_id.partition(":")
    build = _BUILDERS.get(prefix)
    if not sep or build is None:
        return None
    pair = _Pair(_Side.of(base), _Side.of(target), outside_paths or {})
    for entry in build(pair):
        if entry.item.item_id == item_id:
            changes, before, after = entry.views()
            return VersionItemDetail(item=entry.item, changes=changes, before=before, after=after)
    return None
