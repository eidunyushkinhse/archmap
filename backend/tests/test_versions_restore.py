"""Откат документации объекта к версии (app/versions_restore.py, Ф3 эпика doc-versions).

Главный сторож — фикспойнт (ТЗ §5 п.3 в редакции после Ф1): зафиксировать версию на
полном срезе, изменить ВСЁ (и размещение на площадках), откатить — проекция
versions_diff.restorable живого среза равна проекции снимка версии. Процессы и статус страницы откат не трогает, поэтому в
проекцию они не входят, а тест проверяет, что они остались как были.
"""

import types
import uuid

import pytest
from conftest import ensure_architect, make_project

from app import versions
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
from app.versions_diff import restorable, semantic_process
from app.versions_restore import restore_preview, restore_version

DOC = "flowchart TD\n  A[POST /orders] --> B{валидация}\n  B --> C[201]"
SPEC = "openapi: 3.0.0\npaths:\n  /orders:\n    post: {summary: Создать заказ}"


def _scene(db) -> types.SimpleNamespace:
    """«Магазин» (корень среза): «Заказы» (спецификация, две схемы, два параметра), «Оплаты»,
    «БД» с двумя таблицами и внешним ключом между ними, «Шина» с каналом. Снаружи —
    «Банк» (связан с «Заказами») и «Склад». Процесс «Оформление» через «Заказы» и
    «Оплаты». Площадки «Облако» → «prod», «stage» и «Стойка»: «Заказы» стоят в prod,
    «БД» — в стойке."""
    s = types.SimpleNamespace()
    s.user = ensure_architect(db)
    s.p = make_project(db, "Магазин")
    pid = s.p.id
    s.shop = Node(id=uuid.uuid4(), project_id=pid, name="Магазин")
    s.bank = Node(id=uuid.uuid4(), project_id=pid, name="Банк", is_external=True)
    s.store = Node(id=uuid.uuid4(), project_id=pid, name="Склад")
    db.add_all([s.shop, s.bank, s.store])
    db.flush()
    s.orders = Node(
        id=uuid.uuid4(), project_id=pid, name="Заказы", parent_id=s.shop.id,
        technology="Python 3.11", openapi_spec=SPEC,
    )
    s.pay = Node(id=uuid.uuid4(), project_id=pid, name="Оплаты", parent_id=s.shop.id)
    s.db_node = Node(
        id=uuid.uuid4(), project_id=pid, name="БД", parent_id=s.shop.id, shape="database"
    )
    s.bus = Node(id=uuid.uuid4(), project_id=pid, name="Шина", parent_id=s.shop.id, shape="broker")
    db.add_all([s.orders, s.pay, s.db_node, s.bus])
    db.flush()

    s.e_pay = Edge(project_id=pid, source_id=s.orders.id, target_id=s.pay.id, label="оплатить")
    s.e_bank = Edge(project_id=pid, source_id=s.bank.id, target_id=s.orders.id, label="статус")
    s.e_db = Edge(project_id=pid, source_id=s.orders.id, target_id=s.db_node.id, label="заказы")
    s.doc = NodeDoc(node_id=s.orders.id, name="Создать заказ", content=DOC)
    s.doc2 = NodeDoc(node_id=s.orders.id, name="Отменить заказ", content="flowchart TD\n  A --> B")
    s.ttl = ConfigParam(node_id=s.orders.id, name="ORDER_TTL_H", default_value="24")
    s.dsn = ConfigParam(node_id=s.orders.id, name="DB_DSN", required=True)
    s.t_orders = DbTable(node_id=s.db_node.id, name="orders", schema_name="public")
    s.t_users = DbTable(node_id=s.db_node.id, name="users", schema_name="public")
    s.channel = BrokerChannel(node_id=s.bus.id, name="orders.created")
    db.add_all([s.e_pay, s.e_bank, s.e_db, s.doc, s.doc2, s.ttl, s.dsn,
                s.t_orders, s.t_users, s.channel])
    db.flush()
    s.c_user_id = DbColumn(table_id=s.t_users.id, name="id", type="uuid", order=0)
    db.add(s.c_user_id)
    db.flush()
    s.c_id = DbColumn(table_id=s.t_orders.id, name="id", type="uuid", order=0)
    s.c_total = DbColumn(table_id=s.t_orders.id, name="total", type="int", order=1)
    s.c_user = DbColumn(table_id=s.t_orders.id, name="user_id", type="uuid", order=2,
                        references_column_id=s.c_user_id.id)
    s.f_id = ChannelField(channel_id=s.channel.id, name="order_id", type="uuid", order=0)
    s.f_total = ChannelField(channel_id=s.channel.id, name="total", type="int", order=1)
    db.add_all([s.c_id, s.c_total, s.c_user, s.f_id, s.f_total])

    s.proc = BusinessProcess(project_id=pid, name="Оформление")
    db.add(s.proc)
    db.flush()
    s.p_orders = ProcessParticipant(process_id=s.proc.id, node_id=s.orders.id, name="Заказы", order=0)
    s.p_pay = ProcessParticipant(process_id=s.proc.id, node_id=s.pay.id, name="Оплаты", order=1)
    db.add_all([s.p_orders, s.p_pay])
    db.flush()
    s.step = ProcessMessage(
        process_id=s.proc.id, order=0, edge_id=s.e_pay.id, leg="forward",
        from_participant_id=s.p_orders.id, to_participant_id=s.p_pay.id, caption="оплатить",
        doc_id=s.doc.id,
    )
    db.add(s.step)

    s.cloud = DeploymentSite(id=uuid.uuid4(), project_id=pid, name="Облако", kind="cloud")
    s.rack = DeploymentSite(id=uuid.uuid4(), project_id=pid, name="Стойка", kind="physical")
    db.add_all([s.cloud, s.rack])
    db.flush()
    s.prod = DeploymentSite(id=uuid.uuid4(), project_id=pid, name="prod", parent_id=s.cloud.id)
    s.stage = DeploymentSite(id=uuid.uuid4(), project_id=pid, name="stage", parent_id=s.cloud.id)
    db.add_all([s.prod, s.stage])
    db.flush()
    s.i_orders = _place(db, s.orders, s.prod)
    s.i_db = _place(db, s.db_node, s.rack)
    db.commit()
    # id строк сцены — отдельно: удалённую строку сессия отвязывает, и её id после
    # коммита уже не прочитать.
    s.id = {k: v.id for k, v in vars(s).items() if k not in ("user", "p") and hasattr(v, "id")}
    return s


