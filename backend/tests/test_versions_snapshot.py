"""Снимок версии документации объекта (app/versions_snapshot.py, Ф0 эпика doc-versions).

Сторожа: полнота реестров (новая модель обязана быть классифицирована), детерминизм
(одно состояние — одни байты и один хэш), скоуп среза (лист, контейнер, корень) и
семантичность хэша (производное для показа хэш не двигает, правка документации —
двигает).
"""

import hashlib
import importlib
import json
import pkgutil
import types
import typing
import uuid
import zlib

import pytest
from conftest import make_project

import app.models
from app.database import Base
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.channel_field import ChannelField
from app.models.config_param import ConfigParam
from app.models.db_column import DbColumn
from app.models.db_table import DbTable
from app.models.deployment_instance import DeploymentInstance
from app.models.deployment_site import DeploymentSite
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.node_version import NodeVersion
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.process_export import detail_to_mermaid
from app.restore import SNAPSHOT_PLAN
from app.schemas.versions import VersionSnapshot
from app.versions import pending
from app.versions_diff import semantic
from app.versions_snapshot import (
    NOT_IN_VERSION,
    SNAPSHOT_FORMAT,
    VERSION_PLAN,
    build_snapshot,
    canonical_json,
    content_hash,
    decode,
    encode,
    stats,
)

# --- Сторожа реестров ----------------------------------------------------------


def _all_mapped_models() -> set[type]:
    """Все модели проекта. Пакет обходим ФАЙЛАМИ (как в test_copy_plan): новая модель
    приезжает отдельным модулем, и сторож обязан увидеть её сам."""
    for module in pkgutil.iter_modules(app.models.__path__):
        importlib.import_module(f"app.models.{module.name}")
    return {mapper.class_ for mapper in Base.registry.mappers}


def test_каждая_модель_в_версии_или_объявлена_с_причиной():
    """Новая модель проекта обязана попасть либо в VERSION_PLAN (снимок версии несёт её
    строки), либо в NOT_IN_VERSION с причиной. Иначе новая семья фактов (или
    размещение) молча не попала бы в историю — и откат вернул бы объект без неё."""
    models = _all_mapped_models()
    unclassified = models - set(VERSION_PLAN) - set(NOT_IN_VERSION)
    assert not unclassified, (
        "Модели не объявлены в app/versions_snapshot.py: "
        f"{sorted(m.__name__ for m in unclassified)}. Решите: несёт их снимок версии "
        "(VERSION_PLAN + поле VersionSnapshot) или намеренно нет (NOT_IN_VERSION, с причиной)."
    )
    assert not set(VERSION_PLAN) & set(NOT_IN_VERSION)
    for model, reason in NOT_IN_VERSION.items():
        assert reason.strip(), f"{model.__name__}: не входит в версию без объяснения причины"


def test_схемы_версии_те_же_что_у_снимка_удаления():
    """Параллельных схем нет: полноту полей сторожит test_restore по copy_plan, и это
    покрывает версию, только пока схемы одни и те же."""
    for model, schema in VERSION_PLAN.items():
        assert model in SNAPSHOT_PLAN, f"{model.__name__}: в версии есть, в снимке удаления нет"
        assert SNAPSHOT_PLAN[model] is schema, model.__name__


def test_площадка_вне_версии_а_размещение_на_ней_в_версии():
    """Экземпляр — документация объекта («где он крутится»), площадка — общая сущность
    проекта, как процесс: её правка и удаление версией объекта не откатываются."""
    assert DeploymentInstance in VERSION_PLAN
    assert DeploymentSite not in VERSION_PLAN
    assert "общая сущность проекта" in NOT_IN_VERSION[DeploymentSite]


def _list_item_types() -> list[type]:
    """Типы элементов списков VersionSnapshot."""
    out: list[type] = []
    for field in VersionSnapshot.model_fields.values():
        if typing.get_origin(field.annotation) is list:
            out.extend(typing.get_args(field.annotation))
    return out


def test_снимок_версии_несёт_список_каждой_модели_плана():
    """Модель в VERSION_PLAN без поля в VersionSnapshot — объявлена, но не снимается."""
    items = _list_item_types()
    for model, schema in VERSION_PLAN.items():
        assert any(isinstance(t, type) and issubclass(t, schema) for t in items), (
            f"{model.__name__}: в VERSION_PLAN есть, а списка {schema.__name__} в "
            "VersionSnapshot нет"
        )


# --- Сцена ---------------------------------------------------------------------


