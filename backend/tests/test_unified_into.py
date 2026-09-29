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
from app.config_import import ParamIn
from app.database import get_db
from app.export import build_export
from app.import_yaml import parse_import
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
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.models.view_layout import ViewLayoutItem
from app.process_import import apply_import as apply_process_import
from app.process_import import build_preview as build_process_preview
from app.processes import node_path
from app.unified_apply import _Winner, apply_unified_plan, parse_decisions
from app.unified_import import (
    UnifiedImportError,
    apply_unfixable,
    build_unified_plan,
    remainder_from_plan,
)
from app.unified_into import (
    _replace_params,
    apply_into_plan,
    build_into_plan,
    into_preview,
)

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


def _догрузить(db, проект, *архивы, резолюции=None, решения=None):
    план = build_into_plan(db, проект, [(f"a{i}.zip", a) for i, a in enumerate(архивы, 1)])
    превью = into_preview(план)
    отчёт = apply_into_plan(db, проект, план, резолюции or {}, decisions=решения)
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
    # Долитое — информация, её видно по счётчику «дополнено объектов»: в свёртку
    # отчёта не едет (Ф2г-2).
    assert not any("пустовало" in u.text or "залито" in u.text for u in отчёт.unfixable)
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
    # Ф2г: сырого «Проверьте» в окне нет — тёзка показан пунктом свёртки.
    assert any(
        "приедет под именем «Оформление (2)»" in u.text for u in превью.remainder.unfixable
    )
    assert any("приехал под именем «Оформление (2)»" in w for w in отчёт.warnings)
    # Ф2г-2: в свёртке отчёта — ОДИН пункт о тёзке, с фактическим именем; плановое
    # «приедет под именем» его не дублирует.
    assert [u.text for u in отчёт.unfixable if "Процесс" in u.text] == [
        "Процесс «Оформление» из «a1.zip» совпал по имени с другим процессом и приехал под "
        "именем «Оформление (2)». Если это один и тот же процесс, лишний нужно будет удалить "
        "вручную."
    ]


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
    assert any(
        u.text.startswith("В проекте несколько объектов «Ярмарка / orders»")
        for u in превью.remainder.unfixable
    )
    assert _снимок(db, проект.id) == было
    assert db.get(Node, первый.id).technology == "Python"
    assert db.get(Node, второй.id).technology == "Go"


# ── 8а. Законные тёзки: якоря противоречат, мердж держит их раздельно ────────
#
# Путь «Ярмарка / Каталог-БД» адресует ДВОИХ, а во всех ввозных форматах узел
# адресуется путём. До уточнителя-якоря (app/node_ref.py) такой проект не
# догружался ничем — даже собственным архивом: разбор экспорта ТЕКУЩЕГО проекта
# падал на «неоднозначно», а файлы семей тёзок молча пропускались.

ШОП = "git:github.com/org/shop-db"
СКЛАДСКОЙ = "git:github.com/org/warehouse-catalog"


def _тёзки(db, имя: str = "Живой"):
    """Живой проект с якорными тёзками: у каждого своя связь, свой док, своя таблица
    (имена дока и таблицы у тёзок СОВПАДАЮТ — различает их только якорь узла)."""
    проект = _проект(db, имя)
    корень = _узел(db, проект, "Ярмарка", role="система")
    orders = _узел(db, проект, "orders", корень, technology="Python")
    склад = _узел(db, проект, "Склад", корень, technology="Go")
    шоп = _узел(db, проект, "Каталог-БД", корень, shape="database", source_ref=ШОП)
    сток = _узел(db, проект, "Каталог-БД", корень, shape="database", source_ref=СКЛАДСКОЙ)
    _ребро(db, проект, orders, шоп, label="пишет")
    _ребро(db, проект, склад, сток, label="читает")
    _док(db, шоп, "Хранение", "graph TD\n  Витрина\n", kind="worker")
    _док(db, сток, "Хранение", "graph TD\n  Остатки\n", kind="worker")
    _таблица(db, шоп, "items", [("sku", "text")], описание="товары витрины")
    _таблица(db, сток, "items", [("qty", "int")], описание="остатки склада")
    сток.openapi_spec = "openapi: 3.0.3\ninfo:\n  title: Склад\npaths: {}\n"
    db.commit()
    return проект, {"orders": orders, "склад": склад, "шоп": шоп, "сток": сток}


def _по_якорю(db, project_id) -> dict[str | None, Node]:
    return {n.source_ref: n for n in db.query(Node).filter(Node.project_id == project_id).all()}


def test_якорные_тёзки_догружают_свой_архив(db):
    """Свой архив проекта с якорными тёзками — ноль изменений, как у любого проекта:
    разбор не спотыкается о путь, файлы семей тёзок не пропускаются."""
    проект, _ = _тёзки(db)
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, build_archive(db, проект))

    assert превью.ok and превью.errors == []
    assert (превью.nodes_new, превью.edges_new) == (0, 0)
    assert превью.family_conflicts == []
    assert превью.families.model_dump() == {
        "docs": 0, "specs": 0, "tables": 0, "channels": 0, "params": 0, "processes": 0
    }
    # Ни одного пропущенного файла: семьи тёзок нашли каждый своего узла.
    assert not any("пропущен" in w for w in превью.warnings), превью.warnings
    assert not any("тёзк" in w for w in превью.warnings), превью.warnings
    assert _снимок(db, проект.id) == было
    assert отчёт.nodes_created == отчёт.edges_created == отчёт.docs_created == 0
    # Свёртка пуста: живая пара тёзок — не находка догрузки (Р3), и пункт «разные
    # метаданные» о ней был бы шумом — это одна и та же живая пара, а не дубль.
    assert превью.remainder.unfixable == [] and отчёт.unfixable == []


def test_якорные_тёзки_переезжают_архивом_в_новый_проект(db):
    """Новый проект из архива такого проекта: оба тёзки на месте, а связи, схемы,
    таблицы и спека — каждая у СВОЕГО тёзки (путь их не различает, якорь — да)."""
    проект, _ = _тёзки(db, "Исходный")
    план = build_unified_plan([("свой.zip", build_archive(db, проект))])
    assert план.ok, план.errors
    assert план.input_remarks == [[]]

    новый, отчёт = apply_unified_plan(db, план, {}, "Копия", None, ensure_architect(db).id)
    db.commit()

    узлы = _по_якорю(db, новый.id)
    шоп, сток = узлы[ШОП], узлы[СКЛАДСКОЙ]
    assert шоп.name == сток.name == "Каталог-БД" and шоп.id != сток.id
    имя = {n.id: n.name for n in db.query(Node).filter(Node.project_id == новый.id).all()}
    связи = {
        (имя[e.source_id], e.target_id, e.label)
        for e in db.query(Edge).filter(Edge.project_id == новый.id).all()
    }
    assert связи == {("orders", шоп.id, "пишет"), ("Склад", сток.id, "читает")}
    доки = {(d.node_id, d.name, d.content) for d in db.query(NodeDoc).filter(
        NodeDoc.node_id.in_([шоп.id, сток.id])).all()}
    assert доки == {
        (шоп.id, "Хранение", "graph TD\n  Витрина\n"),
        (сток.id, "Хранение", "graph TD\n  Остатки\n"),
    }
    таблицы = {
        (t.node_id, t.name, tuple(c.name for c in t.columns))
        for t in db.query(DbTable).filter(DbTable.node_id.in_([шоп.id, сток.id])).all()
    }
    assert таблицы == {(шоп.id, "items", ("sku",)), (сток.id, "items", ("qty",))}
    assert шоп.openapi_spec is None and "title: Склад" in (сток.openapi_spec or "")
    assert отчёт.db is not None and отчёт.db.errors == []


