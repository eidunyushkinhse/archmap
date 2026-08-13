"""Превью пометок для редактора схемы логики (POST /data-refs/preview, пивот §9).

Плашка редактора обязана отвечать про ТЕКСТ, а не про сохранённый док, и говорить
ровно то, что знает резолв: нашлась цель — показать её человеку («Хранилище · orders»),
не нашлась — назвать причину. Здесь проверяется именно склейка эндпоинта: статусы
резолва (они закреплены в test_data_refs.py) и ПОДПИСЬ цели, которой у чистых функций
нет вовсе.
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.models.node import Node
from app.routers.data_refs import preview_data_refs
from app.routers.db_docs import create_column, create_table
from app.schemas.data_refs import DataRefPreviewIn
from app.schemas.db_doc import DbColumnCreate, DbTableCreate


def _node(db, name, shape="database", parent=None):
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


def _table(db, node, name="orders", schema=""):
    return create_table(
        node.id,
        DbTableCreate(name=name, schema_name=schema),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def _column(db, node, table, name="status"):
    return create_column(
        node.id,
        table.id,
        DbColumnCreate(name=name, type="varchar(16)"),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def _preview(db, content):
    return preview_data_refs(
        DataRefPreviewIn(content=content),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )


def test_пометка_с_колонкой_показывает_готовую_подпись_цели(db):
    бд = _node(db, "Хранилище")
    t = _table(db, бд)
    _column(db, бд, t, "status")

    [item] = _preview(db, 'A["Списать средства<br>пишет: orders.status"]')

    assert (item.ref, item.mode, item.status) == ("orders.status", "write", "ok")
    # Подпись собрана за фронт: плашке нечего доводить руками.
    assert item.target == "Хранилище · orders.status"


def test_пометка_без_колонки_ведёт_к_таблице(db):
    # Глубина опциональна: «SELECT *» — обычное дело, и это законная пометка.
    бд = _node(db, "Хранилище")
    _table(db, бд)

    [item] = _preview(db, 'A["читает: orders"]')

    assert (item.status, item.target) == ("ok", "Хранилище · orders")


def test_подпись_базы_короткая_а_не_полный_путь(db):
    # Квалификатор пометки говорит путями («Платформа / Хранилище»), но плашке нужна
    # подпись, а не адрес объекта в дереве.
    платформа = _node(db, "Платформа", shape="service")
    бд = _node(db, "Хранилище", parent=платформа)
    _table(db, бд)

    [item] = _preview(db, 'A["читает: Платформа / Хранилище / orders"]')

    assert item.target == "Хранилище · orders"


def test_неизвестная_таблица_цели_не_имеет(db):
    бд = _node(db, "Хранилище")
    _table(db, бд)

    [item] = _preview(db, 'A["читает: ordrs.status"]')

    # Опечатка — не факт, а невыполненное обещание: домысливать «наверное, orders»
    # нельзя, и показывать в плашке нечего.
    assert (item.status, item.target) == ("unknown_table", None)


def test_одноимённые_таблицы_в_разных_базах_дают_неоднозначность(db):
    бд = _node(db, "Хранилище")
    кэш = _node(db, "Кэш")
    _table(db, бд, "orders")
    _table(db, кэш, "orders")

    [item] = _preview(db, 'A["читает: orders"]')

    assert (item.status, item.target) == ("ambiguous", None)

    # Лечится квалификатором — та же пометка, дописанная человеком, резолвится.
    [уточнённая] = _preview(db, 'A["читает: Кэш / orders"]')
    assert (уточнённая.status, уточнённая.target) == ("ok", "Кэш · orders")


def test_две_гипотезы_x_y_дают_неоднозначность(db):
    # «orders.status» — это «таблица orders, колонка status» ИЛИ «раздел orders,
    # таблица status». Сработали обе → молча выбрать одну запрещено (§9.9).
    бд = _node(db, "Хранилище")
    t = _table(db, бд, "orders")
    _column(db, бд, t, "status")
    _table(db, бд, "status", schema="orders")

    [item] = _preview(db, 'A["пишет: orders.status"]')

    assert (item.status, item.target) == ("ambiguous", None)


def test_неизвестная_колонка_показывает_таблицу(db):
    бд = _node(db, "Хранилище")
    t = _table(db, бд)
    _column(db, бд, t, "status")

    [item] = _preview(db, 'A["пишет: orders.discount"]')

    # Таблица нашлась — обращение считается к ней целиком; в подписи только она,
    # несуществующую колонку показывать как найденную нельзя.
    assert (item.status, item.target) == ("unknown_column", "Хранилище · orders")


def test_текст_без_пометок_даёт_пустой_ответ(db):
    бд = _node(db, "Хранилище")
    _table(db, бд)

    assert _preview(db, "") == []
    # И обычная проза без маркеров — тоже: плашки на таком доке не будет.
    assert _preview(db, 'A["Проверить заказ"] --> B["Готово"]') == []