def _scene(db, project) -> types.SimpleNamespace:
    """Система (контейнер) с сервисами «Заказы» и «Платежи», базой и брокером;
    внешний узел «Банк» вне системы, связанный с «Заказами»; корень «Склад» без
    связей. Процессы: «Оформление» (Заказы ↔ Платежи), «Сверка» (Платежи ↔ БД, без
    Заказов), «Черновик» (без участников)."""
    pid = project.id
    s = types.SimpleNamespace()
    s.system = Node(id=uuid.uuid4(), project_id=pid, name="Система")
    s.bank = Node(id=uuid.uuid4(), project_id=pid, name="Банк", is_external=True)
    s.store = Node(id=uuid.uuid4(), project_id=pid, name="Склад")
    db.add_all([s.system, s.bank, s.store])
    db.flush()
    s.orders = Node(id=uuid.uuid4(), project_id=pid, name="Заказы", parent_id=s.system.id)
    s.payments = Node(id=uuid.uuid4(), project_id=pid, name="Платежи", parent_id=s.system.id)
    s.db_node = Node(
        id=uuid.uuid4(), project_id=pid, name="БД", parent_id=s.system.id, shape="database"
    )
    s.bus = Node(id=uuid.uuid4(), project_id=pid, name="Шина", parent_id=s.system.id, shape="broker")
    db.add_all([s.orders, s.payments, s.db_node, s.bus])
    db.flush()

    s.e_orders_payments = Edge(
        project_id=pid, source_id=s.orders.id, target_id=s.payments.id, label="оплатить"
    )
    s.e_bank_orders = Edge(project_id=pid, source_id=s.bank.id, target_id=s.orders.id, label="статус")
    s.e_payments_db = Edge(project_id=pid, source_id=s.payments.id, target_id=s.db_node.id)
    db.add_all([s.e_orders_payments, s.e_bank_orders, s.e_payments_db])

    s.doc = NodeDoc(node_id=s.orders.id, name="POST /orders", content="flowchart TD\n  A --> B")
    s.payments_doc = NodeDoc(node_id=s.payments.id, name="POST /pay", content="flowchart TD\n  P")
    s.param = ConfigParam(node_id=s.orders.id, name="ORDERS_LIMIT", default_value="10")
    s.table = DbTable(node_id=s.db_node.id, name="orders")
    db.add_all([s.doc, s.payments_doc, s.param, s.table])
    s.channel = BrokerChannel(node_id=s.bus.id, name="orders.created")
    db.flush()
    db.add(s.channel)
    db.add(DbColumn(table_id=s.table.id, name="id", is_primary_key=True))
    db.flush()
    db.add(ChannelField(channel_id=s.channel.id, name="order_id"))

    s.checkout = BusinessProcess(project_id=pid, name="Оформление")
    s.reconcile = BusinessProcess(project_id=pid, name="Сверка")
    s.draft = BusinessProcess(project_id=pid, name="Черновик")
    db.add_all([s.checkout, s.reconcile, s.draft])
    db.flush()
    p_orders = ProcessParticipant(process_id=s.checkout.id, node_id=s.orders.id, name="Заказы", order=0)
    p_pay = ProcessParticipant(process_id=s.checkout.id, node_id=s.payments.id, name="Платежи", order=1)
    r_pay = ProcessParticipant(process_id=s.reconcile.id, node_id=s.payments.id, name="Платежи", order=0)
    r_db = ProcessParticipant(process_id=s.reconcile.id, node_id=s.db_node.id, name="БД", order=1)
    db.add_all([p_orders, p_pay, r_pay, r_db])
    db.flush()
    s.step = ProcessMessage(
        process_id=s.checkout.id, order=0, edge_id=s.e_orders_payments.id, leg="forward",
        from_participant_id=p_orders.id, to_participant_id=p_pay.id, caption="оплатить",
        doc_id=s.doc.id,
    )
    db.add_all([
        s.step,
        ProcessMessage(
            process_id=s.reconcile.id, order=0, edge_id=s.e_payments_db.id, leg="forward",
            from_participant_id=r_pay.id, to_participant_id=r_db.id, caption="записать",
        ),
    ])
    db.commit()
    return s


# --- Детерминизм и кодек -------------------------------------------------------


def test_одно_состояние_одни_байты_и_один_хэш(db, project):
    s = _scene(db, project)
    a = build_snapshot(db, project.id, s.system.id)
    db.expire_all()  # второй снимок — с чистой сессией, как в другом запросе
    b = build_snapshot(db, project.id, s.system.id)

    assert encode(a) == encode(b)
    assert canonical_json(a) == canonical_json(b)
    assert content_hash(a) == content_hash(b)
    assert len(content_hash(a)) == 64


