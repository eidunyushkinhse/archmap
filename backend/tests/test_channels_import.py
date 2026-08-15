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

from app.channels_import import (
    MAX_ADDRESS_WARNINGS,
    MAX_COVERAGE_WARNINGS,
    MAX_DUPLICATE_WARNINGS,
    parse_channels_file,
)
from app.channels_prompt import build_channels_prompt
from app.data_import import NODE_HEADER
from app.models.broker_channel import BrokerChannel
from app.models.channel_field import ChannelField
from app.models.edge import Edge
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


# ── Адресация при нескольких брокерах (Ф7, находка №1 qa-sentry-brokers.md) ───
# Валидатор проверял ФОРМУ владельца («брокер ли»), но не «тот ли брокер», и слабая
# модель сложила все 136 каналов Sentry на kafka — вместе с Celery-очередями,
# которым место на sentry-redis. Ответ у схемы есть: связь называет свой канал (Ф3).


def _сцена_двух_брокеров(db):
    kafka = _node(db, "kafka")
    redis = _node(db, "redis")
    сервис = _node(db, "Заказы", shape="service")
    return kafka, redis, сервис


def _связь(db, src, tgt, channel):
    e = Edge(
        id=uuid.uuid4(),
        project_id=ensure_project(db).id,
        source_id=src.id,
        target_id=tgt.id,
        channel=channel,
    )
    db.add(e)
    db.flush()
    return e


def _превью(db, текст, node_id=None):
    return channels_import_preview(
        ChannelsImportIn(
            files=[{"name": "channels.yaml", "content": текст}], node_id=node_id
        ),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )


def _адресные(r):
    """Замечания эвристики адресации — по хвосту «проверьте адресацию»."""
    return [w for w in r.warnings if "проверьте адресацию" in w]


def _пакет(*имена, адрес="kafka"):
    строки = "".join(f"  - name: {n}\n" for n in имена)
    return f"# archmap-node: {адрес}\nchannels:\n{строки}"


def test_канал_не_у_того_брокера_предупреждает(db):
    kafka, redis, сервис = _сцена_двух_брокеров(db)
    # Celery-очередь ходит в redis (так говорит схема), а пакет кладёт её на kafka.
    _связь(db, сервис, redis, "task-queue")

    r = _превью(db, _пакет("task-queue"))

    assert r.errors == []  # форма владельца верная — пакет применим
    [w] = _адресные(r)
    assert "канал «task-queue» адресован брокеру «kafka»" in w
    assert "связь «Заказы → redis»" in w
    assert "называет его у брокера «redis»" in w


def test_канал_у_правильного_брокера_молчит(db):
    kafka, _redis, сервис = _сцена_двух_брокеров(db)
    _связь(db, сервис, kafka, "orders.created")

    r = _превью(db, _пакет("orders.created"))

    assert _адресные(r) == []


def test_одноимённый_канал_у_обоих_брокеров_законен(db):
    # Два движка возят канал с одним именем — это не промах адресации: у брокера
    # связи он ОПИСАН, спорить не о чем.
    kafka, redis, сервис = _сцена_двух_брокеров(db)
    _связь(db, сервис, redis, "audit")
    db.add(BrokerChannel(id=uuid.uuid4(), node_id=redis.id, name="audit", group_name=""))
    db.flush()

    r = _превью(db, _пакет("audit"))

    assert _адресные(r) == []

    # И то же самое, когда «канал у обоих» приезжает ОДНИМ пакетом двумя файлами:
    # пакеты разных репозиториев доливаются друг к другу (§5 плана), и второй файл
    # закрывает вопрос к первому — живого канала у redis для этого имени ещё нет.
    _связь(db, сервис, redis, "payments")
    двумя_файлами = channels_import_preview(
        ChannelsImportIn(files=[
            {"name": "a.yaml", "content": _пакет("payments", адрес="kafka")},
            {"name": "b.yaml", "content": _пакет("payments", адрес="redis")},
        ]),
        db=db, project=ensure_project(db), _=ensure_architect(db),
    )
    assert _адресные(двумя_файлами) == []


def test_единственный_брокер_не_поводит_к_подозрениям(db):
    # Брокер один — адресовать больше некуда, и «расхождение» невозможно
    # по построению. Проверяем, что эвристика на такой проект не шумит.
    шина, сервис = _сцена(db)
    _связь(db, сервис, шина, "orders.created")

    r = _превью(db, _пакет("orders.created", адрес="Шина"))

    assert _адресные(r) == []


