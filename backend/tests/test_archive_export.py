"""Рендеры файлов архива (Ф1, docs/plan-archive-export.md).

Критерий каждой пары — КРУГОВОЙ ПРОГОН: рендер пишет файл, СУЩЕСТВУЮЩИЙ ввозной
парсер читает его, семантика совпадает. Формат общий с BYOA — вторые форматы не
заводились. Плюс детерминизм: два рендера одного набора дают одинаковые байты.
"""

import uuid

from conftest import ensure_project

from app.archive_export import (
    render_channels_yaml,
    render_config_yaml,
    render_doc_mmd,
    render_spec_yaml,
    render_tables_yaml,
)
from app.channels_import import parse_channels_file
from app.config_import import parse_config_file
from app.data_import import NODE_HEADER, parse_data_file
from app.mmd_header import parse_mmd_header, strip_header
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.node import Node
from app.models.node_doc import NodeDoc


def _node(db, name):
    n = Node(id=uuid.uuid4(), name=name, project_id=ensure_project(db).id)
    db.add(n)
    db.flush()
    return n


def test_док_круговой_прогон_и_свежая_шапка(db):
    """Тело хранится СО старой шапкой времён заливки, а схему переименовали:
    рендер обязан снять старую и написать свежую из записи — иначе файл врёт."""
    узел = _node(db, "orders")
    тело = 'graph TD\n  A["Приём: запроса"] --> B\n'
    док = NodeDoc(
        id=uuid.uuid4(), node_id=узел.id, name="Крон: выставление счетов",
        kind="worker", operation=None,
        content="%% archmap-name: Старое имя\n%% archmap-kind: operation\n" + тело,
    )
    db.add(док)
    db.commit()

    файл = render_doc_mmd(док, "Ярмарка / orders")

    шапка = parse_mmd_header(файл)
    assert (шапка.name, шапка.kind, шапка.node) == (
        "Крон: выставление счетов", "worker", "Ярмарка / orders",
    )
    assert шапка.operation is None and шапка.problems == []
    # Тело — без обеих шапок (старая снята, свежая отделена стрипом).
    assert strip_header(файл) == тело


def test_заглушка_разведки_остаётся_файлом_из_одной_шапки(db):
    """Пустое тело — план работ, а не мусор (Д4): файл существует, тела нет."""
    узел = _node(db, "orders")
    заглушка = NodeDoc(id=uuid.uuid4(), node_id=узел.id, name="GET /health",
                       kind="operation", operation="GET /health", content="")
    db.add(заглушка)
    db.commit()

    файл = render_doc_mmd(заглушка, "Ярмарка / orders")

    шапка = parse_mmd_header(файл)
    assert (шапка.name, шапка.operation) == ("GET /health", "GET /health")
    assert strip_header(файл).strip() == ""


def test_спека_несёт_адрес_узла_и_остаётся_валидным_YAML(db):
    спека = "openapi: 3.0.3\ninfo:\n  title: Заказы\npaths: {}\n"

    файл = render_spec_yaml(спека, "Ярмарка / orders")

    m = NODE_HEADER.search(файл)
    assert m is not None and m.group(1) == "Ярмарка / orders"
    # Комментарий адреса не ломает саму спеку.
    import yaml
    assert yaml.safe_load(файл)["openapi"] == "3.0.3"
    # Повторный экспорт не плодит адресов.
    повторно = render_spec_yaml(файл, "Ярмарка / orders")
    assert повторно.count("archmap-node") == 1


def test_структура_БД_круговой_прогон(db):
    узел = _node(db, "Каталог-БД")
    t1 = DbTable(id=uuid.uuid4(), node_id=узел.id, name="orders",
                 schema_name="public", description="заказы")
    t2 = DbTable(id=uuid.uuid4(), node_id=узел.id, name="accounts", schema_name="")
    db.add_all([t1, t2])
    db.flush()
    c_id = DbColumn(id=uuid.uuid4(), table_id=t1.id, name="id", type="uuid",
                    nullable=False, is_primary_key=True, order=0)
    c_acc = DbColumn(id=uuid.uuid4(), table_id=t2.id, name="id", type="uuid",
                     nullable=False, is_primary_key=True, order=0)
    db.add_all([c_id, c_acc])
    db.flush()
    c_fk = DbColumn(id=uuid.uuid4(), table_id=t1.id, name="account_id", type="uuid",
                    nullable=True, references_column_id=c_acc.id,
                    description="кто заказал", order=1)
    db.add(c_fk)
    db.commit()
    db.refresh(t1)
    db.refresh(t2)

    файл = render_tables_yaml([t1, t2], "Ярмарка / Каталог-БД")

    разбор = parse_data_file(файл)
    assert разбор is not None and разбор.node_ref == "Ярмарка / Каталог-БД"
    таблицы = {t.name: t for t in разбор.tables}
    assert таблицы["orders"].schema_name == "public"
    assert таблицы["orders"].description == "заказы"
    колонки = {c.name: c for c in таблицы["orders"].columns}
    assert колонки["id"].pk and колонки["id"].required
    # FK доехал строкой «таблица.колонка» — так его читает применение.
    assert колонки["account_id"].references == "accounts.id"
    assert not колонки["account_id"].required
    # Детерминизм: повторный рендер байт-в-байт.
    assert render_tables_yaml([t2, t1], "Ярмарка / Каталог-БД") == файл


def test_каналы_брокера_круговой_прогон(db):
    узел = _node(db, "Kafka")
    канал = BrokerChannel(id=uuid.uuid4(), node_id=узел.id, name="orders.created",
                          group_name="shop", kind="topic", partition_key="order_id",
                          delivery="at-least-once", retention="7d",
                          description="созданные заказы")
    db.add(канал)
    db.flush()
    db.add(ChannelField(id=uuid.uuid4(), channel_id=канал.id, name="order_id",
                        type="uuid", required=True, order=0))
    db.add(ChannelField(id=uuid.uuid4(), channel_id=канал.id, name="total",
                        type="decimal", required=False, description="сумма", order=1))
    db.commit()
    db.refresh(канал)

    файл = render_channels_yaml([канал], "Ярмарка / Kafka")

    разбор = parse_channels_file(файл)
    assert разбор is not None and разбор.node_ref == "Ярмарка / Kafka"
    [c] = разбор.channels
    assert (c.name, c.group_name, c.kind, c.partition_key, c.delivery, c.retention) == (
        "orders.created", "shop", "topic", "order_id", "at-least-once", "7d",
    )
    assert [(f.name, f.type, f.required) for f in c.fields] == [
        ("order_id", "uuid", True), ("total", "decimal", False),
    ]


def test_конфигурация_круговой_прогон(db):
    узел = _node(db, "orders")
    db.add_all([
        ConfigParam(id=uuid.uuid4(), node_id=узел.id, name="TIMEOUT_MS",
                    value_type="int", required=False, default_value="5000",
                    description="таймаут запроса"),
        ConfigParam(id=uuid.uuid4(), node_id=узел.id, name="FEATURE_X",
                    value_type="bool", required=True, default_value=""),
    ])
    db.commit()
    параметры = db.query(ConfigParam).filter(ConfigParam.node_id == узел.id).all()

    файл = render_config_yaml(параметры, "Ярмарка / orders")

    разбор = parse_config_file(файл)
    assert разбор is not None and разбор.node_ref == "Ярмарка / orders"
    по_имени = {p.name: p for p in разбор.params}
    assert по_имени["TIMEOUT_MS"].default_value == "5000"
    assert по_имени["TIMEOUT_MS"].value_type == "int"
    assert по_имени["FEATURE_X"].required
