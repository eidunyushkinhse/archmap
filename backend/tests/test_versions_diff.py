"""Дельта версий документации (app/versions_diff.py, Ф1 эпика doc-versions).

Снимки собираются настоящим build_snapshot со сцены в БД, между снимками сцена
правится как правит её интерфейс. Сторожа: каждая категория на added/removed/changed,
переименования, перестановка шагов, три представления, пустая база, адрес элемента,
детерминированный порядок и главное — «хэш разный ⇔ элементы есть».
"""

import types
import uuid

from conftest import ensure_architect, make_project

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
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.schemas.versions import VersionView
from app.versions import create_version, list_versions
from app.versions_diff import diff_item, diff_items, empty_snapshot, semantic
from app.versions_snapshot import build_snapshot, content_hash

DOC_V1 = "flowchart TD\n  A[POST /orders] --> B{валидация}\n  B --> C[проверить остаток]\n  C --> D[201]"
DOC_V2 = (
    "flowchart TD\n  A[POST /orders] --> B{валидация}\n  B --> C[зарезервировать остаток]\n"
    "  C --> D[201]\n  D --> E[публикует: orders.created]"
)
SPEC = "openapi: 3.0.0\npaths:\n  /orders:\n    post: {summary: Создать заказ}"


def _scene(db) -> types.SimpleNamespace:
    """«Магазин» (корень среза) с «Заказами» (сервис со спецификацией, схемой и конфигурацией),
    «Оплатами», базой и брокером; «Банк» снаружи. Процесс «Оформление»: непривязанный
    «Покупатель», Заказы и Оплаты, три шага."""
    project = make_project(db, "Магазин")
    pid = project.id
    s = types.SimpleNamespace(project=project)
    s.shop = Node(id=uuid.uuid4(), project_id=pid, name="Магазин")
    s.bank = Node(id=uuid.uuid4(), project_id=pid, name="Банк", is_external=True)
    s.other = Node(id=uuid.uuid4(), project_id=pid, name="Склад")
    db.add_all([s.shop, s.bank, s.other])
    db.flush()
    s.orders = Node(
        id=uuid.uuid4(), project_id=pid, name="Заказы", parent_id=s.shop.id,
        technology="Python 3.11", role="сервис", openapi_spec=SPEC,
    )
    s.pay = Node(id=uuid.uuid4(), project_id=pid, name="Оплаты", parent_id=s.shop.id)
    s.db_node = Node(
        id=uuid.uuid4(), project_id=pid, name="БД", parent_id=s.shop.id, shape="database"
    )
    s.bus = Node(id=uuid.uuid4(), project_id=pid, name="Шина", parent_id=s.shop.id, shape="broker")
    db.add_all([s.orders, s.pay, s.db_node, s.bus])
    db.flush()

    s.e_pay = Edge(
        project_id=pid, source_id=s.orders.id, target_id=s.pay.id, label="оплатить",
        technology="gRPC",
    )
    s.e_bank = Edge(project_id=pid, source_id=s.bank.id, target_id=s.orders.id, label="статус")
    s.e_db = Edge(project_id=pid, source_id=s.orders.id, target_id=s.db_node.id, label="заказы")
    db.add_all([s.e_pay, s.e_bank, s.e_db])

    s.doc = NodeDoc(node_id=s.orders.id, name="Создать заказ", content=DOC_V1)
    s.ttl = ConfigParam(node_id=s.orders.id, name="ORDER_TTL_H", value_type="int", default_value="24")
    s.dsn = ConfigParam(node_id=s.orders.id, name="DB_DSN", value_type="string", required=True)
    s.table = DbTable(node_id=s.db_node.id, name="orders", schema_name="public")
    s.channel = BrokerChannel(node_id=s.bus.id, name="orders.created", delivery="at-least-once")
    db.add_all([s.doc, s.ttl, s.dsn, s.table, s.channel])
    db.flush()
    s.col_id = DbColumn(table_id=s.table.id, name="id", type="uuid", nullable=False,
                        is_primary_key=True, order=0)
    s.col_total = DbColumn(table_id=s.table.id, name="total", type="int", order=1)
    s.field = ChannelField(channel_id=s.channel.id, name="order_id", type="uuid", order=0)
    db.add_all([s.col_id, s.col_total, s.field])

    s.proc = BusinessProcess(project_id=pid, name="Оформление")
    db.add(s.proc)
    db.flush()
    s.p_buyer = ProcessParticipant(process_id=s.proc.id, node_id=None, name="Покупатель", order=0)
    s.p_orders = ProcessParticipant(process_id=s.proc.id, node_id=s.orders.id, name="Заказы", order=1)
    s.p_pay = ProcessParticipant(process_id=s.proc.id, node_id=s.pay.id, name="Оплаты", order=2)
    db.add_all([s.p_buyer, s.p_orders, s.p_pay])
    db.flush()
    s.step1 = ProcessMessage(
        process_id=s.proc.id, order=0, leg="forward", from_participant_id=s.p_buyer.id,
        to_participant_id=s.p_orders.id, caption="оформить заказ",
    )
    s.step2 = ProcessMessage(
        process_id=s.proc.id, order=1, edge_id=s.e_pay.id, leg="forward",
        from_participant_id=s.p_orders.id, to_participant_id=s.p_pay.id, caption="провести оплату",
        doc_id=s.doc.id,
    )
    s.step3 = ProcessMessage(
        process_id=s.proc.id, order=2, edge_id=s.e_pay.id, leg="return",
        from_participant_id=s.p_pay.id, to_participant_id=s.p_orders.id, caption="оплата проведена",
    )
    db.add_all([s.step1, s.step2, s.step3])
    db.commit()
    return s


