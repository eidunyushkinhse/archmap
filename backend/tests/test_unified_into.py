"""Догрузка архивов в ЖИВОЙ проект (Ф3, docs/plan-unified-import.md).

Главные гарантии фазы, ради которых написан каждый тест ниже:

1. ДОГРУЗКА АДДИТИВНА. При дефолтных решениях («оставить моё») не меняется ни одна
   живая запись — ни поле узла, ни тело схемы, ни колонка, ни строка раскладки.
   Сильнейшая форма проверки — догрузить проекту ЕГО СОБСТВЕННЫЙ архив: идеальный
   ноль изменений, всё схлопнул дедуп.
2. ПЕРЕЗАПИСЬ — ТОЛЬКО ОСОЗНАННЫМ ВЫБОРОМ. Живое тело подменяется ровно там, где
   пользователь выбрал архивного кандидата, и нигде больше.
3. НИЧЕГО НЕ УДАЛЯЕТСЯ. Даже при «взять из архива» лишние живые колонки и поля
   остаются жить, и об этом говорится строкой отчёта.
4. КАРТА НА ЖИВЫЕ ЗАПИСИ ТОЧНА. Узел архива-входа №0 возвращается к своей записи по
   ПОРЯДКУ экспорта, а не по пути (тёзки в одном родителе легальны).
"""

import io
import json
import uuid
import zipfile

import pytest
import yaml
from conftest import ensure_architect
from fastapi.testclient import TestClient

from app.archive_export import build_archive
from app.auth import require_architect
from app.database import get_db
from app.main import app
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.process_import import apply_import as apply_process_import
from app.process_import import build_preview as build_process_preview
from app.processes import node_path
from app.unified_import import UnifiedImportError
from app.unified_into import apply_into_plan, build_into_plan, into_preview

ПРЕВЬЮ = "/api/v1/projects/{}/import-archive/preview"
ПРИМЕНЕНИЕ = "/api/v1/projects/{}/import-archive/apply"


# ── Строители живых проектов ─────────────────────────────────────────────────


def _проект(db, имя: str) -> Project:
    p = Project(id=uuid.uuid4(), name=имя)
    db.add(p)
    db.flush()
    return p


def _узел(db, проект: Project, имя: str, родитель: Node | None = None, **поля) -> Node:
    n = Node(
        id=uuid.uuid4(),
        project_id=проект.id,
        name=имя,
        parent_id=родитель.id if родитель else None,
        **поля,
    )
    db.add(n)
    db.flush()
    return n


def _ребро(db, проект: Project, из: Node, в: Node, **поля) -> Edge:
    e = Edge(id=uuid.uuid4(), project_id=проект.id, source_id=из.id, target_id=в.id, **поля)
    db.add(e)
    db.flush()
    return e


def _док(db, узел: Node, имя: str, тело: str, **поля) -> NodeDoc:
    d = NodeDoc(node_id=узел.id, name=имя, content=тело, **поля)
    db.add(d)
    db.flush()
    return d


def _таблица(db, узел: Node, имя: str, колонки, описание=None, schema="public") -> DbTable:
    t = DbTable(node_id=узел.id, name=имя, schema_name=schema, description=описание)
    db.add(t)
    db.flush()
    for i, (кимя, ктип) in enumerate(колонки):
        db.add(DbColumn(table_id=t.id, name=кимя, type=ктип, order=i, nullable=True))
    db.flush()
    return t


def _канал(db, узел: Node, имя: str, поля, описание=None, group="") -> BrokerChannel:
    c = BrokerChannel(node_id=узел.id, name=имя, group_name=group, description=описание)
    db.add(c)
    db.flush()
    for i, (пимя, птип) in enumerate(поля):
        db.add(ChannelField(channel_id=c.id, name=пимя, type=птип, order=i))
    db.flush()
    return c


def _параметр(db, узел: Node, имя: str, **поля) -> ConfigParam:
    p = ConfigParam(node_id=узел.id, name=имя, **поля)
    db.add(p)
    db.flush()
    return p


def _процесс(db, проект: Project, имя: str, текст: str) -> BusinessProcess:
    превью = build_process_preview(db, проект.id, текст, имя)
    proc, _ = apply_process_import(
        db, проект.id, текст, имя, {p.alias: p.node_id for p in превью.participants}
    )
    db.flush()
    return proc