def test_кап_замечаний_адресации_и_хвост(db):
    kafka, redis, сервис = _сцена_двух_брокеров(db)
    имена = [f"очередь-{i}" for i in range(MAX_ADDRESS_WARNINGS + 2)]
    for имя in имена:
        _связь(db, сервис, redis, имя)

    r = _превью(db, _пакет(*имена))

    assert len(_адресные(r)) == MAX_ADDRESS_WARNINGS
    assert "…ещё 2 каналов адресованы вразрез со связями" in r.warnings


# ── Покрытие каналов, названных связями (Ф8е, полевая проверка Ф8) ────────────
# Импортный прогон ВЫДУМАЛ имя канала на связи (в коде такого слова нет, есть
# похожее), а канальный пакет пришёл идеальным — полсотни каналов, ноль замечаний.
# Поодиночке обе стороны шва выглядели здоровыми, и расхождение молчало до кривого
# AL31. Промпт этот минимум просит (Ф8д) — превью сверяет ТЕМ ЖЕ перечнем.


def _покрытие(r):
    """Замечания о непокрытых каналах связей — по хвосту «проверьте связь»."""
    return [w for w in r.warnings if "проверьте связь" in w]


def test_непокрытый_канал_связи_предупреждает_и_подсказывает(db):
    шина, сервис = _сцена(db)
    _связь(db, сервис, шина, "task-worker")

    r = _превью(db, _пакет("taskworker", адрес="Шина"))

    # Кто ошибся, машина не знает: замечание называет ОБЕ ветки починки (имя в коде
    # другое → чинится пакет; имя на связи неточно → чинится схема).
    # ⚠ Хвост про «не добавляйте канал» — анти-соглашательство (П12 тюнинга федерации):
    # на это замечание модель добавила несуществующий канал-обёртку, лишь бы валидатор
    # замолчал. Вторая ветка починки обязана быть названа прямым текстом.
    assert _покрытие(r) == [
        "связь «Заказы → Шина» называет канал «task-worker», но его нет ни в пакете, "
        "ни в описании брокера — либо в коде он зовётся иначе (похоже на "
        "«taskworker»), либо имя на связи неточно: проверьте связь. "
        "Канала нет в коде — НЕ добавляйте его в пакет: чините имя на связи."
    ]


def test_непокрытый_канал_без_уверенного_кандидата_подсказки_не_несёт(db):
    # Тот же порог, что у пометок (Ф8б): ложная подсказка хуже отсутствия — её
    # копируют не глядя, и вместо выдуманного имени появится другое выдуманное.
    шина, сервис = _сцена(db)
    _связь(db, сервис, шина, "billing-tasks")

    r = _превью(db, _пакет("taskworker", адрес="Шина"))

    [w] = _покрытие(r)
    assert "называет канал «billing-tasks»" in w
    assert "похоже на" not in w


def test_канал_описанный_пакетом_молчит(db):
    шина, сервис = _сцена(db)
    _связь(db, сервис, шина, "orders.created")

    r = _превью(db, _пакет("orders.created", адрес="Шина"))

    assert _покрытие(r) == []


def test_живой_канал_брокера_молчит(db):
    # Минимум мог быть покрыт ПРОШЛЫМ пакетом (у брокера нет репозитория-владельца,
    # пакеты приезжают из разных репозиториев) — требовать его снова нельзя.
    шина, сервис = _сцена(db)
    _применить(db)  # orders.created и orders.paid описаны раньше
    _связь(db, сервис, шина, "orders.created")

    r = _превью(db, _пакет("orders.shipped", адрес="Шина"))

    assert _покрытие(r) == []


def test_перечень_в_channel_расщеплён_при_сверке_покрытия(db):
    # Связь с перечнем в живом проекте уже есть (её ругает Ф8г) — сверять надо
    # ИМЕНАМИ, иначе покрытая половина перечня считалась бы непокрытой.
    шина, сервис = _сцена(db)
    _связь(db, сервис, шина, "orders.created; task-worker")

    r = _превью(db, _пакет("orders.created", адрес="Шина"))

    [w] = _покрытие(r)
    assert "называет канал «task-worker»" in w


def test_послабление_группа_канал_при_сверке_молчит(db):
    # Послабления имени — те же, что у алерта AL31 и у пометок: связь вправе назвать
    # канал «группа.канал» (vhost RabbitMQ, namespace Pulsar, account NATS).
    шина, сервис = _сцена(db)
    _связь(db, сервис, шина, "vhost.tasks")

    r = _превью(db, "# archmap-node: Шина\nchannels:\n  - name: tasks\n    group: vhost\n")

    assert _покрытие(r) == []