def _place(db, node: Node, site: DeploymentSite) -> DeploymentInstance:
    inst = DeploymentInstance(
        id=uuid.uuid4(), project_id=node.project_id, node_id=node.id, site_id=site.id
    )
    db.add(inst)
    db.flush()
    return inst


def _placements(db, node_id: uuid.UUID) -> set[tuple[uuid.UUID, uuid.UUID]]:
    """Свои экземпляры объекта парами (id экземпляра, площадка)."""
    return {
        (i.id, i.site_id)
        for i in db.query(DeploymentInstance).filter(DeploymentInstance.node_id == node_id)
    }


def _fix(db, s, node: Node | None, comment: str = "v1") -> NodeVersion:
    row = versions.create_version(db, s.p, s.user, node, comment)
    db.commit()
    return row


def _restore(db, s, node: Node | None, number: int):
    row = versions.get_version(db, s.p, node, number)
    assert row is not None
    out = restore_version(db, s.p, s.user, node, row)
    db.commit()
    db.expire_all()
    return out


def _live(db, s, node: Node | None):
    db.expire_all()
    return versions.live_snapshot(db, s.p, node)


def _version_snap(db, s, node: Node | None, number: int):
    row = versions.get_version(db, s.p, node, number)
    assert row is not None
    return versions.snapshot_of(row)


def _process(db, s):
    """Процесс «Оформление» в семантической проекции — откат его трогать не должен."""
    db.expire_all()
    [proc] = [p for p in versions.live_snapshot(db, s.p, None).processes if p.id == s.proc.id]
    return semantic_process(proc)