def _snap(db, s, root: Node | None = None):
    db.expire_all()
    return build_snapshot(db, s.project.id, s.shop.id if root is None else root.id)


def _by_id(items):
    return {i.item_id: i for i in items}


def _rows(view: VersionView) -> list[tuple[str, list[str]]]:
    assert view.rows is not None
    return [(r.mark, r.cells) for r in view.rows]


def _absent(view: VersionView) -> bool:
    return view == VersionView(text=None, lines=None, columns=None, rows=None)


# ── Пустая база и порядок ──────────────────────────────────────────────────────


def test_первая_версия_от_пустого_всё_добавлено(db):
    s = _scene(db)
    snap = _snap(db, s)

    items = diff_items(empty_snapshot(s.shop.id), snap)

    assert {i.status for i in items} == {"added"}
    ids = _by_id(items)
    # Объекты среза — по элементу «Свойства», корень — с пустым путём.
    assert ids[f"props:{s.shop.id}"].node_path == ""
    assert ids[f"props:{s.orders.id}"].node_path == "Заказы"
    assert ids[f"props:{s.orders.id}"].summary == "объект"
    assert f"props:{s.bank.id}" not in ids  # Банк вне среза
    assert ids[f"doc:{s.doc.id}"].summary == "+4"
    assert ids[f"spec:{s.orders.id}"].summary == "+4"
    assert ids[f"config:{s.orders.id}"].name == "2 параметра"
    assert ids[f"table:{s.table.id}"].name == "public.orders"
    assert ids[f"table:{s.table.id}"].summary == "2 колонки"
    assert ids[f"channel:{s.channel.id}"].summary == "1 поле"
    assert ids[f"process:{s.proc.id}"].summary == "3 шага"
    # Статус страницы нового объекта — часть «Свойства · объект», своего элемента нет.
    assert not [i for i in items if i.category == "approval"]
    # Связь наружу — тоже элемент: её путь по концу внутри среза.
    assert ids[f"edge:{s.e_bank.id}"].node_path == "Заказы"
    assert ids[f"edge:{s.e_bank.id}"].name == "Банк → Заказы: статус"


def test_порядок_элементов_по_категории_пути_и_имени(db):
    s = _scene(db)
    _sites(db, s)
    _place(db, s.orders, s.prod)
    db.commit()
    snap = _snap(db, s)

    items = diff_items(empty_snapshot(s.shop.id), snap)

    order = [
        "props", "edges", "doc", "spec", "db", "channels", "config", "placement", "approval",
        "process",
    ]
    cats = [i.category for i in items]
    assert cats == sorted(cats, key=order.index)
    assert "placement" in cats
    props = [i.node_path for i in items if i.category == "props"]
    assert props == ["", "БД", "Заказы", "Оплаты", "Шина"]
    assert items == diff_items(empty_snapshot(s.shop.id), _snap(db, s))


def test_без_изменений_элементов_нет(db):
    s = _scene(db)
    assert diff_items(_snap(db, s), _snap(db, s)) == []


# ── Свойства и статус страницы ────────────────────────────────────────────────


def test_свойства_изменены_три_представления(db):
    s = _scene(db)
    before = _snap(db, s)
    s.orders.technology = "Python 3.12"
    s.orders.description = "Принимает заказы"
    s.orders.status = "deprecated"
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert (item.category, item.status, item.name) == ("props", "changed", "Заказы")
    assert item.summary == "описание, технология, статус"

    detail = diff_item(before, after, item.item_id)
    assert detail is not None and detail.item == item
    assert detail.changes.columns == ["Поле", "Было", "Стало"]
    assert _rows(detail.changes) == [
        ("mod", ["описание", "—", "Принимает заказы"]),
        ("mod", ["технология", "Python 3.11", "Python 3.12"]),
        ("mod", ["статус", "Существует", "Выводится"]),
    ]
    assert detail.before.columns == ["Поле", "Значение"]
    was = dict(r.cells for r in detail.before.rows or [])
    now = dict(r.cells for r in detail.after.rows or [])
    assert was["технология"] == "Python 3.11" and now["технология"] == "Python 3.12"
    assert was["родитель"] == "Магазин" and was["форма"] == "Сервис"
    assert was["внешний"] == "нет"
    assert {r.mark for r in detail.before.rows or []} == {""}


