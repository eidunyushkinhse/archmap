"""Смена ТИПА (shape) узла из меты — со страницы объекта и из панели редактора.

Контракт `NodeUpdate` поле принимал всегда, но менять его было нечем и никто не
проверял, что новая форма унесёт с собой. Кейс, с которого началось: агент импорта
выдал серверу мониторинга тип «Пользователь», и починить это можно было только
пересозданием объекта.

Здесь — доменная часть жеста: смена формы это СТРУКТУРНАЯ правка (видна на холсте),
и у неё запреты — про то, чем узел уже владеет:
  • дети (форму-контейнер имеет только сервис, node.md N4/N4а);
  • структура БД (таблицы рендерятся только у формы database — молча спрятать их
    нельзя);
  • каналы брокера (тот же довод у формы broker).
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.broker_channel import BrokerChannel
from app.models.db_table import DbTable
from app.models.node import Node
from app.routers.nodes import update_node
from app.schemas.node import NodeUpdate


def _node(db, name, shape="service", parent=None):
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


def _table(db, node, name="orders"):
    t = DbTable(id=uuid.uuid4(), node_id=node.id, name=name, schema_name="")
    db.add(t)
    db.flush()
    return t


def _channel(db, node, name="orders.created"):
    c = BrokerChannel(id=uuid.uuid4(), node_id=node.id, name=name, group_name="")
    db.add(c)
    db.flush()
    return c


def _set_shape(db, node, shape, base_version=None):
    return update_node(
        node.id,
        NodeUpdate(shape=shape, base_version=base_version),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


# ── Смена применяется и считается структурной ────────────────────────────────


def test_смена_типа_применяется_и_двигает_graph_rev(db):
    # Кейс пользователя: агент выдал серверу мониторинга тип «Пользователь».
    узел = _node(db, "Monitored Hosts", shape="person")
    проект = ensure_project(db)
    db.commit()
    g0, m0 = проект.graph_rev, проект.meta_rev

    saved = _set_shape(db, узел, "service")

    assert saved.shape == "service"
    db.refresh(проект)
    # Форма видна на холсте — курсор СХЕМЫ, а не меты (иначе редактор соседней
    # сессии не узнал бы, что узел сменил силуэт).
    assert проект.graph_rev == g0 + 1
    assert проект.meta_rev == m0


def test_форма_без_детей_и_структуры_меняется_свободно(db):
    for откуда, куда in (("service", "database"), ("service", "broker"), ("database", "service")):
        узел = _node(db, f"{откуда}→{куда}", shape=откуда)
        assert _set_shape(db, узел, куда).shape == куда


# ── Запрет 1: вложенные объекты ──────────────────────────────────────────────


def test_нельзя_увести_форму_с_детьми_из_сервиса(db):
    контейнер = _node(db, "Платформа")
    _node(db, "Биллинг", parent=контейнер)

    for shape in ("database", "broker", "person"):
        with pytest.raises(HTTPException) as e:
            _set_shape(db, контейнер, shape)
        assert e.value.status_code == 400
        assert e.value.detail == (
            "У узла есть вложенные объекты — тип «Сервис» единственный, "
            "который может их иметь"
        )
    # Отказ ничего не применил
    db.refresh(контейнер)
    assert контейнер.shape == "service"


def test_детей_считаем_в_БД_а_не_по_payload(db):
    # has_children в контракте ВЫЧИСЛЯЕМОЕ и приезжает с клиента — запрет обязан
    # держаться на самой БД. Клиент шлёт полный payload без единого намёка на детей.
    контейнер = _node(db, "Платформа")
    _node(db, "Биллинг", parent=контейнер)
    with pytest.raises(HTTPException) as e:
        update_node(
            контейнер.id,
            NodeUpdate(name="Платформа", shape="database", role="ядро"),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert e.value.status_code == 400


def test_узел_без_детей_становится_кем_угодно(db):
    лист = _node(db, "Одиночка")
    assert _set_shape(db, лист, "person").shape == "person"


def test_person_разрешено_вернуть_в_сервис(db):
    # Обратный путь после ошибки агента: у person детей быть не может по построению,
    # и запрет по детям на него не срабатывает.
    узел = _node(db, "Monitored Hosts", shape="person")
    assert _set_shape(db, узел, "service").shape == "service"


def test_сервис_с_детьми_остаётся_сервисом_без_отказа(db):
    # Полный payload клиента несёт shape всегда: «смены» тут нет — проверка молчит.
    контейнер = _node(db, "Платформа")
    _node(db, "Биллинг", parent=контейнер)
    assert _set_shape(db, контейнер, "service").shape == "service"


# ── Запрет 2: описанная структура БД ─────────────────────────────────────────


def test_нельзя_увести_базу_с_таблицами(db):
    база = _node(db, "Заказы", shape="database")
    _table(db, база)

    for shape in ("service", "broker", "person"):
        with pytest.raises(HTTPException) as e:
            _set_shape(db, база, shape)
        assert e.value.status_code == 400
        assert e.value.detail == "У узла описана структура БД — сначала перенесите или удалите её"
    db.refresh(база)
    assert база.shape == "database"


def test_база_без_таблиц_меняет_форму(db):
    база = _node(db, "Пустая", shape="database")
    assert _set_shape(db, база, "service").shape == "service"


def test_таблицы_чужой_базы_смене_не_мешают(db):
    база = _node(db, "Пустая", shape="database")
    соседняя = _node(db, "Заказы", shape="database")
    _table(db, соседняя)
    assert _set_shape(db, база, "broker").shape == "broker"


# ── Запрет 3: описанные каналы брокера ───────────────────────────────────────
# Зеркало запрета по структуре БД: каналы рендерятся только у формы broker, и CRUD
# их брокером же и ограничивает — запрет здесь замыкает правило с другой стороны.


def test_нельзя_увести_брокер_с_каналами(db):
    брокер = _node(db, "Kafka", shape="broker")
    _channel(db, брокер)

    for shape in ("service", "database", "person"):
        with pytest.raises(HTTPException) as e:
            _set_shape(db, брокер, shape)
        assert e.value.status_code == 400
        assert e.value.detail == (
            "У узла описаны каналы брокера — сначала перенесите или удалите их"
        )
    db.refresh(брокер)
    assert брокер.shape == "broker"


def test_брокер_без_каналов_меняет_форму(db):
    брокер = _node(db, "Пустой", shape="broker")
    assert _set_shape(db, брокер, "service").shape == "service"


def test_каналы_чужого_брокера_смене_не_мешают(db):
    брокер = _node(db, "Пустой", shape="broker")
    соседний = _node(db, "Kafka", shape="broker")
    _channel(db, соседний)
    assert _set_shape(db, брокер, "database").shape == "database"


# ── CAS ──────────────────────────────────────────────────────────────────────


def test_cas_конфликт_при_смене_типа(db):
    узел = _node(db, "Сервис")
    db.commit()
    with pytest.raises(HTTPException) as e:
        _set_shape(db, узел, "person", base_version=узел.version + 5)
    assert e.value.status_code == 409
    db.refresh(узел)
    assert узел.shape == "service"


def test_смена_типа_от_актуальной_версии_проходит(db):
    узел = _node(db, "Сервис")
    db.commit()
    saved = _set_shape(db, узел, "person", base_version=узел.version)
    assert saved.shape == "person"
    assert saved.version == 2
