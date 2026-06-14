"""Тесты снимка удаления и восстановления (Undo удаления узла, итерация 2).

Round-trip: build_deletion_snapshot ДО удаления → delete_node (каскад) → restore
возвращает поддерево, инцидентные рёбра и ghost-метаданные С ТЕМИ ЖЕ id. Внешние
сущности снимок не трогает и restore их не дублирует.
"""

import uuid

import pytest
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.edge_waypoint import EdgeWaypoint
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node
from app.restore import build_deletion_snapshot, restore_from_snapshot
from app.routers.nodes import delete_node, restore_nodes


def _node(db, name, parent=None):
    n = Node(id=uuid.uuid4(), name=name, parent_id=parent.id if parent else None)
    db.add(n)
    return n


def _edge(db, src, tgt, **kw):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id, **kw)
    db.add(e)
    return e


def test_snapshot_restore_round_trip(db):
    # Поддерево A → A1 → A1a; снаружи X, Y. Рёбра: внутреннее A1→A1a, исходящее A1a→X,
    # входящее X→A1, чисто внешнее X→Y. Ghost-метаданные на удаляемых и выживших.
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    a1a = _node(db, "A1a", a1)
    x = _node(db, "X")
    y = _node(db, "Y")
    e_inner = _edge(db, a1, a1a, label="внутр", waypoints=[{"x": 1.0, "y": 2.0}])
    e_out = _edge(db, a1a, x)
    e_in = _edge(db, x, a1, source_handle="x--right--0", label_t=0.3)
    e_external = _edge(db, x, y)
    db.commit()

    db.add(GhostPosition(container_id=x.id, node_id=a1.id, pos_x=1, pos_y=2))  # node в поддереве
    db.add(GhostPosition(container_id=a.id, node_id=x.id, pos_x=3, pos_y=4))  # container в поддереве
    db.add(GhostPosition(container_id=x.id, node_id=y.id, pos_x=5, pos_y=6))  # обе выживают
    db.add(GhostEdgeHandle(container_id=x.id, edge_id=e_in.id, node_id=a1.id, handle="a1--left--1"))
    db.add(EdgeWaypoint(container_id=x.id, edge_id=e_in.id, waypoints=[{"x": 7.0, "y": 8.0}]))
    db.commit()

    # id фиксируем заранее: после delete_node ORM-объекты удалены/просрочены и обращение
    # к их .id уже не пройдёт (DetachedInstanceError).
    a_id, a1_id, a1a_id, x_id, y_id = a.id, a1.id, a1a.id, x.id, y.id
    e_inner_id, e_out_id, e_in_id, e_ext_id = e_inner.id, e_out.id, e_in.id, e_external.id

    snap = build_deletion_snapshot(db, a_id)
    # Снимок повторяет ровно каскад: 3 узла, 3 ребра (e_external — чисто внешнее — нет),
    # 2 ghost-позиции, 1 хэндл, 1 излом.
    assert {n.id for n in snap.nodes} == {a_id, a1_id, a1a_id}
    assert {e.id for e in snap.edges} == {e_inner_id, e_out_id, e_in_id}
    assert len(snap.ghost_positions) == 2
    assert len(snap.ghost_edge_handles) == 1
    assert len(snap.edge_waypoints) == 1

    delete_node(a_id, db=db)
    assert {n.id for n in db.query(Node).all()} == {x_id, y_id}
    assert {e.id for e in db.query(Edge).all()} == {e_ext_id}

    restore_from_snapshot(db, snap)

    # Узлы вернулись с теми же id и связями родителя
    nodes = {n.id: n for n in db.query(Node).all()}
    assert set(nodes) == {a_id, a1_id, a1a_id, x_id, y_id}
    assert nodes[a1_id].parent_id == a_id
    assert nodes[a1a_id].parent_id == a1_id

    # Рёбра вернулись с id и сохранёнными полями раскладки
    edges = {e.id: e for e in db.query(Edge).all()}
    assert set(edges) == {e_inner_id, e_out_id, e_in_id, e_ext_id}
    assert edges[e_inner_id].waypoints == [{"x": 1.0, "y": 2.0}]
    assert edges[e_in_id].source_handle == "x--right--0"
    assert edges[e_in_id].label_t == 0.3

    # ghost-строки восстановлены и не задублированы (внешняя так и одна)
    assert db.query(GhostPosition).count() == 3
    gh = db.query(GhostEdgeHandle).one()
    assert gh.edge_id == e_in_id and gh.node_id == a1_id
    ew = db.query(EdgeWaypoint).one()
    assert ew.edge_id == e_in_id and ew.waypoints == [{"x": 7.0, "y": 8.0}]


