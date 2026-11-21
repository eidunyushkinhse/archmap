"""Удаление пачкой с версией перед ним (решение владельца 2026-11-21, вариант «версия
перед удалением»).

Агент и скрипты удаляют только здесь: личным токеном метод DELETE закрыт целиком. Перед
удалением ArchMap сохраняет автоматическую версию «Перед удалением агентом: …» у
ближайшего общего родителя пачки (или у всего проекта), и человек возвращает удалённое
откатом к ней в интерфейсе: откат воссоздаёт исчезнувшие объекты, связи и документацию
с исходными id (app/versions_restore.py). Если с последней версии этого среза ничего не
менялось, новую не сохраняют: удалённое уже лежит в последней, как у «Перед откатом».

Почему срез именно у общего родителя: версия объекта несёт его поддерево и все связи с
концом в нём, поэтому версия родителя удаляемого объекта содержит его целиком, а версия
самого объекта ушла бы вместе с ним (история объекта удаляется каскадом). Чем ниже срез,
тем меньше откат заденет соседних правок.

Чего откат не вернёт, ответ говорит прямо: привязки процессов к удалённому (участник,
область процесса, шаг на связи и шаг со схемой логики) остаются пустыми, процессы откат
не трогает. Удалённый процесс откатом не возвращается тоже: версия всего проекта,
сохранённая перед удалением, хранит его текст, и процесс ввозят заново из него.

Домен без HTTP и без коммита: роутер переводит DeletionError и коммитит с курсорами.
"""

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from app import processes, tree, versions
from app.domain_types import DeletionKind
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.db_table import DbTable
from app.models.deployment_instance import DeploymentInstance
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.schemas.deletions import (
    DeletionItem,
    DeletionOut,
    DeletionTarget,
    DeletionTotals,
    DeletionVersion,
)
from app.transition import cleanup_layout

NOT_FOUND = {
    "node": "Объекта {id} в проекте нет",
    "edge": "Связи {id} в проекте нет",
    "doc": "Схемы логики {id} в проекте нет",
    "process": "Процесса {id} в проекте нет",
}
PRE_DELETE = "Перед удалением агентом: {what}"
# Сколько имён перечислять в комментарии версии, остальное — числом.
NAMES_IN_COMMENT = 3
# Колонка комментария версии — String(512).
COMMENT_MAX = 512