def test_декодирование_возвращает_тот_же_снимок(db, project):
    _scene(db, project)
    snap = build_snapshot(db, project.id, None)

    back = decode(encode(snap), SNAPSHOT_FORMAT)

    assert back == snap
    assert canonical_json(back) == canonical_json(snap)


def test_неизвестный_формат_снимка_отказ(db, project):
    s = _scene(db, project)
    data = encode(build_snapshot(db, project.id, s.orders.id))

    with pytest.raises(ValueError, match="формат"):
        decode(data, SNAPSHOT_FORMAT + 1)


def test_строка_версии_хранит_снимок_и_читается_обратно(db, project):
    """Колонки bytea/JSON переживают запись: снимок из строки — тот же самый."""
    s = _scene(db, project)
    snap = build_snapshot(db, project.id, s.orders.id)
    db.add(NodeVersion(
        project_id=project.id, node_id=s.orders.id, number=1, comment="v1.0",
        snapshot=encode(snap), content_hash=content_hash(snap), stats=stats(snap),
    ))
    db.commit()
    db.expire_all()

    row = db.query(NodeVersion).one()
    assert (row.kind, row.snapshot_format, row.restored_from) == ("manual", SNAPSHOT_FORMAT, None)
    assert decode(row.snapshot, row.snapshot_format) == snap
    assert row.stats == stats(snap)


# --- Скоуп среза ---------------------------------------------------------------


def test_лист_только_он_его_связи_и_документация(db, project):
    s = _scene(db, project)
    snap = build_snapshot(db, project.id, s.orders.id)

    assert [n.id for n in snap.nodes] == [s.orders.id]
    assert snap.root_id == s.orders.id
    # Связи с концом в листе — и внутрь системы, и наружу; связь Платежи → БД не его.
    edges = {e.id: e for e in snap.edges}
    assert set(edges) == {s.e_orders_payments.id, s.e_bank_orders.id}
    out = edges[s.e_orders_payments.id]
    assert (out.source_path, out.target_path) == ("Система / Заказы", "Система / Платежи")
    inbound = edges[s.e_bank_orders.id]
    assert (inbound.source_path, inbound.target_path) == ("Банк", "Система / Заказы")
    # Документация — только своя, текст схемы на месте (он отложен в модели).
    assert [d.id for d in snap.node_docs] == [s.doc.id]
    assert snap.node_docs[0].content == "flowchart TD\n  A --> B"
    assert [p.name for p in snap.config_params] == ["ORDERS_LIMIT"]
    assert snap.db_tables == [] and snap.broker_channels == []
    # Процесс с участием листа — да, «Сверка» без него — нет, «Черновик» — нет.
    assert [p.id for p in snap.processes] == [s.checkout.id]
    proc = snap.processes[0]
    assert proc.mermaid == detail_to_mermaid(proc.detail)
    assert "оплатить" in proc.mermaid
    assert proc.detail.messages[0].doc_id == s.doc.id


def test_контейнер_с_детьми_и_их_документацией(db, project):
    s = _scene(db, project)
    snap = build_snapshot(db, project.id, s.system.id)

    assert {n.id for n in snap.nodes} == {
        s.system.id, s.orders.id, s.payments.id, s.db_node.id, s.bus.id,
    }
    assert {e.id for e in snap.edges} == {
        s.e_orders_payments.id, s.e_bank_orders.id, s.e_payments_db.id,
    }
    assert {d.id for d in snap.node_docs} == {s.doc.id, s.payments_doc.id}
    assert [t.name for t in snap.db_tables] == ["orders"]
    assert [c.name for c in snap.db_columns] == ["id"]
    assert [c.name for c in snap.broker_channels] == ["orders.created"]
    assert [f.name for f in snap.channel_fields] == ["order_id"]
    assert {p.id for p in snap.processes} == {s.checkout.id, s.reconcile.id}
    assert stats(snap) == {
        "nodes": 5, "edges": 3, "docs": 2, "tables": 1, "channels": 1, "params": 1,
        "processes": 2,
    }


def test_корень_все_узлы_и_все_процессы_проекта(db, project):
    s = _scene(db, project)
    snap = build_snapshot(db, project.id, None)

    assert snap.root_id is None
    assert len(snap.nodes) == 7  # и Банк, и Склад без связей
    assert len(snap.edges) == 3
    # «Черновик» без участников входит только в срез корня.
    assert {p.id for p in snap.processes} == {s.checkout.id, s.reconcile.id, s.draft.id}
    # Списки — в порядке str(id): порядок выдачи БД на снимок не влияет.
    for rows in (snap.nodes, snap.edges, snap.node_docs, snap.processes):
        assert [str(r.id) for r in rows] == sorted(str(r.id) for r in rows)