def _change_everything(db, s) -> uuid.UUID:
    """Правки по всем семьям документации среза «Магазин»; возвращает id нового объекта."""
    pid = s.p.id
    # Свойства, спека, статус страницы.
    s.orders.name = "Заказы 2"
    s.orders.description = "Принимает заказы"
    s.orders.technology = "Python 3.12"
    s.orders.openapi_spec = SPEC.replace("Создать заказ", "Создать")
    s.orders.approval = "approved"
    # Новый объект с документацией и связью.
    search = Node(id=uuid.uuid4(), project_id=pid, name="Поиск", parent_id=s.shop.id)
    db.add(search)
    db.flush()
    db.add_all([
        NodeDoc(node_id=search.id, name="Найти", content="flowchart TD\n  A --> B"),
        ConfigParam(node_id=search.id, name="INDEX"),
        Edge(project_id=pid, source_id=search.id, target_id=s.orders.id, label="читает"),
    ])
    # Схемы: текст и имя, удалённая, новая с именем удалённой.
    s.doc.content = DOC.replace("валидация", "проверка") + "\n  C --> D[событие]"
    s.doc.name = "Создать заказ v2"
    db.delete(s.doc2)
    db.flush()
    db.add(NodeDoc(node_id=s.orders.id, name="Отменить заказ", content="другая"))
    # Параметры: удалён, изменён, добавлен.
    db.delete(s.ttl)
    s.dsn.required = False
    s.dsn.default_value = "postgres://"
    db.add(ConfigParam(node_id=s.orders.id, name="NEW_FLAG"))
    # Связи: наружу удалена, наружу добавлена, подпись изменена.
    db.delete(s.e_bank)
    db.add(Edge(project_id=pid, source_id=s.orders.id, target_id=s.bank.id, label="вебхук"))
    s.e_db.label = "пишет заказы"
    # Структура БД: таблица переименована, колонки переставлены, тип изменён, колонка
    # с внешним ключом удалена, новая добавлена; вторая таблица удалена целиком.
    s.t_orders.name = "orders_v2"
    s.c_id.order, s.c_total.order = 1, 0
    s.c_total.type = "numeric"
    db.delete(s.c_user)
    db.add(DbColumn(table_id=s.t_orders.id, name="status", type="text", order=3))
    db.flush()
    db.delete(s.t_users)
    # Канал: описание, поле удалено, поле добавлено.
    s.channel.description = "событие заказа"
    db.delete(s.f_total)
    db.add(ChannelField(channel_id=s.channel.id, name="amount", type="int", order=2))
    # Размещение: снято в prod, поставлено в stage, у нового объекта своё; площадка
    # переименована (это правка площадки, а не документации объекта).
    db.delete(s.i_orders)
    _place(db, s.orders, s.stage)
    _place(db, search, s.prod)
    s.prod.name = "prod-2"
    # Процесс — правится, но откатом не возвращается.
    s.step.caption = "провести оплату"
    # Ребёнок удалён — вместе со своими связями (каскад).
    db.delete(s.pay)
    db.commit()
    return search.id


# ── Фикспойнт ──────────────────────────────────────────────────────────────────


def test_фикспойнт_изменить_всё_и_откатить(db):
    s = _scene(db)
    _fix(db, s, s.shop)
    v1 = _version_snap(db, s, s.shop, 1)
    search_id = _change_everything(db, s)
    assert restorable(_live(db, s, s.shop)) != restorable(v1)
    process_before = _process(db, s)

    out = _restore(db, s, s.shop, 1)

    assert restorable(_live(db, s, s.shop)) == restorable(v1)
    assert out.created == [2, 3]
    assert out.deleted_nodes == 1
    assert out.remarks == []
    rows = {v.number: v for v in versions.list_versions(db, s.p, s.shop)}
    assert (rows[2].kind, rows[2].comment, rows[2].restored_from) == (
        "pre_restore", "Перед откатом к v1", None,
    )
    assert (rows[3].kind, rows[3].comment, rows[3].restored_from) == ("restore", "Откат к v1", 1)
    # «Перед откатом» хранит состояние до отката: к нему можно вернуться.
    assert restorable(versions.snapshot_of(rows[2])) != restorable(v1)
    # Воссозданное — с исходными id, новое удалено вместе с документацией.
    assert db.get(Node, s.id["pay"]) is not None
    assert db.get(Edge, s.id["e_pay"]) is not None and db.get(Edge, s.id["e_bank"]) is not None
    assert db.get(NodeDoc, s.id["doc2"]).name == "Отменить заказ"
    assert db.get(DbColumn, s.id["c_user"]).references_column_id == s.id["c_user_id"]
    assert db.get(Node, search_id) is None
    assert db.query(NodeDoc).filter(NodeDoc.node_id == search_id).count() == 0
    # Размещение — экземплярами снимка с исходными id; площадка — как есть сейчас.
    assert _placements(db, s.id["orders"]) == {(s.id["i_orders"], s.id["prod"])}
    assert db.query(DeploymentInstance).filter_by(node_id=search_id).count() == 0
    assert db.get(DeploymentSite, s.id["prod"]).name == "prod-2"
    # Процессы и статус страницы — как были перед откатом.
    assert _process(db, s) == process_before
    assert db.get(ProcessMessage, s.id["step"]).caption == "провести оплату"
    assert db.get(Node, s.id["orders"]).approval == "approved"