def test_процесс_с_тёзками_не_задваивается_при_догрузке_своего_архива(db):
    """Участники процесса — тёзки, шаги привязаны к одноимённым схемам тёзок.
    Свой архив приносит байт-в-байт копию процесса — она не ввозится, и ни
    участник, ни привязка шага не меняются (разведка шага 5 twins-refs:
    создание НОВОГО проекта из такого архива оставляет тёзок-участников
    непривязанными — выбор по имени, уточнитель тут не помогает; см. отчёт)."""
    проект, у = _тёзки(db)
    доки = {k: db.query(NodeDoc).filter(NodeDoc.node_id == у[k].id).one() for k in ("шоп", "сток")}
    рёбра = {e.label: e for e in db.query(Edge).filter(Edge.project_id == проект.id).all()}
    процесс = BusinessProcess(id=uuid.uuid4(), name="Сверка", project_id=проект.id)
    db.add(процесс)
    db.flush()
    участники = {}
    for i, k in enumerate(("orders", "шоп", "склад", "сток")):
        участники[k] = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id,
                                          node_id=у[k].id, name=у[k].name, order=i)
        db.add(участники[k])
    db.flush()
    for order, (из, в, связь, док) in enumerate((("orders", "шоп", "пишет", "шоп"),
                                                 ("склад", "сток", "читает", "сток"))):
        db.add(ProcessMessage(id=uuid.uuid4(), process_id=процесс.id, order=order,
                              edge_id=рёбра[связь].id, leg="forward", caption=связь,
                              from_participant_id=участники[из].id,
                              to_participant_id=участники[в].id, doc_id=доки[док].id))
    db.commit()
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, build_archive(db, проект))

    assert превью.ok and превью.families.processes == 0 and отчёт.processes == []
    assert _снимок(db, проект.id) == было


def test_чужой_архив_доливает_знание_своему_тёзке(db):
    """Архив ДРУГОГО проекта с теми же тёзками везёт новую таблицу и схему второму
    тёзке: догрузка находит живую пару по якорям и кладёт новое ровно ему, а
    первый тёзка остаётся как был."""
    проект, узлы = _тёзки(db)
    донор, дузлы = _тёзки(db, "Донор")
    _таблица(db, дузлы["сток"], "reserve", [("sku", "text")])
    _док(db, дузлы["сток"], "Резерв", "graph TD\n  Резерв\n", kind="worker")
    db.commit()
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, build_archive(db, донор))

    assert превью.ok and превью.errors == [] and превью.nodes_new == 0
    assert (превью.families.tables, превью.families.docs) == (1, 1)
    assert отчёт.db is not None and отчёт.db.errors == []
    _цело(было, _снимок(db, проект.id))
    сток, шоп = db.get(Node, узлы["сток"].id), db.get(Node, узлы["шоп"].id)
    assert {t.name for t in сток.db_tables} == {"items", "reserve"}
    assert {t.name for t in шоп.db_tables} == {"items"}
    assert {d.name for d in сток.docs} == {"Хранение", "Резерв"}
    assert {d.name for d in шоп.docs} == {"Хранение"}


def test_каналы_и_конфигурация_тёзок_переезжают_к_своим(db):
    """Те же гарантии у семей, которые пишут родные приёмники каналов и
    конфигурации: тёзки-брокеры (якорь — имя зависимости) и тёзки-сервисы
    (якорь — код в монорепо) получают каждый свои записи, а свой архив к живому
    проекту не приносит ничего."""
    проект = _проект(db, "Брокеры")
    корень = _узел(db, проект, "Ярмарка")
    ka = _узел(db, проект, "Kafka", корень, shape="broker", source_ref="host:kafka-a")
    kb = _узел(db, проект, "Kafka", корень, shape="broker", source_ref="host:kafka-b")
    aa = _узел(db, проект, "api", корень, source_ref="git:github.com/org/mono#a")
    ab = _узел(db, проект, "api", корень, source_ref="git:github.com/org/mono#b")
    _ребро(db, проект, aa, ka, channel="a.events")
    _ребро(db, проект, ab, kb, channel="b.events")
    _канал(db, ka, "a.events", [("id", "uuid")])
    _канал(db, kb, "b.events", [("qty", "int")])
    _параметр(db, aa, "A_TIMEOUT", value_type="int", default_value="1")
    _параметр(db, ab, "B_TIMEOUT", value_type="int", default_value="2")
    db.commit()
    архив = build_archive(db, проект)

    план = build_unified_plan([("свой.zip", архив)])
    assert план.ok and план.input_remarks == [[]]
    новый, отчёт = apply_unified_plan(db, план, {}, "Копия", None, ensure_architect(db).id)
    db.commit()

    узлы = _по_якорю(db, новый.id)
    # С полями — значит из файла каналов, а не заглушкой по связи.
    def каналы(узел: Node) -> set[tuple[str, tuple[str, ...]]]:
        return {(c.name, tuple(f.name for f in c.fields)) for c in узел.broker_channels}

    assert каналы(узлы["host:kafka-a"]) == {("a.events", ("id",))}
    assert каналы(узлы["host:kafka-b"]) == {("b.events", ("qty",))}
    параметры = {
        (p.node_id, p.name) for p in db.query(ConfigParam).join(
            Node, Node.id == ConfigParam.node_id).filter(Node.project_id == новый.id).all()
    }
    assert параметры == {
        (узлы["git:github.com/org/mono#a"].id, "A_TIMEOUT"),
        (узлы["git:github.com/org/mono#b"].id, "B_TIMEOUT"),
    }
    assert отчёт.channels is not None and отчёт.channels.errors == []
    assert отчёт.config is not None and отчёт.config.errors == []

    было = _снимок(db, проект.id)
    превью, _ = _догрузить(db, проект, архив)
    assert превью.ok and превью.errors == [] and (превью.nodes_new, превью.edges_new) == (0, 0)
    assert not any("пропущен" in w for w in превью.warnings), превью.warnings
    assert _снимок(db, проект.id) == было


def test_yaml_экспорт_якорных_тёзок_разбирается_со_связями(db):
    """YAML-экспорт проекта с тёзками — снова вход parse_import, и связи приезжают
    к правильным узлам (разобранный узел узнаётся по своему якорю)."""
    проект, _ = _тёзки(db)
    текст = build_export(
        db.query(Node).filter(Node.project_id == проект.id).all(),
        db.query(Edge).filter(Edge.project_id == проект.id).all(),
    )

    разобрано, ошибки = parse_import(текст)

    assert ошибки == [] and разобрано is not None
    связи = {
        (разобрано.nodes[e.source_idx].name, tuple(разобрано.nodes[e.target_idx].source_keys),
         e.label)
        for e in разобрано.edges
    }
    assert связи == {("orders", (ШОП,), "пишет"), ("Склад", (СКЛАДСКОЙ,), "читает")}