def test_чужой_объект_отказ_а_не_чужая_документация(db, project):
    """Узел другого проекта: выборка документации по его id унесла бы чужие данные."""
    s = _scene(db, project)
    other = make_project(db, "Другой")
    db.commit()

    with pytest.raises(ValueError):
        build_snapshot(db, other.id, s.orders.id)


# --- Хэш семантический ---------------------------------------------------------


def test_переименование_чужого_узла_хэш_листа_не_меняет(db, project):
    s = _scene(db, project)
    before = build_snapshot(db, project.id, s.orders.id)

    s.bank.name = "Банк-партнёр"
    db.commit()
    after = build_snapshot(db, project.id, s.orders.id)

    assert content_hash(after) == content_hash(before)
    # А путь для показа — свежий: дельте есть чем подписать конец связи.
    inbound = next(e for e in after.edges if e.id == s.e_bank_orders.id)
    assert inbound.source_path == "Банк-партнёр"
    assert canonical_json(after) != canonical_json(before)


def test_правка_описания_листа_меняет_хэш(db, project):
    s = _scene(db, project)
    before = content_hash(build_snapshot(db, project.id, s.orders.id))

    s.orders.description = "Принимает заказы"
    db.commit()

    assert content_hash(build_snapshot(db, project.id, s.orders.id)) != before


def test_правка_текста_схемы_логики_меняет_хэш(db, project):
    s = _scene(db, project)
    before = content_hash(build_snapshot(db, project.id, s.orders.id))

    s.doc.content = "flowchart TD\n  A --> C"
    db.commit()

    assert content_hash(build_snapshot(db, project.id, s.orders.id)) != before


def test_правка_шага_процесса_с_участием_листа_меняет_хэш(db, project):
    s = _scene(db, project)
    before = content_hash(build_snapshot(db, project.id, s.orders.id))

    s.step.caption = "оплатить заказ"
    s.step.version += 1
    db.commit()

    assert content_hash(build_snapshot(db, project.id, s.orders.id)) != before


def test_переименование_участника_вне_листа_хэш_не_меняет(db, project):
    """Процесс общий: «Платежи» — его участник, но вне среза листа «Заказы». Живое имя
    участника в detail меняется, а хэш листа — нет: имя привязанного живёт в узле."""
    s = _scene(db, project)
    before = build_snapshot(db, project.id, s.orders.id)

    s.payments.name = "Оплаты"
    db.commit()
    after = build_snapshot(db, project.id, s.orders.id)

    assert {p.name for p in after.processes[0].detail.participants} == {"Заказы", "Оплаты"}
    assert content_hash(after) == content_hash(before)


def test_перепривязка_участника_меняет_хэш(db, project):
    s = _scene(db, project)
    before = content_hash(build_snapshot(db, project.id, s.orders.id))

    part = (
        db.query(ProcessParticipant)
        .filter_by(process_id=s.checkout.id, node_id=s.payments.id)
        .one()
    )
    part.node_id = s.db_node.id
    db.commit()

    assert content_hash(build_snapshot(db, project.id, s.orders.id)) != before


def test_счётчик_CAS_шага_в_хэш_не_входит(db, project):
    """Подпись поправили и вернули: текст тот же, счётчик CAS вырос на два. Это не
    изменение документации — иначе «есть изменения» горело бы без изменений."""
    s = _scene(db, project)
    before = build_snapshot(db, project.id, s.orders.id)

    s.step.caption = "оплатить заказ"
    s.step.version += 1
    db.commit()
    s.step.caption = "оплатить"
    s.step.version += 1
    db.commit()
    after = build_snapshot(db, project.id, s.orders.id)

    assert after.processes[0].detail.messages[0].version == 3
    assert content_hash(after) == content_hash(before)


# --- Размещение ----------------------------------------------------------------


def _site(db, project, name, parent=None) -> DeploymentSite:
    site = DeploymentSite(
        id=uuid.uuid4(), project_id=project.id, name=name,
        parent_id=None if parent is None else parent.id,
    )
    db.add(site)
    db.flush()
    return site


def _place(db, node, site) -> DeploymentInstance:
    inst = DeploymentInstance(
        id=uuid.uuid4(), project_id=node.project_id, node_id=node.id, site_id=site.id
    )
    db.add(inst)
    db.flush()
    return inst


