"""Характеризационные тесты СЫРОГО графа уровня (R2 вид-центричного движка).

_build_graph больше НЕ проецирует концы рёбер: отдаёт рёбра, затрагивающие
поддерево уровня, с реальными концами + реестр не-локальных концов (endpoints)
с цепочками предков. Проекция (подъём к ближайшему видимому представителю) —
на фронтенде (graph/projection.ts, projection.test.ts).
"""

import uuid

from conftest import ensure_project

from app.graph_queries import build_graph as _build_graph
from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
from app.tree import collect_subtree_ids_db


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

    ids = collect_subtree_ids_db(db, a.id)
    assert ids == {a.id, a1.id, a1a.id}


def test_collect_subtree_ids_leaf(db):
    a = _node(db, "A")
    db.commit()
    assert collect_subtree_ids_db(db, a.id) == {a.id}


# =================== _build_graph: сырые рёбра + реестр концов ===================

def test_deep_edge_is_sent_raw_with_endpoint_registry(db):
    # A→A1, B→B1, ребро между глубокими листами A1→B1. Корневой уровень: ребро
    # отдаётся с РЕАЛЬНЫМИ концами, оба конца — в реестре endpoints с предками.
    a = _node(db, "A")
    b = _node(db, "B")
    a1 = _node(db, "A1", a)
    b1 = _node(db, "B1", b)
    e = _edge(db, a1, b1)
    db.commit()

    graph = _build_graph(
        local_nodes=[a, b],
        container_id=None,
        all_nodes=_all_nodes(a, b, a1, b1),
        all_edges=[e],
        db=db,
        project_id=ensure_project(db).id,
    )
    assert len(graph.edges) == 1
    assert graph.edges[0].source_id == a1.id
    assert graph.edges[0].target_id == b1.id
    # оба глубоких конца — в реестре, с цепочками предков для фронтовой проекции
    by_id = {ep.id: ep for ep in graph.endpoints}
    assert set(by_id) == {a1.id, b1.id}
    assert [x.id for x in by_id[a1.id].ancestors] == [a.id]
    assert [x.id for x in by_id[b1.id].ancestors] == [b.id]


def test_inner_edge_of_child_is_sent_raw(db):
    # Оба конца внутри одного ребёнка A: ребро ОТДАЁТСЯ сырым (подавление «оба
    # конца поднялись в один локал» — забота фронтовой проекции; сырые внутренние
    # рёбра нужны будущему раскрытию локальных контейнеров, R5).
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
        project_id=ensure_project(db).id,
    )
    assert len(graph.edges) == 1
    assert graph.edges[0].source_id == a1.id
    assert graph.edges[0].target_id == a2.id
    assert {ep.id for ep in graph.endpoints} == {a1.id, a2.id}


def test_sublevel_external_end_in_registry(db):
    # Уровень внутри A. Ребро A1→B1: ближний конец локальный (A1, в реестр не
    # попадает), дальний (B1) — вне поддерева A → в реестре с предком B.
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
        project_id=ensure_project(db).id,
    )
    assert len(graph.edges) == 1
    assert graph.edges[0].source_id == a1.id
    assert graph.edges[0].target_id == b1.id
    assert {ep.id for ep in graph.endpoints} == {b1.id}
    # предок конца — B (корень → непосредственный родитель)
    assert [x.id for x in graph.endpoints[0].ancestors] == [b.id]


def test_fully_external_edge_is_skipped(db):
    # Ребро B1→B2: не затрагивает поддерево A ни одним концом → не отдаётся.
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
        project_id=ensure_project(db).id,
    )
    assert graph.edges == []
    assert graph.endpoints == []


# =================== _build_graph: раскладка вида без фильтра, чтение не пишет (F6а) ===================

def test_read_returns_all_rows_and_does_not_mutate_db(db):
    # Раскладка вида отдаётся БЕЗ фильтра по «валидным проекциям»: какая проекция
    # показана — решает фронт, лишние ключи безвредны (ищутся по id сущности).
    a = _node(db, "A")
    b = _node(db, "B")
    a1 = _node(db, "A1", a)
    b1 = _node(db, "B1", b)
    other = _node(db, "Other")
    e = _edge(db, a1, b1)
    db.commit()

    project_id = ensure_project(db).id
    db.add(ViewLayoutItem(project_id=project_id, view_id=a.id, item_id=str(b.id), payload={"x": 10, "y": 20}))
    db.add(ViewLayoutItem(project_id=project_id, view_id=a.id, item_id=str(other.id), payload={"x": 99, "y": 99}))
    db.commit()

    graph = _build_graph(
        local_nodes=[a1],
        container_id=a.id,
        all_nodes=_all_nodes(a, b, a1, b1, other),
        all_edges=[e],
        db=db,
        project_id=ensure_project(db).id,
    )
    assert graph.layout[str(b.id)].x == 10
    assert graph.layout[str(other.id)].x == 99
    # чтение НЕ мутировало БД (F6а): обе строки на месте
    remaining = {r.item_id for r in db.query(ViewLayoutItem).all()}
    assert remaining == {str(b.id), str(other.id)}


