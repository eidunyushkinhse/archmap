"""Тесты команды «Переразложить уровень» (own-on-first-render, Ф2).

Эндпоинт стирает ВЕСЬ ручной layout одного уровня → авто-раскладка: позиции
локальных узлов (дети контейнера) обнуляются, а гостевые позиции, хэндлы гостевых
концов и изломы стрелок этого уровня удаляются. Слой соседнего уровня и узлы вне
уровня не трогаются (скоуп строго по container_id).
"""

import uuid

import pytest
from conftest import ensure_project
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.edge_waypoint import EdgeWaypoint
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node
from app.routers.nodes import relayout_level, relayout_root_level


def _node(db, name, parent=None, pos=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        pos_x=pos[0] if pos else None,
        pos_y=pos[1] if pos else None,
    )
    db.add(n)
    return n


def _edge(db, src, tgt):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id, project_id=ensure_project(db).id)
    db.add(e)
    return e


def test_relayout_level_clears_only_this_level(db):
    # Уровень контейнера C: локальные дети c1/c2 с ручными позициями + гость g, чьи
    # позиция/хэндл/излом сохранены на этом уровне. Снаружи: узел out с позицией и
    # соседний уровень D со своими гостевыми строками — всё это должно выжить.
    c = _node(db, "C")
    c1 = _node(db, "C1", c, pos=(10, 20))
    c2 = _node(db, "C2", c, pos=(30, 40))
    g = _node(db, "G")
    out = _node(db, "Out", pos=(99, 99))
    d = _node(db, "D")
    e_cg = _edge(db, c1, g)
    db.commit()

    # Гостевой слой уровня C (под сброс):
    db.add(GhostPosition(container_id=c.id, node_id=g.id, pos_x=1, pos_y=2))
    db.add(GhostEdgeHandle(container_id=c.id, edge_id=e_cg.id, node_id=g.id, handle="g--left--1"))
    db.add(EdgeWaypoint(container_id=c.id, edge_id=e_cg.id, waypoints=[{"x": 5, "y": 6}]))
    # Гостевой слой соседнего уровня D (НЕ трогаем):
    db.add(GhostPosition(container_id=d.id, node_id=g.id, pos_x=7, pos_y=8))
    db.add(EdgeWaypoint(container_id=d.id, edge_id=e_cg.id, waypoints=[{"x": 9, "y": 9}]))
    db.commit()

    relayout_level(c.id, db=db, project=ensure_project(db))

    # Позиции локальных детей уровня C обнулены, гостевой слой уровня C снесён.
    assert db.get(Node, c1.id).pos_x is None and db.get(Node, c1.id).pos_y is None
    assert db.get(Node, c2.id).pos_x is None and db.get(Node, c2.id).pos_y is None
    assert db.query(GhostPosition).filter(GhostPosition.container_id == c.id).count() == 0
    assert db.query(GhostEdgeHandle).filter(GhostEdgeHandle.container_id == c.id).count() == 0
    assert db.query(EdgeWaypoint).filter(EdgeWaypoint.container_id == c.id).count() == 0

    # Узел вне уровня и слой соседнего уровня D — нетронуты.
    assert db.get(Node, out.id).pos_x == 99
    assert db.query(GhostPosition).filter(GhostPosition.container_id == d.id).count() == 1
    assert db.query(EdgeWaypoint).filter(EdgeWaypoint.container_id == d.id).count() == 1


def test_relayout_root_clears_root_node_positions_only(db):
    # Корневые узлы (parent_id IS NULL) с позициями + ребёнок под контейнером.
    r1 = _node(db, "R1", pos=(10, 20))
    cont = _node(db, "Cont", pos=(0, 0))
    child = _node(db, "Child", cont, pos=(50, 60))
    db.commit()

    relayout_root_level(db=db, project=ensure_project(db))

    # Корневые узлы обнулены, ребёнок контейнера (не корневой уровень) — нетронут.
    assert db.get(Node, r1.id).pos_x is None and db.get(Node, r1.id).pos_y is None
    assert db.get(Node, cont.id).pos_x is None and db.get(Node, cont.id).pos_y is None
    assert db.get(Node, child.id).pos_x == 50 and db.get(Node, child.id).pos_y == 60


def test_relayout_missing_level_404(db):
    with pytest.raises(HTTPException) as ei:
        relayout_level(uuid.uuid4(), db=db, project=ensure_project(db))
    assert ei.value.status_code == 404
