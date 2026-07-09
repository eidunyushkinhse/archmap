"""Тесты контекстной схемы узла (GET /nodes/{id}/context).

Регрессия 2026-07-09: после R3 (view_layout снёс колонки хэндлов с Edge)
эндпоинт падал с AttributeError на e.source_handle — тестов на него не было.
Здесь характеризация: проекция концов на фокус/соседа, original_*, соседи.
"""

import uuid

from conftest import ensure_project

from app.models.edge import Edge
from app.models.node import Node
from app.routers.nodes import get_node_context


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _edge(db, src, tgt, label=None):
    e = Edge(
        id=uuid.uuid4(),
        source_id=src.id,
        target_id=tgt.id,
        label=label,
        project_id=ensure_project(db).id,
    )
    db.add(e)
    return e


def test_context_projects_deep_end_to_focus(db, project):
    # A ⊃ A1; ребро A1→B. Контекст A: конец A1 (в поддереве) проецируется на фокус,
    # сосед — B; original_* несут реальные концы для модалки деталей.
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    b = _node(db, "B")
    e = _edge(db, a1, b, label="шлёт")
    db.commit()

    ctx = get_node_context(a.id, db=db, project=project, _=None)

    assert ctx.focus.id == a.id
    assert [n.id for n in ctx.neighbors] == [b.id]
    assert len(ctx.edges) == 1
    ce = ctx.edges[0]
    assert (ce.source_id, ce.target_id) == (a.id, b.id)  # проекция на фокус
    assert (ce.original_source_id, ce.original_target_id) == (a1.id, b.id)
    assert ce.original_source_name == "A1"
    assert ce.id == e.id


def test_context_incoming_edge_and_no_internal(db, project):
    # Входящее ребро B→A1 проецируется соседом-источником; внутренняя связь
    # A1→A2 (оба конца в поддереве фокуса) в контекст не попадает.
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    a2 = _node(db, "A2", a)
    b = _node(db, "B")
    _edge(db, b, a1)
    _edge(db, a1, a2)
    db.commit()

    ctx = get_node_context(a.id, db=db, project=project, _=None)

    assert [n.id for n in ctx.neighbors] == [b.id]
    assert len(ctx.edges) == 1
    assert (ctx.edges[0].source_id, ctx.edges[0].target_id) == (b.id, a.id)


def test_context_leaf_without_edges_is_empty(db, project):
    leaf = _node(db, "Лист")
    db.commit()

    ctx = get_node_context(leaf.id, db=db, project=project, _=None)

    assert ctx.focus.id == leaf.id
    assert ctx.neighbors == []
    assert ctx.edges == []