def test_переименование_объекта_изменение_а_не_удаление(db):
    s = _scene(db)
    before = _snap(db, s)
    s.orders.name = "Сервис заказов"
    db.commit()
    after = _snap(db, s)

    items = _by_id(diff_items(before, after))
    item = items[f"props:{s.orders.id}"]
    assert (item.status, item.summary) == ("changed", "переименован: Заказы → Сервис заказов")
    assert item.node_path == "Сервис заказов"
    # Путь в связях — для показа: переименование конца связь не меняет.
    assert not [i for i in items.values() if i.category == "edges"]


def test_объект_удалён_и_добавлен(db):
    s = _scene(db)
    before = _snap(db, s)
    db.delete(s.pay)
    db.add(Node(id=uuid.uuid4(), project_id=s.project.id, name="Поиск", parent_id=s.shop.id))
    db.commit()
    after = _snap(db, s)

    props = {i.name: i for i in diff_items(before, after) if i.category == "props"}
    assert (props["Оплаты"].status, props["Оплаты"].summary) == ("removed", "объект")
    assert props["Поиск"].status == "added"
    detail = diff_item(before, after, props["Оплаты"].item_id)
    assert detail is not None
    assert _absent(detail.after) and not _absent(detail.before)
    assert {r.mark for r in detail.changes.rows or []} == {"del"}


def test_перенос_корня_подписан_путём_вне_среза(db):
    s = _scene(db)
    before = _snap(db, s, s.orders)
    s.orders.parent_id = s.other.id
    db.commit()
    after = _snap(db, s, s.orders)

    [item] = diff_items(before, after)
    assert (item.item_id, item.summary) == (f"props:{s.orders.id}", "родитель")
    detail = diff_item(
        before, after, item.item_id, outside_paths={s.shop.id: "Магазин", s.other.id: "Склад"}
    )
    assert detail is not None
    assert _rows(detail.changes) == [("mod", ["родитель", "Магазин", "Склад"])]
    # Без путей снаружи — честная заглушка, а не id.
    bare = diff_item(before, after, item.item_id)
    assert bare is not None
    assert _rows(bare.changes) == [("mod", ["родитель", "объект вне среза", "объект вне среза"])]


def test_статус_страницы_свой_элемент(db):
    s = _scene(db)
    before = _snap(db, s)
    s.orders.approval = "approved"
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert (item.item_id, item.category, item.summary) == (
        f"approval:{s.orders.id}", "approval", "в работе → согласовано",
    )
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert _rows(detail.changes) == [("mod", ["статус страницы", "В работе", "Согласовано"])]
    assert _rows(detail.after) == [("", ["статус страницы", "Согласовано"])]


# ── Связи ──────────────────────────────────────────────────────────────────────


def test_связи_новая_удалённая_изменённая(db):
    s = _scene(db)
    before = _snap(db, s)
    s.e_pay.label = "провести оплату"
    s.e_pay.is_synchronous = False
    db.delete(s.e_db)
    s.e_new = Edge(project_id=s.project.id, source_id=s.orders.id, target_id=s.bus.id,
                   label="заказ создан", channel="orders.created")
    db.add(s.e_new)
    db.commit()
    after = _snap(db, s)

    edges = {i.item_id: i for i in diff_items(before, after) if i.category == "edges"}
    changed = edges[f"edge:{s.e_pay.id}"]
    assert changed.status == "changed"
    assert changed.summary == "подпись: оплатить → провести оплату, синхронность"
    assert changed.name == "Заказы → Оплаты: провести оплату"
    assert edges[f"edge:{s.e_db.id}"].status == "removed"
    assert edges[f"edge:{s.e_new.id}"].status == "added"

    detail = diff_item(before, after, changed.item_id)
    assert detail is not None
    assert detail.changes.columns == ["Связь", "Подпись", "Технология", "Канал"]
    assert _rows(detail.changes) == [
        ("mod", ["Заказы → Оплаты", "оплатить → провести оплату", "gRPC",
                 "синхронный → асинхронный"]),
    ]
    # «Было/стало» — полный список связей среза.
    assert len(detail.before.rows or []) == 3 and len(detail.after.rows or []) == 3
    new = diff_item(before, after, f"edge:{s.e_new.id}")
    assert new is not None
    assert _rows(new.changes) == [
        ("add", ["Заказы → Шина", "заказ создан", "—", "синхронный · orders.created"]),
    ]