# Полевой путь (docs/tasks/twins-refs.md): два файла, у каждого свой «Каталог-БД»
# со своим репозиторием, — тот же вход, что в дымовом наборе превью импорта.
_SHOP = """
nodes:
  - name: Ярмарка
    description: Торговая площадка
    children:
      - name: orders
        children:
          - name: api
          - name: worker
          - name: scheduler
          - name: cache
          - name: sender
      - name: Каталог-БД
        shape: database
        source: {repo: 'github.com/org/shop-db'}
  - name: Оператор
    shape: person
edges:
  - from: Оператор
    to: orders
    label: смотрит
  - from: orders
    to: Каталог-БД
    label: пишет
"""
_WAREHOUSE = """
nodes:
  - name: Ярмарка
    children:
      - name: Каталог-БД
        shape: database
        source: {repo: 'github.com/org/warehouse-catalog'}
      - name: Склад
        technology: Go
edges:
  - from: Склад
    to: Каталог-БД
    label: читает
"""


def _полевой_проект(db):
    план = build_unified_plan([("shop.yaml", _SHOP.encode()), ("warehouse.yaml", _WAREHOUSE.encode())])
    assert план.ok, план.errors
    проект, _ = apply_unified_plan(db, план, {}, "Ярмарка", None, ensure_architect(db).id)
    db.commit()
    return план, проект


РАЗНЫЕ_МЕТАДАННЫЕ = (
    "«Каталог-БД» (внутри «Ярмарка») в разных файлах имеет разные метаданные. ArchMap "
    "не знает, это один и тот же объект или нет. Если это дубль, его нужно будет "
    "удалить вручную."
)


def test_полевой_путь_shop_и_warehouse_догружает_свой_архив(db):
    план, проект = _полевой_проект(db)
    узлы = _по_якорю(db, проект.id)
    assert {узлы[ШОП].name, узлы[СКЛАДСКОЙ].name} == {"Каталог-БД"}
    # На СОЗДАНИИ пункт законен: два файла назвали «Каталог-БД» разные объекты, и
    # дубль ли это — знает только человек.
    assert РАЗНЫЕ_МЕТАДАННЫЕ in [u.text for u in remainder_from_plan(план, None).unfixable]
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, build_archive(db, проект))

    assert превью.ok and превью.errors == []
    assert (превью.nodes_new, превью.edges_new) == (0, 0)
    assert _снимок(db, проект.id) == было
    # Догрузка своего архива: пара живая, спрашивать не о чем — свёртка пуста.
    assert превью.remainder.unfixable == [] and отчёт.unfixable == []


def test_новый_тёзка_из_архива_оставляет_пункт_о_метаданных(db):
    """Архив привёз ТРЕТЬЕГО «Каталог-БД» со своим якорем — тёзка новый, и вопрос
    «дубль или нет» законен: пункт свёртки остаётся (гасится только живая пара)."""
    _план, проект = _полевой_проект(db)
    донор = _проект(db, "Донор")
    корень = _узел(db, донор, "Ярмарка")
    _узел(db, донор, "Каталог-БД", корень, shape="database",
          source_ref="git:github.com/org/billing-db")
    db.commit()

    превью, _ = _догрузить(db, проект, build_archive(db, донор))

    assert превью.ok and превью.nodes_new == 1
    assert РАЗНЫЕ_МЕТАДАННЫЕ in [u.text for u in превью.remainder.unfixable]


# ── 8б. Тёзки без различающего якоря: порядковый уточнитель «путь @ #N» ──────
#
# Якорь различает не всех тёзок: два «api», созданные руками, или группа, где якорь
# есть не у всех. Экспорт адресует такую группу порядковым уточнителем — N-й из
# узлов одного пути в порядке документа (app/node_ref.py). До него проект с такой
# парой и связями не догружал даже собственный архив и не создавался из него.


def _безъякорные(db, имя: str = "Живой"):
    """Живой проект с тёзками без якорей: две «Реплика-БД» в «Ярмарка» различаются
    только технологией; у каждой своя связь, свой док и своя таблица (имена дока и
    таблицы СОВПАДАЮТ). Postgres создаётся раньше MySQL — порядок вставки не должен
    решать порядок документа."""
    проект = _проект(db, имя)
    корень = _узел(db, проект, "Ярмарка", role="система")
    orders = _узел(db, проект, "orders", корень)
    склад = _узел(db, проект, "Склад", корень)
    pg = _узел(db, проект, "Реплика-БД", корень, shape="database", technology="Postgres")
    my = _узел(db, проект, "Реплика-БД", корень, shape="database", technology="MySQL")
    _ребро(db, проект, orders, pg, label="пишет")
    _ребро(db, проект, склад, my, label="читает")
    _док(db, pg, "Хранение", "graph TD\n  Постгрес\n", kind="worker")
    _док(db, my, "Хранение", "graph TD\n  Майскуль\n", kind="worker")
    _таблица(db, pg, "items", [("sku", "text")])
    _таблица(db, my, "items", [("qty", "int")])
    db.commit()
    return проект, {"orders": orders, "склад": склад, "pg": pg, "my": my}


def _по_технологии(db, project_id) -> dict[str | None, Node]:
    return {
        n.technology: n
        for n in db.query(Node).filter(
            Node.project_id == project_id, Node.name == "Реплика-БД"
        ).all()
    }


def test_экспорт_безъякорных_тёзок_пишет_порядковый_уточнитель(db):
    """Тёзки без якорей адресуются «путь @ #N» (по порядку документа: MySQL раньше
    Postgres по содержательному ключу, хоть и создана позже), и такой экспорт снова
    разбирается со связями к правильным узлам."""
    проект, _ = _безъякорные(db)
    текст = build_export(
        db.query(Node).filter(Node.project_id == проект.id).all(),
        db.query(Edge).filter(Edge.project_id == проект.id).all(),
    )
    doc = yaml.safe_load(текст)
    assert [(e["from"], e["to"]) for e in doc["edges"]] == [
        ("orders", "Ярмарка / Реплика-БД @ #2"),
        ("Склад", "Ярмарка / Реплика-БД @ #1"),
    ]

    разобрано, ошибки = parse_import(текст)

    assert ошибки == [] and разобрано is not None
    связи = {
        (разобрано.nodes[e.source_idx].name, разобрано.nodes[e.target_idx].technology, e.label)
        for e in разобрано.edges
    }
    assert связи == {("orders", "Postgres", "пишет"), ("Склад", "MySQL", "читает")}


