"""Перенос узла на другой уровень вложенности (смена parent_id).

Две вещи, ради которых модуль app/reparent.py и появился:
  • ЗАПРЕТЫ — контракт принимал любой parent_id, включая собственного потомка
    (поддерево отрывалось от корня и терялось из дерева насовсем);
  • РАСКЛАДКА — позиции переехавшего поддерева во ВНЕШНИХ видах перестают что-либо
    значить, а внутри поддерева остаются верны.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app import reparent
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
from app.routers.nodes import update_node
from app.schemas.node import NodeUpdate


def _node(db, name, parent=None, shape="service"):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        shape=shape,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    db.flush()
    return n


def _row(db, view_id, item_id, x=1.0, y=2.0):
    r = ViewLayoutItem(
        id=uuid.uuid4(),
        project_id=ensure_project(db).id,
        view_id=view_id,
        item_id=str(item_id),
        payload={"x": x, "y": y},
    )
    db.add(r)
    db.flush()
    return r


def _move(db, node, new_parent_id):
    return update_node(
        node.id,
        NodeUpdate(parent_id=new_parent_id),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


# ── Запреты ───────────────────────────────────────────────────────────────────


def test_нельзя_в_самого_себя(db):
    a = _node(db, "A")
    assert reparent.validate_reparent(db, ensure_project(db), a, a.id) is not None


def test_нельзя_внутрь_собственного_потомка(db):
    root = _node(db, "Платформа")
    kid = _node(db, "Биллинг", root)
    grand = _node(db, "Воркер", kid)
    # И прямой ребёнок, и внук — оба потомки: цикл оторвал бы поддерево от корня.
    assert reparent.validate_reparent(db, ensure_project(db), root, kid.id) is not None
    assert reparent.validate_reparent(db, ensure_project(db), root, grand.id) is not None


def test_нельзя_внутрь_формы_без_детей(db):
    a = _node(db, "A")
    for shape in ("database", "broker", "person"):
        target = _node(db, f"цель-{shape}", shape=shape)
        assert reparent.validate_reparent(db, ensure_project(db), a, target.id) is not None


def test_человека_нельзя_вложить_но_можно_вынести(db):
    box = _node(db, "Платформа")
    person = _node(db, "Оператор", box, shape="person")
    p = ensure_project(db)
    assert reparent.validate_reparent(db, p, person, box.id) is not None
    # Вынос наружу разрешён всегда — иначе алерт AL25 снова стал бы тупиком.
    assert reparent.validate_reparent(db, p, person, None) is None


def test_разрешённый_перенос_причины_не_имеет(db):
    a = _node(db, "A")
    box = _node(db, "Контейнер")
    assert reparent.validate_reparent(db, ensure_project(db), a, box.id) is None


def test_запрет_возвращается_ошибкой_400(db):
    root = _node(db, "Платформа")
    kid = _node(db, "Биллинг", root)
    with pytest.raises(HTTPException) as e:
        _move(db, root, kid.id)
    assert e.value.status_code == 400


# ── Раскладка ─────────────────────────────────────────────────────────────────


def test_перенос_снимает_позиции_во_внешних_видах(db):
    старый = _node(db, "Старый дом")
    новый = _node(db, "Новый дом")
    узел = _node(db, "Переезжающий", старый)
    # Позиция в виде старого родителя (смотрели внутрь) и в корневом виде (старый
    # родитель был раскрыт рамкой — ребёнок показан на уровне-предке).
    _row(db, старый.id, узел.id)
    _row(db, None, узел.id)
    # Чужая строка того же вида — переезд её не касается.
    сосед = _node(db, "Сосед", старый)
    _row(db, старый.id, сосед.id)

    _move(db, узел, новый.id)

    остались = {(r.view_id, r.item_id) for r in db.query(ViewLayoutItem).all()}
    assert остались == {(старый.id, str(сосед.id))}


def test_внутренняя_раскладка_поддерева_переезжает_целой(db):
    старый = _node(db, "Старый дом")
    новый = _node(db, "Новый дом")
    узел = _node(db, "Переезжающий", старый)
    ребёнок = _node(db, "Его ребёнок", узел)
    внутренняя = _row(db, узел.id, ребёнок.id)
    внешняя = _row(db, None, ребёнок.id)

    _move(db, узел, новый.id)

    живые = {r.id for r in db.query(ViewLayoutItem).all()}
    # Вид самого поддерева не зависит от того, где висит его корень.
    assert внутренняя.id in живые
    # А позиция того же ребёнка в НАРУЖНОМ виде (обе рамки были раскрыты) — уже нет.
    assert внешняя.id not in живые


def test_снимок_отдаёт_ровно_снимаемое(db):
    старый = _node(db, "Старый дом")
    узел = _node(db, "Переезжающий", старый)
    ребёнок = _node(db, "Его ребёнок", узел)
    _row(db, старый.id, узел.id, x=10, y=20)
    _row(db, узел.id, ребёнок.id)  # внутренняя — в снимок не идёт

    снимок = reparent.build_move_snapshot(db, ensure_project(db), узел)

    assert снимок.nodes == [] and снимок.edges == []
    assert [(i.view_id, i.item_id) for i in снимок.layout_items] == [(старый.id, str(узел.id))]
    assert снимок.layout_items[0].payload == {"x": 10, "y": 20}


def test_обычная_правка_раскладку_не_трогает(db):
    дом = _node(db, "Дом")
    узел = _node(db, "Узел", дом)
    _row(db, дом.id, узел.id)
    update_node(
        узел.id,
        NodeUpdate(name="Переименованный"),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert db.query(ViewLayoutItem).count() == 1
