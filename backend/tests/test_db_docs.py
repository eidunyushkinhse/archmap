"""Структура БД (таблицы/колонки) и обращения к данным.

Проверяется то, ради чего модель именно такая (docs/plan-db-docs.md):
  • структура — «контракт» узла-базы, у контейнера её не бывает;
  • обращения живут у ВЫЗЫВАЮЩЕГО, в доке его операции, и уходят на ЧУЖОЙ узел;
  • снос базы уносит её структуру и обращения к ней, но НЕ доки чужих сервисов.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.doc_data_access import DocDataAccess
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.routers.db_docs import (
    create_access,
    create_column,
    create_table,
    delete_table,
    list_project_tables,
    list_usage,
    update_table,
)
from app.schemas.db_doc import (
    DataAccessCreate,
    DbColumnCreate,
    DbTableCreate,
    DbTableUpdate,
)


def _node(db, name, shape="database", parent=None, project=None):
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


def _doc(db, node, name="POST /pay", content=""):
    d = NodeDoc(id=uuid.uuid4(), node_id=node.id, name=name, kind="operation", content=content)
    db.add(d)
    db.flush()
    return d


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


# ── Таблицы и колонки ─────────────────────────────────────────────────────────


def test_имя_таблицы_уникально_в_контуре_но_не_между_контурами(db):
    бд = _node(db, "Хранилище")
    _table(db, бд, "orders")
    with pytest.raises(HTTPException) as e:
        _table(db, бд, "orders")
    assert e.value.status_code == 409
    # Контур ставит пустую строку вместо NULL — иначе уникальность не сработала бы
    # вовсе (в Postgres NULL-ы друг другу не конфликтуют).
    другой = _table(db, бд, "orders", schema="billing")
    assert другой.schema_name == "billing"


def test_у_контейнера_структуры_не_бывает(db):
    родитель = _node(db, "Платформа", shape="service")
    _node(db, "Ребёнок", shape="service", parent=родитель)
    with pytest.raises(HTTPException) as e:
        _table(db, родитель, "orders")
    assert e.value.status_code == 400


def test_колонка_уникальна_в_таблице_и_уходит_с_таблицей(db):
    бд = _node(db, "Хранилище")
    t = _table(db, бд)
    _column(db, бд, t, "status")
    with pytest.raises(HTTPException) as e:
        _column(db, бд, t, "status")
    assert e.value.status_code == 409

    delete_table(бд.id, t.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert db.query(DbColumn).count() == 0


def test_CAS_таблицы(db):
    бд = _node(db, "Хранилище")
    t = _table(db, бд)
    with pytest.raises(HTTPException) as e:
        update_table(
            бд.id,
            t.id,
            DbTableUpdate(description="что-то", base_version=t.version + 5),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert e.value.status_code == 409


# ── Обращения ─────────────────────────────────────────────────────────────────


def _access(db, сервис, док, table, column=None, mode="write"):
    return create_access(
        сервис.id,
        док.id,
        DataAccessCreate(table_id=table.id, column_id=column.id if column else None, mode=mode),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def test_обращение_уходит_на_чужой_узел_и_не_дублируется(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    док = _doc(db, сервис)
    t = _table(db, бд)
    c = _column(db, бд, t)

    a = _access(db, сервис, док, t, c)
    assert a.table_id == t.id and a.column_id == c.id

    with pytest.raises(HTTPException) as e:
        _access(db, сервис, док, t, c)
    assert e.value.status_code == 409
    # Другое действие с той же колонкой — законная вторая запись.
    assert _access(db, сервис, док, t, c, mode="read").mode == "read"


def test_обращение_на_уровне_таблицы_без_колонки(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    док = _doc(db, сервис)
    t = _table(db, бд)
    # SELECT * обычен: колоночная точность необязательна (решение 2026-08-12).
    assert _access(db, сервис, док, t).column_id is None


def test_колонка_не_из_этой_таблицы_отвергается(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    док = _doc(db, сервис)
    t1, t2 = _table(db, бд, "orders"), _table(db, бд, "accounts")
    чужая = _column(db, бд, t2, "balance")
    with pytest.raises(HTTPException) as e:
        _access(db, сервис, док, t1, чужая)
    assert e.value.status_code == 400


def test_таблица_чужого_проекта_не_видна(db):
    ensure_project(db)  # свой проект должен появиться ПЕРВЫМ (ensure_project берёт first)
    другой = Project(id=uuid.uuid4(), name="Чужой")
    db.add(другой)
    db.flush()
    чужая_бд = _node(db, "Чужое хранилище", project=другой)
    чужая = DbTable(id=uuid.uuid4(), node_id=чужая_бд.id, name="orders")
    db.add(чужая)
    db.flush()

    сервис = _node(db, "Биллинг", shape="service")
    док = _doc(db, сервис)
    with pytest.raises(HTTPException) as e:
        _access(db, сервис, док, чужая)
    assert e.value.status_code == 404


def test_снос_базы_уносит_структуру_и_обращения_но_не_чужой_док(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    док = _doc(db, сервис)
    t = _table(db, бд)
    _access(db, сервис, док, t)

    db.delete(бд)
    db.commit()

    assert db.query(DbTable).count() == 0
    # Обращение без таблицы бессмысленно — уходит каскадом…
    assert db.query(DocDataAccess).count() == 0
    # …а сам док операции остаётся: он про сервис, а не про базу.
    assert db.query(NodeDoc).filter(NodeDoc.id == док.id).count() == 1


# ── Обратный индекс и каталог ─────────────────────────────────────────────────
# Источник обратного индекса — ПОМЕТКИ в тексте схем логики (пивот §9 плана), а не
# отдельные записи: факт «операция пишет orders.status» существует ровно один раз,
# прозой в диаграмме, и разойтись с ней индекс не может.


def _usage(db, бд):
    return list_usage(бд.id, db=db, project=ensure_project(db), _=ensure_architect(db))


def test_обратный_индекс_отвечает_кто_кладёт_значение(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    t = _table(db, бд)
    c = _column(db, бд, t)
    _doc(db, сервис, "POST /pay", 'A["Списать средства<br>пишет: orders.status"]')
    _doc(db, сервис, "Обзор")  # док без текста и без пометок: не падаем и не шумим

    строки = _usage(db, бд)

    assert len(строки) == 1
    u = строки[0]
    # Ради этого ответа всё и строилось: не «есть таблица orders», а «в orders.status
    # пишет операция POST /pay сервиса Биллинг».
    assert (u.table_name, u.column_name, u.mode) == ("orders", "status", "write")
    assert (u.doc_name, u.node_name) == ("POST /pay", "Биллинг")
    assert (u.table_id, u.column_id) == (t.id, c.id)


def test_обратный_индекс_видит_только_свои_таблицы(db):
    бд = _node(db, "Хранилище")
    чужая_бд = _node(db, "Другое хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    _table(db, бд, "orders")  # своя таблица есть — фильтр по узлу не вырожденный
    _table(db, чужая_бд, "прочее")
    _doc(db, сервис, content='A["читает: прочее"]')

    assert _usage(db, бд) == []


def test_неизвестная_колонка_даёт_строку_на_уровне_таблицы(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    t = _table(db, бд)
    _column(db, бд, t, "status")
    _doc(db, сервис, content='A["пишет: orders.discount"]')

    [u] = _usage(db, бд)
    # Таблица нашлась → обращение к ней ЦЕЛИКОМ; несуществующую колонку в индекс не
    # тащим (её подсветит алерт битой пометки), но и обращение не прячем.
    assert (u.table_name, u.column_id, u.column_name) == ("orders", None, None)


def test_битая_пометка_в_индекс_не_попадает(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    _table(db, бд, "orders")
    _doc(db, сервис, content='A["читает: ordrs.status"]')

    # Опечатка в имени таблицы — не факт, а обещание факта: место такой пометке в
    # алертах, а не в индексе базы (домысливать «наверное, orders» нельзя).
    assert _usage(db, бд) == []


def test_неоднозначная_ссылка_показывается_только_с_квалификатором(db):
    бд = _node(db, "Хранилище")
    кэш = _node(db, "Кэш")
    сервис = _node(db, "Биллинг", shape="service")
    _table(db, бд, "orders")
    _table(db, кэш, "orders")  # одноимённая в другой базе: голое «orders» неоднозначно
    док = _doc(db, сервис, "POST /pay", 'A["читает: orders"]')

    assert _usage(db, бд) == []

    док.content = 'A["читает: Хранилище / orders"]'
    db.flush()
    [u] = _usage(db, бд)
    assert (u.table_name, u.node_name, u.mode) == ("orders", "Биллинг", "read")


def test_два_написания_одной_цели_дают_одну_строку(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    t = _table(db, бд)
    _column(db, бд, t)
    _doc(
        db,
        сервис,
        content=(
            'A["Списать<br>пишет: orders.status"] --> '
            'B["Повтор<br>пишет: Хранилище / orders.status"]'
        ),
    )

    # Одно и то же обращение, записанное двумя способами, — одна строка индекса.
    assert len(_usage(db, бд)) == 1


def test_каталог_таблиц_называет_владельца(db):
    бд = _node(db, "Хранилище")
    _table(db, бд, "orders")
    другая = _node(db, "Кэш")
    _table(db, другая, "orders")  # одноимённая: без имени узла их не различить

    каталог = list_project_tables(db=db, project=ensure_project(db), _=ensure_architect(db))

    assert sorted((t.node_name, t.name) for t in каталог) == [
        ("Кэш", "orders"), ("Хранилище", "orders"),
    ]