ПРОЦЕСС = """sequenceDiagram
    participant orders
    participant Каталог-БД
    %% archmap-doc: Ярмарка / orders / POST /orders
    orders->>Каталог-БД: положить заказ
    Каталог-БД-->>orders: ок
"""


def _ярмарка(db, имя: str = "Живой", *, описание="Живое описание", тело="graph TD\n  A\n"):
    """Полный живой проект со всеми семьями знания и одним процессом."""
    проект = _проект(db, имя)
    корень = _узел(db, проект, "Ярмарка", role="система")
    orders = _узел(db, проект, "orders", корень, technology="Python", description=описание)
    каталог = _узел(db, проект, "Каталог-БД", корень, shape="database")
    kafka = _узел(db, проект, "Kafka", корень, shape="broker")
    _ребро(db, проект, orders, каталог, label="читает")
    _ребро(db, проект, kafka, orders, label="доставляет", channel="orders.created")
    _док(db, orders, "POST /orders", тело, kind="operation", operation="POST /orders")
    _таблица(db, каталог, "orders", [("id", "uuid"), ("comment", "text")], описание="заказы")
    _канал(db, kafka, "orders.created", [("id", "uuid")], описание="создание заказа")
    _параметр(db, orders, "TIMEOUT_MS", value_type="int", default_value="5000",
              description="таймаут")
    orders.openapi_spec = "openapi: 3.0.3\ninfo:\n  title: Живая\npaths: {}\n"
    db.flush()
    _процесс(db, проект, "Оформление", ПРОЦЕСС)
    db.commit()
    return проект, {"корень": корень, "orders": orders, "каталог": каталог, "kafka": kafka}


# ── Снимок содержимого проекта ───────────────────────────────────────────────


def _снимок(db, project_id) -> dict:
    """СОДЕРЖИМОЕ проекта построчно, вместе с version и updated_at.

    Версии и метки времени тут не для красоты: догрузка обязана не трогать живую
    запись ВОВСЕ, а «тронул и записал то же самое» видно только по ним."""
    узлы = db.query(Node).filter(Node.project_id == project_id).all()
    все = {n.id: n for n in узлы}
    путь = {n.id: node_path(все, n.id) for n in узлы}

    таблицы = db.query(DbTable).join(Node, Node.id == DbTable.node_id).filter(
        Node.project_id == project_id).all()
    каналы = db.query(BrokerChannel).join(Node, Node.id == BrokerChannel.node_id).filter(
        Node.project_id == project_id).all()
    доки = db.query(NodeDoc).join(Node, Node.id == NodeDoc.node_id).filter(
        Node.project_id == project_id).all()
    процессы = db.query(BusinessProcess).filter(
        BusinessProcess.project_id == project_id).all()
    док_по_id = {d.id: f"{путь[d.node_id]} / {d.name}" for d in доки}

    return {
        "узлы": sorted(
            (путь[n.id], n.role, n.technology, n.shape, n.status, n.is_external, n.source_ref,
             n.description, n.openapi_spec, n.version, n.updated_at)
            for n in узлы
        ),
        "связи": sorted(
            (путь[e.source_id], путь[e.target_id], e.label, e.technology, e.channel,
             e.is_synchronous)
            for e in db.query(Edge).filter(Edge.project_id == project_id).all()
        ),
        "доки": sorted(
            (путь[d.node_id], d.name, d.kind, d.operation, d.content, d.version, d.updated_at)
            for d in доки
        ),
        "таблицы": sorted(
            (путь[t.node_id], t.schema_name, t.name, t.description, t.version, t.updated_at,
             tuple(sorted((c.name, c.type, c.is_primary_key, c.nullable, c.description)
                          for c in t.columns)))
            for t in таблицы
        ),
        "каналы": sorted(
            (путь[c.node_id], c.group_name, c.name, c.description, c.version, c.updated_at,
             tuple(sorted((f.name, f.type, f.required, f.description) for f in c.fields)))
            for c in каналы
        ),
        "параметры": sorted(
            (путь[p.node_id], p.name, p.value_type, p.required, p.default_value, p.description,
             p.version, p.updated_at)
            for p in db.query(ConfigParam).join(Node, Node.id == ConfigParam.node_id).filter(
                Node.project_id == project_id).all()
        ),
        "процессы": sorted(
            (
                proc.name,
                tuple((p.order, p.name, путь.get(p.node_id) if p.node_id else None)
                      for p in sorted(proc.participants, key=lambda p: p.order)),
                tuple((m.order, m.leg, m.caption, док_по_id.get(m.doc_id))
                      for m in sorted(proc.messages, key=lambda m: m.order)),
            )
            for proc in процессы
        ),
        "раскладка": sorted(
            (str(i.view_id), i.item_id, json.dumps(i.payload, sort_keys=True))
            for i in db.query(ViewLayoutItem).filter(
                ViewLayoutItem.project_id == project_id).all()
        ),
    }