def test_безъякорные_тёзки_переезжают_архивом_в_новый_проект(db):
    """Новый проект из архива: обе «Реплика-БД» на месте, а связи, схемы и таблицы —
    каждая у СВОЕЙ (путь их не различает, порядковый уточнитель — да)."""
    проект, _ = _безъякорные(db, "Исходный")
    план = build_unified_plan([("свой.zip", build_archive(db, проект))])
    assert план.ok, план.errors
    assert план.input_remarks == [[]]

    новый, отчёт = apply_unified_plan(db, план, {}, "Копия", None, ensure_architect(db).id)
    db.commit()

    реплики = _по_технологии(db, новый.id)
    pg, my = реплики["Postgres"], реплики["MySQL"]
    имя = {n.id: n.name for n in db.query(Node).filter(Node.project_id == новый.id).all()}
    связи = {
        (имя[e.source_id], e.target_id, e.label)
        for e in db.query(Edge).filter(Edge.project_id == новый.id).all()
    }
    assert связи == {("orders", pg.id, "пишет"), ("Склад", my.id, "читает")}
    assert {(d.node_id, d.content) for d in db.query(NodeDoc).filter(
        NodeDoc.node_id.in_([pg.id, my.id])).all()} == {
        (pg.id, "graph TD\n  Постгрес\n"), (my.id, "graph TD\n  Майскуль\n")
    }
    assert {
        (t.node_id, tuple(c.name for c in t.columns))
        for t in db.query(DbTable).filter(DbTable.node_id.in_([pg.id, my.id])).all()
    } == {(pg.id, ("sku",)), (my.id, ("qty",))}
    assert отчёт.db is not None and отчёт.db.errors == []


def test_безъякорные_тёзки_догружают_свой_архив(db):
    """Свой архив проекта с живыми тёзками без якорей: разбор не спотыкается о путь,
    ни одна живая запись не тронута, нового нет. Мердж второго входа склеивает
    одноимённых по имени — об этом, как и прежде, пункт «несколько объектов»."""
    проект, у = _безъякорные(db)
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, build_archive(db, проект))

    assert превью.ok and превью.errors == []
    assert (превью.nodes_new, превью.edges_new) == (0, 0)
    assert превью.family_conflicts == []
    assert превью.families.model_dump() == {
        "docs": 0, "specs": 0, "tables": 0, "channels": 0, "params": 0, "processes": 0
    }
    assert _снимок(db, проект.id) == было
    assert отчёт.nodes_created == отчёт.edges_created == отчёт.docs_created == 0
    # Внутриархивные дубли склеенной пары повторяют живые записи — нового знания
    # они не теряют, и пунктами свёртки их нет (Р3); честный пункт — один.
    assert [u.text for u in превью.remainder.unfixable] == [
        "В проекте несколько объектов «Ярмарка / Реплика-БД», и знание из архива "
        "приедет только к первому из них. Остальные останутся как были."
    ]
    assert db.get(Node, у["pg"].id).technology == "Postgres"
    assert db.get(Node, у["my"].id).technology == "MySQL"


def test_тёзки_обоих_видов_неподвижны_при_переносе(db):
    """Критерий порядка документа: экспорт → новый проект → экспорт дают те же байты
    и у YAML, и у архива — для проекта с якорными тёзками, тёзками без якоря,
    смешанной группой (якорь не у всех) и полными двойниками с разным знанием."""
    проект, у = _безъякорные(db, "Исходный")
    корень = db.get(Node, у["orders"].parent_id)
    шоп = _узел(db, проект, "Каталог-БД", корень, shape="database", source_ref=ШОП)
    _узел(db, проект, "Каталог-БД", корень, shape="database", source_ref=СКЛАДСКОЙ)
    _ребро(db, проект, у["orders"], шоп, label="пишет")
    смесь = [
        _узел(db, проект, "cache", корень, source_ref="host:redis-a"),
        _узел(db, проект, "cache", корень),
        _узел(db, проект, "cache", корень, source_ref="host:redis-b"),
    ]
    for i, узел in enumerate(смесь):
        _ребро(db, проект, у["склад"], узел, label=f"кэш {i}")
    for тело in ("graph TD\n  Первый\n", "graph TD\n  Второй\n"):
        двойник = _узел(db, проект, "worker", корень)
        _док(db, двойник, "Цикл", тело, kind="worker")
    db.commit()

    def тексты(project_id) -> str:
        return build_export(
            db.query(Node).filter(Node.project_id == project_id).all(),
            db.query(Edge).filter(Edge.project_id == project_id).all(),
        )

    архив = build_archive(db, проект)
    план = build_unified_plan([("свой.zip", архив)])
    assert план.ok and план.input_remarks == [[]], (план.errors, план.input_remarks)
    новый, _ = apply_unified_plan(db, план, {}, "Исходный", None, ensure_architect(db).id)
    db.commit()

    assert тексты(новый.id) == тексты(проект.id)
    assert build_archive(db, новый) == архив
    # Смешанная группа — порядковые уточнители всей группе, якорь пережил перенос.
    assert {n.source_ref for n in db.query(Node).filter(
        Node.project_id == новый.id, Node.name == "cache")} == {"host:redis-a", "host:redis-b", None}


# ── 8в. Дети тёзок-контейнеров: уточнитель на сегменте предка ────────────────
#
# «Ярмарка / Каталог-БД @ git:… / reader»: ребёнок уникален среди своих сиблингов,
# но путь его не различает — различает уточнитель на сегменте тёзки-предка. Путь
# режется по « / » с пробелами: слэши и решётка ключа («git:…#a/b») разрез не ломают.

ШОП_AB = "git:github.com/org/shop-db#a/b"


def _дети_тёзок(db, имя: str = "Живой"):
    """Тёзки-контейнеры обоих видов, у каждого свой «reader» (база) со связью,
    схемой и таблицей — имена у детей и их знания СОВПАДАЮТ."""
    проект = _проект(db, имя)
    корень = _узел(db, проект, "Ярмарка", role="система")
    orders = _узел(db, проект, "orders", корень)
    контейнеры = {
        "шоп": _узел(db, проект, "Каталог-БД", корень, source_ref=ШОП_AB),
        "сток": _узел(db, проект, "Каталог-БД", корень, source_ref=СКЛАДСКОЙ),
        "pg": _узел(db, проект, "Реплика", корень, technology="Postgres"),
        "my": _узел(db, проект, "Реплика", корень, technology="MySQL"),
    }
    читатели = {}
    for метка, контейнер in контейнеры.items():
        reader = _узел(db, проект, "reader", контейнер, shape="database")
        _ребро(db, проект, orders, reader, label=метка)
        _док(db, reader, "Чтение", f"graph TD\n  {метка}\n", kind="worker")
        _таблица(db, reader, "items", [(f"col_{метка}", "text")])
        читатели[метка] = reader
    db.commit()
    return проект, читатели


def _читатели(db, project_id) -> dict[str, Node]:
    """Дети-«reader» по метке своей связи (метка = какой контейнер)."""
    узлы = {n.id: n for n in db.query(Node).filter(Node.project_id == project_id).all()}
    return {
        e.label: узлы[e.target_id]
        for e in db.query(Edge).filter(Edge.project_id == project_id).all()
        if узлы[e.target_id].name == "reader"
    }


