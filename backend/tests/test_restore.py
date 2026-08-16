"""Тесты снимка удаления и восстановления (Undo удаления узла, итерация 2 + R3).

Round-trip: build_deletion_snapshot ДО удаления → delete_node (каскад + чистка
раскладки) → restore возвращает поддерево, инцидентные рёбра и строки раскладки
view_layout С ТЕМИ ЖЕ id/ключами. Внешние сущности снимок не трогает и restore
их не дублирует.
"""

import importlib
import pkgutil
import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException
from sqlalchemy import inspect as sa_inspect

import app.models
from app.copy_plan import COPY_PLAN
from app.database import Base
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.view_layout import ViewLayoutItem
from app.restore import (
    NOT_IN_SNAPSHOT,
    SNAPSHOT_PLAN,
    build_deletion_snapshot,
    restore_from_snapshot,
)
from app.routers.nodes import delete_node, restore_nodes


def _node(db, name, parent=None, **kw):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        **kw,
    )
    db.add(n)
    return n


def _edge(db, src, tgt, **kw):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id, project_id=ensure_project(db).id, **kw)
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


def test_snapshot_restore_round_trip(db):
    # Поддерево A → A1 → A1a; снаружи X, Y. Рёбра: внутреннее A1→A1a, исходящее A1a→X,
    # входящее X→A1, чисто внешнее X→Y. Строки раскладки на удаляемых и выживших.
    a = _node(db, "A")
    a1 = _node(db, "A1", a)
    a1a = _node(db, "A1a", a1)
    x = _node(db, "X")
    y = _node(db, "Y")
    # Не-дефолтные статусы должны пережить round-trip (регресс: при откате удаления
    # узел «Выводится»/«Планируется» возвращался как «Существует»).
    a.status = "deprecated"
    a1a.status = "planned"
    e_inner = _edge(db, a1, a1a, label="внутр")
    e_out = _edge(db, a1a, x)
    e_in = _edge(db, x, a1, is_synchronous=False)
    e_external = _edge(db, x, y)
    db.commit()

    _layout(db, x.id, str(a1.id), {"x": 1, "y": 2})                      # гость a1 на чужом виде
    _layout(db, a.id, str(x.id), {"x": 3, "y": 4})                       # вид A (умрёт каскадом)
    _layout(db, x.id, f"b:{x.id}>{a1.id}", {"waypoints": [{"x": 7.0, "y": 8.0}], "label_t": 0.3})
    _layout(db, x.id, str(y.id), {"x": 5, "y": 6})                       # обе ссылки живы → выживает
    db.commit()

    # id фиксируем заранее: после delete_node ORM-объекты удалены/просрочены и обращение
    # к их .id уже не пройдёт (DetachedInstanceError).
    a_id, a1_id, a1a_id, x_id, y_id = a.id, a1.id, a1a.id, x.id, y.id
    e_inner_id, e_out_id, e_in_id, e_ext_id = e_inner.id, e_out.id, e_in.id, e_external.id

    snap = build_deletion_snapshot(db, a_id)
    # Снимок повторяет ровно то, что исчезнет: 3 узла, 3 ребра (e_external — чисто
    # внешнее — нет) и 3 строки раскладки (гость, вид A, пучок; строка Y-выживает — нет).
    assert {n.id for n in snap.nodes} == {a_id, a1_id, a1a_id}
    assert {e.id for e in snap.edges} == {e_inner_id, e_out_id, e_in_id}
    assert {it.item_id for it in snap.layout_items} == {str(a1_id), str(x_id), f"b:{x_id}>{a1_id}"}

    delete_node(a_id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert {n.id for n in db.query(Node).all()} == {x_id, y_id}
    assert {e.id for e in db.query(Edge).all()} == {e_ext_id}
    assert db.query(ViewLayoutItem).count() == 1  # выжила только строка Y

    restore_from_snapshot(db, snap, project_id=ensure_project(db).id)

    # Узлы вернулись с теми же id и связями родителя
    nodes = {n.id: n for n in db.query(Node).all()}
    assert set(nodes) == {a_id, a1_id, a1a_id, x_id, y_id}
    assert nodes[a1_id].parent_id == a_id
    assert nodes[a1a_id].parent_id == a1_id
    # Статусы сохранились (а не сбросились в дефолтный existing)
    assert nodes[a_id].status == "deprecated"
    assert nodes[a1a_id].status == "planned"
    assert nodes[a1_id].status == "existing"

    # Рёбра вернулись с id и семантикой
    edges = {e.id: e for e in db.query(Edge).all()}
    assert set(edges) == {e_inner_id, e_out_id, e_in_id, e_ext_id}
    assert edges[e_inner_id].label == "внутр"
    assert edges[e_in_id].is_synchronous is False

    # Раскладка восстановлена и не задублирована (внешняя так и одна)
    items = {(r.view_id, r.item_id): r for r in db.query(ViewLayoutItem).all()}
    assert len(items) == 4
    bundle = items[(x_id, f"b:{x_id}>{a1_id}")]
    assert bundle.payload["waypoints"] == [{"x": 7.0, "y": 8.0}]
    assert bundle.payload["label_t"] == 0.3


def test_get_snapshot_missing_node_404(db):
    from app.routers.nodes import get_deletion_snapshot

    with pytest.raises(HTTPException) as ei:
        get_deletion_snapshot(uuid.uuid4(), db=db, project=ensure_project(db))
    assert ei.value.status_code == 404


def test_restore_conflict_when_nodes_exist(db):
    a = _node(db, "A")
    db.commit()
    snap = build_deletion_snapshot(db, a.id)
    # Узел A не удаляли — restore того же снимка должен упереться в конфликт.
    with pytest.raises(HTTPException) as ei:
        restore_nodes(snap, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 409


def test_restore_conflict_when_parent_gone(db):
    parent = _node(db, "P")
    child = _node(db, "C", parent)
    db.commit()
    snap = build_deletion_snapshot(db, child.id)  # снимок только ребёнка
    delete_node(child.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    delete_node(parent.id, db=db, project=ensure_project(db), user=ensure_architect(db))  # родитель тоже исчез
    with pytest.raises(HTTPException) as ei:
        restore_nodes(snap, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 409


def test_restore_empty_snapshot_400(db):
    from app.schemas.restore import DeletionSnapshot

    empty = DeletionSnapshot(nodes=[], edges=[], layout_items=[])
    with pytest.raises(HTTPException) as ei:
        restore_nodes(empty, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 400


# --- Откат удаления/создания СВЯЗИ (итерация 3): рёберный снимок (nodes=[]) ---


def test_edge_snapshot_restore_round_trip(db):
    # Связь X→Y. Раскладка живёт на ключе ПУЧКА и удаление связи её НЕ сносит
    # (R3): снимок несёт только само ребро, геометрия пучка остаётся ждать его.
    from app.restore import build_edge_deletion_snapshot

    x = _node(db, "X")
    y = _node(db, "Y")
    e = _edge(db, x, y, label="зов", is_synchronous=True, channel="orders.created")
    db.commit()
    _layout(db, x.id, f"b:{x.id}>{y.id}", {"source_handle": "x--right--0"})
    db.commit()
    x_id, y_id, e_id = x.id, y.id, e.id

    snap = build_edge_deletion_snapshot(db, e_id)
    assert snap.nodes == []
    assert {ed.id for ed in snap.edges} == {e_id}
    assert snap.layout_items == []

    # Удаляем связь: узлы и геометрия пучка остаются.
    db.delete(db.get(Edge, e_id))
    db.commit()
    assert db.query(Edge).count() == 0
    assert {n.id for n in db.query(Node).all()} == {x_id, y_id}
    assert db.query(ViewLayoutItem).count() == 1

    restore_from_snapshot(db, snap, project_id=ensure_project(db).id)

    edges = db.query(Edge).all()
    assert len(edges) == 1
    e2 = edges[0]
    assert e2.id == e_id and e2.label == "зов" and e2.is_synchronous is True
    # Канал брокера тоже переживает откат: снимок без него молча терял бы поле
    # (урок «nodeFields без status»).
    assert e2.channel == "orders.created"
    # Геометрия пучка дождалась восстановленную связь (и не задублировалась)
    assert db.query(ViewLayoutItem).count() == 1


def test_edge_snapshot_missing_edge_404(db):
    from app.routers.edges import edge_deletion_snapshot

    with pytest.raises(HTTPException) as ei:
        edge_deletion_snapshot(uuid.uuid4(), db=db, project=ensure_project(db))
    assert ei.value.status_code == 404


# --- Документация узла: она умирает каскадом и обязана вернуться вместе с ним ---


def test_restore_returns_db_tables_with_columns_and_reference(db):
    """Откат удаления узла-базы возвращает структуру БД целиком, включая ER-ссылку
    между колонками. Ссылающуюся колонку заводим РАНЬШЕ её цели: в снимке она окажется
    выше, и вставка «как есть» одним проходом упёрлась бы в FK."""
    base = _node(db, "База", shape="database")
    db.flush()
    orders = DbTable(id=uuid.uuid4(), node_id=base.id, name="orders", schema_name="billing")
    users = DbTable(id=uuid.uuid4(), node_id=base.id, name="users")
    db.add_all([orders, users])
    db.flush()
    ref = DbColumn(id=uuid.uuid4(), table_id=orders.id, name="user_id", type="uuid", order=1)
    target = DbColumn(
        id=uuid.uuid4(),
        table_id=users.id,
        name="id",
        type="uuid",
        is_primary_key=True,
        nullable=False,
        description="первичный ключ",
    )
    db.add_all([ref, target])
    db.flush()
    ref.references_column_id = target.id
    db.commit()
    base_id, orders_id, users_id, ref_id, target_id = (
        base.id, orders.id, users.id, ref.id, target.id
    )

    snap = build_deletion_snapshot(db, base_id)
    assert {t.id for t in snap.db_tables} == {orders_id, users_id}
    assert {c.id for c in snap.db_columns} == {ref_id, target_id}

    delete_node(base_id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert db.query(DbTable).count() == 0 and db.query(DbColumn).count() == 0

    restore_from_snapshot(db, snap, project_id=ensure_project(db).id)

    tables = {t.id: t for t in db.query(DbTable).all()}
    assert set(tables) == {orders_id, users_id}
    assert (tables[orders_id].name, tables[orders_id].schema_name) == ("orders", "billing")
    columns = {c.id: c for c in db.query(DbColumn).all()}
    assert set(columns) == {ref_id, target_id}
    assert columns[target_id].is_primary_key is True
    assert columns[target_id].description == "первичный ключ"
    # ER-связь колонка→колонка вернулась и указывает на восстановленную цель.
    assert columns[ref_id].references_column_id == target_id


def test_restore_returns_broker_channels_with_fields(db):
    """Откат удаления узла-брокера возвращает каналы вместе с полями сообщений."""
    broker = _node(db, "Kafka", shape="broker")
    db.flush()
    channel = BrokerChannel(
        id=uuid.uuid4(),
        node_id=broker.id,
        name="orders.created",
        kind="topic",
        partition_key="order_id",
        delivery="at-least-once",
        retention="7d",
    )
    db.add(channel)
    db.flush()
    db.add_all([
        ChannelField(id=uuid.uuid4(), channel_id=channel.id, name="order_id", type="uuid", required=True),
        ChannelField(id=uuid.uuid4(), channel_id=channel.id, name="status", type="string", order=1,
                     description="new|paid"),
    ])
    db.commit()
    broker_id, channel_id = broker.id, channel.id

    snap = build_deletion_snapshot(db, broker_id)
    assert {c.id for c in snap.broker_channels} == {channel_id}
    assert len(snap.channel_fields) == 2

    delete_node(broker_id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert db.query(BrokerChannel).count() == 0 and db.query(ChannelField).count() == 0

    restore_from_snapshot(db, snap, project_id=ensure_project(db).id)

    ch = db.query(BrokerChannel).one()
    assert ch.id == channel_id
    assert (ch.name, ch.kind, ch.partition_key, ch.delivery, ch.retention) == (
        "orders.created", "topic", "order_id", "at-least-once", "7d"
    )
    fields = sorted(db.query(ChannelField).all(), key=lambda f: f.order)
    assert [(f.name, f.type, f.required, f.description) for f in fields] == [
        ("order_id", "uuid", True, None),
        ("status", "string", False, "new|paid"),
    ]


def test_restore_returns_source_ref(db):
    """Якорь источника переживает откат: без него следующий прогон агента не узнал бы
    вернувшийся узел и завёл дубль."""
    n = _node(db, "Платежи", source_ref="git:github.com/org/payments")
    db.commit()
    node_id = n.id

    snap = build_deletion_snapshot(db, node_id)
    delete_node(node_id, db=db, project=ensure_project(db), user=ensure_architect(db))
    restore_from_snapshot(db, snap, project_id=ensure_project(db).id)

    assert db.get(Node, node_id).source_ref == "git:github.com/org/payments"


# --- Сторожа снимка: перечень полей не должен снова стать ручным ---------------


def _all_mappers():
    """Все модели проекта. Пакет обходим ФАЙЛАМИ (как в test_copy_plan): новая модель
    приезжает отдельным модулем, и сторож обязан увидеть её сам."""
    for module in pkgutil.iter_modules(app.models.__path__):
        importlib.import_module(f"app.models.{module.name}")
    return list(Base.registry.mappers)


def _cascade_children_of_node() -> set[type]:
    """Модели, чьи строки снесёт БД-каскадом удаление узла (транзитивно: колонки
    уходят за таблицами, поля — за каналами). Вглубь моделей из NOT_IN_SNAPSHOT не
    идём: их содержимое уезжает вместе с ними, и причина уже записана."""
    mappers = _all_mappers()
    reached: set[type] = set()
    frontier = {Node.__tablename__}
    while frontier:
        parents, frontier = frontier, set()
        for mapper in mappers:
            model = mapper.class_
            if model in reached:
                continue
            if any(
                (fk.ondelete or "").upper() == "CASCADE" and fk.referred_table.name in parents
                for fk in mapper.local_table.foreign_key_constraints
            ):
                reached.add(model)
                if model not in NOT_IN_SNAPSHOT:
                    frontier.add(mapper.local_table.name)
    return reached


def test_every_cascade_child_of_node_is_in_snapshot_or_declared():
    """Новая таблица, которую сносит удаление узла, обязана попасть в снимок.

    Именно этот пропуск стоил пользователю документации: db_tables и broker_channels
    завели, а про откат удаления не вспомнили — Ctrl+Z возвращал узел без неё, молча.
    """
    undeclared = _cascade_children_of_node() - set(SNAPSHOT_PLAN) - set(NOT_IN_SNAPSHOT)
    assert not undeclared, (
        "Модели умирают каскадом вместе с узлом, но в снимке удаления их нет: "
        f"{sorted(m.__name__ for m in undeclared)}. Решите: несёт их снимок "
        "(SNAPSHOT_PLAN + схема) или намеренно нет (NOT_IN_SNAPSHOT, с причиной)."
    )


def test_snapshot_carries_every_data_column_of_its_model():
    """Каждая колонка-ДАННЫЕ (по декларации copy_plan) обязана быть полем снимка.

    Так снимок и потерял source_ref: колонку у модели завели, а перечень полей
    снимка остался ручным.
    """
    for model, schema in SNAPSHOT_PLAN.items():
        missing = set(COPY_PLAN[model].data) - set(schema.model_fields)
        assert not missing, (
            f"{schema.__name__}: не несёт колонки {sorted(missing)} модели "
            f"{model.__name__}. Откат удаления вернёт строку без них — молча."
        )


def test_snapshot_fields_are_columns_of_their_model():
    """Обратная сторона: поле снимка обязано быть колонкой модели — строка
    восстанавливается из полей снимка целиком, и лишнее уронило бы её сборку."""
    for model, schema in SNAPSHOT_PLAN.items():
        columns = {attr.key for attr in sa_inspect(model).column_attrs}
        extra = set(schema.model_fields) - columns
        assert not extra, f"{schema.__name__}: полей {sorted(extra)} нет у {model.__name__}"


def test_restore_conflict_when_edge_exists(db):
    # Рёберный снимок существующей связи → restore без удаления упирается в 409.
    from app.restore import build_edge_deletion_snapshot

    x = _node(db, "X")
    y = _node(db, "Y")
    e = _edge(db, x, y)
    db.commit()
    snap = build_edge_deletion_snapshot(db, e.id)
    with pytest.raises(HTTPException) as ei:
        restore_nodes(snap, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert ei.value.status_code == 409