def _цело(было: dict, стало: dict) -> None:
    """Каждая строка прежнего состояния жива и не изменилась (новое — сверх неё)."""
    for семья, строки in было.items():
        пропало = [s for s in строки if s not in стало[семья]]
        assert not пропало, f"{семья}: изменилось или пропало {пропало}"


def _догрузить(db, проект, *архивы, резолюции=None):
    план = build_into_plan(db, проект, [(f"a{i}.zip", a) for i, a in enumerate(архивы, 1)])
    превью = into_preview(план)
    отчёт = apply_into_plan(db, проект, план, резолюции or {})
    db.commit()  # как роут: коммит обновляет загруженные коллекции (expire_on_commit)
    return превью, отчёт


# ── 1. Инвариант-сторож: свой архив ничего не меняет ─────────────────────────


def test_свой_архив_не_меняет_ни_одной_живой_записи(db):
    """Догрузка проекту ЕГО СОБСТВЕННОГО архива — идеальный ноль изменений.

    Это сторож всей фазы: всё знание проекта проходит полный круг (экспорт →
    разбор → мердж → дифф) и обязано схлопнуться дедупом, не оставив следа."""
    проект, узлы = _ярмарка(db)
    db.add(ViewLayoutItem(project_id=проект.id, view_id=None, item_id=str(узлы["orders"].id),
                          payload={"x": 10, "y": 20}))
    db.commit()
    было = _снимок(db, проект.id)
    ревизии = (проект.graph_rev, проект.meta_rev)

    превью, отчёт = _догрузить(db, проект, build_archive(db, проект))

    assert превью.ok and превью.errors == []
    assert (превью.nodes_new, превью.edges_new) == (0, 0)
    assert превью.family_conflicts == [] and превью.warnings == []
    assert превью.families.model_dump() == {
        "docs": 0, "specs": 0, "tables": 0, "channels": 0, "params": 0, "processes": 0
    }
    assert _снимок(db, проект.id) == было  # ни одна живая запись не тронута
    assert отчёт.warnings == [] and отчёт.nodes_created == 0 and отчёт.docs_created == 0
    assert отчёт.docs_replaced == 0 and отчёт.nodes_filled == 0
    # Ревизии двигаются даже у пустого применения: чужие сессии перечитывают проект
    # по факту действия, а не по нашему выводу «делать было нечего».
    assert (проект.graph_rev, проект.meta_rev) == (ревизии[0] + 1, ревизии[1] + 1)
    assert (отчёт.graph_rev, отчёт.meta_rev) == (проект.graph_rev, проект.meta_rev)


def test_превью_ревизий_не_двигает(db):
    """Ревизии бампаются РОВНО применением: превью — dry-run, БД не трогает."""
    проект, _ = _ярмарка(db)
    архив = build_archive(db, проект)
    ревизии = (проект.graph_rev, проект.meta_rev)

    into_preview(build_into_plan(db, проект, [("свой.zip", архив)]))
    into_preview(build_into_plan(db, проект, [("свой.zip", архив)]))

    assert (проект.graph_rev, проект.meta_rev) == ревизии


# ── 2. Непересекающиеся деревья: приезжает всё, живое цело ───────────────────


