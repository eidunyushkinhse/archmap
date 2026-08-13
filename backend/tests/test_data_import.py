"""Дозаливка СТРУКТУРЫ БД от агента (BYOA).

Без неё эпик наполовину бесполезен: базу с сорока таблицами руками не опишут. Здесь
проверяется то, чем этот путь отличается от ручного ввода: толерантный разбор, адрес
узла в файле, повторный прогон без дублей и политика «ничего не удаляем».

Обращения сюда больше не приезжают — они живут пометками в схемах логики (пивот §9);
пакету по старому промпту это объясняют предупреждением.
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.data_import import parse_data_file
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.node import Node
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
"""

# Пакет по СТАРОМУ промпту: обращения записями. Кроме них в файле нет ничего — такой
# пакет обязан получить объяснение, а не «в пакете нет файлов со структурой данных».
СТАРЫЙ_ПАКЕТ = """# archmap-node: Хранилище
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


def _сцена(db):
    бд = _node(db, "Хранилище")
    # Сервис рядом не для красоты: с единственным узлом резолв адреса владельца был бы
    # вырожденным и «# archmap-node: Хранилище» ничего не проверял.
    сервис = _node(db, "Биллинг", shape="service")
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
    )
    assert pd is not None
    assert [t.name for t in pd.tables] == ["ok"]


# ── Применение ────────────────────────────────────────────────────────────────


def test_пакет_создаёт_структуру_и_ссылки(db):
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


def test_повторный_прогон_не_плодит_дублей(db):
    _сцена(db)
    _применить(db)
    r = _применить(db)

    assert db.query(DbTable).count() == 2
    assert r.tables_written == 0
    # В превью такие строки честно помечены «unchanged», а не «create».
    assert {i.action for i in r.tables} == {"unchanged"}


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


def test_битый_yaml_нашего_файла_не_молчит(db):
    _сцена(db)
    r = _применить(db, "tables:\n  - name: x\n    description: ключ: значение\n")
    assert not r.applied
    # Раньше такой файл просто «не считался нашим», и пользователь получал «в пакете
    # нет файлов со структурой данных» — при том, что данные в пакете были.
    assert any("YAML не разобрался" in e for e in r.errors)


def test_структура_только_у_узла_БД_иначе_ошибка_с_перечнем(db):
    # Зеркало CRUD-правила «структура — контракт узла-БД» (test_у_контейнера_структуры_
    # не_бывает): применённое на сервисе стало бы НЕВИДИМЫМ — секцию «Структура»
    # страница рендерит только у формы database.
    _сцена(db)
    r = _применить(db, ПАКЕТ.replace("Хранилище", "Биллинг"))

    assert not r.applied and db.query(DbTable).count() == 0
    [e] = r.errors
    assert "объект «Биллинг» — не база данных" in e
    # Перечень допустимых — чтобы слабая модель не гадала адрес во второй раз.
    assert "Узлы-БД проекта: Хранилище" in e


def test_структура_контейнеру_не_приезжает(db):
    бд, _сервис = _сцена(db)
    контейнер = _node(db, "Платформа", shape="service")
    вложенная = Node(id=uuid.uuid4(), name="БД платформы", shape="database",
                     parent_id=контейнер.id, project_id=ensure_project(db).id)
    db.add(вложенная)
    db.flush()

    r = _применить(db, ПАКЕТ.replace("Хранилище", "Платформа"))
    assert not r.applied and db.query(DbTable).count() == 0
    [e] = r.errors
    assert "объект «Платформа» — не база данных" in e
    # В перечне — обе базы проекта, вложенная полным путём.
    assert "Узлы-БД проекта: Платформа / БД платформы, Хранилище" in e


def test_объект_не_найден_называет_узлы_БД(db):
    # Полевой кейс: агент выдумал «Zabbix Storage», слепая ошибка стоила раунда
    # переписки — теперь ошибка сама называет допустимые адреса.
    _сцена(db)
    r = _применить(db, ПАКЕТ.replace("Хранилище", "Zabbix Storage"))

    assert not r.applied
    [e] = r.errors
    assert "объект «Zabbix Storage» не найден" in e
    assert "узлы-БД проекта: Хранилище" in e


def test_ключ_archmap_node_адресом_не_считается_но_предупреждает(db):
    # Агент потерял решётку: адрес стал невидимым YAML-ключом, и записи молча уехали
    # к объекту окна. Поведение прежнее (ключ игнорируется), но тишины больше нет.
    бд, _сервис = _сцена(db)
    r = data_import_apply(
        DataImportIn(
            files=[{"name": "data.yaml", "content": ПАКЕТ.replace("# archmap-node:", "archmap-node:")}],
            node_id=бд.id,
        ),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )

    assert r.applied and r.errors == []
    assert db.query(DbTable).filter(DbTable.node_id == бд.id).count() == 2
    про_ключ = [w for w in r.warnings if "archmap-node" in w]
    assert len(про_ключ) == 1
    assert "адресом не является" in про_ключ[0] and "уедут к объекту окна" in про_ключ[0]


def test_частичный_путь_узла_находится(db):
    # Агент видит только свой репозиторий и корневого контейнера не знает — промпт
    # просит путь, а корень в нём отсутствует. Хвост пути обязан совпадать.
    корень = _node(db, "Маркетплейс", shape="service")
    сервис = Node(id=uuid.uuid4(), name="Сервис заказов", shape="service",
                  parent_id=корень.id, project_id=ensure_project(db).id)
    db.add(сервис)
    db.flush()
    бд = Node(id=uuid.uuid4(), name="БД заказов", shape="database",
              parent_id=сервис.id, project_id=ensure_project(db).id)
    db.add(бд)
    db.flush()
    # Полный путь — «Маркетплейс / Сервис заказов / БД заказов»; агент напишет хвост.
    r = _применить(db, "# archmap-node: Сервис заказов / БД заказов\ntables:\n  - name: orders\n")
    assert r.applied and r.errors == []
    assert db.query(DbTable).filter(DbTable.node_id == бд.id).count() == 1


def test_старый_раздел_access_объясняют_а_не_замалчивают(db):
    _сцена(db)
    r = _применить(db, СТАРЫЙ_ПАКЕТ)

    # Не ошибка: файл НАШ, просто его половина больше не существует как сущность.
    # Молчать нельзя — пакет по старому промпту иначе уезжает в тишину и человек
    # решает, что обращения загрузились.
    assert r.applied and r.errors == []
    про_access = [w for w in r.warnings if "access" in w]
    # РОВНО ОДНО на файл, а не по строке на каждое обращение (их в пакете два).
    assert len(про_access) == 1
    assert "пометками" in про_access[0] and "data.yaml" in про_access[0]
    assert db.query(DbTable).count() == 0


def test_структура_рядом_с_разделом_access_всё_равно_приезжает(db):
    _сцена(db)
    # Смешанный пакет: таблицы забираем, про обращения предупреждаем. Отвергать такой
    # файл целиком значило бы наказать за старый промпт.
    r = _применить(db, ПАКЕТ.rstrip() + "\n\naccess:\n  - node: Биллинг\n    doc: POST /pay\n"
                       "    table: orders\n    mode: write\n")

    assert r.applied and r.errors == []
    assert db.query(DbTable).count() == 2
    assert sum("access" in w for w in r.warnings) == 1
