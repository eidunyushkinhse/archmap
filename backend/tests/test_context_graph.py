"""Тесты «Схемы» страницы объекта (GET /nodes/{id}/context-graph, single-schema).

Контекст объекта в формате сырого графа уровня — виртуальный корневой уровень:
локалы = фокус + представители соседей (связанные сиблинги), рёбра сырые
(внутренние поддерева + граничные + сосед↔сосед), реестр концов с цепочками
предков, раскладка — КОРНЕВОГО вида. Критерии заказчика: страница корневого
узла совпадает с корневым холстом (сохранённые позиции корня), страница
вложенного узла раскладывается как корень отдельного проекта (свежий ELK —
строк корневого вида для этих узлов нет).
"""

import uuid

from conftest import ensure_project

from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
from app.routers.nodes import get_node_context_graph


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


def _layout_row(db, view, item, x=None, y=None, expanded=None):
    payload = {}
    if x is not None:
        payload["x"] = x
    if y is not None:
        payload["y"] = y
    if expanded is not None:
        payload["expanded"] = expanded
    db.add(
        ViewLayoutItem(
            project_id=ensure_project(db).id,
            view_id=view.id if view else None,
            item_id=str(item.id),
            payload=payload,
        )
    )


def test_root_focus_locals_are_connected_roots_with_root_layout(db, project):
    # Корневой фокус A (⊃ A1), корневые B (сосед через глубокое ребро A1→B),
    # C (сосед по прямому ребру C→A) и D (НЕ связан — не должен попасть).
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    b = _node(db, "B")
    c = _node(db, "C")
    d = _node(db, "D")
    _edge(db, c, d)  # ребро несвязанных с фокусом — не попадает
    e_deep = _edge(db, a1, b)
    e_direct = _edge(db, c, a)
    e_nn = _edge(db, b, c)  # сосед↔сосед — попадает (как на корневом холсте)
    _layout_row(db, None, a, x=10, y=20)
    _layout_row(db, None, b, x=300, y=40)
    db.commit()

    g = get_node_context_graph(a.id, db=db, project=project, _=None)

    # Локалы: фокус первым + связанные корневые соседи; D исключён.
    assert g.nodes[0].id == a.id
    assert {n.id for n in g.nodes} == {a.id, b.id, c.id}
    # Рёбра сырые: концы реальные (a1, не a); сосед↔сосед включён, c→d — нет.
    assert {e.id for e in g.edges} == {e_deep.id, e_direct.id, e_nn.id}
    raw = next(e for e in g.edges if e.id == e_deep.id)
    assert (raw.source_id, raw.target_id) == (a1.id, b.id)
    # Реестр — глубокий конец a1 с цепочкой предков (для проекции/R5).
    assert {ep.id for ep in g.endpoints} == {a1.id}
    assert [x.id for x in g.endpoints[0].ancestors] == [a.id]
    # Раскладка — строки корневого вида.
    assert set(g.layout) == {str(a.id), str(b.id)}
    assert g.layout[str(a.id)].x == 10


def test_nested_focus_reps_are_connected_siblings_layout_still_root(db, project):
    # P ⊃ {F(фокус) ⊃ F1, S ⊃ S1, T}; сосед — S1 (глубокий, через F1→S1):
    # представитель S (сиблинг), несвязанный сиблинг T исключён. Внутреннее
    # ребро F→F1 включено (питает раскрытие R5). Раскладка — корневого вида,
    # строки вида P (сохранённые позиции уровня родителя) НЕ отдаются.
    p = _node(db, "P")
    f = _node(db, "F", p)
    f1 = _node(db, "F1", f)
    s = _node(db, "S", p)
    s1 = _node(db, "S1", s)
    _node(db, "T", p)
    e_inner = _edge(db, f, f1)
    e_cross = _edge(db, f1, s1)
    _layout_row(db, None, p, x=5, y=5)  # корневой вид: позиция P
    _layout_row(db, p, f, x=100, y=100)  # вид родителя — НЕ должен попасть
    db.commit()

    g = get_node_context_graph(f.id, db=db, project=project, _=None)

    assert g.nodes[0].id == f.id
    assert {n.id for n in g.nodes} == {f.id, s.id}
    # У представителя досчитаны дети (лупа R5 и бейдж на странице).
    rep = next(n for n in g.nodes if n.id == s.id)
    assert rep.has_children and rep.child_count == 1
    assert {e.id for e in g.edges} == {e_inner.id, e_cross.id}
    # Реестр: глубокие концы обоих поддеревьев с цепочками (подъём к фокусу/S).
    assert {ep.id for ep in g.endpoints} == {f1.id, s1.id}
    s1_entry = next(ep for ep in g.endpoints if ep.id == s1.id)
    assert [x.id for x in s1_entry.ancestors] == [p.id, s.id]
    # Раскладка — только корневой вид (свежий ELK для узлов контекста).
    assert set(g.layout) == {str(p.id)}


def test_edge_between_rep_subtree_and_neighbor_only_is_excluded(db, project):
    # P ⊃ {F, S ⊃ {S1, S2}}; сосед фокуса — только S1 (F→S1). Ребро S2→S1 лежит
    # в поддереве представителя, но S2 — не сосед: в контекст не попадает
    # (в «отдельном проекте» из объекта и соседей узла S2 нет).
    p = _node(db, "P")
    f = _node(db, "F", p)
    s = _node(db, "S", p)
    s1 = _node(db, "S1", s)
    s2 = _node(db, "S2", s)
    e_cross = _edge(db, f, s1)
    _edge(db, s2, s1)
    db.commit()

    g = get_node_context_graph(f.id, db=db, project=project, _=None)

    assert {e.id for e in g.edges} == {e_cross.id}
    assert {n.id for n in g.nodes} == {f.id, s.id}


def test_neighbor_outside_parent_stays_in_registry(db, project):
    # P ⊃ F, корневой X — сосед (F→X): X не сиблинг фокуса, локалом не
    # становится — остаётся концом реестра (на странице — гость вне рамки).
    p = _node(db, "P")
    f = _node(db, "F", p)
    x = _node(db, "X")
    e = _edge(db, f, x)
    db.commit()

    g = get_node_context_graph(f.id, db=db, project=project, _=None)

    assert {n.id for n in g.nodes} == {f.id}
    assert {e_.id for e_ in g.edges} == {e.id}
    assert {ep.id for ep in g.endpoints} == {x.id}
    assert g.endpoints[0].ancestors == []


def test_leaf_without_edges_is_bare_focus(db, project):
    leaf = _node(db, "Лист")
    db.commit()

    g = get_node_context_graph(leaf.id, db=db, project=project, _=None)

    assert [n.id for n in g.nodes] == [leaf.id]
    assert g.edges == [] and g.endpoints == []
