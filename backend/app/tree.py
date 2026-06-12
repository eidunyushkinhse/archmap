"""Обход дерева узлов: предки, глубина, поддерево.

Эти функции жили в нескольких дословных копиях (замыкания в routers.nodes
_build_graph и локальные defs в get_node_context) и считали поддерево двумя
способами — собраны сюда, чтобы копии не разъезжались.

Два варианта обхода поддерева — по ситуации:
- subtree_ids — in-memory, когда карта всех узлов уже на руках (all_nodes);
- collect_subtree_ids_db — по БД-фронтиру (один запрос на уровень), когда грузить
  все узлы не нужно/дорого.
"""

import uuid
from collections import defaultdict

from sqlalchemy.orm import Session

from app.models.node import Node
from app.schemas.node import AncestorRef


def ancestors(all_nodes: dict[uuid.UUID, Node], node_id: uuid.UUID) -> list[AncestorRef]:
    """Цепочка предков узла, корень → непосредственный родитель.

    Порядок (корень первым) держит breadcrumb на фронте — не менять.
    """
    chain: list[AncestorRef] = []
    current = all_nodes.get(node_id)
    parent_id = current.parent_id if current else None
    while parent_id is not None:
        parent = all_nodes.get(parent_id)
        if parent is None:
            break
        chain.append(AncestorRef(id=parent.id, name=parent.name, is_external=parent.is_external))
        parent_id = parent.parent_id
    chain.reverse()  # корень → непосредственный родитель
    return chain


def node_depth(all_nodes: dict[uuid.UUID, Node], node_id: uuid.UUID) -> int:
    """Глубина узла в дереве (корень = 0)."""
    depth = 0
    current = all_nodes.get(node_id)
    while current and current.parent_id is not None:
        depth += 1
        current = all_nodes.get(current.parent_id)
    return depth


def subtree_ids(all_nodes: dict[uuid.UUID, Node], root_id: uuid.UUID) -> set[uuid.UUID]:
    """id всего поддерева (root + все потомки) по карте узлов в памяти.

    Применять, когда all_nodes уже загружена; иначе collect_subtree_ids_db.
    """
    children: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for n in all_nodes.values():
        if n.parent_id is not None:
            children[n.parent_id].append(n.id)

    subtree: set[uuid.UUID] = set()
    stack = [root_id]
    while stack:
        cur = stack.pop()
        if cur in subtree:
            continue
        subtree.add(cur)
        stack.extend(children.get(cur, []))
    return subtree


def collect_subtree_ids_db(db: Session, root_id: uuid.UUID) -> set[uuid.UUID]:
    """id всего поддерева: сам узел + все потомки на любой глубине.

    Обход по уровням через parent_id (один запрос на уровень). Применять, когда
    карта всех узлов не загружена; иначе subtree_ids по all_nodes.
    """
    ids: set[uuid.UUID] = {root_id}
    frontier = [root_id]
    while frontier:
        kids = [
            kid
            for (kid,) in db.query(Node.id)
            .filter(Node.parent_id.in_(frontier))
            .all()
        ]
        kids = [k for k in kids if k not in ids]
        if not kids:
            break
        ids.update(kids)
        frontier = kids
    return ids