class DeletionError(Exception):
    """Пункт пачки не найден в проекте (роутер → 404 с этим текстом)."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass
class _Target:
    kind: DeletionKind
    row: Node | Edge | NodeDoc | BusinessProcess
    label: str
    # Имя для комментария версии — короче пути.
    short: str
    # Узлы, от которых считается общий родитель: у объекта — его родитель (None —
    # верхний уровень), у связи — оба конца, у схемы — её объект, у процесса — None
    # (процессы лежат в версии всего проекта).
    anchors: list[uuid.UUID | None]
    covered_by: uuid.UUID | None = None


@dataclass
class Plan:
    """Что уйдёт и к какой версии откатывать. Строится без записи — для dry_run и
    для самого удаления одинаково."""

    targets: list[_Target]
    all_nodes: dict[uuid.UUID, Node]
    slice_id: uuid.UUID | None
    totals: DeletionTotals

    @property
    def live(self) -> list[_Target]:
        return [t for t in self.targets if t.covered_by is None]


def _resolve(
    db: Session, project: Project, all_nodes: dict[uuid.UUID, Node], item: DeletionItem
) -> _Target:
    """Строка пункта, если она принадлежит проекту; иначе DeletionError."""

    def path(node_id: uuid.UUID) -> str:
        return processes.node_path(all_nodes, node_id)

    if item.kind == "node":
        node = all_nodes.get(item.id)
        if node is not None:
            return _Target("node", node, path(node.id), node.name, [node.parent_id])
    elif item.kind == "edge":
        edge = db.get(Edge, item.id)
        if edge is not None and edge.project_id == project.id:
            src, tgt = all_nodes[edge.source_id], all_nodes[edge.target_id]
            return _Target(
                "edge",
                edge,
                f"{path(src.id)} → {path(tgt.id)}",
                f"{src.name} → {tgt.name}",
                [edge.source_id, edge.target_id],
            )
    elif item.kind == "doc":
        doc = db.get(NodeDoc, item.id)
        if doc is not None and doc.node_id in all_nodes:
            return _Target(
                "doc", doc, f"«{doc.name}» у {path(doc.node_id)}", doc.name, [doc.node_id]
            )
    else:
        proc = db.get(BusinessProcess, item.id)
        if proc is not None and proc.project_id == project.id:
            return _Target("process", proc, f"«{proc.name}»", proc.name, [None])
    raise DeletionError(NOT_FOUND[item.kind].format(id=item.id))


def _unique(items: Iterable[DeletionItem]) -> list[DeletionItem]:
    seen: set[tuple[str, uuid.UUID]] = set()
    out: list[DeletionItem] = []
    for item in items:
        if (item.kind, item.id) not in seen:
            seen.add((item.kind, item.id))
            out.append(item)
    return out


def _owners(target: _Target) -> list[uuid.UUID]:
    """Узлы, вместе с которыми пункт уходит каскадом: сам объект, концы связи, объект
    схемы. Процесс удаление объекта переживает (участник остаётся без объекта)."""
    if isinstance(target.row, Node):
        return [target.row.id]
    if isinstance(target.row, Edge):
        return [target.row.source_id, target.row.target_id]
    if isinstance(target.row, NodeDoc):
        return [target.row.node_id]
    return []


def _mark_covered(
    targets: list[_Target], all_nodes: dict[uuid.UUID, Node]
) -> set[uuid.UUID]:
    """Отметить пункты, которые уходят вместе с объектом той же пачки, и вернуть все
    узлы, которые исчезнут. Удалять их отдельно нельзя: каскад уже снёс бы строку."""
    # Крупные поддеревья первыми: поддерево предка включает поддерево потомка, и пункт
    # ссылается на самый верхний объект пачки, который удаляется на деле.
    subtrees = dict(
        sorted(
            (
                (t.row.id, tree.subtree_ids(all_nodes, t.row.id))
                for t in targets
                if isinstance(t.row, Node)
            ),
            key=lambda pair: -len(pair[1]),
        )
    )
    for target in targets:
        own = target.row.id if isinstance(target.row, Node) else None
        for root, subtree in subtrees.items():
            if root != own and any(o in subtree for o in _owners(target)):
                target.covered_by = root
                break
    return set().union(*subtrees.values())


def _chain(all_nodes: dict[uuid.UUID, Node], node_id: uuid.UUID) -> list[uuid.UUID]:
    """Цепочка от корня до узла включительно; seen — от циклов в данных."""
    chain: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    cur: uuid.UUID | None = node_id
    while cur is not None and cur not in seen and cur in all_nodes:
        seen.add(cur)
        chain.append(cur)
        cur = all_nodes[cur].parent_id
    chain.reverse()
    return chain


def common_ancestor(
    all_nodes: dict[uuid.UUID, Node], anchors: Sequence[uuid.UUID | None]
) -> uuid.UUID | None:
    """Ближайший общий предок (или сам узел) всех якорей пачки; None — корень проекта."""
    if not anchors or any(a is None for a in anchors):
        return None
    chains = [_chain(all_nodes, a) for a in anchors if a is not None]
    prefix: uuid.UUID | None = None
    for step in zip(*chains, strict=False):
        if any(s != step[0] for s in step):
            break
        prefix = step[0]
    return prefix


def _count(db: Session, stmt: Select[tuple[int]]) -> int:
    return db.scalar(stmt) or 0


def _totals(
    db: Session, project: Project, live: list[_Target], gone_nodes: set[uuid.UUID]
) -> DeletionTotals:
    """Сколько исчезнет: поддеревья объектов пачки плюс её связи и схемы."""
    edge_ids = {t.row.id for t in live if t.kind == "edge"}
    doc_ids = {t.row.id for t in live if t.kind == "doc"}
    if gone_nodes:
        edge_ids |= set(
            db.scalars(
                select(Edge.id).where(
                    Edge.project_id == project.id,
                    or_(Edge.source_id.in_(gone_nodes), Edge.target_id.in_(gone_nodes)),
                )
            )
        )
        doc_ids |= set(db.scalars(select(NodeDoc.id).where(NodeDoc.node_id.in_(gone_nodes))))
    facts = instances = 0
    if gone_nodes:
        facts = sum(
            _count(db, select(func.count()).where(column.in_(gone_nodes)))
            for column in (DbTable.node_id, BrokerChannel.node_id, ConfigParam.node_id)
        )
        instances = _count(
            db, select(func.count()).where(DeploymentInstance.node_id.in_(gone_nodes))
        )
    return DeletionTotals(
        processes=sum(1 for t in live if t.kind == "process"),
        nodes=len(gone_nodes),
        edges=len(edge_ids),
        docs=len(doc_ids),
        facts=facts,
        instances=instances,
        process_links=_process_links(db, gone_nodes, edge_ids, doc_ids),
    )


def _process_links(
    db: Session, nodes: set[uuid.UUID], edges: set[uuid.UUID], docs: set[uuid.UUID]
) -> int:
    """Привязки процессов, которые удаление обнулит (все — ON DELETE SET NULL)."""
    return sum(
        _count(db, select(func.count()).where(column.in_(ids)))
        for column, ids in (
            (ProcessParticipant.node_id, nodes),
            (BusinessProcess.scope_node_id, nodes),
            (ProcessMessage.edge_id, edges),
            (ProcessMessage.doc_id, docs),
        )
        if ids
    )


def plan(db: Session, project: Project, items: Iterable[DeletionItem]) -> Plan:
    """Разобрать пачку: найти строки, отметить уходящие вместе с объектом, найти срез
    версии и посчитать, что исчезнет. Ничего не пишет."""
    all_nodes = processes.load_nodes(db, project.id)
    targets = [_resolve(db, project, all_nodes, item) for item in _unique(items)]
    gone = _mark_covered(targets, all_nodes)
    live = [t for t in targets if t.covered_by is None]
    anchors = [a for t in live for a in t.anchors]
    return Plan(
        targets=targets,
        all_nodes=all_nodes,
        slice_id=common_ancestor(all_nodes, anchors),
        totals=_totals(db, project, live, gone),
    )


def _comment(live: list[_Target], reason: str | None) -> str:
    names = ", ".join(f"«{t.short}»" for t in live[:NAMES_IN_COMMENT])
    rest = len(live) - NAMES_IN_COMMENT
    what = names + (f" и ещё {rest}" if rest > 0 else "")
    text = PRE_DELETE.format(what=what)
    if reason and reason.strip():
        text += f". Причина: {reason.strip()}"
    return text if len(text) <= COMMENT_MAX else text[: COMMENT_MAX - 1] + "…"


def _out(p: Plan, *, dry_run: bool, number: int | None, created: bool) -> DeletionOut:
    slice_node = p.all_nodes.get(p.slice_id) if p.slice_id is not None else None
    return DeletionOut(
        dry_run=dry_run,
        items=[
            DeletionTarget(kind=t.kind, id=t.row.id, label=t.label, covered_by=t.covered_by)
            for t in p.targets
        ],
        totals=p.totals,
        version=DeletionVersion(
            node_id=p.slice_id,
            label=processes.node_path(p.all_nodes, slice_node.id) if slice_node else None,
            number=number,
            created=created,
        ),
    )


def preview(p: Plan) -> DeletionOut:
    return _out(p, dry_run=True, number=None, created=False)


def remove_node(db: Session, project: Project, node: Node) -> None:
    """Удалить объект с поддеревом (общее у DELETE /nodes/{id} и пачки). Поддерево,
    связи и документацию сносит БД-каскад; строки раскладки чужих видов внешними ключами
    не накрыты, их чистит cleanup_layout."""
    cleanup_layout(db, project, node)
    db.delete(node)


def apply(db: Session, project: Project, user: User, p: Plan, reason: str | None) -> DeletionOut:
    """Сохранить версию среза (если есть незафиксированное) и удалить пачку. Без
    коммита: версия и удаление уходят одной транзакцией, отказ не оставит ни того, ни
    другого."""
    slice_node = p.all_nodes.get(p.slice_id) if p.slice_id is not None else None
    live = p.live
    row, created = versions.ensure_version(
        db, project, user, slice_node, _comment(live, reason), kind="pre_delete"
    )
    number = row.number if row is not None else None
    for target in live:
        if isinstance(target.row, Node):
            remove_node(db, project, target.row)
        else:
            db.delete(target.row)
    db.flush()
    return _out(p, dry_run=False, number=number, created=created)
