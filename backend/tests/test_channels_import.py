"""Дозаливка КАНАЛОВ брокера от агента (BYOA, Ф4 plan-broker-docs.md).

Здесь проверяется то, чем этот путь отличается и от ручного ввода, и от дозаливки
структуры БД. Отличие одно, но оно определяет всё остальное: у брокера НЕТ
репозитория-владельца — один топик описывают пакеты РАЗНЫХ репозиториев. Отсюда
add-only доливка полей к уже описанному каналу и предупреждение вместо тихой
перезаписи, когда два репозитория назвали мету по-разному.

Промпт проверяется тут же: адрес владельца слабая модель выдумывает, если перечня
брокеров в тексте нет (уроки Н8/Н11 полевого QA).
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.channels_import import parse_channels_file
from app.channels_prompt import build_channels_prompt
from app.data_import import NODE_HEADER
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.node import Node
from app.routers.channels_import import (
    channels_import_apply,
    channels_import_preview,
    channels_prompt,
)
from app.schemas.channels_import import ChannelsImportIn

ПАКЕТ = """# archmap-node: Шина
channels:
  - name: orders.created
    kind: topic
    partition_key: order_id
    delivery: at-least-once
    retention: 7d
    description: заказ создан
    fields:
      - name: order_id
        type: uuid
        required: true
      - name: status
        type: string
        required: true
        description: new|paid|shipped
  - name: orders.paid
    kind: topic
    fields:
      - name: order_id
        type: uuid
