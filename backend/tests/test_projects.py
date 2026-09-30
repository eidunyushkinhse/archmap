"""Тесты роутера проектов (CRUD, старт, архив/восстановление, удаление, копия).

Дёргаем функции роутера напрямую с db=db (как остальной набор). Покрываем:
счётчики и редактора в мете, три способа старта, глубокую копию (новые id,
исходник цел), мягкий архив и защиту необратимого удаления.
"""

import uuid

import pytest
from conftest import ensure_architect
from fastapi import HTTPException

from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.routers.projects import (
    archive_project,
    create_project,
    delete_project,
    get_project,
    list_projects,
    restore_project,
)
from app.schemas.project import ProjectCreate


def _schema(db, project_id):
    """Кладёт в проект 2 узла и 1 связь напрямую (для проверки счётчиков/копии)."""
    a = Node(id=uuid.uuid4(), name="A", project_id=project_id)
    b = Node(id=uuid.uuid4(), name="B", project_id=project_id)
    db.add_all([a, b])
    db.flush()
    db.add(Edge(id=uuid.uuid4(), source_id=a.id, target_id=b.id, project_id=project_id))
    db.commit()


def test_create_blank_lists_with_meta(db):
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Пустой", description="опис"), db=db, user=user)
    assert p.object_count == 0 and p.edge_count == 0
    assert p.updated_by == user.username
    assert p.preview.nodes == [] and p.preview.edges == []

    active = list_projects(archived=False, db=db)
    assert [x.name for x in active] == ["Пустой"]


def test_preview_projects_edges_to_root_ancestors(db):
    """Превью карточки = корневой уровень: узлы — корни дерева, связь глубокого
    потомка проецируется на его корневого предка (как ghost на холсте)."""
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Превью"), db=db, user=user)
    # Два корня: R1 (с ребёнком-листом) и R2.
    r1 = Node(id=uuid.uuid4(), name="R1", project_id=p.id)
    r2 = Node(id=uuid.uuid4(), name="R2", project_id=p.id)
    db.add_all([r1, r2])
    db.flush()
    # Сохранённые координаты корней — строками view_layout корневого вида (R3).
    from app.models.view_layout import ViewLayoutItem
    db.add(ViewLayoutItem(project_id=p.id, view_id=None, item_id=str(r1.id), payload={"x": 10, "y": 20}))
    db.add(ViewLayoutItem(project_id=p.id, view_id=None, item_id=str(r2.id), payload={"x": 200, "y": 20}))
    child = Node(id=uuid.uuid4(), name="C", project_id=p.id, parent_id=r1.id)
    db.add(child)
    db.flush()
    # Связь от потомка R1 к R2 — на корневом уровне это ребро R1→R2.
    db.add(Edge(id=uuid.uuid4(), source_id=child.id, target_id=r2.id, project_id=p.id))
    db.commit()

    fresh = get_project(p.id, db=db)
    node_ids = {n.id for n in fresh.preview.nodes}
    assert node_ids == {r1.id, r2.id}  # потомок в превью не попадает
    by_id = {n.id: n for n in fresh.preview.nodes}
    assert by_id[r1.id].x == 10 and by_id[r1.id].y == 20  # сохранённые координаты
    assert fresh.preview.edges == [] or (
        len(fresh.preview.edges) == 1
        and {fresh.preview.edges[0].source, fresh.preview.edges[0].target} == {r1.id, r2.id}
    )
    assert len(fresh.preview.edges) == 1  # проекция дала ровно одно ребро R1↔R2


def test_template_start_removed(db):
    """Способ старта «Шаблон» снят 2026-09-30: каркасов нет, демо-пакет из API не
    сеется (его дождётся онбординг, app/demo_package.py). start="template:<id>"
    отвергается как неизвестный способ — и для бывших каркасов, и для демо-пакета."""
    user = ensure_architect(db)
    db.commit()  # откат отказа ниже не должен уносить пользователя
    было = db.query(Project).count()
    for start in ("template:webapp", "template:demo-marketplace"):
        with pytest.raises(HTTPException) as ei:
            create_project(ProjectCreate(name="X", start=start), db=db, user=user)
        assert ei.value.status_code == 400, start
        assert ei.value.detail == "Неизвестный способ старта проекта"
        # Транзакцией владеет роут: без коммита отказ проекта не оставляет.
        db.rollback()
        assert db.query(Project).count() == было


