"""Версии документации объекта: фиксация, список, чтение, «есть ли изменения» (ТЗ —
docs/tasks/doc-versions.md §3, §6).

Домен без HTTP: роутер (app/routers/versions.py) переводит VersionError в 422 и
коммитит сам, как у прочих мутаций. Объект — узел или None: срез всего проекта
(страница проекта — корень дерева), нумерация у него своя.

Фиксация версии документацию не меняет: курсоры graph_rev / meta_rev не двигаются и
«изменено» проекта (touch_project) не обновляется — иначе соседние страницы ловили бы
ложный рефетч, а дата изменения проекта врала бы.
"""

import uuid
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session

from app import processes
from app.domain_types import VersionKind
from app.models.node import Node
from app.models.node_version import NodeVersion
from app.models.project import Project
from app.models.user import User
from app.schemas.versions import (
    VersionChanged,
    VersionItemDetail,
    VersionPending,
    VersionSnapshot,
    VersionText,
)
from app.versions_diff import diff_item, diff_items, empty_snapshot
from app.versions_snapshot import (
    SNAPSHOT_FORMAT,
    build_snapshot,
    content_hash,
    decode,
    encode,
    stats,
)

EMPTY_COMMENT = "Комментарий версии не может быть пустым"


class VersionError(Exception):
    """Доменный отказ фиксации (роутер → 422 с этим текстом)."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def _root_id(node: Node | None) -> uuid.UUID | None:
    return None if node is None else node.id


def _of_object(project: Project, node: Node | None) -> list[ColumnElement[bool]]:
    """Условие «версии этого объекта»: у среза проекта node_id — NULL."""
    owner = NodeVersion.node_id.is_(None) if node is None else NodeVersion.node_id == node.id
    return [NodeVersion.project_id == project.id, owner]


def live_snapshot(db: Session, project: Project, node: Node | None) -> VersionSnapshot:
    """Снимок текущего состояния документации объекта — «стало» для pending и live."""
    return build_snapshot(db, project.id, _root_id(node))


def snapshot_of(version: NodeVersion) -> VersionSnapshot:
    return decode(version.snapshot, version.snapshot_format)


def list_versions(db: Session, project: Project, node: Node | None) -> list[NodeVersion]:
    """Версии объекта, новые сверху."""
    stmt = select(NodeVersion).where(*_of_object(project, node)).order_by(
        NodeVersion.number.desc()
    )
    return list(db.scalars(stmt))


def get_version(
    db: Session, project: Project, node: Node | None, number: int
) -> NodeVersion | None:
    stmt = select(NodeVersion).where(*_of_object(project, node), NodeVersion.number == number)
    return db.scalars(stmt).first()


def previous_version(
    db: Session, project: Project, node: Node | None, number: int
) -> NodeVersion | None:
    """Ближайшая версия раньше number. Номера после удаления идут с пропусками, поэтому
    «предыдущая» — не number − 1, а наибольший из меньших."""
    stmt = (
        select(NodeVersion)
        .where(*_of_object(project, node), NodeVersion.number < number)
        .order_by(NodeVersion.number.desc())
        .limit(1)
    )
    return db.scalars(stmt).first()


def last_version(db: Session, project: Project, node: Node | None) -> NodeVersion | None:
    stmt = (
        select(NodeVersion)
        .where(*_of_object(project, node))
        .order_by(NodeVersion.number.desc())
        .limit(1)
    )
    return db.scalars(stmt).first()


def _stats(snapshot: VersionSnapshot, base: VersionSnapshot) -> dict[str, Any]:
    """stats строки версии: счётчики снимка и перечень изменённого относительно base
    (форма — schemas.versions.VersionStats)."""
    out: dict[str, Any] = dict(stats(snapshot))
    out["changed"] = [
        VersionChanged(
            item_id=i.item_id, category=i.category, name=i.name, status=i.status
        ).model_dump(mode="json")
        for i in diff_items(base, snapshot)
    ]
    return out


def create_version(
    db: Session,
    project: Project,
    user: User,
    node: Node | None,
    comment: str,
    *,
    kind: VersionKind = "manual",
    restored_from: int | None = None,
) -> NodeVersion:
    """Зафиксировать текущую документацию объекта новой версией (без коммита).

    Номер — max + 1 у объекта под блокировкой строки проекта: две одновременные
    фиксации иначе взяли бы один номер, и вторая упала бы на констрейнте 500-й. SQLite
    тестов FOR UPDATE игнорирует — там уникальность держит констрейнт. Перечень
    изменённого (stats.changed) — относительно предыдущей версии объекта, у первой —
    относительно пустого среза. kind и restored_from — для автоматических версий
    отката (Ф3)."""
    text = comment.strip()
    if not text:
        raise VersionError(EMPTY_COMMENT)
    db.execute(select(Project.id).where(Project.id == project.id).with_for_update())
    top = db.scalar(select(func.max(NodeVersion.number)).where(*_of_object(project, node)))
    number = (top or 0) + 1

    snapshot = live_snapshot(db, project, node)
    prev = last_version(db, project, node)
    base = empty_snapshot(_root_id(node)) if prev is None else snapshot_of(prev)
    row = NodeVersion(
        project_id=project.id,
        node_id=_root_id(node),
        number=number,
        comment=text,
        kind=kind,
        restored_from=restored_from,
        created_by_id=user.id,
        snapshot=encode(snapshot),
        snapshot_format=SNAPSHOT_FORMAT,
        content_hash=content_hash(snapshot),
        stats=_stats(snapshot, base),
    )
    db.add(row)
    db.flush()
    return row


def delete_version(db: Session, version: NodeVersion) -> None:
    """Удалить версию. Номера остальных не пересчитываются: пропуск честнее, чем «v3»,
    вдруг ставшая другой версией в чужих ссылках и комментариях."""
    db.delete(version)
    db.flush()


def pending(db: Session, project: Project, node: Node | None) -> VersionPending:
    """Есть ли незафиксированные изменения с последней версии объекта.

    Быстрый путь — сравнение хэшей без распаковки снимка. Разошлись — перечень по
    дельте; changed берётся по нему: хэш сохранённой версии посчитан проекцией своего
    времени, и если проекция с тех пор уточнилась, хэши разойдутся без единого
    изменения — «есть изменения» с пустым перечнем было бы враньём."""
    last = last_version(db, project, node)
    if last is None:
        return VersionPending(changed=True, items=[])
    live = live_snapshot(db, project, node)
    if content_hash(live) == last.content_hash:
        return VersionPending(changed=False, items=[])
    items = diff_items(snapshot_of(last), live)
    return VersionPending(changed=bool(items), items=items)


def outside_paths(
    db: Session, project: Project, *snapshots: VersionSnapshot
) -> dict[uuid.UUID, str]:
    """Живые пути родителей корня среза — подпись переноса объекта в «Свойствах»: самих
    родителей в срезе нет. Родителя удалили — пути нет, дельта подпишет заглушкой."""
    wanted = {
        n.parent_id
        for snap in snapshots
        for n in snap.nodes
        if n.id == snap.root_id and n.parent_id is not None
    }
    if not wanted:
        return {}
    all_nodes = processes.load_nodes(db, project.id)
    return {nid: processes.node_path(all_nodes, nid) for nid in wanted if nid in all_nodes}


def item_detail(
    db: Session, project: Project, base: VersionSnapshot, target: VersionSnapshot, item_id: str
) -> VersionItemDetail | None:
    """Элемент дельты с тремя представлениями (versions_diff.diff_item) и путями
    объектов вне среза."""
    return diff_item(base, target, item_id, outside_paths=outside_paths(db, project, base, target))


# ── Сравнение и тексты на версии ───────────────────────────────────────────────

# С чем сравнивается версия n: prev — с предыдущей (у первой — с пустым срезом), live
# — n «было», текущее состояние «стало» («что изменилось с версии n»), число m — с
# версией m.
CompareBase = Literal["prev", "live"] | int


@dataclass(frozen=True)
class Comparison:
    """Две стороны дельты. base_version — None: сравнивать не с чем (пустой срез перед
    первой версией); target_version — None: «стало» — текущее состояние."""

    base: VersionSnapshot
    target: VersionSnapshot
    base_version: NodeVersion | None
    target_version: NodeVersion | None


def comparison(
    db: Session, project: Project, node: Node | None, version: NodeVersion, base: CompareBase
) -> Comparison | None:
    """Стороны дельты версии version по выбору base; None — версии base (числом) нет."""
    if base == "live":
        return Comparison(snapshot_of(version), live_snapshot(db, project, node), version, None)
    if base == "prev":
        other = previous_version(db, project, node, version.number)
    else:
        other = get_version(db, project, node, base)
        if other is None:
            return None
    base_snap = empty_snapshot(_root_id(node)) if other is None else snapshot_of(other)
    return Comparison(base_snap, snapshot_of(version), other, version)


def doc_text(snapshot: VersionSnapshot, doc_id: uuid.UUID) -> VersionText | None:
    """Текст схемы логики на версии; None — в срезе версии её нет."""
    doc = next((d for d in snapshot.node_docs if d.id == doc_id), None)
    return None if doc is None else VersionText(name=doc.name, text=doc.content)


def spec_text(snapshot: VersionSnapshot, node_id: uuid.UUID) -> VersionText | None:
    """Спека OpenAPI объекта на версии; None — объекта в срезе нет или спека пуста."""
    node = next((n for n in snapshot.nodes if n.id == node_id), None)
    if node is None or not node.openapi_spec:
        return None
    return VersionText(name=node.name, text=node.openapi_spec)


def process_text(snapshot: VersionSnapshot, process_id: uuid.UUID) -> VersionText | None:
    """Процесс на версии в mermaid (тот же экспорт, что у «Скачать .mmd»)."""
    proc = next((p for p in snapshot.processes if p.id == process_id), None)
    return None if proc is None else VersionText(name=proc.name, text=proc.mermaid)
