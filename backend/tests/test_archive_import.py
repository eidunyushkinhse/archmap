"""Импорт архива знания (Ф4, docs/plan-archive-export.md).

Главная гарантия — ПОЛНЫЙ КРУГ: build_archive → import_archive воспроизводит все
категории знания (C4 с якорями и типом канала, доки с заглушками, спеки, БД,
каналы, конфигурация, процессы с привязками шагов). Частичные промахи — видимой
деградацией в замечаниях, кривой архив — ArchiveError без создания проекта.
"""

import io
import uuid
import zipfile

import pytest
from conftest import ensure_architect, ensure_project

from app.archive_export import build_archive
from app.archive_import import ArchiveError, import_archive
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project


def _полигон(db) -> Project:
    """Проект со всеми категориями знания (тот же состав, что у теста сборки)."""
    проект = ensure_project(db)
    проект.description = "полигон архива"
    ярмарка = Node(id=uuid.uuid4(), name="Ярмарка", project_id=проект.id)
    db.add(ярмарка)
    db.flush()
    orders = Node(id=uuid.uuid4(), name="orders", project_id=проект.id,
                  parent_id=ярмарка.id, openapi_spec="openapi: 3.0.3\npaths: {}\n",
                  source_ref="git:github.com/shop/orders")
    kafka = Node(id=uuid.uuid4(), name="Kafka", project_id=проект.id,
                 parent_id=ярмарка.id, shape="broker")
    база = Node(id=uuid.uuid4(), name="Каталог-БД", project_id=проект.id,
                parent_id=ярмарка.id, shape="database")
    db.add_all([orders, kafka, база])
    db.flush()
    db.add(Edge(id=uuid.uuid4(), project_id=проект.id, source_id=orders.id,
                target_id=kafka.id, channel="orders.created", is_synchronous=False))
    схема = NodeDoc(id=uuid.uuid4(), node_id=orders.id, name="POST /orders",
                    kind="operation", operation="POST /orders",
                    content="graph TD\n  A --> B\n")
    заглушка = NodeDoc(id=uuid.uuid4(), node_id=orders.id, name="GET /health",
                       kind="operation", operation="GET /health", content="")
    db.add_all([схема, заглушка])
    t = DbTable(id=uuid.uuid4(), node_id=база.id, name="orders", schema_name="public")
    db.add(t)
    db.flush()
    db.add(DbColumn(id=uuid.uuid4(), table_id=t.id, name="id", type="uuid",
                    nullable=False, is_primary_key=True, order=0))
    db.add(BrokerChannel(id=uuid.uuid4(), node_id=kafka.id, name="orders.created",
                         group_name="shop", kind="topic", partition_key="",
                         delivery="at-least-once", retention=""))
    db.add(ConfigParam(id=uuid.uuid4(), node_id=orders.id, name="TIMEOUT_MS",
                       value_type="int", required=False, default_value="5000"))
    процесс = BusinessProcess(id=uuid.uuid4(), name="Оформление", project_id=проект.id)
    db.add(процесс)
    db.flush()
    участник = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id,
                                  node_id=orders.id, name="orders", order=0)
    db.add(участник)
    db.flush()
    db.add(ProcessMessage(id=uuid.uuid4(), process_id=процесс.id, order=0,
                          edge_id=None, leg="forward", doc_id=схема.id,
                          from_participant_id=участник.id, to_participant_id=участник.id,
                          caption="оформить"))
    db.commit()
    return проект