def test_адреса_семей_детей_тёзок_несут_уточнитель_предка(db):
    """В архиве: связи c4.yaml, «%% archmap-node:» схем и «# archmap-node:» таблиц
    детей тёзок несут уточнитель на сегменте тёзки-предка, и шапка .mmd с
    «#a/b» внутри ключа не режется."""
    from app.data_import import parse_data_file
    from app.mmd_header import parse_mmd_header

    проект, _ = _дети_тёзок(db)
    zf = zipfile.ZipFile(io.BytesIO(build_archive(db, проект)))
    состав = yaml.safe_load(zf.read("manifest.yaml"))["contents"]
    ожидаемые = {
        "Ярмарка / Каталог-БД @ git:github.com/org/shop-db#a/b / reader",
        "Ярмарка / Каталог-БД @ git:github.com/org/warehouse-catalog / reader",
        "Ярмарка / Реплика @ #1 / reader",
        "Ярмарка / Реплика @ #2 / reader",
    }
    assert {parse_mmd_header(zf.read(f).decode()).node for f in состав["docs"]} == ожидаемые
    таблицы = [parse_data_file(zf.read(f).decode()) for f in состав["db"]]
    assert {t.node_ref for t in таблицы if t is not None} == ожидаемые
    assert {e["to"] for e in yaml.safe_load(zf.read("c4.yaml"))["edges"]} == ожидаемые


def test_дети_тёзок_переезжают_архивом_в_новый_проект(db):
    """Новый проект из архива: связь, схема и таблица каждого «reader» — у ребёнка
    СВОЕГО тёзки-контейнера; экспорт нового проекта — те же байты."""
    проект, _ = _дети_тёзок(db, "Исходный")
    архив = build_archive(db, проект)
    план = build_unified_plan([("свой.zip", архив)])
    assert план.ok, план.errors
    assert план.input_remarks == [[]]

    новый, отчёт = apply_unified_plan(db, план, {}, "Исходный", None, ensure_architect(db).id)
    db.commit()

    читатели = _читатели(db, новый.id)
    узлы = {n.id: n for n in db.query(Node).filter(Node.project_id == новый.id).all()}
    родитель = {метка: узлы[r.parent_id] for метка, r in читатели.items() if r.parent_id}
    assert родитель["шоп"].source_ref == ШОП_AB
    assert родитель["сток"].source_ref == СКЛАДСКОЙ
    assert (родитель["pg"].technology, родитель["my"].technology) == ("Postgres", "MySQL")
    for метка, reader in читатели.items():
        assert [d.content for d in reader.docs] == [f"graph TD\n  {метка}\n"]
        assert [[c.name for c in t.columns] for t in reader.db_tables] == [[f"col_{метка}"]]
    assert отчёт.db is not None and отчёт.db.errors == []
    assert build_archive(db, новый) == архив


def test_дети_тёзок_догружают_свой_архив(db):
    """Свой архив проекта с детьми тёзок: ноль изменений, нового нет."""
    проект, _ = _дети_тёзок(db)
    было = _снимок(db, проект.id)

    превью, отчёт = _догрузить(db, проект, build_archive(db, проект))

    assert превью.ok and превью.errors == []
    assert (превью.nodes_new, превью.edges_new) == (0, 0)
    assert превью.family_conflicts == []
    assert превью.families.model_dump() == {
        "docs": 0, "specs": 0, "tables": 0, "channels": 0, "params": 0, "processes": 0
    }
    assert _снимок(db, проект.id) == было
    assert отчёт.nodes_created == отчёт.edges_created == отчёт.docs_created == 0


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


# ── Основание склейки и якоря новых объектов в превью (Ф2 якорей) ────────────
#
# Догрузка сопоставляет узлы по ЯКОРЮ, и до Ф2 превью об этом молчало: показывало
# только новое. Теперь оно называет, сколько живых узлов найдено, ЧЕМ каждый найден
# и будет ли якорь у создаваемых.


def test_превью_догрузки_называет_основание_склейки(db):
    """Свой архив: каждый живой узел найден — у узлов с якорем словами назван вид
    якоря, у узлов без якоря — имя."""
    проект, узлы = _ярмарка(db)
    узлы["orders"].source_ref = "git:github.com/org/yarmarka#services/orders"
    узлы["каталог"].source_ref = "host:catalog-db"
    db.commit()

    превью = into_preview(build_into_plan(db, проект, [("свой.zip", build_archive(db, проект))]))

    assert превью.ok
    assert превью.nodes_matched == 4  # корень + orders + Каталог-БД + Kafka
    по_пути = {m.path: m.basis for m in превью.matched_nodes}
    assert по_пути == {
        "Ярмарка": "name",
        "Ярмарка / orders": "code",
        "Ярмарка / Каталог-БД": "dependency",
        "Ярмарка / Kafka": "name",
    }


def test_превью_догрузки_называет_якоря_новых_объектов(db):
    """«Появятся» — с якорем у тех, кто его получит, и пусто у остальных: без
    якоря объект будет опознаваться только по имени."""
    проект, _ = _ярмарка(db)
    донор = _проект(db, "Донор")
    корень = _узел(db, донор, "Склад", role="система")
    _узел(db, донор, "receiving", корень, technology="Go",
          source_ref="git:github.com/org/wms#receiving")
    _узел(db, донор, "Склад-БД", корень, shape="database", source_ref="host:wms-db")
    _узел(db, донор, "ручной", корень)
    db.commit()

    превью = into_preview(build_into_plan(db, проект, [("донор.zip", build_archive(db, донор))]))

    assert превью.ok and превью.nodes_new == 4
    якоря = {n.path: n.source for n in превью.new_nodes}
    assert якоря["Склад / receiving"] is not None
    assert (якоря["Склад / receiving"].repo, якоря["Склад / receiving"].path) == (
        "github.com/org/wms", "receiving"
    )
    assert якоря["Склад / Склад-БД"] is not None
    assert якоря["Склад / Склад-БД"].host == "wms-db"
    assert якоря["Склад / ручной"] is None
    assert якоря["Склад"] is None
    # Списки — параллельные: старое поле путей осталось нетронутым (его читает MCP).
    assert [n.path for n in превью.new_nodes] == превью.nodes_new_paths


def test_превью_догрузки_не_числит_несопоставленное(db):
    """Донор с ЧУЖИМ деревом: сопоставлять нечего — ни одного найденного узла.
    Своя схема, нашедшая сама себя, находкой догрузки не считается."""
    проект, _ = _ярмарка(db)
    донор = _проект(db, "Донор")
    _узел(db, донор, "Склад", role="система")
    db.commit()

    превью = into_preview(build_into_plan(db, проект, [("донор.zip", build_archive(db, донор))]))

    assert превью.ok
    assert превью.nodes_matched == 0 and превью.matched_nodes == []


# ── Заглушки каналов по связям догрузки (решение пользователя 2026-09-06) ────


