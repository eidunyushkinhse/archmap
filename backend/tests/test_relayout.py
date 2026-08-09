"""Тесты команды «Переразложить уровень» (own-on-first-render, Ф2 + R3).

Эндпоинт стирает ручной layout одного вида → авто-раскладка: удаляются строки
view_layout этого вида (позиции локалов/гостей и геометрия пучков разом).
Строки с флагом expanded СОХРАНЯЮТСЯ без координат — раскрытия переживают
сброс (решение 2026-08-05). Слой соседнего вида и другие виды не трогаются
(скоуп строго по view_id).
"""

import uuid

import pytest
from conftest import ensure_project
from fastapi import HTTPException

from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
from app.routers.nodes import relayout_level, relayout_root_level


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


def _layout(db, view_id, item_id, payload):
    db.add(
        ViewLayoutItem(
            project_id=ensure_project(db).id,
            view_id=view_id,
            item_id=item_id,
            payload=payload,
        )
    )


def _view_items(db, view_id):
    q = db.query(ViewLayoutItem)
    q = q.filter(ViewLayoutItem.view_id.is_(None)) if view_id is None else q.filter(
        ViewLayoutItem.view_id == view_id
    )
    return q.count()


def _view_rows(db, view_id):
    q = db.query(ViewLayoutItem)
    q = q.filter(ViewLayoutItem.view_id.is_(None)) if view_id is None else q.filter(
        ViewLayoutItem.view_id == view_id
    )
    return q.all()


def test_relayout_level_clears_only_this_view(db):
    # Вид контейнера C: позиции локалов c1/c2, позиция гостя g и геометрия пучка.
    # Соседний вид D со своими строками и корневой вид — должны выжить.
    c = _node(db, "C")
    c1 = _node(db, "C1", c)
    _node(db, "C2", c)
    g = _node(db, "G")
    d = _node(db, "D")
    _edge(db, c1, g)
    db.commit()

    _layout(db, c.id, str(c1.id), {"x": 10, "y": 20})
    _layout(db, c.id, str(g.id), {"x": 1, "y": 2})
    _layout(db, c.id, f"b:{c1.id}>{g.id}", {"waypoints": [{"x": 5, "y": 6}]})
    _layout(db, d.id, str(g.id), {"x": 7, "y": 8})
    _layout(db, None, str(c.id), {"x": 99, "y": 99})
    db.commit()

    relayout_level(c.id, db=db, project=ensure_project(db))

    assert _view_items(db, c.id) == 0        # вид C очищен (раскрытий в нём не было)
    assert _view_items(db, d.id) == 1        # соседний вид не тронут
    assert _view_items(db, None) == 1        # корневой вид не тронут


def test_relayout_preserves_expanded_rows(db):
    # Раскрытия переживают сброс: строка с expanded=True остаётся БЕЗ координат
    # (фронт пересевает позиции ELK'ом, флаг читается из view_layout); строки
    # позиций и легаси-геометрия пучков удаляются. Проверяем на корневом виде.
    cont = _node(db, "Cont")
    _node(db, "Child", cont)
    other = _node(db, "Other")
    db.commit()

    _layout(db, None, str(cont.id), {"x": 10, "y": 20, "expanded": True})
    _layout(db, None, str(other.id), {"x": 30, "y": 40})
    _layout(db, None, f"b:{cont.id}>{other.id}", {"waypoints": [{"x": 5, "y": 6}]})
    db.commit()

    relayout_root_level(db=db, project=ensure_project(db))

    rows = _view_rows(db, None)
    assert len(rows) == 1                    # выжила только expanded-строка
    kept = rows[0]
    assert kept.item_id == str(cont.id)
    assert kept.payload == {"expanded": True}  # координаты и прочее стерты


def test_relayout_keeps_expanded_inside_level_view(db):
    # То же для уровня контейнера: раскрытый локал вида C переживает его сброс.
    c = _node(db, "C")
    inner = _node(db, "Inner", c)
    inner_kid = _node(db, "InnerKid", inner)
    _node(db, "Plain", c)
    db.commit()

    _layout(db, c.id, str(inner.id), {"x": 1, "y": 2, "expanded": True})
    _layout(db, c.id, str(inner_kid.id), {"x": 3, "y": 4})
    db.commit()

    relayout_level(c.id, db=db, project=ensure_project(db))

    rows = _view_rows(db, c.id)
    assert len(rows) == 1
    assert rows[0].item_id == str(inner.id)
    assert rows[0].payload == {"expanded": True}
    # дети раскрытого контейнера positions потеряли — пересеются авто-раскладкой
    assert _view_items(db, c.id) == 1


def test_relayout_root_clears_root_view_only(db):
    r1 = _node(db, "R1")
    cont = _node(db, "Cont")
    child = _node(db, "Child", cont)
    db.commit()

    _layout(db, None, str(r1.id), {"x": 10, "y": 20})
    _layout(db, None, str(cont.id), {"x": 0, "y": 0})
    _layout(db, cont.id, str(child.id), {"x": 50, "y": 60})
    db.commit()

    relayout_root_level(db=db, project=ensure_project(db))

    assert _view_items(db, None) == 0        # корневой вид очищен
    assert _view_items(db, cont.id) == 1     # вид контейнера не тронут


def test_relayout_missing_level_404(db):
    with pytest.raises(HTTPException) as ei:
        relayout_level(uuid.uuid4(), db=db, project=ensure_project(db))
    assert ei.value.status_code == 404
