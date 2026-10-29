"""Применение плана синхронизации (Фаза 2, docs/plan-arch-sync.md).

Разделение с sync_plan строгое: РЕШЕНИЯ принимает build_sync_plan (что создать,
что обновить, чего не трогать), здесь — механический исполнитель. Он не матчит
заново и не переспрашивает политики: берёт действия плана, значения полей — из
разобранного прогона по imp_idx, родителей создаваемых узлов — по parent_path.
Тот же приём, что у docs_import (build_docs_plan → apply_docs_plan).

Чего синк не касается НИКОГДА (главная ценность фазы — обновление без потерь):
node_docs, openapi_spec, раскладка view_layout, бизнес-процессы. Новые узлы
координат не получают: их расставит ELK, а существующие остаются на местах.
Удаления нет ни в каком режиме — пропавшее максимум помечается deprecated.
"""

import uuid
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.identity import known_key
from app.import_yaml import ParsedImport, _ImpNode
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.sync_plan import SyncEdgeAction, SyncNodeAction, SyncPlan
from app.view_state import bump_graph_rev


@dataclass
class SyncReport:
    """Что реально сделано. Зеркало плана постфактум — для тоста и журнала."""

    created_nodes: list[str] = field(default_factory=list)
    updated_nodes: list[str] = field(default_factory=list)
    deprecated_nodes: list[str] = field(default_factory=list)
    created_edges: list[str] = field(default_factory=list)
    updated_edges: list[str] = field(default_factory=list)  # заполнен канал или тип
    skipped: list[str] = field(default_factory=list)  # действия, потерявшие цель

    @property
    def total(self) -> int:
        return (
            len(self.created_nodes)
            + len(self.updated_nodes)
            + len(self.deprecated_nodes)
            + len(self.created_edges)
            + len(self.updated_edges)
        )


# Поля узла, которые синк переносит из прогона как есть: имя поля плана совпадает с
# колонкой узла и полем разобранного прогона. Якорь — отдельно: в плане он уже
# разобранный ключ, а не поле прогона.
_FLAT_FIELDS = frozenset(
    {"name", "description", "role", "technology", "shape", "status", "element"}
)


def apply_sync_plan(
    db: Session,
    project: Project,
    parsed: ParsedImport,
    plan: SyncPlan,
) -> SyncReport:
    """Записать план в проект. Коммит — на вызывающей стороне (как seed_import).

    Порядок: узлы (родители раньше детей — гарантирован порядком обхода прогона),
    затем пометки, затем связи. Связи резолвятся по ПУТЯМ через карту, в которую
    попадают и живые, и только что созданные узлы, — поэтому связь в новый узел
    создаётся в тот же проход."""
    report = SyncReport()
    live_by_id = {
        n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()
    }
    # путь в плане → узел (живой или созданный сейчас); ключ резолва связей
    by_path: dict[str, Node] = {}

    for act in plan.nodes:
        if act.action == "missing":
            _mark_missing(act, live_by_id, plan, report)
            continue
        imp = parsed.nodes[act.imp_idx] if act.imp_idx is not None else None
        if act.action == "create":
            _create_node(db, project, act, imp, by_path, report)
            continue
        node = live_by_id.get(act.node_id) if act.node_id else None
        if node is None:
            report.skipped.append(f"{act.path}: узел исчез до применения")
            continue
        by_path[act.path] = node
        if act.action != "unchanged" and act.fields:
            _update_node(act, imp, node, report)

    live_edges = {
        e.id: e for e in db.query(Edge).filter(Edge.project_id == project.id).all()
    }
    for eact in plan.edges:
        if eact.imp_idx is None:
            continue
        if eact.action == "update":
            _update_edge(eact, parsed, live_edges, report)
            continue
        if eact.action != "create":
            continue
        src = by_path.get(eact.source_path)
        dst = by_path.get(eact.target_path)
        if src is None or dst is None:
            report.skipped.append(f"{eact.source_path} → {eact.target_path}: конец не найден")
            continue
        ie = parsed.edges[eact.imp_idx]
        # Канал и тип канала — те же поля прогона, что пишет импорт (unified_into):
        # до 2026-10-28 синк их терял, и связи с брокером приезжали без канала (AL31).
        db.add(
            Edge(
                id=uuid.uuid4(),
                project_id=project.id,
                source_id=src.id,
                target_id=dst.id,
                label=ie.label,
                technology=ie.technology,
                channel=ie.channel,
                is_synchronous=ie.is_synchronous,
            )
        )
        report.created_edges.append(f"{eact.source_path} → {eact.target_path}")

    if report.total:
        # Курсор поллинга: чужие сессии подтянут обновлённую схему.
        bump_graph_rev(db, project)
    return report