def test_догрузка_заводит_заглушки_только_для_своих_новых_связей(db):
    from app.channels_import import is_edge_stub

    проект, узлы = _ярмарка(db)
    # Живая связь с неописанным каналом — состояние проекта ДО догрузки: её алерт AL31
    # остаётся, догрузка живого не трогает и заглушек ему не заводит.
    _ребро(db, проект, узлы["orders"], узлы["kafka"], label="старая", channel="legacy.topic")
    донор, д = _донор_ярмарки(db)
    _ребро(db, донор, д["orders"], д["kafka"], label="публикует", channel="orders.paid")
    db.commit()

    _, отчёт = _догрузить(db, проект, build_archive(db, донор))

    assert (отчёт.edges_created, отчёт.channel_stubs) == (1, 1)
    каналы = {c.name: c for c in db.query(BrokerChannel).filter(
        BrokerChannel.node_id == узлы["kafka"].id).all()}
    assert set(каналы) == {"orders.created", "orders.paid"}  # legacy.topic не заведён
    assert is_edge_stub(каналы["orders.paid"]) and not is_edge_stub(каналы["orders.created"])


# ── Ф-E: остаток слияния в догрузке (Р3/Р4 задания) ─────────────────────────
#
# Догрузка отвечает за то, что привезли архивы. Остаток, все сущности которого из
# живого проекта, — дело панели незавершённости: она видит его и без импорта, а
# вопрос о нём в модалке догрузки был бы вопросом не по делу.


def _живой_с_остатком(db):
    """Живой проект, в котором остаток есть и БЕЗ всякой догрузки: связь в
    контейнер и оторванная пара — обе целиком свои."""
    проект = _проект(db, "Живой")
    корень = _узел(db, проект, "Ярмарка", role="система")
    orders = _узел(db, проект, "orders", корень)
    _узел(db, проект, "api", orders)
    каталог = _узел(db, проект, "Каталог-БД", корень)
    оператор = _узел(db, проект, "Оператор", shape="person")
    биллинг = _узел(db, проект, "Биллинг")
    счета = _узел(db, проект, "счета", биллинг)
    счета_бд = _узел(db, проект, "Биллинг-БД", биллинг)
    _ребро(db, проект, orders, каталог, label="пишет")
    _ребро(db, проект, оператор, orders, label="смотрит")  # конец в контейнере
    _ребро(db, проект, счета, счета_бд, label="пишет")  # остров
    db.commit()
    return проект, {"orders": orders, "оператор": оператор}


def _донор_витрины(db) -> bytes:
    """Архив соседа: видит orders коробкой (новая связь в контейнер) и зовёт
    оператора по-своему (похожие имена с живым)."""
    донор = _проект(db, "Донор")
    корень = _узел(db, донор, "Ярмарка", role="система")
    orders = _узел(db, донор, "orders", корень)
    витрина = _узел(db, донор, "Витрина")
    _узел(db, донор, "Оператор смены", shape="person")
    _ребро(db, донор, витрина, orders, label="оформляет")
    db.commit()
    return build_archive(db, донор)


def test_остаток_догрузки_только_с_участием_архива(db):
    """Р3: живая связь в контейнер и живой остров вопросами не становятся, а
    привозная связь и пара «живой + архивный» — становятся."""
    проект, узлы = _живой_с_остатком(db)
    архив = _донор_витрины(db)

    превью, _ = _догрузить(db, проект, архив)

    остаток = превью.remainder
    # Живая связь «Оператор → orders» тоже упирается в контейнер, но она не наше дело.
    assert [c.id for c in остаток.container_edges] == [
        "edge|Витрина|Ярмарка / orders|оформляет|target"
    ]
    assert [c.path for c in остаток.container_edges[0].components] == ["Ярмарка / orders / api"]
    assert остаток.isolated_groups == []  # остров «счета → Биллинг-БД» целиком живой
    [пара] = остаток.fuzzy_pairs
    assert (пара.a_path, пара.b_path) == ("Оператор", "Оператор смены")
    assert (пара.a_current, пара.b_current) == (True, False)
    assert пара.a_source == "Из проекта"
    assert пара.b_source == "Из архива a1.zip"
    # Пикер концов видит всё дерево целиком — и живое, и приехавшее.
    assert "Ярмарка / orders / api" in остаток.node_paths and "Витрина" in остаток.node_paths
    # Строки замечаний на месте: структура их дополняет (Р1).
    assert any("конец в контейнере" in w for w in превью.warnings)


def test_остаток_догрузки_дефолт_спора_поля_на_живом(db):
    """Спор поля живого узла с архивным — вопрос, но дефолт стоит на «моём»:
    без ответа догрузка не перепишет ни одного живого поля."""
    проект, _ = _ярмарка(db)
    донор, _ = _донор_ярмарки(db, description="Описание донора")
    db.commit()

    превью, _ = _догрузить(db, проект, build_archive(db, донор))

    [спор] = превью.remainder.field_conflicts
    assert спор.id == "field|Ярмарка / orders|description"
    assert [(c.value, c.current) for c in спор.candidates] == [
        ("Живое описание", True), ("Описание донора", False)
    ]
    assert [c.source_label for c in спор.candidates] == ["Из проекта", "Из архива a1.zip"]
    assert спор.default == 0  # кандидат current


def test_остаток_догрузки_подпись_живого_кандидата_семьи(db):
    """§4.7: живое знание в споре тела подписано «Из проекта», а не чипом."""
    проект, _ = _ярмарка(db)
    архив = _донор_с_доком(db, "graph TD\n  ДОНОР\n")

    превью, _ = _догрузить(db, проект, архив)

    [спор] = превью.family_conflicts
    свой = next(k for k in спор.candidates if k.current)
    чужой = next(k for k in спор.candidates if not k.current)
    assert свой.source_label == "Из проекта"
    assert чужой.source_label == "Из архива a1.zip"


def test_остаток_догрузки_своего_архива_пуст(db):
    """Сторож аддитивности: свой же архив вопросов не рождает — спрашивать не о чем."""
    проект, _ = _живой_с_остатком(db)

    превью, _ = _догрузить(db, проект, build_archive(db, проект))

    assert превью.remainder.field_conflicts == []
    assert превью.remainder.container_edges == []
    assert превью.remainder.isolated_groups == []
    assert превью.remainder.fuzzy_pairs == []


# ── Ф-E: решения по остатку в применении догрузки ───────────────────────────


def _пути_и_связи(db, project_id) -> tuple[set[str], set[tuple]]:
    узлы = db.query(Node).filter(Node.project_id == project_id).all()
    все = {n.id: n for n in узлы}
    пути = {n.id: node_path(все, n.id) for n in узлы}
    связи = {
        (пути[e.source_id], пути[e.target_id], e.label, e.is_synchronous)
        for e in db.query(Edge).filter(Edge.project_id == project_id).all()
    }
    return set(пути.values()), связи