# ── Схемы логики и спека ───────────────────────────────────────────────────────


def test_схема_логики_построчная_дельта(db):
    s = _scene(db)
    before = _snap(db, s)
    s.doc.content = DOC_V2
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert (item.item_id, item.name, item.node_path) == (f"doc:{s.doc.id}", "Создать заказ", "Заказы")
    assert item.summary == "+2 −1"
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    lines = detail.changes.lines or []
    assert lines[0].mark == "mod" and lines[0].text.startswith("@@")
    assert [(ln.mark, ln.text) for ln in lines if ln.mark in {"add", "del"}] == [
        ("del", "  B --> C[проверить остаток]"),
        ("add", "  B --> C[зарезервировать остаток]"),
        ("add", "  D --> E[публикует: orders.created]"),
    ]
    assert detail.before.text == DOC_V1 and detail.after.text == DOC_V2
    assert detail.changes.text is None and detail.changes.rows is None


def test_схема_логики_переименование_и_вид(db):
    s = _scene(db)
    before = _snap(db, s)
    s.doc.name = "Оформить заказ"
    s.doc.kind = "worker"
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert item.status == "changed"
    assert item.summary == "переименована: Создать заказ → Оформить заказ, вид: операция → воркер"
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert [(ln.mark, ln.text) for ln in detail.changes.lines or []] == [
        ("mod", "переименована: Создать заказ → Оформить заказ"),
        ("mod", "вид: операция → воркер"),
    ]


def test_схема_логики_новая_и_удалённая(db):
    s = _scene(db)
    before = _snap(db, s)
    db.delete(s.doc)
    cancel = NodeDoc(node_id=s.pay.id, name="Отменить", content="flowchart TD\n  A --> B")
    stub = NodeDoc(node_id=s.pay.id, name="Вернуть", content="")
    db.add_all([cancel, stub])
    db.commit()
    after = _snap(db, s)

    docs = {i.name: i for i in diff_items(before, after) if i.category == "doc"}
    assert (docs["Создать заказ"].status, docs["Создать заказ"].summary) == ("removed", "−4")
    assert (docs["Отменить"].status, docs["Отменить"].summary) == ("added", "+2")
    assert docs["Вернуть"].summary == "пустая"  # заглушка разведки
    detail = diff_item(before, after, docs["Отменить"].item_id)
    assert detail is not None
    assert _absent(detail.before) and detail.after.text == "flowchart TD\n  A --> B"
    assert {ln.mark for ln in detail.changes.lines or []} == {"mod", "add"}


def test_спека_появилась_изменилась_исчезла(db):
    s = _scene(db)
    before = _snap(db, s)
    s.orders.openapi_spec = SPEC + "\n  /orders/{id}:\n    get: {summary: Получить}"
    s.pay.openapi_spec = "openapi: 3.0.0"
    s.db_node.openapi_spec = ""  # None → «» — для человека «спеки нет», для хэша разница
    db.commit()
    after = _snap(db, s)

    specs = {i.item_id: i for i in diff_items(before, after) if i.category == "spec"}
    assert (specs[f"spec:{s.orders.id}"].status, specs[f"spec:{s.orders.id}"].summary) == (
        "changed", "+2",
    )
    assert specs[f"spec:{s.pay.id}"].status == "added"
    assert specs[f"spec:{s.db_node.id}"].status == "changed"
    assert content_hash(before) != content_hash(after)

    s.orders.openapi_spec = None
    db.commit()
    gone = diff_item(after, _snap(db, s), f"spec:{s.orders.id}")
    assert gone is not None and gone.item.status == "removed"
    assert gone.item.name == "OpenAPI" and _absent(gone.after)


# ── Факты ──────────────────────────────────────────────────────────────────────


def test_таблица_колонки_добавлена_изменена_удалена(db):
    s = _scene(db)
    before = _snap(db, s)
    s.col_total.type = "numeric"
    db.delete(s.col_id)
    db.add(DbColumn(table_id=s.table.id, name="status", type="text", order=2))
    s.table.description = "Заказы покупателей"
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert (item.item_id, item.category, item.node_path) == (f"table:{s.table.id}", "db", "БД")
    assert item.summary == "описание, +1 ~1 −1"
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert detail.changes.columns == ["Колонка", "Тип", "NULL", "PK", "FK", "Описание"]
    assert _rows(detail.changes) == [
        ("mod", ["таблица · описание: — → Заказы покупателей", "", "", "", "", ""]),
        ("mod", ["total", "int → numeric", "да", "нет", "—", "—"]),
        ("add", ["status", "text", "да", "нет", "—", "—"]),
        ("del", ["id", "uuid", "нет", "да", "—", "—"]),
    ]
    assert _rows(detail.before) == [
        ("", ["id", "uuid", "нет", "да", "—", "—"]),
        ("", ["total", "int", "да", "нет", "—", "—"]),
    ]
    assert _rows(detail.after)[0] == (
        "", ["таблица · описание: Заказы покупателей", "", "", "", "", ""]
    )