def test_templates_catalog_endpoint_removed():
    """Каталога витрины GET /projects/templates больше нет (снят 2026-09-30).
    Соседняя статическая ручка на месте — проверка не пустая по построению."""
    from app.main import app

    paths = {getattr(r, "path", "") for r in app.routes}
    assert "/api/v1/projects/import/prompt" in paths
    assert "/api/v1/projects/templates" not in paths


def test_deep_copy_clones_schema_without_touching_source(db):
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник"), db=db, user=user)
    _schema(db, src.id)
    src_after = get_project(src.id, db=db)
    assert (src_after.object_count, src_after.edge_count) == (2, 1)

    copy = create_project(
        ProjectCreate(name="Копия", start=f"copy:{src.id}"), db=db, user=user
    )
    # Копия повторяет счётчики, но это другой проект.
    assert (copy.object_count, copy.edge_count) == (2, 1)
    assert copy.id != src.id
    # Узлы копии принадлежат новому проекту и имеют новые id.
    copy_nodes = db.query(Node).filter(Node.project_id == copy.id).all()
    src_nodes = db.query(Node).filter(Node.project_id == src.id).all()
    assert len(copy_nodes) == 2 and len(src_nodes) == 2
    assert {n.id for n in copy_nodes}.isdisjoint({n.id for n in src_nodes})
    # Исходник не тронут.
    assert get_project(src.id, db=db).object_count == 2


def test_deep_copy_keeps_node_status(db):
    """Регрессия 2026-07-09: копия проекта теряла status узлов (planned/deprecated
    молча сбрасывались в existing) — copy_project_schema не переносил поле."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-статусы"), db=db, user=user)
    a = Node(id=uuid.uuid4(), name="Планируемый", project_id=src.id, status="planned")
    b = Node(id=uuid.uuid4(), name="Уходящий", project_id=src.id, status="deprecated")
    db.add_all([a, b])
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-статусы", start=f"copy:{src.id}"), db=db, user=user
    )
    statuses = {
        n.name: n.status for n in db.query(Node).filter(Node.project_id == copy.id).all()
    }
    assert statuses == {"Планируемый": "planned", "Уходящий": "deprecated"}


def test_deep_copy_remaps_message_doc_link(db):
    """Привязка шага к схеме логики обязана указывать на схему КОПИИ.

    Без карты схем копия ссылалась бы на строку ИСХОДНОГО проекта — межпроектная
    утечка, выглядящая как корректная документация: витрина открыла бы чужую схему и
    ничем не выдала бы подмену. Карту завели ровно поэтому (docs/plan-process-docs-step4.md,
    Ф1); тот же приём, что у tmap/colmap структуры БД.
    """
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-привязка"), db=db, user=user)
    web = Node(id=uuid.uuid4(), name="web", project_id=src.id)
    orders = Node(id=uuid.uuid4(), name="orders", project_id=src.id)
    db.add_all([web, orders])
    db.flush()
    edge = Edge(id=uuid.uuid4(), source_id=web.id, target_id=orders.id, project_id=src.id)
    doc = NodeDoc(id=uuid.uuid4(), node_id=orders.id, name="POST /orders", kind="operation",
                  operation="POST /orders", content="graph TD\n A")
    proc = BusinessProcess(id=uuid.uuid4(), name="Оформление", project_id=src.id)
    db.add_all([edge, doc, proc])
    db.flush()
    # Имя участника ЗАМОРОЖЕНО на записи (не берётся из узла) — колонка обязательна.
    pa = ProcessParticipant(id=uuid.uuid4(), process_id=proc.id, node_id=web.id,
                            name="web", order=0)
    pb = ProcessParticipant(id=uuid.uuid4(), process_id=proc.id, node_id=orders.id,
                            name="orders", order=1)
    db.add_all([pa, pb])
    db.flush()
    db.add(ProcessMessage(id=uuid.uuid4(), process_id=proc.id, order=0, edge_id=edge.id,
                          leg="forward", from_participant_id=pa.id, to_participant_id=pb.id,
                          doc_id=doc.id))
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-привязка", start=f"copy:{src.id}"), db=db, user=user
    )
    copied_procs = db.query(BusinessProcess).filter(BusinessProcess.project_id == copy.id).all()
    msgs = db.query(ProcessMessage).filter(
        ProcessMessage.process_id.in_([p.id for p in copied_procs])
    ).all()
    assert len(msgs) == 1
    # Привязка есть, но это ДРУГАЯ строка — схема копии, а не исходника.
    assert msgs[0].doc_id is not None and msgs[0].doc_id != doc.id
    копия_схемы = db.get(NodeDoc, msgs[0].doc_id)
    assert копия_схемы is not None and копия_схемы.name == "POST /orders"
    узел = db.get(Node, копия_схемы.node_id)
    assert узел is not None and узел.project_id == copy.id


def test_deep_copy_keeps_edge_channel(db):
    """Регрессия 2026-08-16 (П1): копия связи теряла channel — имя канала брокера,
    который эта стрелка называет. Ссылка мягкая (по имени, не FK), поэтому имя обязано
    доехать до копии без изменений — иначе связь копии остаётся без канала."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-канал"), db=db, user=user)
    svc = Node(id=uuid.uuid4(), name="Сервис", project_id=src.id)
    broker = Node(id=uuid.uuid4(), name="Кафка", project_id=src.id, shape="broker")
    db.add_all([svc, broker])
    db.flush()
    db.add(
        Edge(
            id=uuid.uuid4(),
            source_id=svc.id,
            target_id=broker.id,
            project_id=src.id,
            label="публикует",
            channel="orders.created",
            is_synchronous=False,
        )
    )
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-канал", start=f"copy:{src.id}"), db=db, user=user
    )
    edge = db.query(Edge).filter(Edge.project_id == copy.id).one()
    assert edge.channel == "orders.created"
    assert edge.is_synchronous is False and edge.label == "публикует"