def test_решение_склейка_догрузки_сохраняет_живой_узел(db):
    """Р4: из пары «живой + привозной» выживает ЖИВОЙ (его id, его карточка), а
    привозной не создаётся вовсе — его связи и компоненты идут к живому."""
    проект, узлы = _живой_с_остатком(db)
    оператор_id = узлы["оператор"].id
    архив = _донор_витрины(db)
    план = build_into_plan(db, проект, [("a.zip", архив)])
    [пара] = into_preview(план).remainder.fuzzy_pairs
    решения = parse_decisions(
        json.dumps({"merges": {пара.id: {"name": "Оператор мониторинга"}}})
    )

    отчёт = apply_into_plan(db, проект, план, {}, decisions=решения)
    db.commit()

    пути, _ = _пути_и_связи(db, проект.id)
    assert "Оператор смены" not in пути  # привозной тёзка не родился
    assert "Оператор мониторинга" in пути
    живой = db.get(Node, оператор_id)
    assert живой is not None and живой.name == "Оператор мониторинга"  # тот же объект
    assert отчёт.nodes_created == 1  # только «Витрина»; склеенный не создавался
    assert "Ваши решения: склеено объектов 1" in отчёт.warnings


def test_решение_перевес_и_новая_связь_догрузки(db):
    """Перевес касается только ПРИВОЗНОЙ связи, новая связь соединяет живое с
    новым, и обе видны в проекте."""
    проект, _ = _живой_с_остатком(db)
    архив = _донор_витрины(db)
    план = build_into_plan(db, проект, [("a.zip", архив)])
    остаток = into_preview(план).remainder
    [связь] = остаток.container_edges
    решения = parse_decisions(json.dumps({
        "edges": {связь.id: {"to_path": "Ярмарка / orders / api"}},
        # Группы у догрузки нет (живой остров — не её дело, Р3), и связь всё равно
        # можно дорисовать: вопрос был крючком, а не единственным входом.
        "new_edges": [{
            "group_id": "",
            "from_path": "Витрина",
            "to_path": "Ярмарка / Каталог-БД",
            "label": "читает витрину",
            "tech": "SQL",
            "channel": "sync",
        }],
    }))

    отчёт = apply_into_plan(db, проект, план, {}, decisions=решения)
    db.commit()

    _, связи = _пути_и_связи(db, проект.id)
    assert ("Витрина", "Ярмарка / orders / api", "оформляет", None) in связи
    assert ("Витрина", "Ярмарка / orders", "оформляет", None) not in связи
    assert ("Витрина", "Ярмарка / Каталог-БД", "читает витрину", True) in связи
    # Живые связи целы: решения их не касаются (Р3).
    assert ("Оператор", "Ярмарка / orders", "смотрит", None) in связи
    assert отчёт.edges_created == 2
    assert "Ваши решения: перевешено связей 1 · добавлено связей 1" in отчёт.warnings


def test_решение_поля_перезаписывает_живое_только_явным_выбором(db):
    """Спор поля живого узла с архивным: без ответа — «моё» (fill-only), с
    выбором архивного кандидата — запись поверх."""
    проект, узлы = _ярмарка(db)
    orders_id = узлы["orders"].id
    донор, _ = _донор_ярмарки(db, description="Описание донора")
    db.commit()
    архив = build_archive(db, донор)

    # 1. Без решения живое описание остаётся (сторож аддитивности).
    _догрузить(db, проект, архив)
    assert db.get(Node, orders_id).description == "Живое описание"

    # 2. Тот же архив с явным выбором архивного кандидата.
    план = build_into_plan(db, проект, [("a.zip", архив)])
    [спор] = into_preview(план).remainder.field_conflicts
    архивный = next(i for i, c in enumerate(спор.candidates) if not c.current)
    отчёт = apply_into_plan(
        db, проект, план, {},
        decisions=parse_decisions(json.dumps({"fields": {спор.id: архивный}})),
    )
    db.commit()

    assert db.get(Node, orders_id).description == "Описание донора"
    assert any("заменено по вашему решению" in w for w in отчёт.warnings)
    assert "Ваши решения: выбрано значений полей 1" in отчёт.warnings
    # Сделанное по выбору человека — информация: в свёртку отчёта не едет (Ф2г-2).
    assert not any("решени" in u.text for u in отчёт.unfixable)

    # 3. Выбор СВОЕГО кандидата живую запись не трогает вовсе.
    план3 = build_into_plan(db, проект, [("a.zip", архив)])
    споры = into_preview(план3).remainder.field_conflicts
    assert споры == []  # спорить больше не о чем: значения сошлись


def test_решение_догрузки_не_из_плана_отвергается(db):
    проект, _ = _живой_с_остатком(db)
    план = build_into_plan(db, проект, [("a.zip", _донор_витрины(db))])
    было = _снимок(db, проект.id)

    with pytest.raises(UnifiedImportError, match="Превью устарело"):
        apply_into_plan(
            db, проект, план, {},
            decisions=parse_decisions(json.dumps({"merges": {"pair|Нет|Пары": {"name": "Х"}}})),
        )
    db.rollback()
    assert _снимок(db, проект.id) == было


def test_эндпоинт_догрузки_принимает_decisions(db):
    проект, _ = _живой_с_остатком(db)
    архив = _донор_витрины(db)
    план = build_into_plan(db, проект, [("a.zip", архив)])
    [связь] = remainder_from_plan(план.plan, 0).container_edges
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_architect] = lambda: ensure_architect(db)
    try:
        клиент = TestClient(app)
        r = клиент.post(
            ПРИМЕНЕНИЕ.format(проект.id),
            files=[("files", ("a.zip", архив, "application/zip"))],
            data={"decisions": json.dumps(
                {"edges": {связь.id: {"to_path": "Ярмарка / orders / api"}}}
            )},
        )
    finally:
        app.dependency_overrides.clear()

    assert r.status_code == 200, r.text
    assert any("Ваши решения: перевешено связей 1" in w for w in r.json()["warnings"])
    _, связи = _пути_и_связи(db, проект.id)
    assert ("Витрина", "Ярмарка / orders / api", "оформляет", None) in связи


def test_остаток_догрузки_прячет_только_свои_строки(db):
    """Р3 в списке «что прятать»: строка чисто живого остатка вопросом не стала —
    значит и не прячется; строка «живой + архивный» стала."""
    проект, _ = _живой_с_остатком(db)

    превью, _ = _догрузить(db, проект, _донор_витрины(db))

    скрыть = превью.remainder.converted_warnings
    assert any("похожи" in w for w in скрыть)  # «Оператор» и «Оператор смены»
    assert any("Витрина" in w and "конец в контейнере" in w for w in скрыть)
    # Живая связь в контейнер и живой остров вопросами не стали — строки остаются.
    assert not any("Оператор → orders" in w for w in скрыть)
    assert not any("не связана с остальной схемой" in w for w in скрыть)
    assert set(скрыть) <= set(превью.warnings)