# =================== has_status_info: признак ПРОЕКТНЫЙ, не уровневый ===================

def test_has_status_info_true_when_statuses_lежат_глубже(db):
    # Сценарий пользователя (2026-08-09): переключатель «Вид схемы» пропадал, когда
    # architect стоял на уровне, где все узлы existing, а planned/deprecated лежали
    # уровнем ниже. Признак считается по ВСЕМУ проекту, поэтому здесь он True.
    root = _node(db, "Система")
    child = _node(db, "PWA", root)
    child.status = "planned"
    db.commit()

    graph = _build_graph(
        local_nodes=[root], container_id=None,
        all_nodes=_all_nodes(root, child), all_edges=[], db=db, project_id=ensure_project(db).id,
    )

    assert all(n.status == "existing" for n in graph.nodes)  # на уровне статусов нет
    assert graph.has_status_info is True


def test_has_status_info_false_когда_проект_без_статусов(db):
    root = _node(db, "Система")
    _node(db, "API", root)
    db.commit()

    graph = _build_graph(
        local_nodes=[root], container_id=None,
        all_nodes=_all_nodes(root), all_edges=[], db=db, project_id=ensure_project(db).id,
    )

    assert graph.has_status_info is False


# =================== пустой уровень (эпик «связи, упирающиеся в рамку») ===================

def test_пустой_уровень_отдаёт_собственные_связи_контейнера(db):
    # Пользователь вошёл в АТОМАРНЫЙ узел: детей нет, но свои связи у него есть.
    # Они обязаны доехать до фронта — там стрелка упирается в рамку пустого слоя.
    # Раньше build_graph вообще не звали (ранний return с пустым GraphResponse),
    # а сам он падал бы на local_nodes[0].project_id.
    atom = _node(db, "Атом")
    peer = _node(db, "Сосед")
    e = _edge(db, peer, atom)
    db.commit()

    graph = _build_graph(
        local_nodes=[],
        container_id=atom.id,
        all_nodes=_all_nodes(atom, peer),
        all_edges=[e],
        db=db,
        project_id=ensure_project(db).id,
    )

    assert graph.nodes == []
    assert [x.id for x in graph.edges] == [e.id]
    # дальний конец — в реестре (фронт материализует его гостем), сам контейнер тоже:
    # он не локал уровня, а именно он и есть конец связи
    assert {g.id for g in graph.endpoints} == {peer.id, atom.id}


def test_пустой_уровень_без_своих_связей_отдаёт_пусто(db):
    atom = _node(db, "Атом")
    other_a = _node(db, "Чужой А")
    other_b = _node(db, "Чужой Б")
    e = _edge(db, other_a, other_b)
    db.commit()

    graph = _build_graph(
        local_nodes=[],
        container_id=atom.id,
        all_nodes=_all_nodes(atom, other_a, other_b),
        all_edges=[e],
        db=db,
        project_id=ensure_project(db).id,
    )

    assert graph.nodes == []
    assert graph.edges == []


def test_роутер_пустого_уровня_больше_не_отдаёт_заглушку(db):
    # Регрессия V16: get_node_graph делал ранний return с пустым GraphResponse, и
    # собственные связи контейнера до фронта не доезжали вовсе.
    from app.routers.nodes import get_node_graph

    atom = _node(db, "Атом")
    peer = _node(db, "Сосед")
    _edge(db, atom, peer)
    db.commit()

    graph = get_node_graph(atom.id, db=db, project=ensure_project(db), _=None)

    assert graph.nodes == []
    assert len(graph.edges) == 1
    assert {g.id for g in graph.endpoints} == {peer.id, atom.id}
    # курсоры уровня отдаются как у непустого — клиенту есть от чего считать поллинг
    assert graph.version is not None
    assert graph.graph_rev is not None