def test_канал_адресованный_другому_брокеру_замечание_не_дублирует(db):
    # Об этом расхождении уже говорит эвристика адресации (Ф7б): пакет положил канал
    # соседнему брокеру. Две строки об одном промахе агент чинит дважды.
    kafka, redis, сервис = _сцена_двух_брокеров(db)
    _связь(db, сервис, redis, "task-queue")

    r = channels_import_preview(
        ChannelsImportIn(
            files=[
                {"name": "kafka.yaml", "content": _пакет("task-queue", адрес="kafka")},
                {"name": "redis.yaml", "content": _пакет("cache.events", адрес="redis")},
            ],
            node_id=None,
        ),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )

    assert _покрытие(r) == []
    assert len(_адресные(r)) == 1


def test_кап_непокрытых_каналов_и_хвост(db):
    шина, сервис = _сцена(db)
    for i in range(MAX_COVERAGE_WARNINGS + 3):
        _связь(db, сервис, шина, f"очередь-{i}")

    r = _превью(db, _пакет("orders.created", адрес="Шина"))

    assert len(_покрытие(r)) == MAX_COVERAGE_WARNINGS
    assert "…ещё 3 каналов, названных связями, не описаны" in r.warnings


# ── Один канал в НЕСКОЛЬКИХ файлах пакета (находка полевого QA Ф3) ────────────
# Пакет Zulip: перечень очередей rabbitmq и подробные файлы по отдельным очередям
# описали четыре канала дважды. Превью молчало и показывало их ДВУМЯ строками
# «create» с разным числом полей, а применение падало 500-й — второй файл лил
# одноимённое поле в канал, только что созданный первым (uq_channel_field_name).
# Дубль внутри пакета законен (файлы собраны разными прогонами), значит слияние —
# по тому же правилу, что у пакетов разных репозиториев: побеждает описанный раньше.

ФАЙЛ_ОЧЕРЕДЕЙ = """# archmap-node: Шина
channels:
  - name: notify_tornado
    kind: queue
    delivery: at-least-once
    description: события веб-клиентам
    fields:
      - name: event
        type: object
        required: true
        description: тело события
      - name: users
        type: object
"""

# Тот же канал подробным файлом: поле «event» пересекается, «port» — нет, delivery
# расходится, retention виден только отсюда.
ФАЙЛ_ПОДРОБНЫЙ = """# archmap-node: Шина
channels:
  - name: notify_tornado
    kind: queue
    delivery: exactly-once
    retention: до ack
    fields:
      - name: event
        type: string
        description: сериализованное событие
      - name: port
        type: int64
        required: true
"""

ДВА_ФАЙЛА = [("a.yaml", ФАЙЛ_ОЧЕРЕДЕЙ), ("b.yaml", ФАЙЛ_ПОДРОБНЫЙ)]


def _пакет_из(файлы, overwrite=False, node_id=None):
    return ChannelsImportIn(
        files=[{"name": имя, "content": текст} for имя, текст in файлы],
        overwrite=overwrite,
        node_id=node_id,
    )


def _превью_файлами(db, файлы, node_id=None):
    return channels_import_preview(
        _пакет_из(файлы, node_id=node_id),
        db=db,
        project=ensure_project(db),
        _=ensure_architect(db),
    )


def _применить_файлами(db, файлы, overwrite=False, node_id=None):
    return channels_import_apply(
        _пакет_из(файлы, overwrite=overwrite, node_id=node_id),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )


def _дубли(r):
    """Замечания о канале из нескольких файлов — по хвосту «побеждает первый файл»
    (общее «в нескольких файлах» поймало бы и строку капа)."""
    return [w for w in r.warnings if "побеждает первый файл" in w]


def test_канал_из_двух_файлов_пакета_сливается_в_одну_строку(db):
    _сцена(db)

    r = _превью_файлами(db, ДВА_ФАЙЛА)

    assert r.errors == []
    [строка] = r.channels
    # Источник — файл ПЕРВОГО вхождения, а число полей — уже после слияния:
    # event (в обоих файлах) + users + port.
    assert (строка.source, строка.name, строка.action) == (
        "a.yaml", "notify_tornado", "create",
    )
    assert строка.fields == 3
    [w] = _дубли(r)
    assert "канал «notify_tornado» описан в нескольких файлах пакета (a.yaml, b.yaml)" in w
    assert "поля сольются в один канал" in w
    assert "при совпадении имени поля и расхождении меты побеждает первый файл" in w