def test_откат_всего_проекта(db):
    s = _scene(db)
    _fix(db, s, None, "проект 1.0")
    v1 = _version_snap(db, s, None, 1)
    db.add(Node(id=uuid.uuid4(), project_id=s.p.id, name="Новая система"))
    db.delete(s.store)
    s.bank.name = "Банк-партнёр"
    db.commit()

    out = _restore(db, s, None, 1)

    assert restorable(_live(db, s, None)) == restorable(v1)
    assert out.deleted_nodes == 1
    assert out.created == [2, 3]
    assert db.get(Node, s.id["store"]) is not None


# ── Автоверсия «Перед откатом» ─────────────────────────────────────────────────


def test_без_незафиксированного_только_версия_отката(db):
    s = _scene(db)
    _fix(db, s, s.orders, "v1")
    s.orders.technology = "Go"
    db.commit()
    _fix(db, s, s.orders, "v2")

    out = _restore(db, s, s.orders, 1)

    assert out.created == [3]
    assert [v.kind for v in versions.list_versions(db, s.p, s.orders)] == [
        "restore", "manual", "manual",
    ]
    assert db.get(Node, s.id["orders"]).technology == "Python 3.11"


def test_нечего_восстанавливать(db):
    s = _scene(db)
    _fix(db, s, s.orders)
    # Статус страницы и процессы откат не трогает: разница только в них — «нечего».
    s.orders.approval = "approved"
    db.commit()
    row = versions.get_version(db, s.p, s.orders, 1)

    with pytest.raises(versions.VersionError) as exc:
        restore_version(db, s.p, s.user, s.orders, row)

    assert exc.value.detail == "Нечего восстанавливать: документация совпадает с v1"
    db.rollback()
    assert db.query(NodeVersion).count() == 1


# ── Связи и ссылки, которые вернуть нельзя ─────────────────────────────────────


def test_связь_к_удалённому_внешнему_объекту_пропущена(db):
    s = _scene(db)
    _fix(db, s, s.orders)
    db.delete(s.bank)  # вне среза «Заказов»; связь «Банк → Заказы» ушла каскадом
    s.orders.technology = "Go"
    db.commit()

    out = _restore(db, s, s.orders, 1)

    assert out.remarks == ["связь «Банк → Магазин / Заказы» не восстановлена: объекта «Банк» больше нет"]
    assert db.get(Node, s.id["orders"]).technology == "Python 3.11"
    assert db.get(Edge, s.id["e_bank"]) is None
    assert db.get(Edge, s.id["e_pay"]) is not None


def test_внешний_ключ_на_воссозданную_таблицу(db):
    s = _scene(db)
    _fix(db, s, s.db_node)  # срез «БД»: обе таблицы внутри
    db.delete(s.t_users)  # ключ «orders.user_id» погас (SET NULL)
    s.c_total.type = "numeric"
    db.commit()

    out = _restore(db, s, s.db_node, 1)

    # Таблица снимка воссоздана с исходными id — ключ снова ведёт на её колонку.
    assert out.remarks == []
    assert db.get(DbColumn, s.id["c_user"]).references_column_id == s.id["c_user_id"]
    assert db.get(DbColumn, s.id["c_total"]).type == "int"


def test_внешний_ключ_на_исчезнувшую_колонку_вне_среза_погашен(db):
    s = _scene(db)
    ledger = Node(id=uuid.uuid4(), project_id=s.p.id, name="Учёт", shape="database")
    db.add(ledger)
    db.flush()
    accounts = DbTable(node_id=ledger.id, name="accounts")
    db.add(accounts)
    db.flush()
    acc_id = DbColumn(table_id=accounts.id, name="id", type="uuid")
    db.add(acc_id)
    db.flush()
    s.c_total.references_column_id = acc_id.id
    db.commit()
    _fix(db, s, s.db_node)
    db.delete(ledger)  # вне среза «БД»: цели ключа больше нет
    s.t_orders.description = "заказы"
    db.commit()

    out = _restore(db, s, s.db_node, 1)

    assert out.remarks == ["внешний ключ «orders.total» не восстановлен: целевой колонки больше нет"]
    assert db.get(DbColumn, s.id["c_total"]).references_column_id is None
    assert db.get(DbTable, s.id["t_orders"]).description is None


