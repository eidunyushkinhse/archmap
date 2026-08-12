"""Дозаливка структуры БД и обращений от агента (BYOA).

Без неё эпик наполовину бесполезен: базу с сорока таблицами руками не опишут. Здесь
проверяется то, чем этот путь отличается от ручного ввода: толерантный разбор, адрес
узла в файле, повторный прогон без дублей и политика «ничего не удаляем».
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.data_import import parse_data_file
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.doc_data_access import DocDataAccess
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.routers.data_import import data_import_apply, data_import_preview
from app.schemas.data_import import DataImportIn

ПАКЕТ = """# archmap-node: Хранилище
tables:
  - name: orders
    description: заказы покупателей
    columns:
      - name: id
        type: uuid
        pk: true
        required: true
      - name: status
        type: varchar(16)
        required: true
        description: new|paid|shipped
      - name: account_id
        type: uuid
        references: accounts.id
  - name: accounts
    columns:
      - name: id
        type: uuid
        pk: true

access:
  - node: Биллинг
    doc: POST /pay
    table: orders
    column: status
    mode: write
  - node: Биллинг
    doc: POST /pay
    table: accounts
    mode: read
"""


def _node(db, name, shape="database"):
    n = Node(id=uuid.uuid4(), name=name, shape=shape, project_id=ensure_project(db).id)
    db.add(n)
    db.flush()
    return n


def _doc(db, node, name="POST /pay"):
    d = NodeDoc(id=uuid.uuid4(), node_id=node.id, name=name, kind="operation", content="")
    db.add(d)
    db.flush()
    return d


def _сцена(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг", shape="service")
    _doc(db, сервис)
    return бд, сервис


def _применить(db, текст=ПАКЕТ, overwrite=False):
    return data_import_apply(
        DataImportIn(files=[{"name": "data.yaml", "content": текст}], overwrite=overwrite),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


# ── Разбор ────────────────────────────────────────────────────────────────────


def test_чужие_файлы_пакета_разборщик_не_трогает(db):
    # В пакете рядом лежат схемы логики и спеки — они не про данные.
    assert parse_data_file("graph TD\n  A --> B") is None
    assert parse_data_file("openapi: 3.0.0\npaths: {}") is None
    assert parse_data_file(ПАКЕТ) is not None


def test_разбор_толерантен_к_мусору(db):
    pd = parse_data_file(
        "tables:\n"
        "  - лишнее: поле\n"           # без name — пропускаем
        "  - name: ok\n"
        "    неизвестный_ключ: 1\n"     # игнорируем
        "    columns:\n"
        "      - name: c\n"
        "        type: int\n"
        "access:\n"
        "  - doc: X\n"                  # без table/mode — пропускаем
        "  - node: N\n    doc: D\n    table: T\n    mode: пишет\n"  # режим не наш
    )
    assert pd is not None
    assert [t.name for t in pd.tables] == ["ok"]
    assert pd.access == []


# ── Применение ────────────────────────────────────────────────────────────────


def test_пакет_создаёт_структуру_ссылки_и_обращения(db):
    бд, _сервис = _сцена(db)
    r = _применить(db)

    assert r.applied and r.errors == []
    orders = db.query(DbTable).filter(DbTable.name == "orders").one()
    assert orders.node_id == бд.id and orders.description == "заказы покупателей"
    status = next(c for c in orders.columns if c.name == "status")
    assert (status.type, status.nullable, status.description) == (
        "varchar(16)", False, "new|paid|shipped",
    )
    # Внешний ключ разрешается ВТОРЫМ проходом: цель описана ниже по файлу.
    account_id = next(c for c in orders.columns if c.name == "account_id")
    accounts_id = db.query(DbColumn).join(DbTable).filter(
        DbTable.name == "accounts", DbColumn.name == "id",
    ).one()
    assert account_id.references_column_id == accounts_id.id
    # Обращения приехали к доку ВЫЗЫВАЮЩЕГО, а колонка необязательна.
    access = db.query(DocDataAccess).all()
    assert {(a.mode, a.column_id is None) for a in access} == {("write", False), ("read", True)}


def test_повторный_прогон_не_плодит_дублей(db):
    _сцена(db)
    _применить(db)
    r = _применить(db)

    assert db.query(DbTable).count() == 2
    assert db.query(DocDataAccess).count() == 2
    assert r.tables_written == 0 and r.access_written == 0
    # В превью такие строки честно помечены «unchanged», а не «create».
    assert {i.action for i in r.tables} == {"unchanged"}
    assert {i.action for i in r.access} == {"unchanged"}


def test_описанного_руками_пакет_не_затирает_без_разрешения(db):
    _сцена(db)
    _применить(db)
    orders = db.query(DbTable).filter(DbTable.name == "orders").one()
    orders.description = "правка человека"
    db.flush()

    _применить(db)
    assert orders.description == "правка человека"
    _применить(db, overwrite=True)
    assert orders.description == "заказы покупателей"


def test_нет_схемы_логики_у_вызывающего_ошибка_а_не_молчание(db):
    _node(db, "Хранилище")
    _node(db, "Биллинг", shape="service")  # без дока
    r = _применить(db)
    assert not r.applied
    assert any("нет схемы" in e for e in r.errors)
    # Ошибка есть → не пишем НИЧЕГО, даже таблицы.
    assert db.query(DbTable).count() == 0


def test_превью_ничего_не_пишет(db):
    _сцена(db)
    r = data_import_preview(
        DataImportIn(files=[{"name": "data.yaml", "content": ПАКЕТ}]),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )
    assert not r.applied
    assert [i.action for i in r.tables] == ["create", "create"]
    assert db.query(DbTable).count() == 0