def test_полный_круг_архива(db):
    исходный = _полигон(db)
    архив = build_archive(db, исходный)

    новый, отчёт = import_archive(db, архив, None, ensure_architect(db).id)
    db.commit()

    assert отчёт.warnings == []
    assert (новый.name, новый.description) == (исходный.name, "полигон архива")
    # C4: узлы с якорем, связь с каналом и явным типом.
    узлы = {n.name: n for n in db.query(Node).filter(Node.project_id == новый.id)}
    assert len(узлы) == 4 and отчёт.nodes == 4 and отчёт.edges == 1
    assert узлы["orders"].source_ref == "git:github.com/shop/orders"
    [связь] = db.query(Edge).filter(Edge.project_id == новый.id).all()
    assert (связь.channel, связь.is_synchronous) == ("orders.created", False)
    # Доки: обе схемы, заглушка ОСТАЛАСЬ заглушкой (тело без шапки — Д4).
    доки = {d.name: d for d in db.query(NodeDoc).filter(NodeDoc.node_id == узлы["orders"].id)}
    assert отчёт.docs_created == 2 and set(доки) == {"POST /orders", "GET /health"}
    assert доки["POST /orders"].described and доки["POST /orders"].content == "graph TD\n  A --> B\n"
    assert not доки["GET /health"].described
    # Спека — байт-в-байт исходная (адресный комментарий снят при импорте).
    assert отчёт.specs_applied == 1
    assert узлы["orders"].openapi_spec == "openapi: 3.0.3\npaths: {}\n"
    # Семьи фактов — родными приёмниками.
    assert отчёт.db is not None and отчёт.db.tables_written == 1
    assert отчёт.channels is not None and отчёт.channels.errors == []
    assert отчёт.config is not None and отчёт.config.errors == []
    [таблица] = db.query(DbTable).join(Node, Node.id == DbTable.node_id).filter(
        Node.project_id == новый.id).all()
    assert (таблица.name, таблица.schema_name) == ("orders", "public")
    [канал] = db.query(BrokerChannel).join(Node, Node.id == BrokerChannel.node_id).filter(
        Node.project_id == новый.id).all()
    assert (канал.name, канал.group_name, канал.delivery) == (
        "orders.created", "shop", "at-least-once")
    [параметр] = db.query(ConfigParam).join(Node, Node.id == ConfigParam.node_id).filter(
        Node.project_id == новый.id).all()
    assert (параметр.name, параметр.default_value) == ("TIMEOUT_MS", "5000")
    # Процесс: имя из манифеста, шаг привязан к схеме НОВОГО проекта (archmap-doc).
    [процесс] = db.query(BusinessProcess).filter(BusinessProcess.project_id == новый.id).all()
    assert процесс.name == "Оформление"
    [итог] = отчёт.processes
    assert (итог.messages, итог.doc_linked, итог.doc_unresolved) == (1, 1, 0)
    [шаг] = db.query(ProcessMessage).filter(ProcessMessage.process_id == процесс.id).all()
    assert шаг.doc_id == доки["POST /orders"].id


def test_кривой_zip_не_создаёт_проекта(db):
    было = db.query(Project).count()
    with pytest.raises(ArchiveError, match="не читается как zip"):
        import_archive(db, b"\x00\x01musor", None, ensure_architect(db).id)
    assert db.query(Project).count() == было


def test_архив_нового_формата_отклоняется(db):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.yaml", "archmap-archive: 99\ncontents: {}\n")
    with pytest.raises(ArchiveError, match="обновите ArchMap"):
        import_archive(db, buf.getvalue(), None, ensure_architect(db).id)


def test_неразрешённый_адрес_дока_уходит_в_замечания(db):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.yaml", (
            "archmap-archive: 1\n"
            "project: {name: Хвост}\n"
            "contents:\n  c4: c4.yaml\n  docs: [docs/x.mmd]\n"
        ))
        zf.writestr("c4.yaml", "nodes:\n  - name: orders\n")
        zf.writestr("docs/x.mmd", "%% archmap-name: Схема\n%% archmap-node: Нет такого\ngraph TD\n A\n")

    новый, отчёт = import_archive(db, buf.getvalue(), "Переименован", ensure_architect(db).id)
    db.commit()

    # Проект создан (переименование параметром работает), схема честно пропущена.
    assert новый.name == "Переименован"
    assert отчёт.docs_created == 0
    assert any("Нет такого" in w for w in отчёт.warnings)
