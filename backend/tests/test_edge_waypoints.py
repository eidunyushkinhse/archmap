"""Тесты сохранения изломов гостевой стрелки с явным якорем (own-on-first-render, Ф3).

Якорь излома — идентичность узла (anchor_node_id): не null → точки это офсет от позиции
этого узла; null → абсолют уровня. Пустой список waypoints — сброс в авто (строка удаляется).
"""

import uuid

from conftest import ensure_project

from app.models.edge import Edge
from app.models.edge_waypoint import EdgeWaypoint
from app.models.node import Node
from app.routers.nodes import save_edge_waypoints
from app.schemas.node import EdgeWaypointsUpdate, Point


def _node(db, name, parent=None):
    n = Node(id=uuid.uuid4(), name=name, parent_id=parent.id if parent else None,
             project_id=ensure_project(db).id)
    db.add(n)
    return n


def _edge(db, src, tgt):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id, project_id=ensure_project(db).id)
    db.add(e)
    return e


def test_save_waypoints_persists_anchor_node_id(db):
    c = _node(db, "C")
    c1 = _node(db, "C1", c)
    g = _node(db, "G")
    e = _edge(db, c1, g)
    db.commit()

    save_edge_waypoints(
        c.id, e.id,
        EdgeWaypointsUpdate(waypoints=[Point(x=1, y=2)], anchor_node_id=g.id),
        db=db, project=ensure_project(db),
    )
    row = db.query(EdgeWaypoint).filter(EdgeWaypoint.container_id == c.id, EdgeWaypoint.edge_id == e.id).one()
    assert row.anchor_node_id == g.id
    assert row.waypoints == [{"x": 1, "y": 2}]


def test_save_waypoints_null_anchor_is_absolute(db):
    c = _node(db, "C")
    c1 = _node(db, "C1", c)
    g = _node(db, "G")
    e = _edge(db, c1, g)
    db.commit()

    save_edge_waypoints(
        c.id, e.id,
        EdgeWaypointsUpdate(waypoints=[Point(x=5, y=6)]),  # anchor_node_id опущен → null
        db=db, project=ensure_project(db),
    )
    row = db.query(EdgeWaypoint).filter(EdgeWaypoint.container_id == c.id, EdgeWaypoint.edge_id == e.id).one()
    assert row.anchor_node_id is None


def test_save_empty_waypoints_deletes_row(db):
    c = _node(db, "C")
    c1 = _node(db, "C1", c)
    g = _node(db, "G")
    e = _edge(db, c1, g)
    db.commit()
    db.add(EdgeWaypoint(container_id=c.id, edge_id=e.id, waypoints=[{"x": 1, "y": 2}], anchor_node_id=g.id))
    db.commit()

    save_edge_waypoints(
        c.id, e.id, EdgeWaypointsUpdate(waypoints=[]),
        db=db, project=ensure_project(db),
    )
    assert db.query(EdgeWaypoint).filter(EdgeWaypoint.container_id == c.id, EdgeWaypoint.edge_id == e.id).count() == 0