def _донор_склада(db) -> bytes:
    """Проект с ДРУГИМ корнем и полным набором семей — его архив и доливаем."""
    донор = _проект(db, "Донор")
    корень = _узел(db, донор, "Склад", role="система")
    приёмка = _узел(db, донор, "receiving", корень, technology="Go")
    хранилище = _узел(db, донор, "Склад-БД", корень, shape="database")
    шина = _узел(db, донор, "RabbitMQ", корень, shape="broker")
    _ребро(db, донор, приёмка, хранилище, label="пишет")
    _док(db, приёмка, "POST /receive", "graph TD\n  R --> S\n", kind="operation")
    _таблица(db, хранилище, "stock", [("sku", "text")], описание="остатки")
    _канал(db, шина, "stock.changed", [("sku", "text")], описание="изменение остатка")
    _параметр(db, приёмка, "BATCH_SIZE", value_type="int", default_value="100")
    приёмка.openapi_spec = "openapi: 3.0.3\ninfo:\n  title: Склад\npaths: {}\n"
    db.flush()
    _процесс(db, донор, "Приёмка", """sequenceDiagram
    participant receiving
    participant Склад-БД
    %% archmap-doc: Склад / receiving / POST /receive
    receiving->>Склад-БД: положить остаток
""")
    db.commit()
    return build_archive(db, донор)


def test_непересекающееся_дерево_доливается_целиком_а_живое_цело(db):
    проект, _ = _ярмарка(db)
    архив = _донор_склада(db)
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, архив)

    assert превью.ok and превью.nodes_new == 4 and превью.edges_new == 1
    assert превью.nodes_new_paths[0] == "Склад"
    assert превью.families.model_dump() == {
        "docs": 1, "specs": 1, "tables": 1, "channels": 1, "params": 1, "processes": 1
    }
    assert (отчёт.nodes_created, отчёт.edges_created) == (4, 1)
    assert (отчёт.docs_created, отчёт.specs_applied) == (1, 1)
    assert отчёт.db is not None and отчёт.db.tables_written == 1
    assert отчёт.channels is not None and отчёт.channels.channels_written == 1
    assert отчёт.config is not None and отчёт.config.params_written == 1
    assert [p.doc_linked for p in отчёт.processes] == [1]  # привязка шага переехала

    стало = _снимок(db, проект.id)
    _цело(было, стало)  # живое — байт-в-байт, включая version и updated_at
    пути = {u[0] for u in стало["узлы"]}
    assert {"Склад", "Склад / receiving", "Склад / Склад-БД", "Склад / RabbitMQ"} <= пути
    новая = next(t for t in стало["таблицы"] if t[0] == "Склад / Склад-БД")
    assert новая[:4] == ("Склад / Склад-БД", "public", "stock", "остатки")
    assert {p[0] for p in стало["процессы"]} == {"Оформление", "Приёмка"}


# ── 3. Пересечение узла: fill-only ───────────────────────────────────────────


def _донор_ярмарки(db, **правки):
    """Второй взгляд на ТУ ЖЕ систему: пути узлов совпадут, и узлы склеятся."""
    донор = _проект(db, "Донор")
    корень = _узел(db, донор, "Ярмарка", role="система")
    orders = _узел(db, донор, "orders", корень, **правки)
    каталог = _узел(db, донор, "Каталог-БД", корень, shape="database")
    kafka = _узел(db, донор, "Kafka", корень, shape="broker")
    db.flush()
    return донор, {"корень": корень, "orders": orders, "каталог": каталог, "kafka": kafka}


def test_пересечение_узла_доливает_пустое_и_не_трогает_занятое(db):
    проект, узлы = _ярмарка(db)
    донор, _ = _донор_ярмарки(
        db, role="сервис заказов", technology="Python", description="Описание донора"
    )
    db.commit()
    было = _снимок(db, проект.id)

    _, отчёт = _догрузить(db, проект, build_archive(db, донор))

    orders = db.get(Node, узлы["orders"].id)
    assert orders.role == "сервис заказов"  # пустое поле долито
    assert orders.description == "Живое описание"  # занятое не тронуто
    assert отчёт.nodes_created == 0 and отчёт.nodes_filled == 1
    assert orders.version == 2  # запись изменилась ровно один раз
    assert any("«роль» пустовало" in w for w in отчёт.warnings)
    # Расхождение занятого поля называет слияние — там видно оба значения разом
    # (тексты слияния зовут поля по-английски: это его формат, не наш).
    assert any("description: оставлено «Живое описание»" in w and "Описание донора" in w
               for w in отчёт.warnings)
    # Прочие узлы не тронуты вовсе (одинаковые поля — не «изменение»).
    прежние = {u for u in было["узлы"] if not u[0].endswith("orders")}
    assert прежние <= set(_снимок(db, проект.id)["узлы"])


# ── 4. Споры с живым: дефолт «оставить моё», выбор — перезапись ──────────────