def test_deep_copy_keeps_node_source_ref(db):
    """Регрессия 2026-08-16 (П1): копия узла теряла source_ref — якорь, которым узел
    опознаётся между прогонами агента. Без него синк «Архитектура из кода» на копии
    начинает с нуля и плодит дубли вместо обновления."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-якорь"), db=db, user=user)
    db.add(
        Node(
            id=uuid.uuid4(),
            name="Платежи",
            project_id=src.id,
            source_ref="git:github.com/org/payments",
        )
    )
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-якорь", start=f"copy:{src.id}"), db=db, user=user
    )
    node = db.query(Node).filter(Node.project_id == copy.id).one()
    assert node.source_ref == "git:github.com/org/payments"


def test_deep_copy_keeps_db_structure(db):
    """Регрессия 2026-08-16 (П1): структура БД (таблицы и колонки) не копировалась
    ВОВСЕ — копия проекта с документацией базы приходила без неё.

    Отдельно проверяем ссылку колонки на колонку (внешний ключ КАРТЫ): она обязана
    указывать внутрь КОПИИ, иначе ER копии молча смотрит в исходный проект.
    """
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-БД"), db=db, user=user)
    base = Node(id=uuid.uuid4(), name="Основная БД", project_id=src.id, shape="database")
    db.add(base)
    db.flush()
    orders = DbTable(id=uuid.uuid4(), node_id=base.id, name="orders", schema_name="public")
    payments = DbTable(id=uuid.uuid4(), node_id=base.id, name="payments")
    db.add_all([orders, payments])
    db.flush()
    orders_id = DbColumn(
        id=uuid.uuid4(), table_id=orders.id, name="id", type="uuid",
        nullable=False, is_primary_key=True, order=0,
    )
    db.add(orders_id)
    db.add(
        DbColumn(
            id=uuid.uuid4(), table_id=orders.id, name="status", type="varchar(32)",
            description="new|paid", order=1,
        )
    )
    db.flush()
    db.add(
        DbColumn(
            id=uuid.uuid4(), table_id=payments.id, name="order_id", type="uuid",
            references_column_id=orders_id.id, order=0,
        )
    )
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-БД", start=f"copy:{src.id}"), db=db, user=user
    )
    copy_node = db.query(Node).filter(Node.project_id == copy.id).one()
    tables = {t.name: t for t in copy_node.db_tables}
    assert set(tables) == {"orders", "payments"}
    assert tables["orders"].schema_name == "public"
    cols = {c.name: c for c in tables["orders"].columns}
    assert set(cols) == {"id", "status"}
    assert (cols["id"].type, cols["id"].is_primary_key, cols["id"].nullable) == ("uuid", True, False)
    assert cols["status"].description == "new|paid"
    # Ссылка ведёт на колонку КОПИИ, а не исходного проекта.
    ref = tables["payments"].columns[0].references_column_id
    assert ref == cols["id"].id and ref != orders_id.id


def test_deep_copy_keeps_broker_channels(db):
    """Регрессия 2026-08-16 (П1): каналы брокера и поля их сообщений не копировались
    ВОВСЕ. Плюс шов: связь называет канал ПО ИМЕНИ, значит имена каналов в копии
    обязаны совпасть с channel скопированной связи — иначе стрелка теряет канал."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-брокер"), db=db, user=user)
    svc = Node(id=uuid.uuid4(), name="Сервис", project_id=src.id)
    broker = Node(id=uuid.uuid4(), name="Кафка", project_id=src.id, shape="broker")
    db.add_all([svc, broker])
    db.flush()
    channel = BrokerChannel(
        id=uuid.uuid4(), node_id=broker.id, name="orders.created", kind="topic",
        partition_key="order_id", delivery="at-least-once", retention="7d",
        description="факт создания заказа",
    )
    db.add(channel)
    db.add(
        Edge(
            id=uuid.uuid4(), source_id=svc.id, target_id=broker.id, project_id=src.id,
            channel="orders.created", is_synchronous=False,
        )
    )
    db.flush()
    db.add_all(
        [
            ChannelField(
                id=uuid.uuid4(), channel_id=channel.id, name="order_id", type="uuid",
                required=True, order=0,
            ),
            ChannelField(
                id=uuid.uuid4(), channel_id=channel.id, name="status", type="string",
                description="new|paid", order=1,
            ),
        ]
    )
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-брокер", start=f"copy:{src.id}"), db=db, user=user
    )
    copy_broker = (
        db.query(Node).filter(Node.project_id == copy.id, Node.shape == "broker").one()
    )
    assert len(copy_broker.broker_channels) == 1
    ch = copy_broker.broker_channels[0]
    assert (ch.name, ch.kind, ch.partition_key) == ("orders.created", "topic", "order_id")
    assert (ch.delivery, ch.retention) == ("at-least-once", "7d")
    assert [(f.name, f.type, f.required) for f in ch.fields] == [
        ("order_id", "uuid", True),
        ("status", "string", False),
    ]
    # Шов «стрелка → канал» цел: имя канала копии совпадает с channel связи копии.
    edge = db.query(Edge).filter(Edge.project_id == copy.id).one()
    assert edge.channel == ch.name