def _placed(db, project) -> types.SimpleNamespace:
    """Сцена с площадками «Облако» → «Кластер prod» и «Стойка»: «Система» стоит в
    кластере (её дети наследуют), у «Заказов» своё размещение в кластере и в стойке."""
    s = _scene(db, project)
    s.cloud = _site(db, project, "Облако")
    s.prod = _site(db, project, "Кластер prod", s.cloud)
    s.rack = _site(db, project, "Стойка")
    s.i_system = _place(db, s.system, s.prod)
    s.i_orders_prod = _place(db, s.orders, s.prod)
    s.i_orders_rack = _place(db, s.orders, s.rack)
    db.commit()
    return s


def test_снимок_несёт_свои_экземпляры_с_путём_площадки(db, project):
    s = _placed(db, project)

    snap = build_snapshot(db, project.id, s.system.id)

    # Свои экземпляры узлов среза — по id; унаследованных (Платежи от Системы) нет.
    assert [(i.id, i.node_id, i.site_id, i.site_path) for i in snap.instances] == sorted(
        [
            (s.i_system.id, s.system.id, s.prod.id, "Облако / Кластер prod"),
            (s.i_orders_prod.id, s.orders.id, s.prod.id, "Облако / Кластер prod"),
            (s.i_orders_rack.id, s.orders.id, s.rack.id, "Стойка"),
        ],
        key=lambda row: str(row[0]),
    )
    leaf = build_snapshot(db, project.id, s.payments.id)
    assert leaf.instances == []
    # Кодек переносит размещение как есть.
    assert decode(encode(snap), SNAPSHOT_FORMAT) == snap


def test_цикл_площадок_в_данных_не_вешает_снимок(db, project):
    s = _placed(db, project)
    s.cloud.parent_id = s.prod.id  # испорченные данные: Облако ↔ Кластер prod
    db.commit()

    snap = build_snapshot(db, project.id, s.orders.id)

    assert {i.site_path for i in snap.instances} == {"Облако / Кластер prod", "Стойка"}


def test_путь_площадки_вне_хэша_а_размещение_в_нём(db, project):
    """Переименование и перенос площадки — не правка документации объекта: путь
    свежий для показа, хэш тот же. Снятое размещение хэш меняет."""
    s = _placed(db, project)
    before = build_snapshot(db, project.id, s.orders.id)

    s.prod.name = "Кластер prod-2"
    s.prod.parent_id = None
    db.commit()
    renamed = build_snapshot(db, project.id, s.orders.id)

    assert content_hash(renamed) == content_hash(before)
    assert canonical_json(renamed) != canonical_json(before)
    assert "Кластер prod-2" in {i.site_path for i in renamed.instances}

    db.delete(s.i_orders_rack)
    db.commit()
    assert content_hash(build_snapshot(db, project.id, s.orders.id)) != content_hash(before)


def _old_format(snap: VersionSnapshot) -> tuple[bytes, str]:
    """Байты и хэш снимка так, как их записала бы версия до размещения в снимке: в JSON
    и в семантической проекции нет ключа instances."""
    data = json.loads(canonical_json(snap))
    del data["instances"]
    sem = semantic(snap)
    del sem["instances"]

    def dumps(obj) -> str:
        return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    raw = zlib.compress(dumps(data).encode("utf-8"))
    return raw, hashlib.sha256(dumps(sem).encode("utf-8")).hexdigest()


def test_старый_снимок_без_размещения_читается_и_не_даёт_ложных_изменений(db, project):
    """Версии, снятые до размещения в снимке: формат тот же (поле с дефолтом), хэш в
    колонке посчитан без ключа и с живым расходится, но pending сверяет перечень по
    дельте — «изменений нет»."""
    s = _scene(db, project)
    raw, old_hash = _old_format(build_snapshot(db, project.id, s.orders.id))
    assert old_hash != content_hash(build_snapshot(db, project.id, s.orders.id))
    db.add(NodeVersion(
        project_id=project.id, node_id=s.orders.id, number=1, comment="до размещения",
        snapshot=raw, content_hash=old_hash, stats={},
    ))
    db.commit()

    row = db.query(NodeVersion).one()
    assert decode(row.snapshot, row.snapshot_format).instances == []
    assert pending(db, project, s.orders).model_dump() == {"changed": False, "items": []}

    # А настоящая правка размещения после такой версии видна — элементом «размещение».
    _place(db, s.orders, _site(db, project, "Облако"))
    db.commit()
    after = pending(db, project, s.orders)
    assert after.changed is True
    assert [(i.item_id, i.category, i.status) for i in after.items] == [
        (f"placement:{s.orders.id}", "placement", "added"),
    ]
