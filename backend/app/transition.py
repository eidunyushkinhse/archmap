"""«Принять переход»: план стал фактом — новое становится существующим, а то,
что выводили из эксплуатации, уходит из схемы.

Две половины одной операции (идея пользователя 2026-08-08, решения — в
docs/plan-work-2026-08-08.md, шаг 6):
  • узлы со статусом planned становятся existing;
  • узлы со статусом deprecated УДАЛЯЮТСЯ вместе с поддеревом.

Область — ВЕСЬ ПРОЕКТ: переход принимают целиком, а не по уровням.

Главная опасность здесь — не сами удаления, а то, что уедет ВМЕСТЕ с ними:
у выводимого контейнера могут быть дети, которые устаревшими не помечены. Молча
такое делать нельзя, поэтому build_transition считает «попутные потери» отдельным
списком, и окно показывает их до подтверждения.
"""

import uuid

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import tree
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.models.view_layout import ViewLayoutItem
from app.view_state import bump_view_version


class TransitionPlan:
    """Что произойдёт при принятии перехода. Считается по живой схеме."""

    def __init__(self) -> None:
        # Верхние выводимые узлы: их потомки уедут каскадом, поэтому в списке на
        # удаление они не нужны (иначе счёт двоился бы).
        self.delete_roots: list[Node] = []
        # Все узлы, которые физически исчезнут (корни + всё поддерево).
        self.delete_ids: set[uuid.UUID] = set()
        # Уезжающие ЗАОДНО — те, кого устаревшими никто не помечал.
        self.collateral: list[Node] = []
        self.promote: list[Node] = []
        self.edges = 0
        self.docs = 0
        self.specs = 0

    @property
    def is_noop(self) -> bool:
        return not self.delete_roots and not self.promote


def build_transition(db: Session, project: Project) -> TransitionPlan:
    """План перехода по текущему состоянию схемы. БД не меняет."""
    plan = TransitionPlan()
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    by_id = {n.id: n for n in nodes}
    kids: dict[uuid.UUID | None, list[Node]] = {}
    for n in nodes:
        kids.setdefault(n.parent_id, []).append(n)

    def has_deprecated_ancestor(n: Node) -> bool:
        cur = by_id.get(n.parent_id) if n.parent_id else None
        while cur is not None:
            if cur.status == "deprecated":
                return True
            cur = by_id.get(cur.parent_id) if cur.parent_id else None
        return False

    for n in nodes:
        if n.status == "deprecated" and not has_deprecated_ancestor(n):
            plan.delete_roots.append(n)
    plan.delete_roots.sort(key=lambda n: n.name)

    for root in plan.delete_roots:
        for nid in tree.subtree_ids(by_id, root.id):
            plan.delete_ids.add(nid)
    plan.collateral = sorted(
        (by_id[i] for i in plan.delete_ids if by_id[i].status != "deprecated"),
        key=lambda n: n.name,
    )

    # planned → existing. Узлы, которые всё равно уедут, повышать незачем.
    plan.promote = sorted(
        (n for n in nodes if n.status == "planned" and n.id not in plan.delete_ids),
        key=lambda n: n.name,
    )

    if plan.delete_ids:
        plan.edges = (
            db.query(Edge)
            .filter(
                Edge.project_id == project.id,
                or_(Edge.source_id.in_(plan.delete_ids), Edge.target_id.in_(plan.delete_ids)),
            )
            .count()
        )
        plan.docs = db.query(NodeDoc).filter(NodeDoc.node_id.in_(plan.delete_ids)).count()
        plan.specs = sum(1 for i in plan.delete_ids if by_id[i].openapi_spec)
    return plan


def cleanup_layout(db: Session, project: Project, node: Node) -> None:
    """Стереть строки раскладки, ссылающиеся на поддерево узла, и сдвинуть версии
    затронутых видов.

    Вынесено из обработчика удаления узла: удаление поддерева делает БД-каскад, а
    вот строки view_layout ЧУЖИХ видов (гостевые позиции, ключи пучков
    «b:<src>><tgt>») внешними ключами не накрыты — item_id это строка. Чистим их
    явно, по вхождению uuid в ключ.
    """
    subtree = tree.collect_subtree_ids_db(db, node.id)
    like_filter = or_(*[ViewLayoutItem.item_id.like(f"%{sid}%") for sid in subtree])
    # Виды ВНУТРИ поддерева умирают тем же каскадом — им версию не бампаем.
    touched = {
        vid
        for (vid,) in db.query(ViewLayoutItem.view_id)
        .filter(ViewLayoutItem.project_id == project.id, like_filter)
        .distinct()
        .all()
        if vid is None or vid not in subtree
    }
    db.query(ViewLayoutItem).filter(
        ViewLayoutItem.project_id == project.id, like_filter
    ).delete(synchronize_session=False)
    touched.add(node.parent_id)  # членство родительского вида изменилось
    for vid in touched:
        bump_view_version(db, project.id, vid)


def apply_transition(db: Session, project: Project, plan: TransitionPlan) -> tuple[int, int]:
    """Выполнить план: (удалено узлов, переведено в существующие).

    Одной транзакцией — коммит делает вызывающий. Иначе отказ посреди пачки
    оставил бы схему в полупринятом состоянии: часть удалили, часть нет.
    """
    for node in plan.delete_roots:
        cleanup_layout(db, project, node)
        db.delete(node)
    for node in plan.promote:
        node.status = "existing"
        node.version += 1
    return len(plan.delete_ids), len(plan.promote)