def test_deep_copy_keeps_config_params(db):
    """Конфигурация сервисов едет в копию, и ИМЕНА параметров в ней те же: пометка
    «зависит от:» в тексте схемы логики ссылается по имени (мягкая ссылка, не FK), и
    переименование порвало бы шов «развилка → параметр» в копии."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-конфиг"), db=db, user=user)
    svc = Node(id=uuid.uuid4(), name="Платежи", project_id=src.id)
    db.add(svc)
    db.flush()
    db.add_all(
        [
            ConfigParam(
                id=uuid.uuid4(), node_id=svc.id, name="RETRY_TIMEOUT",
                value_type="duration", default_value="30s",
                description="сколько ждать перед повтором",
            ),
            ConfigParam(
                id=uuid.uuid4(), node_id=svc.id, name="DATABASE_URL", required=True,
            ),
        ]
    )
    db.commit()
    исходные_id = {p.id for p in db.query(ConfigParam).all()}

    copy = create_project(
        ProjectCreate(name="Копия-конфиг", start=f"copy:{src.id}"), db=db, user=user
    )
    копия_сервиса = db.query(Node).filter(Node.project_id == copy.id).one()
    параметры = копия_сервиса.config_params
    assert [
        (p.name, p.value_type, p.required, p.default_value, p.description)
        for p in параметры
    ] == [
        ("DATABASE_URL", "", True, "", None),
        ("RETRY_TIMEOUT", "duration", False, "30s", "сколько ждать перед повтором"),
    ]
    # У копии свои id и своя история правок — исходник не тронут.
    assert not {p.id for p in параметры} & исходные_id
    assert all(p.version == 1 for p in параметры)
    assert db.query(ConfigParam).filter(ConfigParam.node_id == svc.id).count() == 2


def test_deep_copy_keeps_alt_branches(db):
    """Ветви [иначе] — часть фрагмента, а копируются они отдельными строками: без
    явного переноса копия молча теряла бы ветвления alt (тестов на это не было)."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-ветви"), db=db, user=user)
    proc = BusinessProcess(id=uuid.uuid4(), name="Оплата", project_id=src.id)
    db.add(proc)
    db.add(
        ProcessFragment(
            id=uuid.uuid4(), process_id=proc.id, kind="alt",
            from_order=0, to_order=2, guard="успех",
            branches=[
                ProcessFragmentBranch(start_order=1, guard="отказ"),
                ProcessFragmentBranch(start_order=2, guard="таймаут"),
            ],
        )
    )
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-ветви", start=f"copy:{src.id}"), db=db, user=user
    )

    copy_proc = db.query(BusinessProcess).filter(BusinessProcess.project_id == copy.id).one()
    frag = db.query(ProcessFragment).filter(ProcessFragment.process_id == copy_proc.id).one()
    assert [(b.start_order, b.guard) for b in frag.branches] == [(1, "отказ"), (2, "таймаут")]


