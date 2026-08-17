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
from app.routers.broker_channels import create_channel, create_field
from app.routers.data_refs import preview_data_refs
from app.routers.db_docs import create_column, create_table
from app.schemas.broker_channel import BrokerChannelCreate, ChannelFieldCreate
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


def _preview(db, content, node=None):
    return preview_data_refs(
        DataRefPreviewIn(content=content, node_id=node.id if node else None),
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


# ── Каналы брокера (Ф2) ───────────────────────────────────────────────────────
# Плашка одна на док: рядом стоят и «пишет: orders», и «публикует: созданные», и
# резолвер у них общий — отдельной работы почти нет, но подпись цели своя.


def _channel(db, node, name="созданные", group=""):
    return create_channel(
        node.id,
        BrokerChannelCreate(name=name, group_name=group),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def _field(db, node, channel, name="order_id"):
    return create_field(
        node.id,
        channel.id,
        ChannelFieldCreate(name=name, type="uuid"),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def test_пометка_канала_с_полем_показывает_готовую_подпись(db):
    брокер = _node(db, "Kafka", shape="broker")
    канал = _channel(db, брокер)
    _field(db, брокер, канал)

    [item] = _preview(db, 'A["Оформить<br>публикует: созданные.order_id"]')

    assert (item.ref, item.mode, item.status) == ("созданные.order_id", "publish", "ok")
    assert item.target == "Kafka · созданные.order_id"


def test_пометка_канала_без_поля_ведёт_к_каналу(db):
    брокер = _node(db, "Kafka", shape="broker")
    _channel(db, брокер)

    [item] = _preview(db, 'A["потребляет: созданные"]')

    assert (item.mode, item.status, item.target) == ("consume", "ok", "Kafka · созданные")


def test_неизвестный_канал_цели_не_имеет(db):
    брокер = _node(db, "Kafka", shape="broker")
    _channel(db, брокер)

    [item] = _preview(db, 'A["публикует: создание"]')

    assert (item.status, item.target) == ("unknown_channel", None)


def test_нет_поля_в_канале_показывает_канал(db):
    брокер = _node(db, "Kafka", shape="broker")
    канал = _channel(db, брокер)
    _field(db, брокер, канал, "order_id")

    [item] = _preview(db, 'A["публикует: созданные.total"]')

    # Канал нашёлся — обращение считается к нему целиком; несуществующее поле
    # показывать как найденное нельзя.
    assert (item.status, item.target) == ("unknown_field", "Kafka · созданные")


def test_одноимённые_каналы_у_разных_брокеров_дают_неоднозначность(db):
    kafka = _node(db, "Kafka", shape="broker")
    rabbit = _node(db, "RabbitMQ", shape="broker")
    _channel(db, kafka, "события")
    _channel(db, rabbit, "события")

    [item] = _preview(db, 'A["публикует: события"]')
    assert (item.status, item.target) == ("ambiguous", None)

    # Лечится квалификатором — той же пометкой, дописанной человеком.
    [уточнённая] = _preview(db, 'A["публикует: RabbitMQ / события"]')
    assert (уточнённая.status, уточнённая.target) == ("ok", "RabbitMQ · события")


def test_одноимённые_таблица_и_канал_не_мешают_друг_другу(db):
    # Каталоги разведены: маркер выбирает мир, и подпись цели это показывает.
    бд = _node(db, "Хранилище")
    брокер = _node(db, "Kafka", shape="broker")
    _table(db, бд, "заказы")
    _channel(db, брокер, "заказы")

    [записал, опубликовал] = _preview(
        db, 'A["Оформить<br>пишет: заказы<br>публикует: заказы"]'
    )

    assert (записал.status, записал.target) == ("ok", "Хранилище · заказы")
    assert (опубликовал.status, опубликовал.target) == ("ok", "Kafka · заказы")


# ── Конфигурация ──────────────────────────────────────────────────────────────


def _param(db, node, name="FEATURE_X"):
    from app.routers.config_params import create_param
    from app.schemas.config_param import ConfigParamCreate

    return create_param(
        node.id,
        ConfigParamCreate(name=name),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def test_пометка_конфигурации_ведёт_в_раздел_объекта(db):
    сервис = _node(db, "Заказы", shape="service")
    _param(db, сервис, "FEATURE_NEW_CHECKOUT")

    [item] = _preview(db, 'A["зависит от: FEATURE_NEW_CHECKOUT"]', node=сервис)

    assert (item.ref, item.mode, item.status) == ("FEATURE_NEW_CHECKOUT", "config", "ok")
    # Владелец — сам узел, чей док открыт: повторять его имя незачем, а раздел, куда
    # идти сверяться, назвать полезно.
    assert item.target == "Конфигурация · FEATURE_NEW_CHECKOUT"


def test_неизвестный_параметр_цели_не_имеет(db):
    сервис = _node(db, "Заказы", shape="service")
    _param(db, сервис, "FEATURE_X")

    [item] = _preview(db, 'A["зависит от: FEATURE_Y"]', node=сервис)

    assert (item.status, item.target) == ("unknown_param", None)


def test_параметр_соседнего_узла_в_превью_не_находится(db):
    """Плашка обязана показывать ровно то, что скажет резолв: ручка соседа своей не
    становится, иначе редактор обещал бы связь, которой карта не подтвердит."""
    заказы = _node(db, "Заказы", shape="service")
    платежи = _node(db, "Платежи", shape="service")
    _param(db, платежи, "FEATURE_X")

    [item] = _preview(db, 'A["зависит от: FEATURE_X"]', node=заказы)

    assert item.status == "unknown_param"


def test_без_владельца_конфигурационные_пометки_выпадают_а_прочие_остаются(db):
    """Старый клиент не шлёт node_id. Сказать «параметра нет» было бы враньём — мы
    его не искали, поэтому такие пометки просто не показываются; пометки других
    семей при этом отвечают как обычно."""
    бд = _node(db, "Хранилище")
    t = _table(db, бд)
    _column(db, бд, t, "status")

    ответ = _preview(db, 'A["пишет: orders.status<br>зависит от: FEATURE_X"]')

    assert [(i.mode, i.status) for i in ответ] == [("write", "ok")]