def _update_edge(
    eact: SyncEdgeAction,
    parsed: ParsedImport,
    live_edges: dict[uuid.UUID, Edge],
    report: SyncReport,
) -> None:
    """Заполнить у живой связи пустые поля из прогона. Что заполнять — решил план
    (fields); здесь только присваивание, как у _update_node."""
    edge = live_edges.get(eact.edge_id) if eact.edge_id else None
    path = f"{eact.source_path} → {eact.target_path}"
    if edge is None or eact.imp_idx is None:
        report.skipped.append(f"{path}: связь исчезла до применения")
        return
    ie = parsed.edges[eact.imp_idx]
    for fld in eact.fields:
        if fld == "channel":
            edge.channel = ie.channel
        elif fld == "is_synchronous":
            edge.is_synchronous = ie.is_synchronous
    edge.version += 1
    report.updated_edges.append(path)


def _mark_missing(
    act: SyncNodeAction, live_by_id: dict[uuid.UUID, Node], plan: SyncPlan, report: SyncReport
) -> None:
    node = live_by_id.get(act.node_id) if act.node_id else None
    if node is None:
        report.skipped.append(f"{act.path}: узел исчез до применения")
        return
    # Пометка ставится только по политике — build_sync_plan оставляет действие
    # missing и без неё (пропажу показываем всегда, помечаем нет).
    if plan.policies.mark_missing_deprecated and node.status != "deprecated":
        node.status = "deprecated"
        node.version += 1
        report.deprecated_nodes.append(act.path)


def _create_node(
    db: Session,
    project: Project,
    act: SyncNodeAction,
    imp: _ImpNode | None,
    by_path: dict[str, Node],
    report: SyncReport,
) -> None:
    if imp is None:
        report.skipped.append(f"{act.path}: нечего создавать")
        return
    parent = by_path.get(act.parent_path) if act.parent_path else None
    if act.parent_path and parent is None:
        # Родитель не создался (например, был пропущен как компонент) — ребёнка в
        # корень не выносим, это исказило бы иерархию.
        report.skipped.append(f"{act.path}: родитель не найден")
        return
    node = Node(
        id=uuid.uuid4(),
        project_id=project.id,
        name=imp.name,
        description=imp.description,
        role=imp.role,
        technology=imp.technology,
        shape=imp.shape,
        status=imp.status,
        is_external=imp.is_external,
        # Как есть: разбор прогона уже санитизирован. Контейнер без компонентов (их
        # слой синк по умолчанию отрезает) — норма: у листа значение — намерение (Р3).
        element=imp.element,
        source_ref=known_key(act.source_ref),
        parent_id=parent.id if parent else None,
    )
    db.add(node)
    db.flush()  # id нужен детям и связям этого же прохода
    by_path[act.path] = node
    report.created_nodes.append(act.path)


def _update_node(
    act: SyncNodeAction, imp: _ImpNode | None, node: Node, report: SyncReport
) -> None:
    if imp is None:
        report.skipped.append(f"{act.path}: нет данных в YAML")
        return
    # Что менять — решено планом (список fields); здесь только присваивание.
    for fld in act.fields:
        if fld == "source_ref":
            node.source_ref = known_key(act.source_ref)
        elif fld in _FLAT_FIELDS:
            setattr(node, fld, getattr(imp, fld))
    node.version += 1
    report.updated_nodes.append(act.path)
