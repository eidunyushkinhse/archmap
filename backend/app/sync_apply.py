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

from app.import_yaml import ParsedImport
from app.models.edge import Edge
from app.models.node import Node
from app.models.project import Project
from app.sync_plan import SyncPlan
from app.view_state import bump_graph_rev


@dataclass
class SyncReport:
    """Что реально сделано. Зеркало плана постфактум — для тоста и журнала."""

    created_nodes: list[str] = field(default_factory=list)
    updated_nodes: list[str] = field(default_factory=list)
    deprecated_nodes: list[str] = field(default_factory=list)
    created_edges: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # действия, потерявшие цель

    @property
    def total(self) -> int:
        return (
            len(self.created_nodes)
            + len(self.updated_nodes)
            + len(self.deprecated_nodes)
            + len(self.created_edges)
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
            node = live_by_id.get(act.node_id) if act.node_id else None
            if node is None:
                report.skipped.append(f"{act.path}: узел исчез до применения")
                continue
            # Пометка ставится только по политике — build_sync_plan оставляет
            # действие missing и без неё (пропажу показываем всегда, помечаем нет).
            if plan.policies.mark_missing_deprecated and node.status != "deprecated":
                node.status = "deprecated"
                node.version += 1
                report.deprecated_nodes.append(act.path)
            continue

        imp = parsed.nodes[act.imp_idx] if act.imp_idx is not None else None

        if act.action == "create":
            if imp is None:
                report.skipped.append(f"{act.path}: нечего создавать")
                continue
            parent = by_path.get(act.parent_path) if act.parent_path else None
            if act.parent_path and parent is None:
                # Родитель не создался (например, был пропущен как компонент) —
                # ребёнка в корень не выносим, это исказило бы иерархию.
                report.skipped.append(f"{act.path}: родитель не найден")
                continue
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
                source_ref=act.source_ref,
                parent_id=parent.id if parent else None,
            )
            db.add(node)
            db.flush()  # id нужен детям и связям этого же прохода
            by_path[act.path] = node
            report.created_nodes.append(act.path)
            continue

        node = live_by_id.get(act.node_id) if act.node_id else None
        if node is None:
            report.skipped.append(f"{act.path}: узел исчез до применения")
            continue
        by_path[act.path] = node
        if act.action == "unchanged" or not act.fields:
            continue
        if imp is None:
            report.skipped.append(f"{act.path}: нет данных прогона")
            continue
        # Что менять — решено планом (список fields); здесь только присваивание.
        for fld in act.fields:
            if fld == "source_ref":
                node.source_ref = act.source_ref
            elif fld == "name":
                node.name = imp.name
            elif fld == "description":
                node.description = imp.description
            elif fld == "role":
                node.role = imp.role
            elif fld == "technology":
                node.technology = imp.technology
            elif fld == "shape":
                node.shape = imp.shape
            elif fld == "status":
                node.status = imp.status
        node.version += 1
        report.updated_nodes.append(act.path)

    for eact in plan.edges:
        if eact.action != "create" or eact.imp_idx is None:
            continue
        src = by_path.get(eact.source_path)
        dst = by_path.get(eact.target_path)
        if src is None or dst is None:
            report.skipped.append(f"{eact.source_path} → {eact.target_path}: конец не найден")
            continue
        ie = parsed.edges[eact.imp_idx]
        db.add(
            Edge(
                id=uuid.uuid4(),
                project_id=project.id,
                source_id=src.id,
                target_id=dst.id,
                label=ie.label,
                technology=ie.technology,
            )
        )
        report.created_edges.append(f"{eact.source_path} → {eact.target_path}")

    if report.total:
        # Курсор поллинга: чужие сессии подтянут обновлённую схему.
        bump_graph_rev(db, project)
    return report