def test_межфайловый_дубль_применяется_и_побеждает_первый_файл(db):
    """Тот самый 500-й: второй файл лил поле «event» в канал, только что созданный
    первым, и падал на уникальности (channel_id, name)."""
    _сцена(db)

    r = _применить_файлами(db, ДВА_ФАЙЛА)

    assert r.applied and r.errors == []
    assert db.query(BrokerChannel).count() == 1
    ch = _канал(db, "notify_tornado")
    # Поля объединились по имени, порядок сообщения не перемешан.
    assert [f.name for f in ch.fields] == ["event", "users", "port"]
    event = next(f for f in ch.fields if f.name == "event")
    assert (event.type, event.description) == ("object", "тело события")
    assert ch.delivery == "at-least-once"
    assert r.channels_written == 1 and r.fields_written == 3

    # Повторный прогон того же пакета ничего не дописывает (инвариант модуля).
    повтор = _применить_файлами(db, ДВА_ФАЙЛА)
    assert db.query(BrokerChannel).count() == 1
    assert db.query(ChannelField).count() == 3
    assert (повтор.channels_written, повтор.fields_written) == (0, 0)
    assert [i.action for i in повтор.channels] == ["unchanged"]


def test_расхождение_меты_между_файлами_замечает_и_берёт_первое(db):
    # Файлы собраны разными прогонами и честно видят разное. Молча взять последнее —
    # значит поставить смысл карты в зависимость от порядка файлов в пакете.
    _сцена(db)

    r = _превью_файлами(db, ДВА_ФАЙЛА)

    [w] = [w for w in r.warnings if "delivery" in w]
    assert w == (
        "b.yaml: канал «notify_tornado» — delivery «exactly-once», а в a.yaml "
        "«at-least-once»; оставлено значение из a.yaml (описан раньше)"
    )
    # Применение оставляет ровно то значение, о котором сказало превью.
    _применить_файлами(db, ДВА_ФАЙЛА)
    assert _канал(db, "notify_tornado").delivery == "at-least-once"


def test_мету_которой_нет_в_первом_файле_второй_доливает_молча(db):
    # «Не знаю» не спорит со «знаю» — то же правило, что у меты из ArchMap: файл про
    # один срез кода не видит того, что видел другой.
    _сцена(db)

    r = _применить_файлами(db, ДВА_ФАЙЛА)

    assert _канал(db, "notify_tornado").retention == "до ack"  # только во втором файле
    assert [w for w in r.warnings if "retention" in w] == []


def test_превью_и_применение_дают_один_план(db):
    # Расхождение этих двух планов и было багой: превью показывало две строки
    # «create», применение — 500-ю.
    _сцена(db)

    п = _превью_файлами(db, ДВА_ФАЙЛА)
    р = _применить_файлами(db, ДВА_ФАЙЛА)

    assert [i.model_dump() for i in п.channels] == [i.model_dump() for i in р.channels]
    assert п.warnings == р.warnings and р.errors == []


def test_одно_имя_у_разных_брокеров_остаётся_двумя_каналами(db):
    # Слияние — по «узел + группа + имя»: два движка законно возят одноимённый канал,
    # и склейка потеряла бы один из них.
    _сцена_двух_брокеров(db)

    r = _применить_файлами(db, [
        ("kafka.yaml", _пакет("audit", адрес="kafka")),
        ("redis.yaml", _пакет("audit", адрес="redis")),
    ])

    assert len(r.channels) == 2
    assert db.query(BrokerChannel).count() == 2
    assert _дубли(r) == []


def test_поле_названное_дважды_в_одном_канале_не_задваивается(db):
    # Неряшливость того же класса внутри одного файла: превью показало бы завышенное
    # число полей, а применение упало бы на той же уникальности.
    _сцена(db)

    r = _применить(
        db,
        "# archmap-node: Шина\nchannels:\n  - name: tasks\n    fields:\n"
        "      - name: id\n        type: uuid\n"
        "      - name: id\n        type: string\n",
    )

    assert r.applied and r.errors == []
    assert [(f.name, f.type) for f in _канал(db, "tasks").fields] == [("id", "uuid")]
    assert [i.fields for i in r.channels] == [1]


def test_кап_замечаний_о_дублях_и_хвост(db):
    _сцена(db)
    имена = [f"очередь-{i}" for i in range(MAX_DUPLICATE_WARNINGS + 2)]

    r = _превью_файлами(db, [
        ("a.yaml", _пакет(*имена, адрес="Шина")),
        ("b.yaml", _пакет(*имена, адрес="Шина")),
    ])

    assert len(_дубли(r)) == MAX_DUPLICATE_WARNINGS
    assert "…ещё 2 каналов описаны в нескольких файлах пакета" in r.warnings


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


