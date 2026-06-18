"""Тесты обхода дерева (app.tree): предки, глубина, два варианта поддерева.

Главный инвариант — две реализации поддерева (in-memory subtree_ids и БД-фронтир
collect_subtree_ids_db) дают один и тот же набор id.
"""

import uuid

from conftest import ensure_project

from app import tree
from app.models.node import Node


def _node(db, name: str, parent: Node | None = None) -> Node:
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _build_tree(db):
    # root → mid → leaf, и побочная ветка root → other (чужое поддерево для leaf).
    root = _node(db, "root")
    mid = _node(db, "mid", root)
    leaf = _node(db, "leaf", mid)
    other = _node(db, "other", root)
    db.commit()
    return root, mid, leaf, other


def test_ancestors_root_first(db):
    root, mid, leaf, _other = _build_tree(db)
    all_nodes = {n.id: n for n in db.query(Node).all()}
    chain = tree.ancestors(all_nodes, leaf.id)
    # Порядок «корень → непосредственный родитель» — на нём держится breadcrumb.
    assert [a.id for a in chain] == [root.id, mid.id]
    # У корня предков нет.
    assert tree.ancestors(all_nodes, root.id) == []


def test_node_depth(db):
    root, mid, leaf, _other = _build_tree(db)
    all_nodes = {n.id: n for n in db.query(Node).all()}
    assert tree.node_depth(all_nodes, root.id) == 0
    assert tree.node_depth(all_nodes, mid.id) == 1
    assert tree.node_depth(all_nodes, leaf.id) == 2


def test_subtree_of_leaf_is_just_leaf(db):
    _root, _mid, leaf, _other = _build_tree(db)
    all_nodes = {n.id: n for n in db.query(Node).all()}
    assert tree.subtree_ids(all_nodes, leaf.id) == {leaf.id}


def test_two_subtree_impls_agree(db):
    root, mid, leaf, _other = _build_tree(db)
    all_nodes = {n.id: n for n in db.query(Node).all()}
    # In-memory и БД-обход должны совпасть: поддерево root — он, mid, leaf (без other-ветки? нет:
    # other тоже потомок root). Проверяем согласованность реализаций, а не конкретный набор.
    in_mem = tree.subtree_ids(all_nodes, root.id)
    in_db = tree.collect_subtree_ids_db(db, root.id)
    assert in_mem == in_db
    assert leaf.id in in_mem and mid.id in in_mem and root.id in in_mem
