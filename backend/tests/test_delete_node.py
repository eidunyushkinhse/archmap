"""Характеризационные тесты удаления узла (F6б + R3).

Фиксируют каскад удаления поддерева: сам узел + потомки любой глубины, все их
рёбра (включая входящие СНАРУЖИ — это и был повод для bulk-костыля). Раскладка
(view_layout): строки СВОИХ видов поддерева умирают каскадом view_id, строки,
ссылающиеся на поддерево из ЧУЖИХ видов (позиции гостей, ключи пучков), чистятся
явно (item_id — строка без FK). Чисто внешние рёбра и чужая раскладка выживают.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
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


def _layout(db, view, item_id, payload):
    row = ViewLayoutItem(
        project_id=ensure_project(db).id,
        view_id=view.id if view is not None else None,
        item_id=item_id,
        payload=payload,
    )
    db.add(row)
    return row


def test_delete_node_cascades_subtree_edges_and_layout(db):
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

    # Раскладка: строки, ссылающиеся на удаляемое поддерево (чистка), свой вид
    # поддерева (каскад view_id) и «чужая» строка, которая должна выжить.
    _layout(db, x, str(a1.id), {"x": 1, "y": 2})                 # позиция гостя a1 на чужом виде → чистка по item_id
    _layout(db, a, str(x.id), {"x": 3, "y": 4})                  # вид A в поддереве → каскад view_id
    _layout(db, x, f"b:{x.id}>{a1.id}", {"source_handle": "h"})  # пучок с концом в поддереве → чистка
    survivor = _layout(db, x, str(y.id), {"x": 5, "y": 6})       # обе ссылки живы → остаётся
    db.commit()

    delete_node(a.id, db=db, project=ensure_project(db), user=ensure_architect(db))

    node_ids = {n.id for n in db.query(Node).all()}
    assert node_ids == {x.id, y.id}  # поддерево A снесено, X и Y живы

    edge_ids = {e.id for e in db.query(Edge).all()}
    assert edge_ids == {e_external.id}  # выжило только чисто внешнее X→Y (X→A1 снесено)
    _ = e_in  # ссылка выше нужна только для создания ребра

    rows = db.query(ViewLayoutItem).all()
    assert len(rows) == 1
    assert rows[0].item_id == survivor.item_id and rows[0].view_id == x.id


def test_delete_missing_node_404(db):
    with pytest.raises(HTTPException) as ei:
        delete_node(uuid.uuid4(), db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 404