def test_при_двух_брокерах_промпт_учит_класть_канал_ЕГО_владельцу():
    """Находка №1 полевого QA: перечня брокеров мало — слабая модель адресовала ВСЕ
    136 каналов первому узлу перечня, включая Celery-очереди чужого брокера. Правило
    выбора («чей клиент им пользуется по коду») обязано быть в промпте отдельно."""
    p = build_channels_prompt(["Ярмарка / kafka", "Ярмарка / redis"])
    assert "## В проекте НЕСКОЛЬКО брокеров" in p
    assert "У КАЖДОГО брокера свой файл со своим адресом" in p
    # Именно по коду, а не по правдоподобию: два самых частых движка названы прямо.
    assert "Celery" in p and "Kafka-топики — узлу Kafka" in p
    assert "НЕ адресуй все каналы одному брокеру потому, что он первый в перечне" in p


def test_при_одном_брокере_раздел_про_несколько_не_шумит():
    # Выбирать не из чего: лишний абзац разбавляет правила, которые работают.
    p = build_channels_prompt(["Ярмарка / events"])
    assert "В проекте НЕСКОЛЬКО брокеров" not in p
    assert "НЕ адресуй все каналы одному брокеру" not in p


def test_без_брокеров_промпт_велит_сначала_создать_узел():
    p = build_channels_prompt([])
    assert "сначала создайте его" in p
    assert "уедут к объекту, со страницы которого открыто окно" in p


# ── Каналы, которые уже назвала схема (Ф8д, находка №4 qa-zulip-brokers.md) ────
# Канальная и доковая сессии ОДНОЙ модели разошлись в перечне очередей: канальная
# шла от каталога потребителей и не увидела очередь, в которую код только пишет, а
# доковая пометила её девять раз (девять честных AL30 об одном канале). Схема —
# второй независимый источник, и она этот канал уже называет.


def test_промпт_называет_каналы_которые_уже_знает_схема():
    p = build_channels_prompt(
        ["Ярмарка / kafka", "Ярмарка / redis"],
        {"Ярмарка / kafka": ["orders.created"], "Ярмарка / redis": ["task-queue"]},
    )

    assert "## Каналы, которые уже называет схема" in p
    assert "- «Ярмарка / kafka»: orders.created" in p
    assert "- «Ярмарка / redis»: task-queue" in p
    # Это МИНИМУМ пакета, а не разрешение выдумать недостающее по имени.
    assert "это минимум пакета" in p
    assert "не выдумывай: назови его в финальном ответе" in p


def test_без_каналов_на_связях_раздела_в_промпте_нет():
    # Схема ещё не называет ни одного канала — заголовок над пустотой сказал бы
    # «схема их не знает», хотя знать пока нечего.
    base = build_channels_prompt(["Ярмарка / kafka"])

    assert build_channels_prompt(["Ярмарка / kafka"], {}) == base
    assert build_channels_prompt(["Ярмарка / kafka"], {"Ярмарка / kafka": []}) == base
    assert "уже называет схема" not in base


def test_промпт_велит_искать_и_точки_публикации():
    # Половина находки №4 на стороне обнаружения: перечень воркеров даёт только
    # потребителей, и очередь, в которую этот код лишь публикует, теряется.
    p = build_channels_prompt(["Ярмарка / kafka"])

    assert "Ищи и точки ПУБЛИКАЦИИ" in p
    assert "очередь, в которую из этого кода только пишут" in p


def test_эндпоинт_несёт_каналы_названные_связями(db):
    kafka, redis, сервис = _сцена_двух_брокеров(db)
    бд = _node(db, "orders-db", shape="database")
    _связь(db, сервис, kafka, "orders.created")
    # Перечень в channel (превью импорта его ругает, но в живом проекте он уже есть)
    # промпту нужен ИМЕНАМИ, а не строкой целиком: и по запятой, и по «;», и без
    # пробела после разделителя.
    _связь(db, сервис, redis, "notify_tornado,email; digest_emails")
    _связь(db, сервис, бд, "мимо-брокера")

    out = channels_prompt(db=db, project=ensure_project(db), _=ensure_architect(db))

    assert "- «kafka»: orders.created" in out.prompt
    assert "- «redis»: digest_emails, email, notify_tornado" in out.prompt
    # Конец не брокер — канал связи к перечню не относится.
    assert "мимо-брокера" not in out.prompt


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
