"""Тесты хелпера app.database.upsert (INSERT … ON CONFLICT DO UPDATE).

Гоняются на SQLite (как и весь набор) — проверяют диалект-агностичную ветку
sqlite.insert. Цель: апсерт по ключу UniqueConstraint обновляет строку, а не
плодит дубли; разные ключи дают разные строки.
"""

import uuid

from conftest import ensure_project

from app.database import upsert
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node


def _node(db, name: str) -> Node:
    n = Node(name=name, project_id=ensure_project(db).id)
    db.add(n)
    db.flush()  # нужен id для FK-ссылок ниже
    return n


def test_upsert_ghost_position_inserts_then_updates(db):
    level = _node(db, "Уровень")
    ghost = _node(db, "Гость")

    # Первый апсерт — вставка.
    upsert(
        db,
        GhostPosition,
        keys={"container_id": level.id, "node_id": ghost.id},
        values={"pos_x": 1.0, "pos_y": 2.0},
    )
    db.commit()
    rows = db.query(GhostPosition).all()
    assert len(rows) == 1
    assert (rows[0].pos_x, rows[0].pos_y) == (1.0, 2.0)

    # Второй апсерт с теми же ключами — обновление, строка остаётся одна.
    upsert(
        db,
        GhostPosition,
        keys={"container_id": level.id, "node_id": ghost.id},
        values={"pos_x": 10.0, "pos_y": 20.0},
    )
    db.commit()
    rows = db.query(GhostPosition).all()
    assert len(rows) == 1
    assert (rows[0].pos_x, rows[0].pos_y) == (10.0, 20.0)


def test_upsert_ghost_position_different_key_adds_row(db):
    level = _node(db, "Уровень")
    ghost_a = _node(db, "Гость A")
    ghost_b = _node(db, "Гость B")

    upsert(
        db, GhostPosition,
        keys={"container_id": level.id, "node_id": ghost_a.id},
        values={"pos_x": 1.0, "pos_y": 1.0},
    )
    upsert(
        db, GhostPosition,
        keys={"container_id": level.id, "node_id": ghost_b.id},
        values={"pos_x": 2.0, "pos_y": 2.0},
    )
    db.commit()
    assert db.query(GhostPosition).count() == 2


def test_upsert_ghost_edge_handle_projections_do_not_clobber(db):
    # Ребро source→target и его две проекции гостевого конца (разные node_id):
    # трёхколоночный ключ (container_id, edge_id, node_id) должен держать их раздельно.
    level = _node(db, "Уровень")
    source = _node(db, "Источник")
    target = _node(db, "Цель")
    from app.models.edge import Edge

    edge = Edge(
        id=uuid.uuid4(),
        source_id=source.id,
        target_id=target.id,
        project_id=ensure_project(db).id,
    )
    db.add(edge)
    db.flush()

    proj_leaf = _node(db, "Лист-гость")
    proj_container = _node(db, "Предок-контейнер")

    upsert(
        db, GhostEdgeHandle,
        keys={"container_id": level.id, "edge_id": edge.id, "node_id": proj_leaf.id},
        values={"handle": "leaf--left--0"},
    )
    upsert(
        db, GhostEdgeHandle,
        keys={"container_id": level.id, "edge_id": edge.id, "node_id": proj_container.id},
        values={"handle": "container--right--0"},
    )
    db.commit()
    assert db.query(GhostEdgeHandle).count() == 2

    # Апсерт одной из проекций — обновляет её и не трогает вторую.
    upsert(
        db, GhostEdgeHandle,
        keys={"container_id": level.id, "edge_id": edge.id, "node_id": proj_leaf.id},
        values={"handle": "leaf--top--1"},
    )
    db.commit()
    handles = {
        (h.node_id, h.handle) for h in db.query(GhostEdgeHandle).all()
    }
    assert handles == {
        (proj_leaf.id, "leaf--top--1"),
        (proj_container.id, "container--right--0"),
    }