"""


def _node(db, name, shape="broker", parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        shape=shape,
        project_id=ensure_project(db).id,
        parent_id=parent.id if parent is not None else None,
    )
    db.add(n)
    db.flush()
    return n


def _сцена(db):
    шина = _node(db, "Шина")
    # Сервис рядом не для красоты: с единственным узлом резолв адреса был бы
    # вырожденным и «# archmap-node: Шина» ничего не проверял.
    сервис = _node(db, "Заказы", shape="service")
    return шина, сервис


def _применить(db, текст=ПАКЕТ, overwrite=False, node_id=None):
    return channels_import_apply(
        ChannelsImportIn(
            files=[{"name": "channels.yaml", "content": текст}],
            overwrite=overwrite,
            node_id=node_id,
        ),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def _канал(db, name="orders.created"):
    return db.query(BrokerChannel).filter(BrokerChannel.name == name).one()


# ── Разбор ────────────────────────────────────────────────────────────────────


def test_чужие_файлы_пакета_разборщик_не_трогает(db):
    # В пакете рядом лежат схемы логики, спеки и структура БД — они не про каналы.
    assert parse_channels_file("graph TD\n  A --> B") is None
    assert parse_channels_file("openapi: 3.0.0\npaths: {}") is None
    assert parse_channels_file("tables:\n  - name: orders\n") is None
    assert parse_channels_file(ПАКЕТ) is not None


def test_разбор_толерантен_к_мусору(db):
    pc = parse_channels_file(
        "channels:\n"
        "  - лишнее: поле\n"            # без name — пропускаем
        "  - name: ok\n"
        "    неизвестный_ключ: 1\n"      # игнорируем
        "    fields:\n"
        "      - name: f\n"
        "        type: int64\n"
        "      - тип: без имени\n"       # поле без name — пропускаем
    )
    assert pc is not None
    assert [c.name for c in pc.channels] == ["ok"]
    assert [f.name for f in pc.channels[0].fields] == ["f"]


# ── Применение ────────────────────────────────────────────────────────────────


def test_пакет_создаёт_каналы_с_метой_и_полями(db):
    шина, _сервис = _сцена(db)
    r = _применить(db)

    assert r.applied and r.errors == []
    ch = _канал(db)
    assert ch.node_id == шина.id
    # Мета доставки — ради неё канал отдельная сущность: порядок событий, повторная
    # обработка и переигрывание держатся на этих трёх полях.
    assert (ch.kind, ch.partition_key, ch.delivery, ch.retention) == (
        "topic", "order_id", "at-least-once", "7d",
    )
    status = next(f for f in ch.fields if f.name == "status")
    assert (status.type, status.required, status.description) == (
        "string", True, "new|paid|shipped",
    )
    assert r.channels_written == 2 and r.fields_written == 3


def test_повторный_прогон_не_плодит_дублей(db):
    _сцена(db)
    _применить(db)
    r = _применить(db)

    assert db.query(BrokerChannel).count() == 2
    assert db.query(ChannelField).count() == 3
    assert r.channels_written == 0 and r.fields_written == 0
    assert {i.action for i in r.channels} == {"unchanged"}


def test_второй_репозиторий_доливает_поля_к_чужому_каналу(db):
    """Тот же топик описывают РАЗНЫЕ репозитории: продюсер видит одни поля, консьюмер
    другие. Второй пакет обязан долить свои, а не переоткрыть канал."""
    _сцена(db)
    _применить(db)
    r = _применить(
        db,
        "# archmap-node: Шина\nchannels:\n"
        "  - name: orders.created\n"
        "    fields:\n"
        "      - name: total\n"
        "        type: int64\n",
    )

    assert r.applied and r.errors == []
    assert db.query(BrokerChannel).count() == 2  # канал не задвоился
    ch = _канал(db)
    assert [f.name for f in ch.fields] == ["order_id", "status", "total"]
    # Новое поле встало В КОНЕЦ, а не перемешало порядок сообщения.
    assert next(f for f in ch.fields if f.name == "total").order == 2
    assert r.fields_written == 1
    # Мета первого пакета не пострадала: второй её просто не видел.
    assert ch.delivery == "at-least-once"


def test_расхождение_меты_предупреждает_и_оставляет_описанное(db):
    """Два репозитория честно видят разное (у продюсера свой retention). Молча
    перетереть — значит поставить смысл карты в зависимость от порядка загрузки."""
    _сцена(db)
    _применить(db)
    r = _применить(db, ПАКЕТ.replace("retention: 7d", "retention: 30d"))

    assert r.applied and r.errors == []
    assert _канал(db).retention == "7d"  # побеждает описанное раньше
    [w] = [w for w in r.warnings if "retention" in w]
    assert "канал «orders.created»" in w
    assert "в пакете «30d»" in w and "в ArchMap «7d»" in w
    assert "оставлено значение из ArchMap" in w


def test_пустая_мета_пакета_конфликтом_не_считается(db):
    # «Не знаю» не спорит со «знаю»: консьюмер не видит настроек продюсера, и
    # предупреждение об этом было бы шумом на каждом втором пакете.
    _сцена(db)
    _применить(db)
    r = _применить(db, ПАКЕТ.replace("    retention: 7d\n", ""))

    assert r.warnings == []
    assert _канал(db).retention == "7d"


def test_описанное_раньше_перетирается_только_по_разрешению(db):
    _сцена(db)
    _применить(db)
    ch = _канал(db)
    ch.delivery = "правка человека"
    db.flush()

    _применить(db)
    assert _канал(db).delivery == "правка человека"
    _применить(db, overwrite=True)
    assert _канал(db).delivery == "at-least-once"


def test_перезапись_не_стирает_метой_из_пустого_пакета(db):
    # Пустое поле у агента значит «не видно из моего репозитория», а не «этого нет»:
    # перезапись обязана трогать ТОЛЬКО заполненное пакетом.
    _сцена(db)
    _применить(db)
    _применить(db, ПАКЕТ.replace("    retention: 7d\n", ""), overwrite=True)
    assert _канал(db).retention == "7d"


def test_превью_ничего_не_пишет(db):
    _сцена(db)
    r = channels_import_preview(
        ChannelsImportIn(files=[{"name": "channels.yaml", "content": ПАКЕТ}]),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )
    assert not r.applied
    assert [i.action for i in r.channels] == ["create", "create"]
    assert db.query(BrokerChannel).count() == 0


def test_битый_yaml_нашего_файла_не_молчит(db):
    _сцена(db)
    r = _применить(db, "channels:\n  - name: x\n    description: ключ: значение\n")
    assert not r.applied
    # Иначе такой файл «не считался нашим», и пользователь получал «в пакете нет
    # файлов с каналами» — при том, что каналы в пакете были.
    assert any("YAML не разобрался" in e for e in r.errors)
    assert any("в кавычки" in e for e in r.errors)


def test_каналы_только_у_брокера_иначе_ошибка_с_перечнем(db):
    # Зеркало CRUD-правила «каналы — контракт узла-брокера»: применённое на сервисе
    # стало бы НЕВИДИМЫМ — секцию «Каналы» страница рендерит только у формы broker.
    _сцена(db)
    r = _применить(db, ПАКЕТ.replace("# archmap-node: Шина", "# archmap-node: Заказы"))

    assert not r.applied and db.query(BrokerChannel).count() == 0
    [e] = r.errors
    assert "объект «Заказы» — не брокер" in e
    # Перечень допустимых — чтобы слабая модель не гадала адрес во второй раз.
    assert "Узлы-брокеры проекта: Шина" in e


def test_объект_не_найден_называет_брокеры_проекта(db):
    # Слепая ошибка «не найден» стоила раунда переписки (урок Н8) — теперь ошибка
    # сама называет допустимые адреса.
    _сцена(db)
    вложенный = _node(db, "kafka", parent=_node(db, "Платформа", shape="service"))
    assert вложенный.parent_id is not None
    r = _применить(db, ПАКЕТ.replace("# archmap-node: Шина", "# archmap-node: Events Bus"))

    assert not r.applied
    [e] = r.errors
    assert "объект «Events Bus» не найден" in e
    # В перечне — оба брокера проекта, вложенный полным путём.
    assert "узлы-брокеры проекта: Платформа / kafka, Шина" in e


def test_без_адреса_каналы_едут_к_объекту_окна(db):
    шина, _сервис = _сцена(db)
    r = _применить(db, ПАКЕТ.replace("# archmap-node: Шина\n", ""), node_id=шина.id)

    assert r.applied and r.errors == []
    assert db.query(BrokerChannel).filter(BrokerChannel.node_id == шина.id).count() == 2


def test_ключ_archmap_node_адресом_не_считается_но_предупреждает(db):
    # Агент потерял решётку: адрес стал невидимым YAML-ключом, и каналы молча уехали
    # к объекту окна (урок Н11). Поведение прежнее, но тишины больше нет.
    шина, _сервис = _сцена(db)
    r = _применить(db, ПАКЕТ.replace("# archmap-node:", "archmap-node:"), node_id=шина.id)

    assert r.applied and r.errors == []
    assert db.query(BrokerChannel).filter(BrokerChannel.node_id == шина.id).count() == 2
    про_ключ = [w for w in r.warnings if "archmap-node" in w]
    assert len(про_ключ) == 1
    assert "адресом не является" in про_ключ[0] and "уедут к объекту окна" in про_ключ[0]


def test_группа_канала_различает_одноимённые(db):
    # group_name — уровень изоляции движка (vhost/namespace): одно имя в разных
    # группах — РАЗНЫЕ каналы, и уникальность считается по паре.
    шина, _сервис = _сцена(db)
    _применить(
        db,
        "# archmap-node: Шина\nchannels:\n"
        "  - name: audit\n"
        "  - name: audit\n    group: billing\n",
    )
    assert db.query(BrokerChannel).count() == 2
    assert {c.group_name for c in db.query(BrokerChannel).all()} == {"", "billing"}


# ── Промпт ────────────────────────────────────────────────────────────────────


def test_промпт_велит_прогонять_в_каждом_репозитории():
    """Ключевое отличие от промпта БД: репозитория-владельца у брокера нет, и
    инструкция «запускай у владельца» здесь была бы прямо вредной."""
    p = build_channels_prompt(["Ярмарка / events"])
    assert "У брокера нет «репозитория-владельца»" in p
    assert "в КАЖДОМ репозитории" in p
    assert "видит код этого репозитория" in p
    # Мету из головы (гарантия доставки, retention) выдумывать запрещено прямым текстом.
    assert "НЕ ВЫДУМЫВАЙ мету" in p and "оставь пустым" in p
    # Имена сшивают канал с пометками — они обязаны быть дословными (урок Н2).
    assert "ДОСЛОВНО из кода" in p and "Точки, дефисы и версии в имени — норма" in p
    # Смысл enum-подобных значений — самый частый вопрос сопровождения.
    assert "у полей со значениями-состояниями ОБЯЗАТЕЛЕН" in p
    # Кавычки — класс ошибок №1 слабой модели.
    assert "двоеточие с пробелом" in p
    # Обращения в этот пакет не входят: иначе агент пришлёт раздел, который некуда деть.
    assert "«публикует:/потребляет:» в схемах логики" in p


def test_единственный_брокер_подставлен_в_пример():
    # Адрес нарочно не похож на образцовый: подстановку видно, подмену — тоже.
    p = build_channels_prompt(["Ярмарка / events"])
    assert "## Куда адресовать" in p
    assert "# archmap-node: Ярмарка / events" in p
    assert "Платформа / Шина событий" not in p
    assert "Узел-брокер в этом проекте один" in p
    # Потерянная решётка — второй способ промахнуться мимо узла (урок Н11).
    assert "КОММЕНТАРИЕМ" in p and "именно с решёткой" in p


def test_адрес_из_образца_разбирается_нашим_же_парсером():
    """Адрес в образце копируют ДОСЛОВНО — значит, строка обязана извлекаться ровно в
    путь узла (та же гарантия, что у образца .mmd и у промпта структуры БД)."""
    m = NODE_HEADER.search(build_channels_prompt(["Ярмарка / events"]))
    assert m is not None and m.group(1) == "Ярмарка / events"


def test_несколько_брокеров_перечислены():
    p = build_channels_prompt(["Ярмарка / kafka", "Ярмарка / rabbit"])
    assert "Ярмарка / kafka" in p and "Ярмарка / rabbit" in p
    assert "ДОСЛОВНО из этого перечня" in p
    # Один файл — один брокер: иначе каналы двух движков слипнутся в одном адресе.
    assert "Один прогон описывает каналы ОДНОГО брокера" in p


def test_без_брокеров_промпт_велит_сначала_создать_узел():
    p = build_channels_prompt([])
    assert "сначала создайте его" in p
    assert "уедут к объекту, со страницы которого открыто окно" in p


def test_эндпоинт_подставляет_брокеры_проекта(db):
    система = _node(db, "Ярмарка", shape="service")
    _node(db, "events", parent=система)
    # Контейнер и база адресом каналов быть не могут — в перечне им не место.
    _node(db, "orders", shape="service", parent=система)
    _node(db, "orders-db", shape="database", parent=система)

    out = channels_prompt(db=db, project=ensure_project(db), _=ensure_architect(db))

    # Адрес — ПОЛНЫЙ путь узла: тот же, что понимает резолвер дозаливки.
    assert "Ярмарка / events" in out.prompt
    assert "orders-db" not in out.prompt
    assert "сначала создайте" not in out.prompt