# ── Размещение ─────────────────────────────────────────────────────────────────


def test_снятое_размещение_возвращается_добавленное_снимается(db):
    s = _scene(db)
    _fix(db, s, s.orders)
    v1 = _version_snap(db, s, s.orders, 1)
    db.delete(s.i_orders)
    late = _place(db, s.orders, s.stage)
    db.commit()

    out = _restore(db, s, s.orders, 1)

    assert out.remarks == []
    assert _placements(db, s.id["orders"]) == {(s.id["i_orders"], s.id["prod"])}
    assert db.get(DeploymentInstance, late.id) is None
    assert restorable(_live(db, s, s.orders)) == restorable(v1)


def test_размещение_поставленное_заново_на_ту_же_площадку(db):
    """Сняли и снова поставили в prod: пара «объект, площадка» та же, id другой. Шаг 1
    отката удаляет новую строку (её id не в снимке) раньше воссоздания исходной — без
    отказа на уникальности пары."""
    s = _scene(db)
    _fix(db, s, s.orders)
    v1 = _version_snap(db, s, s.orders, 1)
    db.delete(s.i_orders)
    db.flush()
    again = _place(db, s.orders, s.prod)
    db.commit()
    assert restorable(_live(db, s, s.orders)) != restorable(v1)

    out = _restore(db, s, s.orders, 1)

    assert out.remarks == []
    assert _placements(db, s.id["orders"]) == {(s.id["i_orders"], s.id["prod"])}
    assert db.get(DeploymentInstance, again.id) is None
    assert restorable(_live(db, s, s.orders)) == restorable(v1)


def test_площадки_больше_нет_размещение_пропущено_с_замечанием(db):
    """Площадка в версию не входит: удалённую откат не вернёт. Остальное возвращается,
    а проекции расходятся ровно на пропущенный экземпляр."""
    s = _scene(db)
    _fix(db, s, s.shop)
    v1 = _version_snap(db, s, s.shop, 1)
    db.delete(s.prod)  # каскад унёс экземпляр «Заказов»
    s.orders.technology = "Go"
    db.commit()

    out = _restore(db, s, s.shop, 1)

    assert out.remarks == [
        "размещение «Магазин / Заказы» на площадке «Облако / prod» не восстановлено: "
        "площадки больше нет"
    ]
    assert db.get(Node, s.id["orders"]).technology == "Python 3.11"
    assert _placements(db, s.id["db_node"]) == {(s.id["i_db"], s.id["rack"])}
    expected = restorable(v1)
    expected["instances"] = [i for i in expected["instances"] if i["id"] != str(s.id["i_orders"])]
    assert restorable(_live(db, s, s.shop)) == expected


# ── Перенос и имена ────────────────────────────────────────────────────────────


def test_корень_возвращается_к_прежнему_родителю(db):
    s = _scene(db)
    _fix(db, s, s.orders)
    s.orders.parent_id = s.store.id
    db.commit()

    out = _restore(db, s, s.orders, 1)

    assert out.remarks == []
    assert db.get(Node, s.id["orders"]).parent_id == s.id["shop"]


def test_прежнего_родителя_нет_объект_остаётся(db):
    s = _scene(db)
    _fix(db, s, s.orders)
    s.orders.parent_id = s.store.id
    s.orders.technology = "Go"
    db.commit()
    db.delete(s.shop)  # уносит и братьев «Заказов» — откату среза «Заказов» не мешает
    db.commit()

    out = _restore(db, s, s.orders, 1)

    # Вместе с «Магазином» ушли «Оплаты» и «БД» — связей к ним тоже не вернуть (связи
    # в замечаниях — в порядке снимка, по id).
    *edges, parent = out.remarks
    assert sorted(edges) == [
        "связь «Магазин / Заказы → Магазин / БД» не восстановлена: объекта «Магазин / БД» больше нет",
        "связь «Магазин / Заказы → Магазин / Оплаты» не восстановлена: объекта «Магазин / Оплаты» больше нет",
    ]
    assert parent == "объект остаётся у текущего родителя: прежнего больше нет"
    node = db.get(Node, s.id["orders"])
    assert (node.parent_id, node.technology) == (s.id["store"], "Python 3.11")