def test_таблица_переименована_колонки_переставлены_ссылка_FK(db):
    s = _scene(db)
    s.col_total.references_column_id = s.col_id.id
    db.commit()
    before = _snap(db, s)
    s.table.name = "orders_v2"
    s.col_id.order, s.col_total.order = 1, 0
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert item.summary == "переименована: public.orders → public.orders_v2, порядок колонок"
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    rows = _rows(detail.changes)
    assert rows[0] == (
        "mod", ["переименована: public.orders → public.orders_v2", "", "", "", "", ""]
    )
    # Соседи поменялись местами — помечен один: второй сдвинулся вместе с ним.
    assert [mark for mark, _cells in rows[1:]] == ["move"]
    fk = _rows(detail.after)[0][1][4]
    assert fk == "public.orders_v2.id"


def test_таблица_новая_и_удалённая(db):
    s = _scene(db)
    before = _snap(db, s)
    db.delete(s.table)
    db.add(DbTable(node_id=s.db_node.id, name="payments"))
    db.commit()
    after = _snap(db, s)

    tables = {i.name: i for i in diff_items(before, after) if i.category == "db"}
    assert (tables["public.orders"].status, tables["public.orders"].summary) == (
        "removed", "2 колонки",
    )
    assert (tables["payments"].status, tables["payments"].summary) == ("added", "0 колонок")
    detail = diff_item(before, after, tables["public.orders"].item_id)
    assert detail is not None
    assert {r.mark for r in detail.changes.rows or []} == {"del"}
    assert _absent(detail.after)


def test_канал_свойства_и_поля(db):
    s = _scene(db)
    before = _snap(db, s)
    s.channel.delivery = "exactly-once"
    s.field.required = True
    db.add(ChannelField(channel_id=s.channel.id, name="total", type="int", order=1))
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert (item.category, item.node_path, item.name) == ("channels", "Шина", "orders.created")
    assert item.summary == "доставка, +1 ~1"
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert detail.changes.columns == ["Поле", "Тип", "Обязательное", "Описание"]
    assert _rows(detail.changes) == [
        ("mod", ["канал · доставка: at-least-once → exactly-once", "", "", ""]),
        ("mod", ["order_id", "uuid", "нет → да", "—"]),
        ("add", ["total", "int", "нет", "—"]),
    ]
    assert _rows(detail.before) == [
        ("", ["канал · доставка: at-least-once", "", "", ""]),
        ("", ["order_id", "uuid", "нет", "—"]),
    ]


def test_канал_переименован_новый_удалённый(db):
    s = _scene(db)
    before = _snap(db, s)
    s.channel.name = "orders.placed"
    db.add(BrokerChannel(node_id=s.bus.id, name="orders.cancelled"))
    db.commit()
    mid = _snap(db, s)

    items = {i.name: i for i in diff_items(before, mid)}
    assert items["orders.placed"].summary == "переименован: orders.created → orders.placed"
    assert (items["orders.cancelled"].status, items["orders.cancelled"].summary) == (
        "added", "0 полей",
    )
    db.delete(s.channel)
    db.commit()
    [gone] = diff_items(mid, _snap(db, s))
    assert (gone.status, gone.summary) == ("removed", "1 поле")


def test_конфигурация_один_элемент_на_объект(db):
    s = _scene(db)
    before = _snap(db, s)
    s.ttl.default_value = "48"
    db.add(ConfigParam(node_id=s.orders.id, name="ORDER_CANCEL_MIN", value_type="int",
                       default_value="30", description="окно отмены"))
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert (item.item_id, item.name, item.summary) == (
        f"config:{s.orders.id}", "3 параметра", "+1 ~1",
    )
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert detail.changes.columns == ["Параметр", "Тип", "Обязателен", "Дефолт", "Описание"]
    assert _rows(detail.changes) == [
        ("add", ["ORDER_CANCEL_MIN", "int", "нет", "30", "окно отмены"]),
        ("mod", ["ORDER_TTL_H", "int", "нет", "24 → 48", "—"]),
    ]
    # Ячейка «было → стало» — ещё и по частям (фронт рисует зачёркнутое «было»); у
    # добавленной строки сравнивать не с чем.
    rows = detail.changes.rows or []
    assert [c.model_dump() for c in rows[1].changed] == [{"index": 3, "was": "24", "now": "48"}]
    assert rows[0].changed == []
    assert [cells[0] for _m, cells in _rows(detail.before)] == ["DB_DSN", "ORDER_TTL_H"]
    assert [cells[0] for _m, cells in _rows(detail.after)] == [
        "DB_DSN", "ORDER_CANCEL_MIN", "ORDER_TTL_H",
    ]


