"""Структура брокера — каналы и поля сообщений (docs/plan-broker-docs.md §2, Ф0).

Проверяется то, ради чего модель именно такая:
  • канал — «контракт» узла-брокера, и ТОЛЬКО брокера (правило формы на входе);
  • пустая группа — это пустая строка, а не NULL, иначе уникальность имени не
    сработала бы вовсе;
  • снос брокера уносит его каналы, снос канала — его поля;
  • скоуп проекта: чужой канал недоступен даже по прямому id.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.db_table import DbTable
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.routers.broker_channels import (
    create_channel,
    create_field,
    delete_channel,
    list_channels,
    list_usage,
    update_channel,
    update_field,
)
from app.schemas.broker_channel import (
    BrokerChannelCreate,
    BrokerChannelUpdate,
    ChannelFieldCreate,
    ChannelFieldUpdate,
)


def _node(db, name, shape="broker", parent=None, project=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        shape=shape,
        parent_id=parent.id if parent else None,
        project_id=(project or ensure_project(db)).id,
    )
    db.add(n)
    db.flush()
    return n


def _channel(db, node, name="orders.created", group="", project=None, **мета):
    return create_channel(
        node.id,
        BrokerChannelCreate(name=name, group_name=group, **мета),
        db=db,
        project=project or ensure_project(db),
        user=ensure_architect(db),
    )


def _field(db, node, channel, name="order_id", project=None, **прочее):
    return create_field(
        node.id,
        channel.id,
        ChannelFieldCreate(name=name, **прочее),
        db=db,
        project=project or ensure_project(db),
        user=ensure_architect(db),
    )


# ── CRUD-цикл ─────────────────────────────────────────────────────────────────


def test_канал_с_полями_создаётся_правится_и_читается(db):
    брокер = _node(db, "Kafka")
    канал = _channel(db, брокер, kind="topic", delivery="at-least-once", retention="7d")
    _field(db, брокер, канал, "order_id", type="uuid", required=True)
    _field(db, брокер, канал, "amount", type="int64", order=1)

    # Мета канала отвечает на три частых вопроса сопровождения: порядок применения
    # (ключ), повторная обработка (доставка), переигрывание (хранение).
    было = канал.version
    обновлённый = update_channel(
        брокер.id,
        канал.id,
        BrokerChannelUpdate(partition_key="order_id", base_version=было),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert обновлённый.partition_key == "order_id"
    assert обновлённый.version == было + 1

    [прочитанный] = list_channels(
        брокер.id, db=db, project=ensure_project(db), _=ensure_architect(db)
    )
    assert (прочитанный.kind, прочитанный.delivery, прочитанный.retention) == (
        "topic",
        "at-least-once",
        "7d",
    )
    # Порядок полей — как в схеме события (order), а не по алфавиту.
    assert [f.name for f in прочитанный.fields] == ["order_id", "amount"]
    assert прочитанный.fields[0].required is True


# ── Уникальность ──────────────────────────────────────────────────────────────


def test_имя_канала_уникально_в_группе_но_не_между_группами(db):
    брокер = _node(db, "RabbitMQ")
    _channel(db, брокер, "payments")
    with pytest.raises(HTTPException) as e:
        _channel(db, брокер, "payments")
    assert e.value.status_code == 409

    # Группа (vhost/namespace/tenant) ставит пустую строку вместо NULL — иначе
    # уникальность не сработала бы вовсе (в Postgres NULL-ы друг другу не конфликтуют).
    свой = _channel(db, брокер, "payments", group="billing")
    чужой = _channel(db, брокер, "payments", group="analytics")
    assert (свой.group_name, чужой.group_name) == ("billing", "analytics")
    assert свой.id != чужой.id


def test_переименование_в_занятое_имя_группы_отвергается(db):
    брокер = _node(db, "Kafka")
    _channel(db, брокер, "payments")
    другой = _channel(db, брокер, "refunds")
    with pytest.raises(HTTPException) as e:
        update_channel(
            брокер.id,
            другой.id,
            BrokerChannelUpdate(name="payments"),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert e.value.status_code == 409


def test_поле_уникально_в_канале(db):
    брокер = _node(db, "Kafka")
    канал = _channel(db, брокер)
    поле = _field(db, брокер, канал, "order_id")
    with pytest.raises(HTTPException) as e:
        _field(db, брокер, канал, "order_id")
    assert e.value.status_code == 409

    другое = _field(db, брокер, канал, "amount")
    with pytest.raises(HTTPException) as e:
        update_field(
            брокер.id,
            канал.id,
            другое.id,
            ChannelFieldUpdate(name="order_id"),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert e.value.status_code == 409
    # Одноимённое поле в ДРУГОМ канале — законно: уникальность в пределах канала.
    второй = _channel(db, брокер, "orders.paid")
    assert _field(db, брокер, второй, "order_id").name == поле.name


# ── CAS ───────────────────────────────────────────────────────────────────────


def test_CAS_канала(db):
    брокер = _node(db, "Kafka")
    канал = _channel(db, брокер)
    with pytest.raises(HTTPException) as e:
        update_channel(
            брокер.id,
            канал.id,
            BrokerChannelUpdate(description="что-то", base_version=канал.version + 5),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert e.value.status_code == 409
    assert e.value.detail == "Канал изменён в другой сессии"
    db.refresh(канал)
    assert канал.description is None


# ── Гвард формы ───────────────────────────────────────────────────────────────


def test_каналы_бывают_только_у_брокера(db):
    """Правило формы энфорсится на ВХОДЕ, а не разбирается потом расхождением:
    «канал» у сервиса или базы бессмыслен, и страница его всё равно не покажет."""
    контейнер = _node(db, "Платформа", shape="service")
    _node(db, "Биллинг", shape="service", parent=контейнер)  # контейнер по-настоящему

    for узел in (
        _node(db, "Биллинг-сервис", shape="service"),
        _node(db, "Хранилище", shape="database"),
        _node(db, "Клиент", shape="person"),
        контейнер,
    ):
        with pytest.raises(HTTPException) as e:
            _channel(db, узел, "orders.created")
        assert e.value.status_code == 400
        assert e.value.detail == "Каналы может иметь только узел-брокер"
    assert db.query(BrokerChannel).count() == 0


def test_гвард_формы_держит_и_мутации_а_не_только_создание(db):
    брокер = _node(db, "Kafka")
    канал = _channel(db, брокер)
    # Форму сменили в обход (например, правкой БД) — правки каналов больше не идут.
    брокер.shape = "service"
    db.flush()

    for мутация in (
        lambda: update_channel(
            брокер.id,
            канал.id,
            BrokerChannelUpdate(kind="queue"),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        ),
        lambda: delete_channel(
            брокер.id, канал.id, db=db, project=ensure_project(db), user=ensure_architect(db)
        ),
        lambda: _field(db, брокер, канал, "order_id"),
    ):
        with pytest.raises(HTTPException) as e:
            мутация()
        assert e.value.status_code == 400

    # А ЧИТАТЬ уже описанное можно: спрятать существующее хуже, чем показать.
    [прочитанный] = list_channels(
        брокер.id, db=db, project=ensure_project(db), _=ensure_architect(db)
    )
    assert прочитанный.id == канал.id


# ── Каскады ───────────────────────────────────────────────────────────────────


def test_снос_канала_уносит_поля(db):
    брокер = _node(db, "Kafka")
    канал = _channel(db, брокер)
    _field(db, брокер, канал, "order_id")
    _field(db, брокер, канал, "amount")

    delete_channel(
        брокер.id, канал.id, db=db, project=ensure_project(db), user=ensure_architect(db)
    )
    assert db.query(ChannelField).count() == 0


def test_снос_брокера_уносит_каналы_и_поля(db):
    брокер = _node(db, "Kafka")
    сосед = _node(db, "RabbitMQ")
    канал = _channel(db, брокер)
    _field(db, брокер, канал, "order_id")
    чужой_канал = _channel(db, сосед, "audit")
    _field(db, сосед, чужой_канал, "actor")

    db.delete(брокер)
    db.commit()

    # Ушли ровно свои: структура принадлежит узлу, а не проекту.
    assert [c.node_id for c in db.query(BrokerChannel).all()] == [сосед.id]
    assert [f.channel_id for f in db.query(ChannelField).all()] == [чужой_канал.id]


# ── Скоуп проекта ─────────────────────────────────────────────────────────────


def test_чужой_проект_не_виден(db):
    """Скоуп — проект, а не вся база: db.get по PK его игнорирует, и без явной
    проверки чужой брокер был бы доступен по прямому id (этот тест регулярно теряли
    в прошлом круге эпика)."""
    свой = ensure_project(db)
    чужой = Project(id=uuid.uuid4(), name="Другой проект")
    db.add(чужой)
    db.flush()

    брокер = _node(db, "Kafka", project=свой)
    чужой_брокер = _node(db, "Kafka", project=чужой)
    канал = _channel(db, брокер)
    чужой_канал = _channel(db, чужой_брокер, project=чужой)

    # Узел чужого проекта — 404 даже архитектору своего.
    with pytest.raises(HTTPException) as e:
        list_channels(чужой_брокер.id, db=db, project=свой, _=ensure_architect(db))
    assert e.value.status_code == 404

    # И канал чужого узла не доехать через СВОЙ узел: id канала скоупится узлом.
    with pytest.raises(HTTPException) as e:
        update_channel(
            брокер.id,
            чужой_канал.id,
            BrokerChannelUpdate(kind="topic"),
            db=db,
            project=свой,
            user=ensure_architect(db),
        )
    assert e.value.status_code == 404

    [видимый] = list_channels(брокер.id, db=db, project=свой, _=ensure_architect(db))
    assert видимый.id == канал.id


# ── Курсор меты ───────────────────────────────────────────────────────────────


def test_мутации_двигают_meta_rev_а_не_graph_rev(db):
    брокер = _node(db, "Kafka")
    проект = ensure_project(db)
    db.commit()
    g0, m0 = проект.graph_rev, проект.meta_rev

    _channel(db, брокер)

    db.refresh(проект)
    # Структура — МЕТА узла (видна на его странице, не на схеме): поллинг редактора
    # не обязан из-за неё перестраивать холст.
    assert (проект.graph_rev, проект.meta_rev) == (g0, m0 + 1)


# ── Обратный индекс: кто публикует и кто потребляет (Ф2) ──────────────────────
# Источник — ПОМЕТКИ «публикует:/потребляет:» в тексте схем логики вызывающих
# (пивот §1 плана), а не отдельные записи: факт «сервис публикует событие»
# существует ровно один раз, прозой в диаграмме, и разойтись с ней индекс не может.


def _doc(db, node, name="POST /pay", content=""):
    d = NodeDoc(id=uuid.uuid4(), node_id=node.id, name=name, kind="operation", content=content)
    db.add(d)
    db.flush()
    return d


def _usage(db, брокер, project=None):
    return list_usage(
        брокер.id,
        db=db,
        project=project or ensure_project(db),
        _=ensure_architect(db),
    )


def test_обратный_индекс_отвечает_кто_публикует_и_кто_потребляет(db):
    брокер = _node(db, "Kafka")
    заказы = _node(db, "Заказы", shape="service")
    склад = _node(db, "Склад", shape="service")
    канал = _channel(db, брокер, "созданные")
    поле = _field(db, брокер, канал, "order_id")
    _doc(db, заказы, "POST /orders", 'A["Оформить<br>публикует: созданные.order_id"]')
    _doc(db, склад, "Обработчик", 'A["Резерв<br>потребляет: созданные"]')
    _doc(db, склад, "Обзор")  # док без текста: не падаем и не шумим

    строки = _usage(db, брокер)

    # Ради этого ответа структура каналов и заводилась: не «есть канал созданные»,
    # а «его публикует POST /orders Заказов и потребляет обработчик Склада».
    assert len(строки) == 2
    публикация = next(u for u in строки if u.mode == "publish")
    потребление = next(u for u in строки if u.mode == "consume")
    assert (публикация.channel_name, публикация.field_name) == ("созданные", "order_id")
    assert (публикация.channel_id, публикация.field_id) == (канал.id, поле.id)
    assert (публикация.node_name, публикация.doc_name) == ("Заказы", "POST /orders")
    assert (потребление.node_name, потребление.field_id) == ("Склад", None)


def test_табличная_пометка_в_индекс_канала_не_попадает(db):
    """Каталоги разведены: «пишет: заказы» — про таблицу, «публикует: заказы» — про
    канал. Одноимённые сущности не должны перетекать друг в друга (решение §7.1)."""
    брокер = _node(db, "Kafka")
    бд = _node(db, "Хранилище", shape="database")
    сервис = _node(db, "Заказы", shape="service")
    _channel(db, брокер, "заказы")
    db.add(DbTable(id=uuid.uuid4(), node_id=бд.id, name="заказы", schema_name=""))
    db.flush()
    _doc(db, сервис, "POST /orders", 'A["Оформить<br>пишет: заказы"]')

    assert _usage(db, брокер) == []

    # А та же строка под своим маркером — уже факт брокера.
    _doc(db, сервис, "Публикатор", 'A["Оформить<br>публикует: заказы"]')
    [u] = _usage(db, брокер)
    assert (u.channel_name, u.mode, u.doc_name) == ("заказы", "publish", "Публикатор")


def test_обратный_индекс_видит_только_свои_каналы(db):
    брокер = _node(db, "Kafka")
    чужой_брокер = _node(db, "RabbitMQ")
    сервис = _node(db, "Заказы", shape="service")
    _channel(db, брокер, "созданные")  # свой канал есть — фильтр не вырожденный
    _channel(db, чужой_брокер, "письма")
    _doc(db, сервис, content='A["публикует: письма"]')

    assert _usage(db, брокер) == []


def test_неизвестное_поле_даёт_строку_на_уровне_канала(db):
    брокер = _node(db, "Kafka")
    сервис = _node(db, "Заказы", shape="service")
    канал = _channel(db, брокер, "созданные")
    _field(db, брокер, канал, "order_id")
    _doc(db, сервис, content='A["публикует: созданные.total"]')

    [u] = _usage(db, брокер)
    # Канал нашёлся → обращение к нему ЦЕЛИКОМ; несуществующее поле в индекс не
    # тащим (его подсветит алерт), но и обращение не прячем.
    assert (u.channel_name, u.field_id, u.field_name) == ("созданные", None, None)


def test_битая_пометка_в_индекс_не_попадает(db):
    брокер = _node(db, "Kafka")
    сервис = _node(db, "Заказы", shape="service")
    _channel(db, брокер, "созданные")
    _doc(db, сервис, content='A["публикует: создание"]')

    # Опечатка в имени канала — не факт, а обещание факта: место такой пометке в
    # алертах, а не в индексе брокера (домысливать «наверное, созданные» нельзя).
    assert _usage(db, брокер) == []


def test_неоднозначная_ссылка_показывается_только_с_квалификатором(db):
    брокер = _node(db, "Kafka")
    другой = _node(db, "RabbitMQ")
    сервис = _node(db, "Заказы", shape="service")
    _channel(db, брокер, "события")
    _channel(db, другой, "события")  # одноимённый канал у соседа → голое имя неоднозначно
    док = _doc(db, сервис, "POST /orders", 'A["публикует: события"]')

    assert _usage(db, брокер) == []

    док.content = 'A["публикует: Kafka / события"]'
    db.flush()
    [u] = _usage(db, брокер)
    assert (u.channel_name, u.node_name, u.mode) == ("события", "Заказы", "publish")


def test_два_написания_одной_цели_дают_одну_строку(db):
    брокер = _node(db, "Kafka")
    сервис = _node(db, "Заказы", shape="service")
    канал = _channel(db, брокер, "созданные")
    _field(db, брокер, канал, "order_id")
    _doc(
        db,
        сервис,
        content=(
            'A["Оформить<br>публикует: созданные.order_id"] --> '
            'B["Повтор<br>публикует: Kafka / созданные.order_id"]'
        ),
    )

    assert len(_usage(db, брокер)) == 1


def test_обратный_индекс_не_видит_чужой_проект(db):
    """Скоуп индекса — проект: и доки чужого проекта не показываются, и одноимённый
    канал оттуда не делает свою ссылку неоднозначной. Проверка отдельная, потому что
    резолв идёт по каталогу ВСЕГО проекта — ровно на этой формулировке легко потерять
    границу (тот же тест у базы однажды теряли)."""
    свой = ensure_project(db)
    брокер = _node(db, "Kafka")
    сервис = _node(db, "Заказы", shape="service")
    канал = _channel(db, брокер, "созданные")
    _field(db, брокер, канал, "order_id")
    _doc(db, сервис, "POST /orders", 'A["публикует: созданные.order_id"]')

    чужой = Project(id=uuid.uuid4(), name="Другой проект")
    db.add(чужой)
    db.flush()
    чужой_брокер = _node(db, "Kafka", project=чужой)
    чужой_сервис = _node(db, "Заказы", shape="service", project=чужой)
    db.add(BrokerChannel(id=uuid.uuid4(), node_id=чужой_брокер.id, name="созданные", group_name=""))
    _doc(db, чужой_сервис, "POST /charge", 'A["потребляет: созданные"]')
    db.flush()

    [u] = _usage(db, брокер, project=свой)
    # Чужой док в индекс не попал (иначе строк было бы две), а чужой одноимённый
    # канал не сделал свою пометку неоднозначной (иначе строк не было бы вовсе).
    assert (u.doc_name, u.field_name) == ("POST /orders", "order_id")
