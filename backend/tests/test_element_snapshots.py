"""Элемент архитектуры в копии, снимках и версиях (docs/plan-c4-elements.md, Ф1, камень 3).

Поле хранимое и правится человеком, поэтому едет везде, где едет форма узла: копия
проекта, снимок удаления (Undo), снимок версии. Дельта версий показывает его строкой
«Свойств», откат версии его возвращает. Старый снимок без поля — то же «не сказано»,
что у всех узлов до эпика: ложных изменений он не даёт.
"""

import hashlib
import json
import uuid
import zlib

import pytest
from conftest import ensure_architect, make_project

from app import versions
from app.models.node import Node
from app.projects import copy_project_schema
from app.routers.nodes import delete_node, get_deletion_snapshot, restore_nodes
from app.versions_diff import diff_item, diff_items, semantic
from app.versions_restore import restore_version
from app.versions_snapshot import _dumps, build_snapshot, content_hash, decode


def _shop(db):
    p = make_project(db, "Ярмарка")
    shop = Node(id=uuid.uuid4(), project_id=p.id, name="shop")
    db.add(shop)
    db.flush()
    orders = Node(id=uuid.uuid4(), project_id=p.id, name="orders", parent_id=shop.id)
    db.add(orders)
    db.flush()
    api = Node(id=uuid.uuid4(), project_id=p.id, name="api", parent_id=orders.id)
    db.add(api)
    db.commit()
    return p, shop, orders, api


def _snap(db, p, root: Node):
    db.expire_all()
    return build_snapshot(db, p.id, root.id)


def _rows(view) -> list[tuple[str, list[str]]]:
    assert view.rows is not None
    return [(r.mark, r.cells) for r in view.rows]


def test_копия_проекта_переносит_элемент(db):
    p, _shop_node, orders, _api = _shop(db)
    orders.element = "container"
    db.commit()
    dst = make_project(db, "Ярмарка (копия)")
    copy_project_schema(db, p.id, dst.id)
    db.commit()
    copied = {n.name: n.element for n in db.query(Node).filter(Node.project_id == dst.id)}
    assert copied == {"shop": None, "orders": "container", "api": None}


def test_откат_удаления_возвращает_элемент(db):
    p, _shop_node, orders, _api = _shop(db)
    orders.element = "container"
    db.commit()
    arch = ensure_architect(db)
    snap = get_deletion_snapshot(orders.id, db=db, project=p, _=arch)
    delete_node(orders.id, db=db, project=p, user=arch)
    restore_nodes(snap, db=db, project=p, user=arch)
    db.expire_all()
    assert db.get(Node, orders.id).element == "container"


def test_смена_элемента_строка_свойств_в_дельте(db):
    p, shop, orders, _api = _shop(db)
    before = _snap(db, p, shop)
    orders.element = "container"
    db.commit()
    after = _snap(db, p, shop)

    [item] = diff_items(before, after)
    assert (item.category, item.status, item.name, item.summary) == (
        "props", "changed", "orders", "элемент архитектуры",
    )
    assert content_hash(before) != content_hash(after)
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert _rows(detail.changes) == [("mod", ["элемент архитектуры", "Не задан", "Контейнер"])]
    was = dict(r.cells for r in detail.before.rows or [])
    now = dict(r.cells for r in detail.after.rows or [])
    assert (was["элемент архитектуры"], now["элемент архитектуры"]) == ("Не задан", "Контейнер")


def test_старый_снимок_без_поля_изменений_не_даёт(db):
    """Камень 3: версия, снятая до эпика, — в её JSON ключа element нет, и хэш посчитан
    без него. Живой срез с element = null — то же состояние: «изменений нет», откатывать
    нечего."""
    p, shop, _orders, _api = _shop(db)
    user = ensure_architect(db)
    row = versions.create_version(db, p, user, shop, "v1")
    db.commit()

    data = json.loads(zlib.decompress(row.snapshot))
    for node in data["nodes"]:
        del node["element"]
    row.snapshot = zlib.compress(_dumps(data).encode("utf-8"))
    old = semantic(decode(row.snapshot, row.snapshot_format))
    for node in old["nodes"]:
        del node["element"]
    row.content_hash = hashlib.sha256(_dumps(old).encode("utf-8")).hexdigest()
    db.commit()
    db.expire_all()

    live = versions.live_snapshot(db, p, shop)
    assert content_hash(live) != row.content_hash  # проекция уточнилась…
    pending = versions.pending(db, p, shop)
    assert (pending.changed, pending.items) == (False, [])  # …а изменений нет
    assert diff_items(versions.snapshot_of(row), live) == []
    with pytest.raises(versions.VersionError):
        restore_version(db, p, user, shop, row)


def test_откат_версии_возвращает_элемент(db):
    p, shop, orders, _api = _shop(db)
    user = ensure_architect(db)
    orders.element = "container"
    db.commit()
    versions.create_version(db, p, user, shop, "v1")
    db.commit()
    db.get(Node, orders.id).element = None
    db.commit()

    row = versions.get_version(db, p, shop, 1)
    assert row is not None
    restore_version(db, p, user, shop, row)
    db.commit()
    db.expire_all()
    assert db.get(Node, orders.id).element == "container"


def test_пустая_система_в_копии_и_версии(db):
    """Пустая система (Р39): элемент листа едет в копию проекта и возвращается откатом
    версии, как у любого узла."""
    p, shop, _orders, api = _shop(db)
    user = ensure_architect(db)
    db.get(Node, api.id).element = "system"
    db.commit()
    dst = make_project(db, "Ярмарка (копия)")
    copy_project_schema(db, p.id, dst.id)
    db.commit()
    copied = {n.name: n.element for n in db.query(Node).filter(Node.project_id == dst.id)}
    assert copied == {"shop": None, "orders": None, "api": "system"}

    versions.create_version(db, p, user, shop, "v1")
    db.commit()
    db.get(Node, api.id).element = None
    db.commit()
    row = versions.get_version(db, p, shop, 1)
    assert row is not None
    restore_version(db, p, user, shop, row)
    db.commit()
    db.expire_all()
    assert db.get(Node, api.id).element == "system"

