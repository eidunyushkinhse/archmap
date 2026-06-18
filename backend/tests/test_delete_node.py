"""Характеризационные тесты удаления узла (F6б).

Фиксируют каскад удаления поддерева: сам узел + потомки любой глубины, все их
рёбра (включая входящие СНАРУЖИ — это и был повод для bulk-костыля), плюс
ghost-метаданные, ссылающиеся на удаляемые узлы. Чисто внешние рёбра выживают.
Тест должен оставаться зелёным и на bulk-удалении, и после перехода на db.delete
с passive_deletes (каскад БД) — это и доказывает эквивалентность рефактора.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node
from app.routers.nodes import delete_node


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _edge(db, src, tgt):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id, project_id=ensure_project(db).id)
    db.add(e)
    return e


def test_delete_node_cascades_subtree_edges_and_ghost_meta(db):
    # Поддерево A → A1 → A1a; снаружи X. Рёбра: внутреннее A1→A1a, исходящее наружу
    # A1a→X, входящее снаружи X→A1 (повод для прежнего костыля), и чисто внешнее X→Y.
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    a1a = _node(db, "A1a", a1)
    x = _node(db, "X")
    y = _node(db, "Y")
    _edge(db, a1, a1a)  # внутреннее A1→A1a — должно уйти каскадом (не ссылаемся ниже)
    _edge(db, a1a, x)   # исходящее наружу A1a→X — тоже каскадом (не ссылаемся ниже)
    e_in = _edge(db, x, a1)
    e_external = _edge(db, x, y)
    db.commit()

    # ghost-метаданные: ссылаются на удаляемые узлы (должны уйти каскадом) и на
    # выжившие (должны остаться).
    db.add(GhostPosition(container_id=x.id, node_id=a1.id, pos_x=1, pos_y=2))   # node_id в поддереве → каскад
    db.add(GhostPosition(container_id=a.id, node_id=x.id, pos_x=3, pos_y=4))    # container_id в поддереве → каскад
    db.add(GhostPosition(container_id=x.id, node_id=y.id, pos_x=5, pos_y=6))    # обе ссылки выживают → остаётся
    db.add(GhostEdgeHandle(container_id=x.id, edge_id=e_in.id, node_id=a1.id, handle="a1--left--1"))  # edge+node в поддереве → каскад
    db.commit()

    delete_node(a.id, db=db, project=ensure_project(db), user=ensure_architect(db))

    node_ids = {n.id for n in db.query(Node).all()}
    assert node_ids == {x.id, y.id}  # поддерево A снесено, X и Y живы

    edge_ids = {e.id for e in db.query(Edge).all()}
    assert edge_ids == {e_external.id}  # выжило только чисто внешнее X→Y

    # ghost-строки, ссылавшиеся на удалённые узлы/рёбра, ушли каскадом; «внешняя» жива
    gp = db.query(GhostPosition).all()
    assert len(gp) == 1 and gp[0].node_id == y.id and gp[0].container_id == x.id
    assert db.query(GhostEdgeHandle).count() == 0


def test_delete_missing_node_404(db):
    with pytest.raises(HTTPException) as ei:
        delete_node(uuid.uuid4(), db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 404