def _донор_с_доком(db, тело: str) -> bytes:
    донор, узлы = _донор_ярмарки(db)
    _док(db, узлы["orders"], "POST /orders", тело, kind="operation", operation="POST /orders")
    db.commit()
    return build_archive(db, донор)


def test_спор_доки_дефолтом_оставляет_живое(db):
    проект, _ = _ярмарка(db)
    архив = _донор_с_доком(db, "graph TD\n  ДОНОР\n")
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, архив)

    [спор] = превью.family_conflicts
    assert спор.id == "doc|Ярмарка / orders|POST /orders"
    свой = next(k for k in спор.candidates if k.current)
    assert свой.origin == 0 and свой.origin_label == "Текущий проект"
    assert спор.default == f"cand:{спор.candidates.index(свой)}"  # «оставить моё»
    assert превью.families.docs == 0  # при дефолтах не приедет ничего
    assert отчёт.docs_created == 0 and отчёт.docs_replaced == 0
    _цело(было, _снимок(db, проект.id))


def test_спор_доки_выбором_архива_заменяет_тело(db):
    проект, узлы = _ярмарка(db)
    архив = _донор_с_доком(db, "graph TD\n  ДОНОР\n")

    _, отчёт = _догрузить(db, проект, архив,
                          резолюции={"doc|Ярмарка / orders|POST /orders": "cand:1"})

    [док] = db.query(NodeDoc).filter(NodeDoc.node_id == узлы["orders"].id).all()
    assert док.content == "graph TD\n  ДОНОР\n" and док.version == 2
    assert (отчёт.docs_replaced, отчёт.docs_created) == (1, 0)
    assert отчёт.resolved_conflicts == 1


def test_спор_доки_взять_все_разводит_тёзок_суффиксом(db):
    """«Взять все» — не перезапись: живая схема остаётся, привозная получает имя."""
    проект, узлы = _ярмарка(db)
    архив = _донор_с_доком(db, "graph TD\n  ДОНОР\n")

    _, отчёт = _догрузить(db, проект, архив,
                          резолюции={"doc|Ярмарка / orders|POST /orders": "all"})

    доки = db.query(NodeDoc).filter(NodeDoc.node_id == узлы["orders"].id).all()
    assert sorted((d.name, d.content, d.version) for d in доки) == [
        ("POST /orders", "graph TD\n  A\n", 1),
        ("POST /orders (2)", "graph TD\n  ДОНОР\n", 1),
    ]
    assert (отчёт.docs_created, отчёт.docs_replaced) == (1, 0)


def test_спор_спеки_и_параметра(db):
    проект, узлы = _ярмарка(db)
    донор, д = _донор_ярмарки(db)
    д["orders"].openapi_spec = "openapi: 3.0.3\ninfo:\n  title: Донорская\npaths: {}\n"
    _параметр(db, д["orders"], "TIMEOUT_MS", value_type="duration", default_value="9000",
              description="таймаут донора")
    db.commit()
    архив = build_archive(db, донор)
    было = _снимок(db, проект.id)

    # (1) Дефолт — живое цело.
    превью, отчёт = _догрузить(db, проект, архив)
    assert {c.id for c in превью.family_conflicts} == {
        "spec|Ярмарка / orders|openapi", "config|Ярмарка / orders|TIMEOUT_MS"
    }
    assert all(any(k.current for k in c.candidates) for c in превью.family_conflicts)
    assert превью.families.specs == 0 and превью.families.params == 0
    assert отчёт.specs_applied == 0 and отчёт.params_replaced == 0
    _цело(было, _снимок(db, проект.id))

    # (2) Явный выбор архива — тела заменены, версии выросли.
    _, отчёт2 = _догрузить(db, проект, архив, резолюции={
        "spec|Ярмарка / orders|openapi": "cand:1",
        "config|Ярмарка / orders|TIMEOUT_MS": "cand:1",
    })
    живой = db.get(Node, узлы["orders"].id)
    параметр = db.query(ConfigParam).filter(ConfigParam.node_id == живой.id).one()
    assert "Донорская" in (живой.openapi_spec or "")
    assert (параметр.value_type, параметр.default_value) == ("duration", "9000")
    assert параметр.description == "таймаут донора" and параметр.version == 2
    assert (отчёт2.specs_applied, отчёт2.params_replaced) == (1, 1)