def test_get_snapshot_missing_node_404(db):
    from app.routers.nodes import get_deletion_snapshot

    with pytest.raises(HTTPException) as ei:
        get_deletion_snapshot(uuid.uuid4(), db=db)
    assert ei.value.status_code == 404


def test_restore_conflict_when_nodes_exist(db):
    a = _node(db, "A")
    db.commit()
    snap = build_deletion_snapshot(db, a.id)
    # Узел A не удаляли — restore того же снимка должен упереться в конфликт.
    with pytest.raises(HTTPException) as ei:
        restore_nodes(snap, db=db)
    assert ei.value.status_code == 409


def test_restore_conflict_when_parent_gone(db):
    parent = _node(db, "P")
    child = _node(db, "C", parent)
    db.commit()
    snap = build_deletion_snapshot(db, child.id)  # снимок только ребёнка
    delete_node(child.id, db=db)
    delete_node(parent.id, db=db)  # родитель тоже исчез
    with pytest.raises(HTTPException) as ei:
        restore_nodes(snap, db=db)
    assert ei.value.status_code == 409


def test_restore_empty_snapshot_400(db):
    from app.schemas.restore import DeletionSnapshot

    empty = DeletionSnapshot(
        nodes=[], edges=[], ghost_positions=[], ghost_edge_handles=[], edge_waypoints=[]
    )
    with pytest.raises(HTTPException) as ei:
        restore_nodes(empty, db=db)
    assert ei.value.status_code == 400


# --- Откат удаления/создания СВЯЗИ (итерация 3): рёберный снимок (nodes=[]) ---


def test_edge_snapshot_restore_round_trip(db):
    # Связь X→Y с хэндлом/изломом-колонкой плюс ghost-метаданные по edge_id.
    # Узлы снимок НЕ трогает — только само ребро и его ghost-строки.
    from app.restore import build_edge_deletion_snapshot

    x = _node(db, "X")
    y = _node(db, "Y")
    e = _edge(db, x, y, label="зов", source_handle="x--right--0", label_t=0.4,
              waypoints=[{"x": 1.0, "y": 2.0}])
    db.commit()
    db.add(GhostEdgeHandle(container_id=x.id, edge_id=e.id, node_id=y.id, handle="y--left--1"))
    db.add(EdgeWaypoint(container_id=x.id, edge_id=e.id, waypoints=[{"x": 3.0, "y": 4.0}]))
    db.commit()
    x_id, y_id, e_id = x.id, y.id, e.id

    snap = build_edge_deletion_snapshot(db, e_id)
    assert snap.nodes == []
    assert {ed.id for ed in snap.edges} == {e_id}
    assert len(snap.ghost_edge_handles) == 1
    assert len(snap.edge_waypoints) == 1

    # Удаляем связь (каскад сносит ghost-хэндл и излом по edge_id), узлы остаются.
    db.delete(db.get(Edge, e_id))
    db.commit()
    assert db.query(Edge).count() == 0
    assert db.query(GhostEdgeHandle).count() == 0
    assert db.query(EdgeWaypoint).count() == 0
    assert {n.id for n in db.query(Node).all()} == {x_id, y_id}

    restore_from_snapshot(db, snap)

    edges = db.query(Edge).all()
    assert len(edges) == 1
    e2 = edges[0]
    assert e2.id == e_id and e2.label == "зов"
    assert e2.source_handle == "x--right--0" and e2.label_t == 0.4
    assert e2.waypoints == [{"x": 1.0, "y": 2.0}]
    gh = db.query(GhostEdgeHandle).one()
    assert gh.edge_id == e_id and gh.handle == "y--left--1"
    ew = db.query(EdgeWaypoint).one()
    assert ew.edge_id == e_id and ew.waypoints == [{"x": 3.0, "y": 4.0}]


def test_edge_snapshot_missing_edge_404(db):
    from app.routers.edges import edge_deletion_snapshot

    with pytest.raises(HTTPException) as ei:
        edge_deletion_snapshot(uuid.uuid4(), db=db)
    assert ei.value.status_code == 404


def test_restore_conflict_when_edge_exists(db):
    # Рёберный снимок существующей связи → restore без удаления упирается в 409.
    from app.restore import build_edge_deletion_snapshot

    x = _node(db, "X")
    y = _node(db, "Y")
    e = _edge(db, x, y)
    db.commit()
    snap = build_edge_deletion_snapshot(db, e.id)
    with pytest.raises(HTTPException) as ei:
        restore_nodes(snap, db=db)
    assert ei.value.status_code == 409
