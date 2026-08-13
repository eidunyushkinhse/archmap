"""Пометки обращений в тексте схем логики: разбор и резолв (пивот §9).

Чистые функции без БД. Проверяется нормативная грамматика (spec.md) и правила
резолва — особенно неоднозначность «x.y»: молча выбрать одну из гипотез — значит
казаться работающим, атрибутируя обращение не туда.
"""

import uuid

from app.data_refs import (
    CatalogTable,
    DataRefIn,
    parse_data_refs,
    resolve_data_refs,
)

# ── Разбор ────────────────────────────────────────────────────────────────────


def test_разбор_маркеры_и_режимы():
    doc = 'A["Проверить<br>читает: orders.status"] --> B["Списать<br>пишет: accounts"]'
    refs = parse_data_refs(doc)
    assert refs == [
        DataRefIn(ref="orders.status", mode="read"),
        DataRefIn(ref="accounts", mode="write"),
    ]


def test_разбор_английские_маркеры_и_регистр():
    doc = 'A["reads: orders"] --> B["Writes: accounts.balance"]'
    assert parse_data_refs(doc) == [
        DataRefIn(ref="orders", mode="read"),
        DataRefIn(ref="accounts.balance", mode="write"),
    ]


def test_разбор_список_через_запятую_и_терминаторы():
    # Терминаторы: <br>, кавычка, закрывающие скобки, конец строки — хвост подписи
    # не утекает в ссылку.
    doc = (
        'A["Шаг<br>читает: orders.status, orders.total<br>дальше проза"]\n'
        "B(пишет: audit)\n"
        "C{reads: events}"
    )
    refs = parse_data_refs(doc)
    assert refs == [
        DataRefIn(ref="orders.status", mode="read"),
        DataRefIn(ref="orders.total", mode="read"),
        DataRefIn(ref="audit", mode="write"),
        DataRefIn(ref="events", mode="read"),
    ]


def test_разбор_маркер_внутри_слова_не_считается():
    assert parse_data_refs('A["перечитает: orders"]') == []


def test_разбор_дедуп_в_пределах_дока_с_учётом_режима():
    doc = 'A["читает: orders"] B["читает: orders"] C["пишет: orders"]'
    assert parse_data_refs(doc) == [
        DataRefIn(ref="orders", mode="read"),
        DataRefIn(ref="orders", mode="write"),
    ]


def test_разбор_квалификатор_узла_с_пробелами():
    doc = 'A["пишет: БД заказов / orders.status"]'
    assert parse_data_refs(doc) == [
        DataRefIn(ref="БД заказов / orders.status", mode="write")
    ]


def test_разбор_пустой_хвост_не_даёт_ссылок():
    assert parse_data_refs('A["читает:"] B["пишет: , ,"]') == []


# ── Резолв ────────────────────────────────────────────────────────────────────

N_STORE = uuid.uuid4()
N_BILLING_DB = uuid.uuid4()

PATHS = {
    N_STORE: "Ярмарка / Хранилище",
    N_BILLING_DB: "Ярмарка / Биллинг / БД биллинга",
}


def _t(
    node: uuid.UUID, name: str, schema: str = "", cols: tuple[str, ...] = ()
) -> CatalogTable:
    return CatalogTable(
        id=uuid.uuid4(),
        node_id=node,
        schema_name=schema,
        name=name,
        columns={c: uuid.uuid4() for c in cols},
    )


def _resolve(ref: str, tables: list[CatalogTable], mode: str = "read"):
    [out] = resolve_data_refs(
        [DataRefIn(ref=ref, mode=mode)], tables, PATHS  # type: ignore[arg-type]
    )
    return out


def test_резолв_таблица_и_колонка():
    orders = _t(N_STORE, "orders", cols=("status",))
    got = _resolve("orders.status", [orders])
    assert (got.status, got.table_id) == ("ok", orders.id)
    assert got.column_id == orders.columns["status"]


def test_резолв_только_таблица_колонка_законно_не_указана():
    orders = _t(N_STORE, "orders", cols=("status",))
    got = _resolve("orders", [orders])
    assert (got.status, got.table_id, got.column_id) == ("ok", orders.id, None)


def test_резолв_xy_неоднозначно_между_колонкой_и_разделом():
    # Есть И таблица x с потенциальной колонкой y, И таблица y в разделе x: обе
    # гипотезы «x.y» сработали — молча выбирать нельзя.
    tables = [
        _t(N_STORE, "orders", cols=("audit",)),
        _t(N_STORE, "audit", schema="orders"),
    ]
    assert _resolve("orders.audit", tables).status == "ambiguous"


def test_резолв_xy_как_раздел_таблица():
    audit = _t(N_STORE, "audit", schema="billing")
    got = _resolve("billing.audit", [audit])
    assert (got.status, got.table_id, got.column_id) == ("ok", audit.id, None)


def test_резолв_неизвестная_колонка_подсвечивается_но_таблица_найдена():
    orders = _t(N_STORE, "orders", cols=("status",))
    got = _resolve("orders.discount", [orders])
    assert (got.status, got.table_id, got.column_id) == (
        "unknown_column",
        orders.id,
        None,
    )


def test_резолв_одноимённые_таблицы_требуют_квалификатора():
    tables = [_t(N_STORE, "orders"), _t(N_BILLING_DB, "orders")]
    assert _resolve("orders", tables).status == "ambiguous"
    got = _resolve("БД биллинга / orders", tables)
    assert (got.status, got.table_id) == ("ok", tables[1].id)
    # Квалификатором годится и суффикс пути — агент корневого контейнера не знает.
    got2 = _resolve("Биллинг / БД биллинга / orders", tables)
    assert (got2.status, got2.table_id) == ("ok", tables[1].id)


def test_резолв_квалификатор_не_цепляется_к_части_имени():
    # «Заказы» не должно находить узел «Мои Заказы»: суффикс — по границе « / ».
    n_my = uuid.uuid4()
    paths = dict(PATHS)
    paths[n_my] = "Ярмарка / Мои Заказы"
    t = CatalogTable(
        id=uuid.uuid4(), node_id=n_my, schema_name="", name="orders", columns={}
    )
    [got] = resolve_data_refs([DataRefIn(ref="Заказы / orders", mode="read")], [t], paths)
    assert got.status == "unknown_table"


def test_резолв_проза_после_маркера_видима_как_невыполненное_обещание():
    # Слова с пробелами — не токен: такая «ссылка» не резолвится и должна дойти до
    # алертов, а не молча пропасть (маркер = обещание факта).
    got = _resolve("договор из архива", [_t(N_STORE, "orders")])
    assert got.status == "unknown_table"


def test_резолв_битые_сегменты_не_гадаются():
    orders = _t(N_STORE, "orders", cols=("status",))
    assert _resolve("orders.", [orders]).status == "unknown_table"
    assert _resolve("a.b.c.d", [orders]).status == "unknown_table"