def test_таблица_из_архива_накладывается_а_лишняя_колонка_живёт(db):
    """Наложение родным приёмником: описание перетёрто, новая колонка добавлена,
    лишняя ЖИВАЯ колонка осталась — удалять данные пользователя нельзя."""
    проект, узлы = _ярмарка(db)
    донор, д = _донор_ярмарки(db)
    _таблица(db, д["каталог"], "orders", [("id", "uuid"), ("total", "numeric")],
             описание="заказы донора")
    db.commit()

    превью, отчёт = _догрузить(db, проект, build_archive(db, донор),
                               резолюции={"table|Ярмарка / Каталог-БД|public.orders": "cand:1"})

    [таблица] = db.query(DbTable).filter(DbTable.node_id == узлы["каталог"].id).all()
    assert таблица.description == "заказы донора"
    assert sorted(c.name for c in таблица.columns) == ["comment", "id", "total"]
    assert any("«comment»" in w and "не удаляет данные" in w for w in отчёт.warnings)
    assert [c.id for c in превью.family_conflicts] == ["table|Ярмарка / Каталог-БД|public.orders"]


def test_канал_из_архива_накладывается_с_описанием(db):
    проект, узлы = _ярмарка(db)
    донор, д = _донор_ярмарки(db)
    _канал(db, д["kafka"], "orders.created", [("id", "uuid"), ("total", "numeric")],
           описание="создание заказа (донор)")
    db.commit()

    _, отчёт = _догрузить(db, проект, build_archive(db, донор),
                          резолюции={"channel|Ярмарка / Kafka|orders.created": "cand:1"})

    [канал] = db.query(BrokerChannel).filter(BrokerChannel.node_id == узлы["kafka"].id).all()
    assert канал.description == "создание заказа (донор)"
    assert sorted(f.name for f in канал.fields) == ["id", "total"]
    assert отчёт.channels is not None and отчёт.channels.applied


# ── 5. Связи ─────────────────────────────────────────────────────────────────


def test_живое_ребро_не_задваивается_а_новое_создаётся(db):
    проект, узлы = _ярмарка(db)
    донор, д = _донор_ярмарки(db)
    _ребро(db, донор, д["orders"], д["каталог"], label="читает")  # такая же, как живая
    _ребро(db, донор, д["orders"], д["kafka"], label="публикует", channel="orders.created")
    db.commit()

    превью, отчёт = _догрузить(db, проект, build_archive(db, донор))

    assert превью.edges_new == 1 and отчёт.edges_created == 1
    связи = sorted(
        (e.source_id, e.target_id, e.label)
        for e in db.query(Edge).filter(Edge.project_id == проект.id).all()
    )
    assert связи == sorted([
        (узлы["orders"].id, узлы["каталог"].id, "читает"),  # жила — не задвоилась
        (узлы["kafka"].id, узлы["orders"].id, "доставляет"),
        (узлы["orders"].id, узлы["kafka"].id, "публикует"),  # приехала из архива
    ])


# ── 6. Раскладка и процессы ──────────────────────────────────────────────────


def test_раскладка_не_едет_и_не_двигается(db):
    """Новые узлы координат не получают (их построит конвейер), старые не двигаются."""
    проект, узлы = _ярмарка(db)
    db.add(ViewLayoutItem(project_id=проект.id, view_id=None, item_id=str(узлы["корень"].id),
                          payload={"x": 100, "y": 200, "expanded": True}))
    db.commit()
    было = _снимок(db, проект.id)["раскладка"]

    _догрузить(db, проект, _донор_склада(db))

    assert _снимок(db, проект.id)["раскладка"] == было


def test_процесс_тёзка_приезжает_с_суффиксом_а_свой_не_задваивается(db):
    проект, _ = _ярмарка(db)
    донор, д = _донор_ярмарки(db)
    _док(db, д["orders"], "POST /orders", "graph TD\n  A\n", kind="operation",
         operation="POST /orders")
    db.flush()
    _процесс(db, донор, "Оформление", ПРОЦЕСС.replace("положить заказ", "положить иначе"))
    db.commit()

    превью, отчёт = _догрузить(db, проект, build_archive(db, донор))

    имена = sorted(p.name for p in db.query(BusinessProcess).filter(
        BusinessProcess.project_id == проект.id).all())
    assert имена == ["Оформление", "Оформление (2)"]
    assert any("тёзка уже имеющегося" in w for w in превью.warnings)
    assert any("приехал под именем «Оформление (2)»" in w for w in отчёт.warnings)


