"""Дозаливка СТРУКТУРЫ БД от агента (BYOA).

Без неё эпик наполовину бесполезен: базу с сорока таблицами руками не опишут. Здесь
проверяется то, чем этот путь отличается от ручного ввода: толерантный разбор, адрес
узла в файле, повторный прогон без дублей и политика «ничего не удаляем».

Обращения сюда больше не приезжают — они живут пометками в схемах логики (пивот §9);
пакету по старому промпту это объясняют предупреждением.
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.data_import import MAX_DUPLICATE_WARNINGS, parse_data_file
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


# ── Одна таблица в НЕСКОЛЬКИХ файлах пакета (П7 тюнинга федерации) ────────────
# Механизм тот же, что у каналов (7bbf9cd): живое состояние читалось по файлу и не
# знало о таблицах, уже поставленных в план предыдущими файлами. Превью молчало и
# показывало такую таблицу ДВУМЯ строками «create» с разным числом колонок, а
# применение падало 500-й — второй файл лил одноимённую колонку в таблицу, только что
# созданную первым (uq_db_column_name). Дубль внутри пакета законен (обзорный файл по
# миграциям пересекается с подробным по одной таблице), значит слияние — по тому же
# правилу, что у пакетов разных репозиториев: побеждает описавший раньше.

ФАЙЛ_ОБЗОРНЫЙ = """# archmap-node: Хранилище
tables:
  - name: orders
    description: заказы покупателей
    columns:
      - name: id
        type: uuid
        pk: true
        required: true
      - name: status
        description: new|paid|shipped
"""

# Та же таблица подробным файлом: «id» пересекается, «created_at» — нет, описание
# таблицы расходится, а тип «status» виден только отсюда.
ФАЙЛ_ПОДРОБНЫЙ = """# archmap-node: Хранилище
tables:
  - name: orders
    description: заказы маркетплейса
    columns:
      - name: id
        type: bigint
        description: суррогатный ключ
      - name: status
        type: varchar(16)
      - name: created_at
        type: timestamptz
        required: true