def test_конфигурация_появилась_и_исчезла(db):
    s = _scene(db)
    before = _snap(db, s)
    db.delete(s.ttl)
    db.delete(s.dsn)
    db.add(ConfigParam(node_id=s.pay.id, name="PAY_URL"))
    db.commit()
    after = _snap(db, s)

    configs = {i.item_id: i for i in diff_items(before, after)}
    gone = configs[f"config:{s.orders.id}"]
    assert (gone.status, gone.name, gone.summary) == ("removed", "2 параметра", "−2")
    new = configs[f"config:{s.pay.id}"]
    assert (new.status, new.name, new.summary) == ("added", "1 параметр", "+1")
    detail = diff_item(before, after, gone.item_id)
    assert detail is not None and _absent(detail.after)


# ── Размещение ─────────────────────────────────────────────────────────────────


def _sites(db, s) -> None:
    """Площадки «Облако» → «prod», «stage» и отдельная «Стойка»."""
    pid = s.project.id
    s.cloud = DeploymentSite(id=uuid.uuid4(), project_id=pid, name="Облако", kind="cloud")
    s.rack = DeploymentSite(id=uuid.uuid4(), project_id=pid, name="Стойка", kind="physical")
    db.add_all([s.cloud, s.rack])
    db.flush()
    s.prod = DeploymentSite(id=uuid.uuid4(), project_id=pid, name="prod", parent_id=s.cloud.id)
    s.stage = DeploymentSite(id=uuid.uuid4(), project_id=pid, name="stage", parent_id=s.cloud.id)
    db.add_all([s.prod, s.stage])
    db.flush()


def _place(db, node, site) -> DeploymentInstance:
    inst = DeploymentInstance(
        id=uuid.uuid4(), project_id=node.project_id, node_id=node.id, site_id=site.id
    )
    db.add(inst)
    db.flush()
    return inst


def test_размещение_указано_снято_изменено(db):
    s = _scene(db)
    _sites(db, s)
    i_orders = _place(db, s.orders, s.prod)
    _place(db, s.orders, s.rack)
    i_db = _place(db, s.db_node, s.prod)
    db.commit()
    before = _snap(db, s)
    db.delete(i_orders)
    _place(db, s.orders, s.stage)
    db.delete(i_db)
    _place(db, s.pay, s.stage)
    db.commit()
    after = _snap(db, s)

    items = diff_items(before, after)
    assert {i.category for i in items} == {"placement"}
    got = {i.item_id: (i.node_path, i.name, i.status, i.summary) for i in items}
    assert got == {
        f"placement:{s.orders.id}": ("Заказы", "2 площадки", "changed", "+1 −1"),
        f"placement:{s.db_node.id}": ("БД", "1 площадка", "removed", "−1"),
        f"placement:{s.pay.id}": ("Оплаты", "1 площадка", "added", "+1"),
    }

    detail = diff_item(before, after, f"placement:{s.orders.id}")
    assert detail is not None
    assert detail.changes.columns == ["Площадка"]
    assert _rows(detail.changes) == [("add", ["Облако / stage"]), ("del", ["Облако / prod"])]
    assert detail.before.columns == ["Площадка"]
    assert _rows(detail.before) == [("", ["Облако / prod"]), ("", ["Стойка"])]
    assert _rows(detail.after) == [("", ["Облако / stage"]), ("", ["Стойка"])]

    gone = diff_item(before, after, f"placement:{s.db_node.id}")
    assert gone is not None and _absent(gone.after)
    assert _rows(gone.changes) == [("del", ["Облако / prod"])]
    new = diff_item(before, after, f"placement:{s.pay.id}")
    assert new is not None and _absent(new.before)
    assert _rows(new.after) == [("", ["Облако / stage"])]


def test_переименование_и_перенос_площадки_не_элемент(db):
    """Площадка — общая сущность проекта: её имя и место в дереве площадок — подпись
    экземпляра, а не документация объекта. Ни хэш, ни дельта их не видят."""
    s = _scene(db)
    _sites(db, s)
    _place(db, s.orders, s.prod)
    db.commit()
    before = _snap(db, s)
    s.prod.name = "prod-2"
    s.prod.parent_id = s.rack.id
    db.commit()
    after = _snap(db, s)

    assert [i.site_path for i in after.instances] == ["Стойка / prod-2"]
    assert diff_items(before, after) == []
    assert content_hash(before) == content_hash(after)
    # В элементе, который появился по другой причине, переименованная площадка — без
    # строки «было → стало»: смысл экземпляра — площадка, а не её путь.
    _place(db, s.orders, s.stage)
    db.commit()
    detail = diff_item(before, _snap(db, s), f"placement:{s.orders.id}")
    assert detail is not None
    assert _rows(detail.changes) == [("add", ["Облако / stage"])]


