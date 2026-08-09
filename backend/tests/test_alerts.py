"""Тесты глобальных алертов незавершённости схемы (GET /nodes/alerts).

Покрывают три проверки:
1) подвисшие атомарные узлы без связей;
2) связи в промежуточный (контейнерный) узел;
3) изолированные группы — связные компоненты графа рёбер (иерархию
   parent_id игнорируем; зажигается только при ≥2 группах размера ≥2).
"""

import uuid

from conftest import ensure_project

from app.models.edge import Edge
from app.models.node import Node
from app.routers.nodes import get_alerts


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


def test_disconnected_and_intermediate(db):
    # Лист без связей (подвисший), пара связанных листьев, контейнер с ребёнком.
    a = _node(db, "A")
    b = _node(db, "B")
    _node(db, "Подвисший")
    box = _node(db, "Контейнер")
    child = _node(db, "Ребёнок", box)
    _edge(db, a, b)        # нормальная связь лист↔лист
    _edge(db, a, box)      # связь в промежуточный узел
    _edge(db, child, b)    # ребёнок связан → не подвисает (иначе попал бы в disconnected)
    db.commit()

    res = get_alerts(db=db, project=ensure_project(db))

    # «Подвисший» без связей — в disconnected; контейнер (промежуточный) и
    # связанный ребёнок туда не идут.
    assert [d.node_name for d in res.disconnected_nodes] == ["Подвисший"]
    # Ровно одна связь упирается в промежуточный узел (A→Контейнер).
    assert len(res.intermediate_edges) == 1
    ie = res.intermediate_edges[0]
    assert ie.target_name == "Контейнер" and ie.target_is_intermediate
    assert not ie.source_is_intermediate
    # Один связный кластер (A,B,Контейнер,Ребёнок) → фрагментации нет.
    assert res.isolated_groups == []


def test_isolated_groups_when_fragmented(db):
    # Два не связанных между собой кластера: A↔B и В↔Г. Плюс висячий узел —
    # он в группы НЕ попадает (его ловит disconnected).
    a = _node(db, "A")
    b = _node(db, "B")
    v = _node(db, "В")
    g = _node(db, "Г")
    _node(db, "Висячий")
    _edge(db, a, b)
    _edge(db, v, g)
    db.commit()

    res = get_alerts(db=db, project=ensure_project(db))

    assert len(res.isolated_groups) == 2
    groups = sorted(sorted(grp.node_names) for grp in res.isolated_groups)
    assert groups == [["A", "B"], ["В", "Г"]]


def test_single_cluster_plus_dangling_is_not_fragmented(db):
    # Один связный кластер + висячие узлы — это НЕ фрагментация.
    a = _node(db, "A")
    b = _node(db, "B")
    c = _node(db, "C")
    _node(db, "Висячий1")
    _node(db, "Висячий2")
    _edge(db, a, b)
    _edge(db, b, c)
    db.commit()

    res = get_alerts(db=db, project=ensure_project(db))

    assert res.isolated_groups == []
    assert len(res.disconnected_nodes) == 2


# =================== 5) Люди внутри системы ===================

def _person(db, name, parent=None):
    n = _node(db, name, parent)
    n.shape = "person"
    return n


def test_человек_внутри_контейнера_попадает_в_алерт(db):
    # C4: актор живёт на контекстном уровне, ВНЕ границы системы. Промпт импорта
    # это требует, а объекты, заведённые руками, до этой проверки не ловил никто.
    система = _node(db, "Маркетплейс")
    _person(db, "Покупатель", система)
    db.commit()

    out = get_alerts(db=db, project=ensure_project(db), _=None)

    assert [(p.node_name, p.parent_name) for p in out.persons_inside] == [("Покупатель", "Маркетплейс")]


def test_человек_в_корне_алерт_не_зажигает(db):
    система = _node(db, "Маркетплейс")
    _person(db, "Покупатель")
    _edge(db, _person(db, "Продавец"), система)
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).persons_inside == []


def test_обычный_узел_внутри_контейнера_не_человек(db):
    # Проверка бьёт именно по форме узла, а не по вложенности как таковой.
    система = _node(db, "Маркетплейс")
    _node(db, "Сервис заказов", система)
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).persons_inside == []