def test_унесённый_из_среза_объект_возвращается_без_новых_детей(db):
    s = _scene(db)
    _fix(db, s, s.shop)
    v1 = _version_snap(db, s, s.shop, 1)
    s.pay.parent_id = s.store.id
    db.flush()
    late = Node(id=uuid.uuid4(), project_id=s.p.id, name="Возвраты", parent_id=s.pay.id)
    db.add(late)
    db.commit()

    preview = restore_preview(db, s.p, s.shop, versions.get_version(db, s.p, s.shop, 1))
    out = _restore(db, s, s.shop, 1)

    assert preview.deleted_nodes == out.deleted_nodes == 1
    assert db.get(Node, s.id["pay"]).parent_id == s.id["shop"]
    assert db.get(Node, late.id) is None
    assert restorable(_live(db, s, s.shop)) == restorable(v1)


def test_схема_унесённая_к_новому_объекту_возвращается_к_владельцу(db):
    """Каскад удаления нового объекта не должен унести схему, которую откат только что
    вернул прежнему владельцу (коллекция схем в сессии помнит состав до отката)."""
    s = _scene(db)
    _fix(db, s, s.shop)
    late = Node(id=uuid.uuid4(), project_id=s.p.id, name="Новый", parent_id=s.shop.id)
    db.add(late)
    db.flush()
    db.refresh(late)
    s.doc.node_id = late.id
    db.commit()
    db.refresh(late)
    assert [d.id for d in late.docs] == [s.id["doc"]]

    _restore(db, s, s.shop, 1)

    doc = db.get(NodeDoc, s.id["doc"])
    assert doc is not None and (doc.node_id, doc.content) == (s.id["orders"], DOC)
    assert db.get(Node, late.id) is None
    # Привязка шага процесса к схеме пережила откат.
    assert db.get(ProcessMessage, s.id["step"]).doc_id == s.id["doc"]


def test_обмен_именами_схем_и_параметров(db):
    """Уникальный индекс (объект, имя): обмен именами двух схем и двух параметров
    проходит через временные имена, а не падает 500-й."""
    s = _scene(db)
    _fix(db, s, s.orders)
    # Сама сцена меняется через третье имя по шагу на flush — иначе упала бы на том
    # же индексе, от которого бережёт откат.
    for a, b in ((s.doc, s.doc2), (s.ttl, s.dsn)):
        a_name, b_name = a.name, b.name
        a.name = "tmp"
        db.flush()
        b.name = a_name
        db.flush()
        a.name = b_name
        db.flush()
    db.commit()

    _restore(db, s, s.orders, 1)

    assert db.get(NodeDoc, s.id["doc"]).name == "Создать заказ"
    assert db.get(NodeDoc, s.id["doc2"]).name == "Отменить заказ"
    assert (db.get(ConfigParam, s.id["ttl"]).name, db.get(ConfigParam, s.id["dsn"]).name) == (
        "ORDER_TTL_H", "DB_DSN",
    )


def test_тёзка_брата_снаружи_не_мешает(db):
    """Имена объектов не уникальны (братья-тёзки допустимы), а ключи имён схем и фактов
    — внутри объекта-владельца из среза: тёзка вне среза откату не мешает."""
    s = _scene(db)
    _fix(db, s, s.orders)
    s.orders.name = "Заказы 2"
    s.pay.name = "Заказы"  # брат занял прежнее имя
    db.commit()

    out = _restore(db, s, s.orders, 1)

    assert out.remarks == []
    assert db.get(Node, s.id["orders"]).name == db.get(Node, s.id["pay"]).name == "Заказы"


# ── Превью ─────────────────────────────────────────────────────────────────────


def test_превью_отката(db):
    s = _scene(db)
    _fix(db, s, s.shop)
    v1 = versions.get_version(db, s.p, s.shop, 1)

    preview = restore_preview(db, s.p, s.shop, v1)
    assert (preview.pending, preview.deleted_nodes, preview.has_processes) == (False, 0, True)

    db.add_all([
        Node(id=uuid.uuid4(), project_id=s.p.id, name="Поиск", parent_id=s.shop.id),
        Node(id=uuid.uuid4(), project_id=s.p.id, name="Каталог", parent_id=s.shop.id),
    ])
    db.commit()
    preview = restore_preview(db, s.p, s.shop, v1)
    assert (preview.pending, preview.deleted_nodes) == (True, 2)

    # У «Склада» процессов нет ни в версии, ни сейчас.
    _fix(db, s, s.store)
    store_v1 = versions.get_version(db, s.p, s.store, 1)
    assert restore_preview(db, s.p, s.store, store_v1).has_processes is False