def test_унаследованное_размещение_не_элемент(db):
    """Контейнер поставили на площадку — у детей действующее размещение появилось, но
    своего у них нет: элемент один, у самого контейнера."""
    s = _scene(db)
    _sites(db, s)
    db.commit()
    before = _snap(db, s)
    _place(db, s.shop, s.prod)
    db.commit()

    [item] = diff_items(before, _snap(db, s))
    assert (item.item_id, item.node_path, item.status) == (f"placement:{s.shop.id}", "", "added")


def test_размещение_в_хэше_и_в_перечне(db):
    """«Хэш разный ⇔ элементы есть» на размещении. Снять и снова поставить ту же
    площадку — новый экземпляр (id — часть проекции): и хэш другой, и элемент есть."""
    s = _scene(db)
    _sites(db, s)
    inst = _place(db, s.orders, s.prod)
    db.commit()
    steps = [
        lambda: _place(db, s.orders, s.stage),
        lambda: db.delete(inst),
        lambda: _place(db, s.orders, s.prod),
    ]
    for mutate in steps:
        before = _snap(db, s)
        mutate()
        db.commit()
        after = _snap(db, s)
        items = diff_items(before, after)
        assert content_hash(before) != content_hash(after), mutate
        assert [i.category for i in items] == ["placement"]
        assert diff_item(before, after, items[0].item_id) is not None


def test_список_версий_несёт_изменённое_размещение(db):
    s = _scene(db)
    _sites(db, s)
    user = ensure_architect(db)
    create_version(db, s.project, user, s.orders, "v1")
    _place(db, s.orders, s.prod)
    db.commit()
    create_version(db, s.project, user, s.orders, "v2")
    db.commit()

    latest = list_versions(db, s.project, s.orders)[0]
    assert latest.stats["changed"] == [{
        "item_id": f"placement:{s.orders.id}", "category": "placement",
        "name": "1 площадка", "status": "added",
    }]


# ── Процессы ───────────────────────────────────────────────────────────────────


def test_процесс_шаги_изменены_и_добавлены(db):
    s = _scene(db)
    before = _snap(db, s)
    s.step2.caption = "списать оплату"
    db.add(ProcessMessage(
        process_id=s.proc.id, order=3, edge_id=s.e_pay.id, leg="forward",
        from_participant_id=s.p_orders.id, to_participant_id=s.p_pay.id, caption="чек",
    ))
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert (item.item_id, item.name, item.node_path) == (f"process:{s.proc.id}", "Оформление", "")
    assert item.summary == "+1 ~1 шага"
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert detail.changes.columns == ["№", "Кто → кому", "Подпись"]
    assert _rows(detail.changes) == [
        ("mod", ["2", "Заказы → Оплаты",
                 "провести оплату · схема «Создать заказ» → списать оплату · схема «Создать заказ»"]),
        ("add", ["4", "Заказы → Оплаты", "чек"]),
    ]
    assert _rows(detail.before) == [
        # У непривязанного участника канала нет — шаг честно повисший.
        ("", ["1", "Покупатель → Заказы", "оформить заказ · связь удалена"]),
        ("", ["2", "Заказы → Оплаты", "провести оплату · схема «Создать заказ»"]),
        ("", ["3", "Оплаты → Заказы", "оплата проведена · ответ"]),
    ]
    assert len(detail.after.rows or []) == 4


def test_процесс_только_порядок_шагов(db):
    s = _scene(db)
    before = _snap(db, s)
    s.step1.order, s.step3.order = 2, 0
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert item.summary == "порядок шагов"
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    # Первый и третий поменялись местами вокруг второго: помечены они, номер «был →
    # стал»; второй, чей номер не менялся, в «изменениях» не появляется.
    assert [(mark, cells[0]) for mark, cells in _rows(detail.changes)] == [
        ("move", "3 → 1"),
        ("move", "1 → 3"),
    ]


def test_процесс_удалённый_шаг_и_участники(db):
    s = _scene(db)
    before = _snap(db, s)
    db.delete(s.step1)
    s.p_buyer.name = "Клиент"  # непривязанный: имя — его собственное, это правка процесса
    s.proc.name = "Оформление заказа"
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert item.summary == (
        "переименован: Оформление → Оформление заказа, −1 шаг, участники"
    )
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert ("del", ["1", "Покупатель → Заказы", "оформить заказ · связь удалена"]) in _rows(
        detail.changes
    )
    assert ("mod", ["участник", "Покупатель → Клиент", "не привязан"]) in _rows(detail.changes)


