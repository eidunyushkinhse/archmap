"""Внешние связи поддерева узла (GET /nodes/{id}/edges → graph_queries.external_edges):
направление и сосед снаружи — относительно поддерева, inner_* — конец внутри него
(2026-11-02: таблица «Связи» страницы объекта сводит одноимённые связи в строку и в окне
выбора называет каждую её внутренним концом)."""

import uuid

from conftest import ensure_project

from app.graph_queries import external_edges
from app.models.edge import Edge
from app.models.node import Node


def _node(db, name, parent=None):
    n = Node(id=uuid.uuid4(), name=name, parent_id=parent.id if parent else None, project_id=ensure_project(db).id)
    db.add(n)
    return n


def _edge(db, src, tgt, label):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id, label=label, project_id=ensure_project(db).id)
    db.add(e)
    return e


def test_external_edges_inner_end_is_subtree_node(db):
    user = _node(db, "Пользователь")
    orders = _node(db, "Заказы")
    catalog = _node(db, "Каталог", orders)
    cart = _node(db, "Корзина", orders)
    to_catalog = _edge(db, user, catalog, "пользуется")
    to_cart = _edge(db, user, cart, "пользуется")
    _edge(db, catalog, cart, "внутренняя")  # оба конца внутри поддерева — не показывается
    notify = _edge(db, orders, user, "уведомляет")  # собственная связь узла
    db.commit()

    rows = {r.id: r for r in external_edges(db, ensure_project(db).id, orders.id)}
    assert set(rows) == {to_catalog.id, to_cart.id, notify.id}

    # входящие связи соседа к вложенным: сосед снаружи один, внутренние концы — свои
    assert rows[to_catalog.id].direction == "incoming"
    assert rows[to_catalog.id].other_node_name == "Пользователь"
    assert (rows[to_catalog.id].inner_node_id, rows[to_catalog.id].inner_node_name) == (catalog.id, "Каталог")
    assert (rows[to_cart.id].inner_node_id, rows[to_cart.id].inner_node_name) == (cart.id, "Корзина")

    # собственная связь узла: внутренний конец — он сам
    assert rows[notify.id].direction == "outgoing"
    assert rows[notify.id].other_node_id == user.id
    assert (rows[notify.id].inner_node_id, rows[notify.id].inner_node_name) == (orders.id, "Заказы")


def test_external_edges_of_leaf_inner_is_itself(db):
    user = _node(db, "Пользователь")
    leaf = _node(db, "Каталог")
    e = _edge(db, leaf, user, "отвечает")
    db.commit()

    [row] = external_edges(db, ensure_project(db).id, leaf.id)
    assert row.id == e.id
    assert (row.direction, row.other_node_name, row.inner_node_name) == ("outgoing", "Пользователь", "Каталог")


def test_external_edges_order_is_fixed_by_server(db):
    """Порядок строк задаёт сервер (без ORDER BY строки таблицы «Связи» менялись местами
    между запросами): имя соседа снаружи без учёта регистра, подпись, технология,
    направление, конец внутри, затем id."""
    hub = _node(db, "Заказы")
    cart = _node(db, "Корзина", hub)
    catalog = _node(db, "Каталог", hub)
    stock = _node(db, "Склад")
    api = _node(db, "api")
    billing = _node(db, "Billing")
    reserve = _edge(db, hub, stock, "резервирует")
    invoice = _edge(db, billing, hub, "выставляет счёт")
    to_cart = _edge(db, api, cart, "пишет")
    to_catalog = _edge(db, api, catalog, "пишет")
    reads = _edge(db, api, catalog, "читает")
    answers = _edge(db, hub, api, "пишет")  # тот же сосед и подпись, но исходящая
    reads_grpc = _edge(db, api, catalog, "читает")
    reads_grpc.technology = "gRPC"
    db.commit()

    rows = external_edges(db, ensure_project(db).id, hub.id)
    assert [r.id for r in rows] == [
        to_catalog.id,  # api · пишет · входящая · Каталог
        to_cart.id,  # api · пишет · входящая · Корзина
        answers.id,  # api · пишет · исходящая
        reads.id,  # api · читает · без технологии
        reads_grpc.id,  # api · читает · gRPC
        invoice.id,  # Billing после api: регистр не решает
        reserve.id,  # Склад
    ]