# ── 7. Отказы: не архив, кап, непригодный план ───────────────────────────────


def test_не_архив_отбивается_подсказкой_про_импорт_схемы(db):
    проект, _ = _ярмарка(db)
    было = _снимок(db, проект.id)

    yaml_вход = "nodes:\n  - name: Ярмарка\n".encode()
    план = build_into_plan(db, проект, [("схема.yaml", yaml_вход)])
    превью = into_preview(план)

    assert not превью.ok and превью.errors == [
        "схема.yaml: это не архив ArchMap; YAML в существующий проект заливается "
        "через «Импорт схемы» (синк)"
    ]
    with pytest.raises(UnifiedImportError, match="непригоден"):
        apply_into_plan(db, проект, план, {})
    assert _снимок(db, проект.id) == было


def test_пустой_запрос_и_кап_архивов(db):
    проект, _ = _ярмарка(db)
    with pytest.raises(UnifiedImportError, match="ни один файл"):
        build_into_plan(db, проект, [])
    много = [(f"{i}.zip", b"PK\x03\x04") for i in range(17)]
    with pytest.raises(UnifiedImportError, match="Больше 16 архивов"):
        build_into_plan(db, проект, много)


def test_кривой_архив_адресуется_своему_чипу(db):
    проект, _ = _ярмарка(db)

    план = build_into_plan(db, проект, [("битый.zip", b"PK\x03\x04" + "мусор".encode())])
    превью = into_preview(план)

    assert not превью.ok and превью.errors
    assert превью.errors[0].startswith("битый.zip: ")


def test_архив_без_c4_адресуется_чипу(db):
    проект, _ = _ярмарка(db)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump(
            {"archmap-archive": 1, "project": {"name": "Пустой"}, "contents": {}},
            allow_unicode=True))

    превью = into_preview(build_into_plan(db, проект, [("пустой.zip", buf.getvalue())]))

    assert not превью.ok
    assert превью.errors == ["пустой.zip: В архиве нет файла C4 (contents.c4)"]


# ── 8. Тёзки узлов: карта строится порядком, а не путём ──────────────────────


def test_узлы_тёзки_не_путают_карту(db):
    """Два «orders» под одним родителем — путь их не различает. Карта живых записей
    держится на порядке экспорта, поэтому знание едет к первому, а второй остаётся
    как был (и об этом есть строка отчёта)."""
    проект = _проект(db, "Живой")
    корень = _узел(db, проект, "Ярмарка")
    первый = _узел(db, проект, "orders", корень, technology="Python")
    второй = _узел(db, проект, "orders", корень, technology="Go", description="второй")
    db.commit()
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, build_archive(db, проект))

    assert превью.ok and превью.nodes_new == 0
    assert any("узлы-тёзки" in w for w in превью.warnings)
    assert _снимок(db, проект.id) == было
    assert db.get(Node, первый.id).technology == "Python"
    assert db.get(Node, второй.id).technology == "Go"


# ── 9. Эндпоинты ─────────────────────────────────────────────────────────────


@pytest.fixture()
def клиент(db):
    """Клиент с настоящей БД: догрузка пишет, а форму multipart с текстовыми полями
    (JSON резолюций, курсоры fence) видно только настоящим запросом."""
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_architect] = lambda: ensure_architect(db)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _файлы(*архивы: bytes):
    return [("files", (f"a{i}.zip", a, "application/zip")) for i, a in enumerate(архивы, 1)]


def test_эндпоинты_превью_и_применения(клиент, db):
    проект, узлы = _ярмарка(db)
    архив = _донор_с_доком(db, "graph TD\n  ДОНОР\n")

    превью = клиент.post(ПРЕВЬЮ.format(проект.id), files=_файлы(архив))
    assert превью.status_code == 200, превью.text
    тело = превью.json()
    assert тело["ok"] and тело["nodes_new"] == 0
    [спор] = тело["family_conflicts"]
    assert [k["current"] for k in спор["candidates"]] == [True, False]
    assert спор["default"] == "cand:0"
    assert (тело["base_graph_rev"], тело["base_meta_rev"]) == (проект.graph_rev, проект.meta_rev)

    ответ = клиент.post(
        ПРИМЕНЕНИЕ.format(проект.id),
        files=_файлы(архив),
        data={
            "resolutions": json.dumps({спор["id"]: "cand:1"}),
            "base_graph_rev": тело["base_graph_rev"],
            "base_meta_rev": тело["base_meta_rev"],
        },
    )
    assert ответ.status_code == 200, ответ.text
    отчёт = ответ.json()
    assert отчёт["docs_replaced"] == 1 and отчёт["resolved_conflicts"] == 1
    [док] = db.query(NodeDoc).filter(NodeDoc.node_id == узлы["orders"].id).all()
    assert док.content == "graph TD\n  ДОНОР\n"


