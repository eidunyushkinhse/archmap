"""Тесты снимка удаления и восстановления (Undo удаления узла, итерация 2 + R3).

Round-trip: build_deletion_snapshot ДО удаления → delete_node (каскад + чистка
раскладки) → restore возвращает поддерево, инцидентные рёбра и строки раскладки
view_layout С ТЕМИ ЖЕ id/ключами. Внешние сущности снимок не трогает и restore
их не дублирует.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
from app.restore import build_deletion_snapshot, restore_from_snapshot
from app.routers.nodes import delete_node, restore_nodes


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _edge(db, src, tgt, **kw):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id, project_id=ensure_project(db).id, **kw)
    db.add(e)
    return e


def _layout(db, view_id, item_id, payload):
    db.add(
        ViewLayoutItem(
            project_id=ensure_project(db).id,
            view_id=view_id,
            item_id=item_id,
            payload=payload,
        )
    )


def test_snapshot_restore_round_trip(db):
    # Поддерево A → A1 → A1a; снаружи X, Y. Рёбра: внутреннее A1→A1a, исходящее A1a→X,
    # входящее X→A1, чисто внешнее X→Y. Строки раскладки на удаляемых и выживших.
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    a1a = _node(db, "A1a", a1)
    x = _node(db, "X")
    y = _node(db, "Y")
    # Не-дефолтные статусы должны пережить round-trip (регресс: при откате удаления
    # узел «Выводится»/«Планируется» возвращался как «Существует»).
    a.status = "deprecated"
    a1a.status = "planned"
    e_inner = _edge(db, a1, a1a, label="внутр")
    e_out = _edge(db, a1a, x)
    e_in = _edge(db, x, a1, is_synchronous=False)
    e_external = _edge(db, x, y)
    db.commit()

    _layout(db, x.id, str(a1.id), {"x": 1, "y": 2})                      # гость a1 на чужом виде
    _layout(db, a.id, str(x.id), {"x": 3, "y": 4})                       # вид A (умрёт каскадом)
    _layout(db, x.id, f"b:{x.id}>{a1.id}", {"waypoints": [{"x": 7.0, "y": 8.0}], "label_t": 0.3})
    _layout(db, x.id, str(y.id), {"x": 5, "y": 6})                       # обе ссылки живы → выживает
    db.commit()

    # id фиксируем заранее: после delete_node ORM-объекты удалены/просрочены и обращение
    # к их .id уже не пройдёт (DetachedInstanceError).
    a_id, a1_id, a1a_id, x_id, y_id = a.id, a1.id, a1a.id, x.id, y.id
    e_inner_id, e_out_id, e_in_id, e_ext_id = e_inner.id, e_out.id, e_in.id, e_external.id

    snap = build_deletion_snapshot(db, a_id)
    # Снимок повторяет ровно то, что исчезнет: 3 узла, 3 ребра (e_external — чисто
    # внешнее — нет) и 3 строки раскладки (гость, вид A, пучок; строка Y-выживает — нет).
    assert {n.id for n in snap.nodes} == {a_id, a1_id, a1a_id}
    assert {e.id for e in snap.edges} == {e_inner_id, e_out_id, e_in_id}
    assert {it.item_id for it in snap.layout_items} == {str(a1_id), str(x_id), f"b:{x_id}>{a1_id}"}

    delete_node(a_id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert {n.id for n in db.query(Node).all()} == {x_id, y_id}
    assert {e.id for e in db.query(Edge).all()} == {e_ext_id}
    assert db.query(ViewLayoutItem).count() == 1  # выжила только строка Y

    restore_from_snapshot(db, snap, project_id=ensure_project(db).id)

    # Узлы вернулись с теми же id и связями родителя
    nodes = {n.id: n for n in db.query(Node).all()}
    assert set(nodes) == {a_id, a1_id, a1a_id, x_id, y_id}
    assert nodes[a1_id].parent_id == a_id
    assert nodes[a1a_id].parent_id == a1_id
    # Статусы сохранились (а не сбросились в дефолтный existing)
    assert nodes[a_id].status == "deprecated"
    assert nodes[a1a_id].status == "planned"
    assert nodes[a1_id].status == "existing"

    # Рёбра вернулись с id и семантикой
    edges = {e.id: e for e in db.query(Edge).all()}
    assert set(edges) == {e_inner_id, e_out_id, e_in_id, e_ext_id}
    assert edges[e_inner_id].label == "внутр"
    assert edges[e_in_id].is_synchronous is False

    # Раскладка восстановлена и не задублирована (внешняя так и одна)
    items = {(r.view_id, r.item_id): r for r in db.query(ViewLayoutItem).all()}
    assert len(items) == 4
    bundle = items[(x_id, f"b:{x_id}>{a1_id}")]
    assert bundle.payload["waypoints"] == [{"x": 7.0, "y": 8.0}]
    assert bundle.payload["label_t"] == 0.3


def test_get_snapshot_missing_node_404(db):
    from app.routers.nodes import get_deletion_snapshot

    with pytest.raises(HTTPException) as ei:
        get_deletion_snapshot(uuid.uuid4(), db=db, project=ensure_project(db))
    assert ei.value.status_code == 404


def test_restore_conflict_when_nodes_exist(db):
    a = _node(db, "A")
    db.commit()
    snap = build_deletion_snapshot(db, a.id)
    # Узел A не удаляли — restore того же снимка должен упереться в конфликт.
    with pytest.raises(HTTPException) as ei:
        restore_nodes(snap, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 409


def test_restore_conflict_when_parent_gone(db):
    parent = _node(db, "P")
    child = _node(db, "C", parent)
    db.commit()
    snap = build_deletion_snapshot(db, child.id)  # снимок только ребёнка
    delete_node(child.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    delete_node(parent.id, db=db, project=ensure_project(db), user=ensure_architect(db))  # родитель тоже исчез
    with pytest.raises(HTTPException) as ei:
        restore_nodes(snap, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 409


def test_restore_empty_snapshot_400(db):
    from app.schemas.restore import DeletionSnapshot

    empty = DeletionSnapshot(nodes=[], edges=[], layout_items=[])
    with pytest.raises(HTTPException) as ei:
        restore_nodes(empty, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 400


# --- Откат удаления/создания СВЯЗИ (итерация 3): рёберный снимок (nodes=[]) ---


def test_edge_snapshot_restore_round_trip(db):
    # Связь X→Y. Раскладка живёт на ключе ПУЧКА и удаление связи её НЕ сносит
    # (R3): снимок несёт только само ребро, геометрия пучка остаётся ждать его.
    from app.restore import build_edge_deletion_snapshot

    x = _node(db, "X")
    y = _node(db, "Y")
    e = _edge(db, x, y, label="зов", is_synchronous=True, channel="orders.created")
    db.commit()
    _layout(db, x.id, f"b:{x.id}>{y.id}", {"source_handle": "x--right--0"})
    db.commit()
    x_id, y_id, e_id = x.id, y.id, e.id

    snap = build_edge_deletion_snapshot(db, e_id)
    assert snap.nodes == []
    assert {ed.id for ed in snap.edges} == {e_id}
    assert snap.layout_items == []

    # Удаляем связь: узлы и геометрия пучка остаются.
    db.delete(db.get(Edge, e_id))
    db.commit()
    assert db.query(Edge).count() == 0
    assert {n.id for n in db.query(Node).all()} == {x_id, y_id}
    assert db.query(ViewLayoutItem).count() == 1

    restore_from_snapshot(db, snap, project_id=ensure_project(db).id)

    edges = db.query(Edge).all()
    assert len(edges) == 1
    e2 = edges[0]
    assert e2.id == e_id and e2.label == "зов" and e2.is_synchronous is True
    # Канал брокера тоже переживает откат: снимок без него молча терял бы поле
    # (урок «nodeFields без status»).
    assert e2.channel == "orders.created"
    # Геометрия пучка дождалась восстановленную связь (и не задублировалась)
    assert db.query(ViewLayoutItem).count() == 1


def test_edge_snapshot_missing_edge_404(db):
    from app.routers.edges import edge_deletion_snapshot

    with pytest.raises(HTTPException) as ei:
        edge_deletion_snapshot(uuid.uuid4(), db=db, project=ensure_project(db))
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
        restore_nodes(snap, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 409