def test_процесс_фрагменты_и_область(db):
    s = _scene(db)
    before = _snap(db, s)
    frag = ProcessFragment(process_id=s.proc.id, kind="alt", from_order=1, to_order=2,
                           guard="оплата прошла")
    db.add(frag)
    db.flush()
    db.add(ProcessFragmentBranch(fragment_id=frag.id, start_order=2, guard="отказ"))
    s.proc.scope_node_id = s.shop.id
    db.commit()
    after = _snap(db, s)

    [item] = diff_items(before, after)
    assert item.summary == "область, фрагменты"
    detail = diff_item(before, after, item.item_id)
    assert detail is not None
    assert _rows(detail.changes) == [
        ("add", ["фрагмент", "alt", "шаги 2–3 · оплата прошла · отказ"]),
    ]


def test_процесс_новый_и_ушедший_из_среза(db):
    s = _scene(db)
    before = _snap(db, s)
    other = BusinessProcess(project_id=s.project.id, name="Возврат")
    db.add(other)
    db.flush()
    db.add(ProcessParticipant(process_id=other.id, node_id=s.pay.id, name="Оплаты", order=0))
    # «Оформление» больше не касается «Заказов»: в срезе листа его не станет.
    db.commit()
    after = _snap(db, s)

    [new] = diff_items(before, after)
    assert (new.name, new.status, new.summary) == ("Возврат", "added", "0 шагов")
    detail = diff_item(before, after, new.item_id)
    assert detail is not None and _absent(detail.before)

    leaf_before = _snap(db, s, s.orders)
    s.p_orders.node_id = None
    db.commit()
    leaf_after = _snap(db, s, s.orders)
    [gone] = diff_items(leaf_before, leaf_after)
    assert (gone.item_id, gone.status, gone.summary) == (
        f"process:{s.proc.id}", "removed", "3 шага",
    )


def test_живые_имена_чужих_узлов_в_процессе_не_изменение(db):
    """Переименование участника вне среза листа меняет detail (имя в нём живое), но не
    semantic-проекцию: ни хэш, ни дельта этого не видят."""
    s = _scene(db)
    before = _snap(db, s, s.orders)
    s.pay.name = "Платежи"
    db.commit()
    after = _snap(db, s, s.orders)

    assert before.processes[0].detail != after.processes[0].detail
    assert semantic(before) == semantic(after)
    assert diff_items(before, after) == []


# ── Адрес элемента ─────────────────────────────────────────────────────────────


def test_элемент_по_неизвестному_адресу_None(db):
    s = _scene(db)
    before = _snap(db, s)
    s.orders.technology = "Go"
    db.commit()
    after = _snap(db, s)

    assert diff_item(before, after, f"props:{uuid.uuid4()}") is None
    assert diff_item(before, after, f"doc:{s.doc.id}") is None  # не менялась
    assert diff_item(before, after, "чепуха") is None
    assert diff_item(before, after, f"node:{s.orders.id}") is None


# ── Одна правда: хэш и перечень ────────────────────────────────────────────────


def _mutations(s):
    """Правки сцены по одной на поле семантики — каждая обязана дать и новый хэш, и
    хотя бы один элемент."""
    return [
        lambda: setattr(s.orders, "role", "шлюз"),
        lambda: setattr(s.orders, "shape", "person"),
        lambda: setattr(s.orders, "is_external", True),
        lambda: setattr(s.orders, "source_ref", "git:shop#orders"),
        lambda: setattr(s.orders, "approval", "approved"),
        lambda: setattr(s.e_pay, "technology", "REST"),
        lambda: setattr(s.e_pay, "channel", "orders.created"),
        lambda: setattr(s.e_pay, "target_id", s.db_node.id),
        lambda: setattr(s.doc, "operation", "POST /orders"),
        lambda: setattr(s.table, "schema_name", "shop"),
        lambda: setattr(s.table, "node_id", s.pay.id),
        lambda: setattr(s.col_id, "description", "ключ"),
        lambda: setattr(s.channel, "retention", "7d"),
        lambda: setattr(s.field, "description", "id заказа"),
        lambda: setattr(s.dsn, "required", False),
        lambda: setattr(s.step1, "leg", "return"),
        lambda: setattr(s.step3, "doc_id", s.doc.id),
        lambda: setattr(s.p_pay, "node_id", s.db_node.id),
        lambda: setattr(s.p_buyer, "order", 5),
    ]


def test_хэш_разный_тогда_и_только_тогда_когда_есть_элементы(db):
    s = _scene(db)
    for mutate in _mutations(s):
        before = _snap(db, s)
        mutate()
        db.commit()
        after = _snap(db, s)
        items = diff_items(before, after)
        assert content_hash(before) != content_hash(after), mutate
        assert items, f"хэш сменился, а элементов нет: {semantic(after)}"
        for item in items:
            assert diff_item(before, after, item.item_id) is not None, item