def test_склейка_догрузки_доливает_знание_поглощённого(db):
    """Привозной объект не создаётся, но и не пропадает: его пустующие у живого
    поля и его якорь переезжают к живому выжившему, занятое не трогается."""
    проект, узлы = _живой_с_остатком(db)
    оператор = узлы["оператор"]
    оператор.role = "человек"  # занятое поле — сторож fill-only
    db.commit()
    оператор_id = оператор.id

    донор = _проект(db, "Донор")
    корень = _узел(db, донор, "Ярмарка", role="система")
    _узел(db, донор, "orders", корень)
    _узел(db, донор, "Оператор смены", shape="person", role="дежурный",
          description="Следит за очередью заказов",
          source_ref="git:github.com/org/ops#operator")
    db.commit()
    архив = build_archive(db, донор)

    план = build_into_plan(db, проект, [("a.zip", архив)])
    [пара] = into_preview(план).remainder.fuzzy_pairs
    отчёт = apply_into_plan(
        db, проект, план, {},
        decisions=parse_decisions(json.dumps({"merges": {пара.id: {"name": "Оператор"}}})),
    )
    db.commit()

    живой = db.get(Node, оператор_id)
    assert живой is not None and живой.name == "Оператор"  # выбрано имя живого
    assert живой.description == "Следит за очередью заказов"  # пустое долито
    assert живой.role == "человек"  # заполненное не тронуто
    assert живой.source_ref == "git:github.com/org/ops#operator"  # якорь переехал
    assert db.query(Node).filter(
        Node.project_id == проект.id, Node.name == "Оператор смены"
    ).count() == 0
    assert any("залито из склеенного объекта" in w for w in отчёт.warnings)


def _донор_чужого_корня(db) -> bytes:
    """Архив с ДРУГИМ корнем: даёт незакрываемое замечание «нет общих корней»."""
    донор = _проект(db, "Донор")
    корень = _узел(db, донор, "Склад", role="система")
    приёмка = _узел(db, донор, "receiving", корень)
    хранилище = _узел(db, донор, "Склад-БД", корень, shape="database")
    _ребро(db, донор, приёмка, хранилище, label="пишет")
    db.commit()
    return build_archive(db, донор)


def test_незакрываемое_замечание_догрузки_без_агента_и_создания(db):
    """Правка Ф2г: пункт свёртки — факт и ручное действие, без «прогона агента» и
    «подмените файл». Тексты общие для обоих окон: в них нет «проект создастся»."""
    проект, _ = _ярмарка(db)

    превью, _ = _догрузить(db, проект, _донор_чужого_корня(db))

    [замечание] = [u for u in превью.remainder.unfixable if "корневые объекты" in u.text]
    assert замечание.text == (
        "У файлов разные корневые объекты («Ярмарка», «Склад»), поэтому в проекте будет "
        "несколько корней. Если это одна система, их содержимое нужно будет перенести в "
        "один корень вручную."
    )
    assert замечание.file is None
    for u in превью.remainder.unfixable:
        for ложь in ("агент", "создастся", "подмените"):
            assert ложь not in u.text


def test_незакрываемые_догрузки_без_замечаний_о_живом_проекте(db):
    """Р3: пофайловые замечания входа №0 (живого проекта) в свёртку не едут —
    одинокие объекты и прочее живое — дело панели незавершённости. Замечания
    архива — едут."""
    проект, _ = _живой_с_остатком(db)
    архив = _донор_чужого_корня(db)

    план = build_into_plan(db, проект, [("a1.zip", архив)])
    превью = into_preview(план)

    живые = [
        w for w, o in zip(план.plan.report.warnings, план.plan.report.warning_files, strict=True)
        if o == 0
    ]
    assert живые, "сторож теста: у живого проекта есть свои замечания"
    assert all(u.file != 0 for u in превью.remainder.unfixable)

# ── Ф2г-2: экран «Архивы догружены» — свёртка вместо сырых замечаний ─────────


def test_отчёт_догрузки_свёртка_вместо_сырых_замечаний(db):
    """Строки применения — пунктами «Придется подправить вручную» (что требует рук),
    информация о сделанном («пустовало — залито», легенда нумерации, «оставлено …
    (файл N)» мерджа) — нет. Сырые warnings остаются на месте: их читает MCP."""
    проект, _ = _ярмарка(db)
    донор = _проект(db, "Донор")
    корень = _узел(db, донор, "Ярмарка", role="система")
    orders = _узел(db, донор, "orders", корень, technology="Go", description="Описание донора")
    _узел(db, донор, "api", orders)  # донор видит orders изнутри: его поля побеждают в мердже
    каталог = _узел(db, донор, "Каталог-БД", корень, shape="database", status="planned")
    kafka = _узел(db, донор, "Kafka", корень, shape="broker")
    _таблица(db, каталог, "orders", [("id", "uuid")], описание="заказы донора")
    _канал(db, kafka, "orders.created", [("total", "numeric")], описание="донор")
    db.commit()

    превью, отчёт = _догрузить(db, проект, build_archive(db, донор), резолюции={
        "table|Ярмарка / Каталог-БД|public.orders": "cand:1",
        "channel|Ярмарка / Kafka|orders.created": "cand:1",
    })

    assert [u.text for u in отчёт.unfixable] == [
        # остаток плана — тот же, что был в превью
        *[u.text for u in превью.remainder.unfixable],
        "У объекта «Ярмарка / orders» в архиве другое значение поля «описание» («Описание "
        "донора»), а в проекте осталось прежнее («Живое описание»). Если верно значение из "
        "архива, поле нужно будет поправить в карточке объекта вручную.",
        "У объекта «Ярмарка / orders» в архиве другое значение поля «технология» («Go»), а в "
        "проекте осталось прежнее («Python»). Если верно значение из архива, поле нужно будет "
        "поправить в карточке объекта вручную.",
        "У объекта «Ярмарка / Каталог-БД» в архиве другое значение поля «статус» "
        "(«Проектируется»), а в проекте осталось прежнее («Существует»). Если верно значение "
        "из архива, поле нужно будет поправить в карточке объекта вручную.",
        "В таблице «public.orders» объекта «Ярмарка / Каталог-БД» осталась колонка «comment», "
        "которой нет в архиве: догрузка ничего не удаляет. Если она больше не нужна, её нужно "
        "будет удалить вручную.",
        "В канале «orders.created» объекта «Ярмарка / Kafka» осталось поле «id», которого нет "
        "в архиве: догрузка ничего не удаляет. Если оно больше не нужно, его нужно будет "
        "удалить вручную.",
    ]
    assert превью.remainder.unfixable, "сторож теста: у плана есть свой остаток"
    # Сырые строки на месте (MCP), включая информацию и строки мерджа.
    assert any(w.startswith("нумерация файлов") for w in отчёт.warnings)
    assert any("в архиве нет — оставлены" in w for w in отчёт.warnings)
    for u in отчёт.unfixable:
        for ложь in ("агент", "(файл ", "нумерация", "оставлено «"):
            assert ложь not in u.text


def test_отчёт_догрузки_пропавший_параметр_пунктом(db):
    """Параметр, чья живая запись исчезла к применению, — пункт свёртки (генератор
    настоящий: _replace_params)."""
    проект, узлы = _ярмарка(db)
    строки: list[str] = []
    победитель = _Winner(
        family="config", node_idx=0, key="GONE", origin=1, fname="config/x.yaml",
        value=ParamIn(name="GONE"),
        from_conflict=True,
    )

    заменено = _replace_params(db, [победитель], {("config", 0, "GONE")}, [узлы["orders"]], строки)

    assert заменено == 0
    assert [u.text for u in apply_unfixable(строки)] == [
        "Параметр «GONE» не догружен: в проекте его уже нет. Если он нужен, его нужно будет "
        "добавить вручную."
    ]