"""

ДВА_ФАЙЛА = [("a.yaml", ФАЙЛ_ОБЗОРНЫЙ), ("b.yaml", ФАЙЛ_ПОДРОБНЫЙ)]


def _пакет_из(файлы, overwrite=False, node_id=None):
    return DataImportIn(
        files=[{"name": имя, "content": текст} for имя, текст in файлы],
        overwrite=overwrite,
        node_id=node_id,
    )


def _превью_файлами(db, файлы, node_id=None):
    return data_import_preview(
        _пакет_из(файлы, node_id=node_id),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )


def _применить_файлами(db, файлы, overwrite=False, node_id=None):
    return data_import_apply(
        _пакет_из(файлы, overwrite=overwrite, node_id=node_id),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def _дубли(r):
    """Замечания о таблице из нескольких файлов — по хвосту «побеждает первый файл»
    (общее «в нескольких файлах» поймало бы и строку капа)."""
    return [w for w in r.warnings if "побеждает первый файл" in w]


def _таблица(db, имя):
    return db.query(DbTable).filter(DbTable.name == имя).one()


def _пакет_таблиц(*имена, адрес="Хранилище"):
    return f"# archmap-node: {адрес}\ntables:\n" + "".join(f"  - name: {и}\n" for и in имена)


def test_таблица_из_двух_файлов_пакета_сливается_в_одну_строку(db):
    _сцена(db)

    r = _превью_файлами(db, ДВА_ФАЙЛА)

    assert r.errors == []
    [строка] = r.tables
    # Источник — файл ПЕРВОГО вхождения, а число колонок — уже после слияния:
    # id (в обоих файлах) + status + created_at.
    assert (строка.source, строка.name, строка.action) == ("a.yaml", "orders", "create")
    assert строка.columns == 3
    [w] = _дубли(r)
    assert "таблица «orders» описана в нескольких файлах пакета (a.yaml, b.yaml)" in w
    assert "колонки сольются в одну таблицу" in w
    assert "при совпадении имени колонки и расхождении меты побеждает первый файл" in w


def test_межфайловый_дубль_применяется_и_побеждает_первый_файл(db):
    """Тот самый 500-й: второй файл лил колонку «id» в таблицу, только что созданную
    первым, и падал на уникальности (table_id, name)."""
    _сцена(db)

    r = _применить_файлами(db, ДВА_ФАЙЛА)

    assert r.applied and r.errors == []
    assert db.query(DbTable).count() == 1
    orders = _таблица(db, "orders")
    # Колонки объединились по имени, порядок первого файла не перемешан.
    assert [c.name for c in orders.columns] == ["id", "status", "created_at"]
    id_ = next(c for c in orders.columns if c.name == "id")
    assert (id_.type, id_.is_primary_key, id_.nullable) == ("uuid", True, False)
    # Пустое доливается вторым файлом: описание «id» и тип «status» есть только там.
    assert id_.description == "суррогатный ключ"
    status = next(c for c in orders.columns if c.name == "status")
    assert (status.type, status.description) == ("varchar(16)", "new|paid|shipped")
    assert orders.description == "заказы покупателей"
    assert (r.tables_written, r.columns_written) == (1, 3)

    # Повторный прогон того же пакета ничего не дописывает (инвариант модуля).
    повтор = _применить_файлами(db, ДВА_ФАЙЛА)
    assert db.query(DbTable).count() == 1 and db.query(DbColumn).count() == 3
    assert (повтор.tables_written, повтор.columns_written) == (0, 0)
    assert [i.action for i in повтор.tables] == ["unchanged"]


def test_расхождение_описания_таблицы_замечает_и_берёт_первое(db):
    # Файлы собраны разными прогонами и честно видят разное. Молча взять последнее —
    # значит поставить смысл карты в зависимость от порядка файлов в пакете.
    _сцена(db)

    r = _превью_файлами(db, ДВА_ФАЙЛА)

    [w] = [w for w in r.warnings if "description" in w]
    assert w == (
        "b.yaml: таблица «orders» — description «заказы маркетплейса», а в a.yaml "
        "«заказы покупателей»; оставлено значение из a.yaml (описана раньше)"
    )
    # Применение оставляет ровно то значение, о котором сказало превью.
    _применить_файлами(db, ДВА_ФАЙЛА)
    assert _таблица(db, "orders").description == "заказы покупателей"


def test_описание_которого_нет_в_первом_файле_второй_доливает_молча(db):
    # «Не знаю» не спорит со «знаю» — то же правило, что у меты каналов: файл про один
    # срез кода не видит того, что видел другой.
    _сцена(db)

    r = _применить_файлами(db, [
        ("a.yaml", "# archmap-node: Хранилище\ntables:\n  - name: orders\n"),
        ("b.yaml", ФАЙЛ_ПОДРОБНЫЙ),
    ])

    assert _таблица(db, "orders").description == "заказы маркетплейса"
    assert [w for w in r.warnings if "description" in w] == []


def test_превью_и_применение_дают_один_план(db):
    # Расхождение этих двух планов и было багой: превью показывало две строки
    # «create», применение — 500-ю.
    _сцена(db)

    п = _превью_файлами(db, ДВА_ФАЙЛА)
    р = _применить_файлами(db, ДВА_ФАЙЛА)

    assert [i.model_dump() for i in п.tables] == [i.model_dump() for i in р.tables]
    assert п.warnings == р.warnings and р.errors == []


def test_одно_имя_в_разных_базах_и_схемах_остаётся_разными_таблицами(db):
    # Слияние — по «узел + схема БД + имя»: одноимённая таблица в другой базе (или в
    # другой схеме той же базы) законна, и склейка потеряла бы одну из них.
    _сцена(db)
    _node(db, "Архив")

    r = _применить_файлами(db, [
        ("a.yaml", "# archmap-node: Хранилище\ntables:\n  - name: orders\n"),
        ("b.yaml", "# archmap-node: Архив\ntables:\n  - name: orders\n"),
        ("c.yaml", "# archmap-node: Хранилище\ntables:\n  - name: orders\n    schema: billing\n"),
    ])

    assert len(r.tables) == 3
    assert db.query(DbTable).count() == 3
    assert _дубли(r) == []


def test_колонка_названная_дважды_в_одной_таблице_не_задваивается(db):
    # Неряшливость того же класса внутри одного файла: превью показало бы завышенное
    # число колонок, а применение упало бы на той же уникальности.
    _сцена(db)

    r = _применить(
        db,
        "# archmap-node: Хранилище\ntables:\n  - name: orders\n    columns:\n"
        "      - name: id\n        type: uuid\n"
        "      - name: id\n        type: bigint\n",
    )

    assert r.applied and r.errors == []
    assert [(c.name, c.type) for c in _таблица(db, "orders").columns] == [("id", "uuid")]
    assert [i.columns for i in r.tables] == [1]


def test_таблица_названная_дважды_в_одном_файле_сливается_молча(db):
    # Тот же 500-й внутри ОДНОГО файла, и то же слияние. Предупреждения нет: «описана в
    # нескольких файлах пакета» тут было бы неправдой — файл один.
    _сцена(db)

    r = _применить(
        db,
        "# archmap-node: Хранилище\ntables:\n"
        "  - name: orders\n    columns:\n      - name: id\n        type: uuid\n"
        "  - name: orders\n    columns:\n      - name: id\n        type: bigint\n"
        "      - name: total\n        type: numeric\n",
    )

    assert r.applied and r.errors == []
    assert [i.columns for i in r.tables] == [2]
    assert [(c.name, c.type) for c in _таблица(db, "orders").columns] == [
        ("id", "uuid"), ("total", "numeric"),
    ]
    assert _дубли(r) == []


def test_кап_замечаний_о_дублях_и_хвост(db):
    _сцена(db)
    имена = [f"t{i}" for i in range(MAX_DUPLICATE_WARNINGS + 2)]

    r = _превью_файлами(db, [
        ("a.yaml", _пакет_таблиц(*имена)),
        ("b.yaml", _пакет_таблиц(*имена)),
    ])

    assert len(_дубли(r)) == MAX_DUPLICATE_WARNINGS
    assert "…ещё 2 таблиц описаны в нескольких файлах пакета" in r.warnings
