"""Тесты единого хранилища раскладки (R3): PUT /views/{id}/layout + отдача в графе.

Батч items: payload — апсерт строки (повторная запись обновляет, не плодит дубли),
null — удаление (сброс в авто). Вид "root" — корневой (view_id IS NULL). Граф
уровня отдаёт строки вида как есть (layout: item_id → payload).
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
from app.routers.nodes import get_node_graph, get_root_graph
from app.routers.views import save_view_layout
from app.schemas.node import ViewLayoutBatch, ViewLayoutPayload


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


def _put(db, view_id: str, items: dict) -> None:
    save_view_layout(
        view_id,
        ViewLayoutBatch(items=items),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )


def test_batch_upserts_updates_and_deletes(db):
    c = _node(db, "C")
    c1 = _node(db, "C1", c)
    c2 = _node(db, "C2", c)
    db.commit()

    # Вставка: позиция и раскрытие одним батчем.
    _put(db, str(c.id), {
        str(c1.id): ViewLayoutPayload(x=10, y=20),
        str(c2.id): ViewLayoutPayload(expanded=True),
    })
    rows = {r.item_id: r for r in db.query(ViewLayoutItem).all()}
    assert rows[str(c1.id)].payload == {"x": 10.0, "y": 20.0}
    assert rows[str(c2.id)].payload == {"expanded": True}

    # Апсерт: повторная запись обновляет строку, не плодит дубль.
    _put(db, str(c.id), {str(c1.id): ViewLayoutPayload(x=111, y=222)})
    rows = db.query(ViewLayoutItem).filter(ViewLayoutItem.item_id == str(c1.id)).all()
    assert len(rows) == 1 and rows[0].payload == {"x": 111.0, "y": 222.0}

    # null — сброс: строка удаляется.
    _put(db, str(c.id), {str(c2.id): None})
    assert db.query(ViewLayoutItem).filter(ViewLayoutItem.item_id == str(c2.id)).count() == 0
    # удаление несуществующего ключа — no-op, не ошибка
    _put(db, str(c.id), {"b:нет>такого": None})


def test_root_view_and_graph_payload(db):
    # Корневой вид ("root", view_id IS NULL): позиции корневых узлов отдаются в
    # GET /nodes/graph как layout. Легаси-строка пучка (ручной слой стрелок,
    # удалён 2026-07-09) в отдачу НЕ попадает — живых полей у неё нет.
    r1 = _node(db, "R1")
    r2 = _node(db, "R2")
    db.commit()
    _edge(db, r1, r2)
    db.commit()
    bundle = f"b:{r1.id}>{r2.id}"

    _put(db, "root", {str(r1.id): ViewLayoutPayload(x=1, y=2)})
    # легаси-строка пучка с ручной геометрией — прямо в БД (как от старой версии)
    db.add(ViewLayoutItem(
        project_id=ensure_project(db).id, view_id=None, item_id=bundle,
        payload={"source_handle": f"{r1.id}--right--1", "waypoints": [{"x": 5, "y": 6}]},
    ))
    db.commit()

    graph = get_root_graph(db=db, project=ensure_project(db), _=ensure_architect(db))
    assert graph.layout[str(r1.id)].x == 1
    assert bundle not in graph.layout  # мусор ручного слоя не отдаётся


def test_level_graph_returns_only_its_view(db):
    # Строки чужого вида в graph уровня не попадают.
    c = _node(db, "C")
    c1 = _node(db, "C1", c)
    d = _node(db, "D")
    _node(db, "D1", d)
    db.commit()

    _put(db, str(c.id), {str(c1.id): ViewLayoutPayload(x=10, y=20)})
    _put(db, str(d.id), {str(c1.id): ViewLayoutPayload(x=77, y=88)})

    graph = get_node_graph(c.id, db=db, project=ensure_project(db), _=ensure_architect(db))
    assert graph.layout[str(c1.id)].x == 10
    assert len(graph.layout) == 1