def test_эндпоинт_применения_ловит_разъехавшийся_проект(клиент, db):
    """Fence: проект изменился между превью и применением — 409, а не тихая запись
    поверх того, чего пользователь не видел."""
    проект, узлы = _ярмарка(db)
    архив = _донор_склада(db)
    base = (проект.graph_rev, проект.meta_rev)

    # Схема уехала: кто-то создал узел (тот же бамп, что делают роуты узлов).
    _узел(db, проект, "Новый", узлы["корень"])
    from app.view_state import bump_graph_rev
    bump_graph_rev(db, проект)
    db.commit()

    ответ = клиент.post(
        ПРИМЕНЕНИЕ.format(проект.id),
        files=_файлы(архив),
        data={"base_graph_rev": base[0], "base_meta_rev": base[1]},
    )
    assert ответ.status_code == 409
    assert "обновите превью" in ответ.json()["detail"]
    assert db.query(Node).filter(Node.project_id == проект.id).count() == 5  # ничего не приехало

    # Мета тоже сторожится: догрузка меняет обе половины проекта.
    from app.view_state import bump_meta_rev
    bump_meta_rev(db, проект)
    db.commit()
    ответ2 = клиент.post(
        ПРИМЕНЕНИЕ.format(проект.id),
        files=_файлы(архив),
        data={"base_graph_rev": проект.graph_rev, "base_meta_rev": проект.meta_rev - 1},
    )
    assert ответ2.status_code == 409


def test_эндпоинты_отвергают_кривой_запрос(клиент, db):
    проект, _ = _ярмарка(db)
    архив = build_archive(db, проект)

    кривой = клиент.post(ПРИМЕНЕНИЕ.format(проект.id), files=_файлы(архив),
                         data={"resolutions": "{это не json"})
    assert кривой.status_code == 400 and "resolutions" in кривой.json()["detail"]

    устарело = клиент.post(ПРИМЕНЕНИЕ.format(проект.id), files=_файлы(архив),
                           data={"resolutions": json.dumps({"doc|Нет|Схема": "cand:0"})})
    assert устарело.status_code == 400 and "превью устарело" in устарело.json()["detail"]

    пусто = клиент.post(ПРЕВЬЮ.format(проект.id))
    assert пусто.status_code == 400 and "ни один файл" in пусто.json()["detail"]

    чужой = клиент.post(ПРЕВЬЮ.format(uuid.uuid4()), files=_файлы(архив))
    assert чужой.status_code == 404


def test_эндпоинт_превью_не_пишет_в_бд(клиент, db):
    проект, _ = _ярмарка(db)
    было = _снимок(db, проект.id)

    ответ = клиент.post(ПРЕВЬЮ.format(проект.id), files=_файлы(_донор_склада(db)))

    assert ответ.status_code == 200 and ответ.json()["nodes_new"] == 4
    assert _снимок(db, проект.id) == было


def test_роль_читателя_к_догрузке_не_допускается(db):
    """require_architect — тот же гейт, что у синка и создания."""
    app.dependency_overrides[get_db] = lambda: db
    try:
        клиент = TestClient(app)
        ответ = клиент.post(ПРЕВЬЮ.format(uuid.uuid4()), files=_файлы(b"PK"))
        assert ответ.status_code in (401, 403)
    finally:
        app.dependency_overrides.clear()


def test_пользователь_не_архитектор_отбивается(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_architect] = _отказ
    try:
        клиент = TestClient(app)
        ответ = клиент.post(ПРЕВЬЮ.format(uuid.uuid4()), files=_файлы(b"PK"))
        assert ответ.status_code == 403
    finally:
        app.dependency_overrides.clear()


def _отказ() -> User:
    from fastapi import HTTPException

    raise HTTPException(status_code=403, detail="Только архитектор")