def test_deep_copy_keeps_unbound_participant_and_dangling_step(db):
    """Непривязанный участник (node_id = NULL) и повисший шаг (edge_id = NULL) —
    законные состояния (импорт процесса, удалённый узел/связь). Копия обязана их
    сохранить: расхождение со схемой должно быть ВИДНО и в копии, а не исчезать.
    Концы шага при этом перевешиваются на участников КОПИИ."""
    user = ensure_architect(db)
    src = create_project(ProjectCreate(name="Источник-процесс"), db=db, user=user)
    svc = Node(id=uuid.uuid4(), name="Сервис", project_id=src.id)
    db.add(svc)
    proc = BusinessProcess(id=uuid.uuid4(), name="Оплата", project_id=src.id)
    db.add(proc)
    db.flush()
    bound = ProcessParticipant(id=uuid.uuid4(), process_id=proc.id, node_id=svc.id, name="Сервис", order=0)
    unbound = ProcessParticipant(
        id=uuid.uuid4(), process_id=proc.id, node_id=None, name="Внешний биллинг", order=1
    )
    db.add_all([bound, unbound])
    db.flush()
    db.add(
        ProcessMessage(
            id=uuid.uuid4(), process_id=proc.id, order=0, edge_id=None, leg="forward",
            from_participant_id=bound.id, to_participant_id=unbound.id, caption="списать",
        )
    )
    db.commit()

    copy = create_project(
        ProjectCreate(name="Копия-процесс", start=f"copy:{src.id}"), db=db, user=user
    )
    copy_proc = db.query(BusinessProcess).filter(BusinessProcess.project_id == copy.id).one()
    parts = sorted(
        db.query(ProcessParticipant).filter(ProcessParticipant.process_id == copy_proc.id).all(),
        key=lambda p: p.order,
    )
    assert [(p.name, p.node_id is None) for p in parts] == [("Сервис", False), ("Внешний биллинг", True)]
    msg = db.query(ProcessMessage).filter(ProcessMessage.process_id == copy_proc.id).one()
    assert msg.edge_id is None and msg.caption == "списать"
    # Концы ведут на участников копии, а не исходного процесса.
    assert (msg.from_participant_id, msg.to_participant_id) == (parts[0].id, parts[1].id)


def test_copy_unknown_source_404(db):
    user = ensure_architect(db)
    with pytest.raises(HTTPException) as ei:
        create_project(
            ProjectCreate(name="К", start=f"copy:{uuid.uuid4()}"), db=db, user=user
        )
    assert ei.value.status_code == 404


def test_archive_restore_flow(db):
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Архивируемый"), db=db, user=user)

    archive_project(p.id, db=db)
    assert [x.name for x in list_projects(archived=False, db=db)] == []
    assert [x.name for x in list_projects(archived=True, db=db)] == ["Архивируемый"]

    restore_project(p.id, db=db)
    assert [x.name for x in list_projects(archived=False, db=db)] == ["Архивируемый"]
    assert list_projects(archived=True, db=db) == []


def test_delete_requires_archive_and_exact_name(db):
    user = ensure_architect(db)
    p = create_project(ProjectCreate(name="Удаляемый"), db=db, user=user)
    _schema(db, p.id)

    # Активный — удалять нельзя.
    with pytest.raises(HTTPException) as ei:
        delete_project(p.id, confirm="Удаляемый", db=db)
    assert ei.value.status_code == 409

    archive_project(p.id, db=db)
    # Неверное подтверждение имени.
    with pytest.raises(HTTPException) as ei:
        delete_project(p.id, confirm="не то", db=db)
    assert ei.value.status_code == 400

    # Точное имя — сносит проект и его схему каскадом.
    delete_project(p.id, confirm="Удаляемый", db=db)
    assert get_project_or_none(db, p.id) is None
    assert db.query(Node).filter(Node.project_id == p.id).count() == 0


def get_project_or_none(db, pid):
    from app.models.project import Project

    return db.get(Project, pid)
