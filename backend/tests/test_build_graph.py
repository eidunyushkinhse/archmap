"""Характеризационные тесты проекции графа уровня.

Фиксируют ТЕКУЩЕЕ поведение _build_graph / find_effective (проекция сквозных
рёбер, набор ghost_ids, GC valid_keys) и _collect_subtree_ids, чтобы предстоящий
рефактор бэкенда (REFACTOR_PLAN.md, F6 + Фазы) не изменил его незаметно.
"""

import uuid

from app.models.node import Node
from app.models.edge import Edge
from app.models.ghost_position import GhostPosition
from app.routers.nodes import _build_graph, _collect_subtree_ids


def _node(db, name, parent=None):
    n = Node(id=uuid.uuid4(), name=name, parent_id=parent.id if parent else None)
    db.add(n)
    return n


def _edge(db, src, tgt):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id)
    db.add(e)
    return e


def _all_nodes(*nodes):
    return {n.id: n for n in nodes}


# =================== _collect_subtree_ids ===================

def test_collect_subtree_ids_returns_node_and_all_descendants(db):
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    a1a = _node(db, "A1a", a1)
    b = _node(db, "B")  # чужое поддерево — не должно попасть
    _node(db, "B1", b)
    db.commit()

    ids = _collect_subtree_ids(db, a.id)
    assert ids == {a.id, a1.id, a1a.id}


def test_collect_subtree_ids_leaf(db):
    a = _node(db, "A")
    db.commit()
    assert _collect_subtree_ids(db, a.id) == {a.id}


# =================== _build_graph: проекция сквозных рёбер ===================

def test_deep_edge_projects_up_to_roots_at_root_level(db):
    # A→A1, B→B1, ребро между глубокими листами A1→B1.
    a = _node(db, "A")
    b = _node(db, "B")
    a1 = _node(db, "A1", a)
    b1 = _node(db, "B1", b)
    e = _edge(db, a1, b1)
    db.commit()

    # Корневой уровень: container_id=None, локальные узлы = корни.
    graph = _build_graph(
        local_nodes=[a, b],
        container_id=None,
        all_nodes=_all_nodes(a, b, a1, b1),
        all_edges=[e],
        db=db,
    )
    assert len(graph.edges) == 1
    assert graph.edges[0].source_id == a.id
    assert graph.edges[0].target_id == b.id
    # на корне внешних узлов нет — гостей не образуется
    assert graph.ghost_nodes == []


def test_self_projection_edge_is_suppressed(db):
    # Оба конца ребра проецируются на один и тот же локальный узел A → ребро скрыто.
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    a2 = _node(db, "A2", a)
    e = _edge(db, a1, a2)
    db.commit()

    graph = _build_graph(
        local_nodes=[a],
        container_id=None,
        all_nodes=_all_nodes(a, a1, a2),
        all_edges=[e],
        db=db,
    )
    assert graph.edges == []


def test_sublevel_external_end_becomes_ghost(db):
    # Уровень внутри A. Ребро A1→B1: ближний конец локальный (A1), дальний (B1) —
    # вне поддерева A → гость, показываемый самим листом B1 с предком B.
    a = _node(db, "A")
    b = _node(db, "B")
    a1 = _node(db, "A1", a)
    b1 = _node(db, "B1", b)
    e = _edge(db, a1, b1)
    db.commit()

    graph = _build_graph(
        local_nodes=[a1],
        container_id=a.id,
        all_nodes=_all_nodes(a, b, a1, b1),
        all_edges=[e],
        db=db,
    )
    assert len(graph.edges) == 1
    assert graph.edges[0].source_id == a1.id
    assert graph.edges[0].target_id == b1.id
    ghost_ids = {g.id for g in graph.ghost_nodes}
    assert ghost_ids == {b1.id}
    # предок гостя — B (корень → непосредственный родитель)
    ghost = graph.ghost_nodes[0]
    assert [a.id for a in ghost.ancestors] == [b.id]


def test_fully_external_edge_is_skipped(db):
    # Ребро B1→B2: оба конца вне уровня A → ребра на уровне нет, гостей нет.
    a = _node(db, "A")
    b = _node(db, "B")
    a1 = _node(db, "A1", a)
    b1 = _node(db, "B1", b)
    b2 = _node(db, "B2", b)
    e = _edge(db, b1, b2)
    db.commit()

    graph = _build_graph(
        local_nodes=[a1],
        container_id=a.id,
        all_nodes=_all_nodes(a, b, a1, b1, b2),
        all_edges=[e],
        db=db,
    )
    assert graph.edges == []
    assert graph.ghost_nodes == []


# =================== _build_graph: valid_keys фильтрует ответ, чтение не пишет (F6а) ===================

def test_read_returns_valid_position_and_does_not_mutate_db(db):
    # Уровень A, гость B1 (ребро A1→B1). valid_keys = {B1, B} (сам лист + предок-контейнер
    # ниже общей с уровнем рамки). Позиция для B валидна, для постороннего узла — нет.
    a = _node(db, "A")
    b = _node(db, "B")
    a1 = _node(db, "A1", a)
    b1 = _node(db, "B1", b)
    other = _node(db, "Other")
    e = _edge(db, a1, b1)
    db.commit()

    # B — допустимая проекция (свёрнутый контейнер), Other — нет.
    db.add(GhostPosition(container_id=a.id, node_id=b.id, pos_x=10, pos_y=20))
    db.add(GhostPosition(container_id=a.id, node_id=other.id, pos_x=99, pos_y=99))
    db.commit()

    graph = _build_graph(
        local_nodes=[a1],
        container_id=a.id,
        all_nodes=_all_nodes(a, b, a1, b1, other),
        all_edges=[e],
        db=db,
    )
    # валидная позиция отдана фронту по ключу id отображаемой сущности (B)
    assert str(b.id) in graph.level_positions
    assert graph.level_positions[str(b.id)].pos_x == 10
    # невалидная (Other) в ответ НЕ попала
    assert str(other.id) not in graph.level_positions
    # но чтение НЕ мутировало БД (F6а): обе строки на месте, в т.ч. семантически устаревшая
    remaining = {r.node_id for r in db.query(GhostPosition).all()}
    assert remaining == {b.id, other.id}
