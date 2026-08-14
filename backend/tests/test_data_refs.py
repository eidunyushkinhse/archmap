"""Пометки обращений в тексте схем логики: разбор и резолв (пивот §9).

Чистые функции без БД. Проверяется нормативная грамматика (spec.md) и правила
резолва — особенно неоднозначность «x.y»: молча выбрать одну из гипотез — значит
казаться работающим, атрибутируя обращение не туда.

Каналы брокеров (docs/plan-broker-docs.md §3) живут здесь же, но в ДРУГОМ каталоге:
«пишет: orders» и «публикует: orders» обязаны вести в разные места — ради этого
маркеры и разведены (решение §7.1).
"""

import uuid

from app.data_refs import (
    CatalogChannel,
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


def test_разбор_слитный_маркер_даёт_обе_пометки():
    # «читает/пишет:» — форма, которую агент пишет сам (полевой QA): раньше парсер брал
    # из неё только «пишет», и читающая половина факта молча терялась.
    assert parse_data_refs('A["Обновить статус<br>читает/пишет: orders"]') == [
        DataRefIn(ref="orders", mode="read"),
        DataRefIn(ref="orders", mode="write"),
    ]
    assert parse_data_refs('A["Reads/Writes: accounts.balance"]') == [
        DataRefIn(ref="accounts.balance", mode="read"),
        DataRefIn(ref="accounts.balance", mode="write"),
    ]


def test_разбор_слитный_маркер_пробелы_вокруг_слэша_и_список():
    # Порядок режимов — как написано; ссылки списком, каждая получает обе пометки.
    assert parse_data_refs('A["пишет / читает: orders, audit"]') == [
        DataRefIn(ref="orders", mode="write"),
        DataRefIn(ref="orders", mode="read"),
        DataRefIn(ref="audit", mode="write"),
        DataRefIn(ref="audit", mode="read"),
    ]


def test_разбор_слитный_маркер_дедупится_с_раздельными():
    # Слитная пометка ПЕРВАЯ: она уже дала обе, и раздельные ниже ничего не добавляют
    # (порядок появления при этом остаётся её порядком).
    doc = 'A["читает/пишет: orders"] B["читает: orders"] C["пишет: orders"]'
    assert parse_data_refs(doc) == [
        DataRefIn(ref="orders", mode="read"),
        DataRefIn(ref="orders", mode="write"),
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


def test_разбор_маркеры_каналов_ru_и_en():
    # Свои слова, а не «пишет/читает»: семантика доставки другая, и каталог свой.
    doc = (
        'A["Оформить<br>публикует: orders.created"] --> B["Списать<br>потребляет: payments"]\n'
        'C["Publishes: audit.log"]\n'
        "D(consumes: events)"
    )
    assert parse_data_refs(doc) == [
        DataRefIn(ref="orders.created", mode="publish"),
        DataRefIn(ref="payments", mode="consume"),
        DataRefIn(ref="audit.log", mode="publish"),
        DataRefIn(ref="events", mode="consume"),
    ]


def test_разбор_слитный_маркер_каналов_даёт_обе_пометки():
    # «публикует/потребляет:» агент пишет сам — как «читает/пишет:» у данных.
    assert parse_data_refs('A["Реле<br>публикует/потребляет: orders.created"]') == [
        DataRefIn(ref="orders.created", mode="publish"),
        DataRefIn(ref="orders.created", mode="consume"),
    ]
    assert parse_data_refs('A["Publishes / Consumes: events"]') == [
        DataRefIn(ref="events", mode="publish"),
        DataRefIn(ref="events", mode="consume"),
    ]


def test_разбор_маркер_канала_внутри_слова_не_считается():
    assert parse_data_refs('A["перепубликует: orders"]') == []


# ── Резолв ────────────────────────────────────────────────────────────────────

N_STORE = uuid.uuid4()
N_BILLING_DB = uuid.uuid4()
N_KAFKA = uuid.uuid4()
N_RABBIT = uuid.uuid4()

PATHS = {
    N_STORE: "Ярмарка / Хранилище",
    N_BILLING_DB: "Ярмарка / Биллинг / БД биллинга",
    N_KAFKA: "Ярмарка / Kafka",
    N_RABBIT: "Ярмарка / Биллинг / RabbitMQ",
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


def _c(
    node: uuid.UUID, name: str, group: str = "", fields: tuple[str, ...] = ()
) -> CatalogChannel:
    return CatalogChannel(
        id=uuid.uuid4(),
        node_id=node,
        group_name=group,
        name=name,
        fields={f: uuid.uuid4() for f in fields},
    )


def _resolve(
    ref: str,
    tables: list[CatalogTable],
    mode: str = "read",
    channels: list[CatalogChannel] | None = None,
):
    [out] = resolve_data_refs(
        [DataRefIn(ref=ref, mode=mode)], tables, channels or [], PATHS  # type: ignore[arg-type]
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
    [got] = resolve_data_refs(
        [DataRefIn(ref="Заказы / orders", mode="read")], [t], [], paths
    )
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


# ── Резолв каналов ────────────────────────────────────────────────────────────
# Своя семья маркеров и СВОЙ каталог: read/write ищутся только среди таблиц,
# publish/consume — только среди каналов. Именно это делает одноимённые «orders»
# в базе и в брокере разными целями, а не двусмысленностью.


def _ch(ref: str, channels: list[CatalogChannel], mode: str = "publish"):
    return _resolve(ref, [], mode=mode, channels=channels)


def test_резолв_канал_и_поле():
    created = _c(N_KAFKA, "orders", fields=("order_id",))
    got = _ch("orders.order_id", [created])
    assert (got.status, got.channel_id) == ("ok", created.id)
    assert got.field_id == created.fields["order_id"]
    assert got.field_name == "order_id"
    # Табличные поля у канальной пометки пусты — семьи не перепутаны.
    assert (got.table_id, got.column_id) == (None, None)


def test_резолв_только_канал_поле_законно_не_указано():
    created = _c(N_KAFKA, "payments", fields=("amount",))
    got = _ch("payments", [created], mode="consume")
    assert (got.status, got.channel_id, got.field_id) == ("ok", created.id, None)


def test_резолв_каталоги_разведены_одноимённые_таблица_и_канал_не_конфликтуют():
    # ГЛАВНЫЙ инвариант фазы: «пишет: orders» — таблица, «публикует: orders» — канал.
    # Слитый каталог сделал бы обе пометки неоднозначными (или увёл бы не туда).
    orders_t = _t(N_STORE, "orders", cols=("status",))
    orders_c = _c(N_KAFKA, "orders", fields=("order_id",))

    записал = _resolve("orders", [orders_t], mode="write", channels=[orders_c])
    assert (записал.status, записал.table_id, записал.channel_id) == (
        "ok", orders_t.id, None,
    )

    опубликовал = _resolve("orders", [orders_t], mode="publish", channels=[orders_c])
    assert (опубликовал.status, опубликовал.channel_id, опубликовал.table_id) == (
        "ok", orders_c.id, None,
    )


def test_резолв_табличная_пометка_канал_не_видит():
    # Обратная сторона того же правила: канал есть, таблицы нет — «пишет: orders»
    # обязано остаться невыполненным обещанием, а не тихо уехать в топик.
    assert _resolve("orders", [], mode="write", channels=[_c(N_KAFKA, "orders")]).status == (
        "unknown_table"
    )
    # И симметрично: таблица есть, канала нет.
    assert _ch("orders", [], mode="publish").status == "unknown_channel"
    assert _resolve("orders", [_t(N_STORE, "orders")], mode="publish").status == (
        "unknown_channel"
    )


def test_резолв_xy_канала_неоднозначно_между_полем_и_группой():
    # «x.y» у каналов — те же две гипотезы: «канал x, поле y» против «группа x,
    # канал y». Сработали обе → выбирать за пользователя запрещено.
    channels = [
        _c(N_RABBIT, "orders", fields=("created",)),
        _c(N_RABBIT, "created", group="orders"),
    ]
    assert _ch("orders.created", channels).status == "ambiguous"


def test_резолв_xy_канала_как_группа_канал():
    # vhost/namespace в роли раздела: «биллинг.orders» — канал orders в группе.
    ch = _c(N_RABBIT, "orders", group="биллинг")
    got = _ch("биллинг.orders", [ch], mode="consume")
    assert (got.status, got.channel_id, got.field_id) == ("ok", ch.id, None)


def test_резолв_неизвестное_поле_подсвечивается_но_канал_найден():
    ch = _c(N_KAFKA, "orders", fields=("order_id",))
    got = _ch("orders.total", [ch])
    # Зеркало unknown_column: событие через канал ходит, а поля в контракте нет —
    # обращение считается к каналу ЦЕЛИКОМ и подсвечивается алертом.
    assert (got.status, got.channel_id, got.field_id) == ("unknown_field", ch.id, None)


def test_резолв_одноимённые_каналы_требуют_квалификатора_брокера():
    channels = [_c(N_KAFKA, "orders"), _c(N_RABBIT, "orders")]
    assert _ch("orders", channels).status == "ambiguous"

    got = _ch("RabbitMQ / orders", channels)
    assert (got.status, got.channel_id) == ("ok", channels[1].id)
    # Квалификатором годится и хвост пути — агент корневого контейнера не знает.
    got2 = _ch("Биллинг / RabbitMQ / orders", channels)
    assert (got2.status, got2.channel_id) == ("ok", channels[1].id)


def test_резолв_проза_после_маркера_канала_видима_как_обещание():
    got = _ch("события из очереди", [_c(N_KAFKA, "orders")])
    assert got.status == "unknown_channel"


# ── Точки внутри имени канала ─────────────────────────────────────────────────
# «orders.created» — норма именования Kafka, и грамматика «группа.канал.поле» её
# резала: пометка уезжала в unknown_channel. У каналов точка может быть ЧАСТЬЮ
# ИМЕНИ — две дополнительные гипотезы, равноправные с остальными. Таблиц это не
# касается: там точки в именах редки, и лишние гипотезы плодили бы неоднозначность.


def test_резолв_имя_канала_с_точкой():
    created = _c(N_KAFKA, "orders.created")
    got = _ch("orders.created", [created])
    assert (got.status, got.channel_id, got.field_id) == ("ok", created.id, None)

    # И длиннее двух сегментов: «orders.created.v2» — тоже одно имя топика.
    v2 = _c(N_KAFKA, "orders.created.v2")
    got2 = _ch("orders.created.v2", [v2])
    assert (got2.status, got2.channel_id) == ("ok", v2.id)


def test_резолв_поле_у_канала_с_точкой():
    created = _c(N_KAFKA, "orders.created", fields=("user_id",))
    got = _ch("orders.created.user_id", [created], mode="consume")
    assert (got.status, got.channel_id) == ("ok", created.id)
    assert (got.field_id, got.field_name) == (created.fields["user_id"], "user_id")

    # Четыре сегмента: «orders.created.v2.user_id» — имя с точками + поле.
    v2 = _c(N_KAFKA, "orders.created.v2", fields=("user_id",))
    got2 = _ch("orders.created.v2.user_id", [v2])
    assert (got2.status, got2.field_name) == ("ok", "user_id")

    # Поля нет — канал с точкой всё равно найден (обращение к нему целиком).
    got3 = _ch("orders.created.total", [created])
    assert (got3.status, got3.channel_id) == ("unknown_field", created.id)


def test_резолв_имя_с_точкой_против_канала_с_полем_неоднозначно():
    # Гипотезы равноправны: есть И канал «orders.created», И канал «orders» с полем
    # «created» — выбрать за пользователя нельзя, лечится квалификатором.
    channels = [_c(N_KAFKA, "orders.created"), _c(N_RABBIT, "orders", fields=("created",))]
    assert _ch("orders.created", channels).status == "ambiguous"

    got = _ch("Kafka / orders.created", channels)
    assert (got.status, got.channel_id) == ("ok", channels[0].id)


def test_резолв_имя_с_точкой_против_группы_неоднозначно():
    # Та же коллизия с группой (vhost «orders», канал «created»).
    channels = [_c(N_KAFKA, "orders.created"), _c(N_RABBIT, "created", group="orders")]
    assert _ch("orders.created", channels).status == "ambiguous"


def test_резолв_таблицы_новых_гипотез_не_получили():
    # Асимметрия намеренная: у таблиц точка остаётся разделителем, и «a.b» НЕ значит
    # «таблица с именем a.b». Иначе каждая пара «таблица orders + колонка status»
    # против гипотетической таблицы «orders.status» стала бы неоднозначной.
    точечная = _t(N_STORE, "orders.created", cols=("user_id",))
    assert _resolve("orders.created", [точечная]).status == "unknown_table"
    assert _resolve("orders.created.user_id", [точечная]).status == "unknown_table"
    # И длинная ссылка по-прежнему битая (границы «раздел.таблица.колонка»).
    assert _resolve("a.b.c.d", [точечная]).status == "unknown_table"


def test_резолв_битые_сегменты_у_каналов_не_гадаются():
    # Пустой сегмент бьёт ссылку ЦЕЛИКОМ и у каналов: «orders.created.» — не «канал
    # orders.created», а битая пометка (проверка сегментов идёт до гипотез).
    ch = _c(N_KAFKA, "orders.created")
    assert _ch("orders.created.", [ch]).status == "unknown_channel"
    assert _ch(".orders.created", [ch]).status == "unknown_channel"


def test_резолв_смешанного_дока_каждая_пометка_идёт_в_свой_каталог():
    # Обычный док сервиса: и данные, и события рядом. Порядок ответа = порядок
    # пометок, и каждая резолвится своим каталогом.
    orders_t = _t(N_STORE, "orders", cols=("status",))
    created_c = _c(N_KAFKA, "созданные", fields=("order_id",))
    doc = 'A["Оформить<br>пишет: orders.status<br>публикует: созданные.order_id"]'

    got = resolve_data_refs(parse_data_refs(doc), [orders_t], [created_c], PATHS)

    assert [(r.mode, r.status) for r in got] == [("write", "ok"), ("publish", "ok")]
    assert (got[0].table_id, got[1].channel_id) == (orders_t.id, created_c.id)
