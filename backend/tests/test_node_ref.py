"""Прямые тесты адресов узла (app/node_ref.py) — без БД и HTTP.

NodeIndex — один источник пути узла для приёмников пакетов, разведки, процессов и
превью перехода (аудит Q-4: было три способа). Тёзки различаются порядком документа
экспорта, и порядковый уточнитель «путь @ #N» должен находить того же N-го тёзку.
"""

import uuid

from app.models.node import Node
from app.node_ref import NodeIndex, node_addresses, qualified_node_hits


def _node(name: str, parent: Node | None = None, **kw: object) -> Node:
    return Node(id=uuid.uuid4(), name=name, parent_id=parent.id if parent else None, **kw)


def test_пути_в_порядке_документа_родитель_раньше_детей() -> None:
    shop = _node("Маркетплейс")
    orders = _node("Сервис заказов", shop)
    api = _node("API", orders)
    billing = _node("Биллинг", shop)
    # Вход перемешан: порядок задаёт обход, а не список.
    index = NodeIndex.of([api, billing, orders, shop])
    assert index.paths == [
        "Маркетплейс",
        "Маркетплейс / Биллинг",
        "Маркетплейс / Сервис заказов",
        "Маркетплейс / Сервис заказов / API",
    ]
    assert [n.id for n in index.flat] == [shop.id, billing.id, orders.id, api.id]
    assert index.by_path["Маркетплейс / Сервис заказов / API"] == [3]
    assert index.path_by_id()[api.id] == "Маркетплейс / Сервис заказов / API"


def test_тёзки_делят_имя_и_путь_а_порядок_у_них_по_содержанию() -> None:
    shop = _node("Маркетплейс")
    db_b = _node("БД", shop, technology="Redis")
    db_a = _node("БД", shop, technology="PostgreSQL")
    index = NodeIndex.of([shop, db_b, db_a])
    assert index.by_name["БД"] == [1, 2]
    assert index.by_path["Маркетплейс / БД"] == [1, 2]
    # Порядок тёзок — по содержательному ключу, не по порядку входа: так его видит
    # и экспорт, и уточнитель «@ #N» находит того же тёзку.
    first, second = index.flat[1], index.flat[2]
    assert (first.technology, second.technology) == ("PostgreSQL", "Redis")
    hits = qualified_node_hits("Маркетплейс / БД @ #2", index.flat)
    assert [index.flat[i].id for i in hits] == [db_b.id]
    assert node_addresses([shop, db_b, db_a])[db_b.id] == "Маркетплейс / БД @ #2"


def test_узел_с_родителем_вне_набора_становится_корнем() -> None:
    outside = _node("Чужой контейнер")
    orphan = _node("Сирота", outside)
    index = NodeIndex.of([orphan])
    assert index.paths == ["Сирота"]


def test_распаковка_как_у_прежнего_кортежа() -> None:
    root = _node("Система")
    flat, paths, by_name, by_path = NodeIndex.of([root])
    assert (flat, paths, by_name, by_path) == ([root], ["Система"], {"Система": [0]}, {"Система": [0]})
