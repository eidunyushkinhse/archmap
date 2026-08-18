"""Тесты глобальных алертов незавершённости схемы (GET /nodes/alerts).

Покрывают три проверки:
1) подвисшие атомарные узлы без связей;
2) связи в промежуточный (контейнерный) узел;
3) изолированные группы — связные компоненты графа рёбер (иерархию
   parent_id игнорируем; зажигается только при ≥2 группах размера ≥2).
"""

import uuid

from conftest import ensure_project

from app.models.edge import Edge
from app.models.node import Node
from app.routers.nodes import get_alerts


def _node(db, name, parent=None, **kw):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
        **kw,
    )
    db.add(n)
    return n


def _edge(db, src, tgt, **kw):
    e = Edge(
        id=uuid.uuid4(),
        source_id=src.id,
        target_id=tgt.id,
        project_id=ensure_project(db).id,
        **kw,
    )
    db.add(e)
    return e


def test_disconnected_and_intermediate(db):
    # Лист без связей (подвисший), пара связанных листьев, контейнер с ребёнком.
    a = _node(db, "A")
    b = _node(db, "B")
    _node(db, "Подвисший")
    box = _node(db, "Контейнер")
    child = _node(db, "Ребёнок", box)
    _edge(db, a, b)        # нормальная связь лист↔лист
    _edge(db, a, box)      # связь в промежуточный узел
    _edge(db, child, b)    # ребёнок связан → не подвисает (иначе попал бы в disconnected)
    db.commit()

    res = get_alerts(db=db, project=ensure_project(db))

    # «Подвисший» без связей — в disconnected; контейнер (промежуточный) и
    # связанный ребёнок туда не идут.
    assert [d.node_name for d in res.disconnected_nodes] == ["Подвисший"]
    # Ровно одна связь упирается в промежуточный узел (A→Контейнер).
    assert len(res.intermediate_edges) == 1
    ie = res.intermediate_edges[0]
    assert ie.target_name == "Контейнер" and ie.target_is_intermediate
    assert not ie.source_is_intermediate
    # Один связный кластер (A,B,Контейнер,Ребёнок) → фрагментации нет.
    assert res.isolated_groups == []


def test_isolated_groups_when_fragmented(db):
    # Два не связанных между собой кластера: A↔B и В↔Г. Плюс висячий узел —
    # он в группы НЕ попадает (его ловит disconnected).
    a = _node(db, "A")
    b = _node(db, "B")
    v = _node(db, "В")
    g = _node(db, "Г")
    _node(db, "Висячий")
    _edge(db, a, b)
    _edge(db, v, g)
    db.commit()

    res = get_alerts(db=db, project=ensure_project(db))

    assert len(res.isolated_groups) == 2
    groups = sorted(sorted(grp.node_names) for grp in res.isolated_groups)
    assert groups == [["A", "B"], ["В", "Г"]]


def test_single_cluster_plus_dangling_is_not_fragmented(db):
    # Один связный кластер + висячие узлы — это НЕ фрагментация.
    a = _node(db, "A")
    b = _node(db, "B")
    c = _node(db, "C")
    _node(db, "Висячий1")
    _node(db, "Висячий2")
    _edge(db, a, b)
    _edge(db, b, c)
    db.commit()

    res = get_alerts(db=db, project=ensure_project(db))

    assert res.isolated_groups == []
    assert len(res.disconnected_nodes) == 2


# =================== 5) Люди внутри системы ===================

def _person(db, name, parent=None):
    n = _node(db, name, parent)
    n.shape = "person"
    return n


def test_человек_внутри_контейнера_попадает_в_алерт(db):
    # C4: актор живёт на контекстном уровне, ВНЕ границы системы. Промпт импорта
    # это требует, а объекты, заведённые руками, до этой проверки не ловил никто.
    система = _node(db, "Маркетплейс")
    _person(db, "Покупатель", система)
    db.commit()

    out = get_alerts(db=db, project=ensure_project(db), _=None)

    assert [(p.node_name, p.parent_name) for p in out.persons_inside] == [("Покупатель", "Маркетплейс")]


def test_человек_в_корне_алерт_не_зажигает(db):
    система = _node(db, "Маркетплейс")
    _person(db, "Покупатель")
    _edge(db, _person(db, "Продавец"), система)
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).persons_inside == []


def test_обычный_узел_внутри_контейнера_не_человек(db):
    # Проверка бьёт именно по форме узла, а не по вложенности как таковой.
    система = _node(db, "Маркетплейс")
    _node(db, "Сервис заказов", система)
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).persons_inside == []


# =================== 6) Повисшие сообщения процессов ===================

def test_удаление_связи_делает_сообщение_повисшим_в_алертах(db):
    # Полный путь, а не подложенный NULL: создаём сообщение по живой связи, затем
    # удаляем связь из схемы. ON DELETE SET NULL сохраняет сообщение — расхождение
    # процесса со схемой должно быть ВИДНО, и теперь видно на уровне схемы.
    from app.models.business_process import BusinessProcess
    from app.models.process_message import ProcessMessage
    from app.models.process_participant import ProcessParticipant

    покупатель = _node(db, "Покупатель")
    заказы = _node(db, "Сервис заказов")
    связь = _edge(db, покупатель, заказы)
    процесс = BusinessProcess(id=uuid.uuid4(), name="Оформление заказа", project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    отправитель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=покупатель.id, name=покупатель.name, order=0)
    получатель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=заказы.id, name=заказы.name, order=1)
    db.add_all([отправитель, получатель])
    db.flush()
    db.add(ProcessMessage(
        id=uuid.uuid4(), process_id=процесс.id, order=0, edge_id=связь.id, leg="forward",
        from_participant_id=отправитель.id, to_participant_id=получатель.id, caption="создать заказ",
    ))
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).dangling_messages == []

    db.delete(связь)
    db.commit()

    out = get_alerts(db=db, project=ensure_project(db), _=None).dangling_messages
    assert len(out) == 1
    assert (out[0].process_name, out[0].caption) == ("Оформление заказа", "создать заказ")
    assert (out[0].from_name, out[0].to_name) == ("Покупатель", "Сервис заказов")


def test_самосообщение_повисшим_не_считается(db):
    # У внутренней операции участника связи C4 не было — терять нечего.
    from app.models.business_process import BusinessProcess
    from app.models.process_message import ProcessMessage
    from app.models.process_participant import ProcessParticipant

    сервис = _node(db, "Сервис заказов")
    процесс = BusinessProcess(id=uuid.uuid4(), name="P", project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    участник = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=сервис.id, name=сервис.name, order=0)
    db.add(участник)
    db.flush()
    db.add(ProcessMessage(
        id=uuid.uuid4(), process_id=процесс.id, order=0, edge_id=None, leg="forward",
        from_participant_id=участник.id, to_participant_id=участник.id, caption="посчитать скидку",
    ))
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).dangling_messages == []


# =================== 7) Участники процессов без узла (AL27) ===================

def test_удаление_узла_даёт_участника_без_узла_в_алертах(db):
    """Полный путь, а не подложенный NULL: заводим участника на живом узле и удаляем
    узел. FK гасит ссылку (SET NULL), процесс переживает удаление — и расхождение со
    схемой обязано быть видно, иначе линия жизни висит в пустоте молча."""
    from app.models.business_process import BusinessProcess
    from app.models.process_participant import ProcessParticipant

    сервис = _node(db, "Сервис заказов")
    процесс = BusinessProcess(id=uuid.uuid4(), name="Оформление заказа", project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    db.add(ProcessParticipant(
        id=uuid.uuid4(), process_id=процесс.id, node_id=сервис.id, name=сервис.name, order=0,
    ))
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).unbound_participants == []

    db.delete(сервис)
    db.commit()

    out = get_alerts(db=db, project=ensure_project(db), _=None).unbound_participants
    assert len(out) == 1
    assert (out[0].process_name, out[0].name) == ("Оформление заказа", "Сервис заказов")


def test_привязанный_участник_в_алерт_не_попадает(db):
    from app.models.business_process import BusinessProcess
    from app.models.process_participant import ProcessParticipant

    сервис = _node(db, "Сервис")
    процесс = BusinessProcess(id=uuid.uuid4(), name="P", project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    db.add(ProcessParticipant(
        id=uuid.uuid4(), process_id=процесс.id, node_id=сервис.id, name=сервис.name, order=0,
    ))
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).unbound_participants == []


def test_повисший_шаг_непривязанного_показывает_его_имя(db):
    """Регрессия смены модели: конец повисшего шага брался только из имён УЗЛОВ, и у
    непривязанного участника показался бы «?»."""
    from app.models.business_process import BusinessProcess
    from app.models.process_message import ProcessMessage
    from app.models.process_participant import ProcessParticipant

    покупатель = _node(db, "Покупатель")
    заказы = _node(db, "Сервис заказов")
    связь = _edge(db, покупатель, заказы)
    процесс = BusinessProcess(id=uuid.uuid4(), name="P", project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    отправитель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=покупатель.id, name=покупатель.name, order=0)
    получатель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=заказы.id, name=заказы.name, order=1)
    db.add_all([отправитель, получатель])
    db.flush()
    db.add(ProcessMessage(
        id=uuid.uuid4(), process_id=процесс.id, order=0, edge_id=связь.id, leg="forward",
        from_participant_id=отправитель.id, to_participant_id=получатель.id, caption="создать заказ",
    ))
    db.commit()

    db.delete(покупатель)  # узел ушёл: участник осиротел, шаг повис
    db.commit()

    out = get_alerts(db=db, project=ensure_project(db), _=None).dangling_messages
    assert len(out) == 1
    assert out[0].from_name == "Покупатель"  # а не «?»


# ============ 8) Шаги с исчезнувшим плечом канала (AL28) ============

def test_смена_канала_на_асинхронный_ломает_шаг_ответа(db):
    """Полный путь, а не подложенное состояние: заводим ответ на СИНХРОННОМ канале и
    переключаем канал в асинхронный. Плеча «ответ» у такого канала нет
    (legs_for_edge), create_message его отклоняет — но уже созданный шаг переживал
    смену молча и продолжал считаться корректным (находка приёмки 2026-08-10)."""
    from app.models.business_process import BusinessProcess
    from app.models.process_message import ProcessMessage
    from app.models.process_participant import ProcessParticipant

    покупатель = _node(db, "Покупатель")
    заказы = _node(db, "Сервис заказов")
    связь = _edge(db, покупатель, заказы)
    связь.is_synchronous = True
    связь.label = "оформить заказ"
    процесс = BusinessProcess(id=uuid.uuid4(), name="Оформление заказа", project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    отправитель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=покупатель.id, name=покупатель.name, order=0)
    получатель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=заказы.id, name=заказы.name, order=1)
    db.add_all([отправитель, получатель])
    db.flush()
    db.add(ProcessMessage(
        id=uuid.uuid4(), process_id=процесс.id, order=0, edge_id=связь.id, leg="return",
        from_participant_id=получатель.id, to_participant_id=отправитель.id, caption="номер заказа",
    ))
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).orphan_legs == []

    связь.is_synchronous = False  # плечо «ответ» исчезло
    db.commit()

    out = get_alerts(db=db, project=ensure_project(db), _=None).orphan_legs
    assert len(out) == 1
    assert (out[0].process_name, out[0].caption) == ("Оформление заказа", "номер заказа")
    assert out[0].edge_label == "оформить заказ"  # чем связь узнать на схеме
    assert (out[0].from_name, out[0].to_name) == ("Сервис заказов", "Покупатель")
    # Связь на месте — это НЕ «сообщение без связи», и чинится оно иначе.
    assert get_alerts(db=db, project=ensure_project(db), _=None).dangling_messages == []


def test_вызов_на_асинхронном_канале_цел(db):
    """Плечо forward есть у ЛЮБОГО канала — асинхронность ломает только «ответ»."""
    from app.models.business_process import BusinessProcess
    from app.models.process_message import ProcessMessage
    from app.models.process_participant import ProcessParticipant

    покупатель = _node(db, "Покупатель")
    заказы = _node(db, "Сервис заказов")
    связь = _edge(db, покупатель, заказы)
    связь.is_synchronous = False
    процесс = BusinessProcess(id=uuid.uuid4(), name="P", project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    отправитель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=покупатель.id, name=покупатель.name, order=0)
    получатель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=заказы.id, name=заказы.name, order=1)
    db.add_all([отправитель, получатель])
    db.flush()
    db.add(ProcessMessage(
        id=uuid.uuid4(), process_id=процесс.id, order=0, edge_id=связь.id, leg="forward",
        from_participant_id=отправитель.id, to_participant_id=получатель.id, caption="событие",
    ))
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).orphan_legs == []


def test_канал_без_явной_синхронности_плечо_не_теряет(db):
    """is_synchronous nullable, NULL = синхронный по умолчанию (легаси-связи).
    Сравнение обязано быть с False, иначе весь легаси разом уехал бы в алерт."""
    from app.models.business_process import BusinessProcess
    from app.models.process_message import ProcessMessage
    from app.models.process_participant import ProcessParticipant

    покупатель = _node(db, "Покупатель")
    заказы = _node(db, "Сервис заказов")
    связь = _edge(db, покупатель, заказы)  # is_synchronous не задан → NULL
    процесс = BusinessProcess(id=uuid.uuid4(), name="P", project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    отправитель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=покупатель.id, name=покупатель.name, order=0)
    получатель = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id, node_id=заказы.id, name=заказы.name, order=1)
    db.add_all([отправитель, получатель])
    db.flush()
    db.add(ProcessMessage(
        id=uuid.uuid4(), process_id=процесс.id, order=0, edge_id=связь.id, leg="return",
        from_participant_id=получатель.id, to_participant_id=отправитель.id, caption="ответ",
    ))
    db.commit()

    assert get_alerts(db=db, project=ensure_project(db), _=None).orphan_legs == []


# ====== 9) Пометки обращений, не нашедшие цели (AL29) ======
# Пометка «читает:/пишет:» в тексте схемы логики — ОБЕЩАНИЕ ФАКТА. Невыполненное
# обещание не имеет права молчать: обратный индекс базы такую пометку не показывает
# вовсе, а обращение с несуществующей колонкой показывает как обращение к таблице
# целиком — алерт остаётся единственным местом, где расхождение со структурой видно.


def _таблица(db, узел, name="orders", schema=""):
    from app.models.db_table import DbTable

    t = DbTable(id=uuid.uuid4(), node_id=узел.id, name=name, schema_name=schema)
    db.add(t)
    db.flush()
    return t


def _колонка(db, таблица, name="status"):
    from app.models.db_column import DbColumn

    c = DbColumn(id=uuid.uuid4(), table_id=таблица.id, name=name, type="varchar(16)")
    db.add(c)
    db.flush()
    return c


def _док(db, узел, name="POST /pay", content=""):
    from app.models.node_doc import NodeDoc

    d = NodeDoc(id=uuid.uuid4(), node_id=узел.id, name=name, kind="operation", content=content)
    db.add(d)
    db.flush()
    return d


def _пометки(db):
    return get_alerts(db=db, project=ensure_project(db), _=None).unresolved_data_refs


def test_битая_пометка_даёт_алерт(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг")
    _таблица(db, бд, "orders")
    _док(db, сервис, "POST /pay", 'A["Списать<br>пишет: ordrs.status"]')
    db.commit()

    [алерт] = _пометки(db)

    # Адрес починки — у ВЫЗЫВАЮЩЕГО: чинится текст его схемы логики, а не структура базы.
    assert (алерт.node_name, алерт.doc_name) == ("Биллинг", "POST /pay")
    assert (алерт.ref, алерт.mode, алерт.reason) == ("ordrs.status", "write", "unknown_table")


def test_здоровая_пометка_алерта_не_даёт(db):
    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг")
    t = _таблица(db, бд, "orders")
    _колонка(db, t, "status")
    _док(db, сервис, content='A["пишет: orders.status"]')
    _док(db, сервис, "Обзор")  # док без текста: не падаем и не шумим
    db.commit()

    assert _пометки(db) == []


def test_неоднозначная_пометка_попадает_в_алерт(db):
    бд = _node(db, "Хранилище")
    кэш = _node(db, "Кэш")
    сервис = _node(db, "Биллинг")
    _таблица(db, бд, "orders")
    _таблица(db, кэш, "orders")  # одноимённая в другой базе → голое «orders» неоднозначно
    док = _док(db, сервис, content='A["читает: orders"]')
    db.commit()

    [алерт] = _пометки(db)
    assert алерт.reason == "ambiguous"

    # Квалификатор «БД / таблица» снимает алерт — угадывать за пользователя нельзя,
    # но и тупиком алерт не является.
    док.content = 'A["читает: Кэш / orders"]'
    db.commit()
    assert _пометки(db) == []


def test_битая_колонка_видна_только_алертом(db):
    from app.routers.db_docs import list_usage

    бд = _node(db, "Хранилище")
    сервис = _node(db, "Биллинг")
    t = _таблица(db, бд, "orders")
    _колонка(db, t, "status")
    _док(db, сервис, content='A["пишет: orders.discount"]')
    db.commit()

    [алерт] = _пометки(db)
    assert алерт.reason == "unknown_column"
    # А обратный индекс базы ту же пометку показывает как обращение к таблице ЦЕЛИКОМ:
    # колонки в строке нет, и без алерта опечатка осталась бы незамеченной.
    [строка] = list_usage(бд.id, db=db, project=ensure_project(db), _=None)
    assert (строка.table_name, строка.column_name) == ("orders", None)


def test_порядок_алертов_детерминированный(db):
    # Порядок появляется только после разбора текста (ORDER BY тут не помогает), а
    # прыгающий от запроса к запросу список панель делает нечитаемой.
    # Порядок ввода СПЕЦИАЛЬНО обратный ожидаемому — и по узлам, и внутри дока:
    # без сортировки ответ повторил бы порядок вставки.
    бд = _node(db, "Хранилище")
    заказы = _node(db, "Заказы")
    биллинг = _node(db, "Биллинг")
    _таблица(db, бд, "orders")
    _док(db, заказы, "GET /orders", 'A["читает: нет_такой"]')
    _док(db, биллинг, "POST /pay", 'A["читает: счета, ordrs"]')
    db.commit()

    assert [(a.node_name, a.doc_name, a.ref) for a in _пометки(db)] == [
        ("Биллинг", "POST /pay", "ordrs"),
        ("Биллинг", "POST /pay", "счета"),
        ("Заказы", "GET /orders", "нет_такой"),
    ]


# ====== 10) Пометки каналов, не нашедшие цели (AL30) ======
# Зеркало AL29 для событий, но КЛАСС ОТДЕЛЬНЫЙ (решение §7.4 plan-broker-docs.md):
# причины и слова починки свои («укажите „Брокер / канал“»), а мешать топики с
# таблицами в одной строке панели значит запутать починку.


def _канал(db, узел, name="созданные", group=""):
    from app.models.broker_channel import BrokerChannel

    c = BrokerChannel(id=uuid.uuid4(), node_id=узел.id, name=name, group_name=group)
    db.add(c)
    db.flush()
    return c


def _поле(db, канал, name="order_id"):
    from app.models.channel_field import ChannelField

    f = ChannelField(id=uuid.uuid4(), channel_id=канал.id, name=name, type="uuid")
    db.add(f)
    db.flush()
    return f


def _каналы(db):
    return get_alerts(db=db, project=ensure_project(db), _=None).unresolved_channel_refs


def test_битая_канальная_пометка_даёт_алерт(db):
    брокер = _node(db, "Kafka")
    сервис = _node(db, "Заказы")
    _канал(db, брокер, "созданные")
    _док(db, сервис, "POST /orders", 'A["Оформить<br>публикует: создание"]')
    db.commit()

    [алерт] = _каналы(db)

    # Адрес починки — у ВЫЗЫВАЮЩЕГО: чинится текст его схемы, а не структура брокера.
    assert (алерт.node_name, алерт.doc_name) == ("Заказы", "POST /orders")
    assert (алерт.ref, алерт.mode, алерт.reason) == ("создание", "publish", "unknown_channel")


def test_здоровая_канальная_пометка_алерта_не_даёт(db):
    брокер = _node(db, "Kafka")
    сервис = _node(db, "Заказы")
    канал = _канал(db, брокер, "созданные")
    _поле(db, канал, "order_id")
    _док(db, сервис, content='A["публикует: созданные.order_id"]')
    _док(db, сервис, "Обзор")  # док без текста: не падаем и не шумим
    db.commit()

    assert _каналы(db) == []


def test_неоднозначный_канал_и_отсутствующее_поле_названы_своими_причинами(db):
    брокер = _node(db, "Kafka")
    сосед = _node(db, "RabbitMQ")
    сервис = _node(db, "Заказы")
    канал = _канал(db, брокер, "события")
    _поле(db, канал, "order_id")
    _канал(db, сосед, "события")  # одноимённый у соседа → голое имя неоднозначно
    док = _док(db, сервис, content='A["потребляет: события"]')
    db.commit()

    [алерт] = _каналы(db)
    assert (алерт.reason, алерт.mode) == ("ambiguous", "consume")

    # Квалификатор «Брокер / канал» снимает алерт — угадывать за пользователя нельзя,
    # но и тупиком алерт не является.
    док.content = 'A["потребляет: Kafka / события"]'
    db.commit()
    assert _каналы(db) == []

    # Поля в канале нет — канал есть, а обещанной глубины нет: третья причина.
    док.content = 'A["потребляет: Kafka / события.total"]'
    db.commit()
    [нет_поля] = _каналы(db)
    assert нет_поля.reason == "unknown_field"


def test_классы_разведены_канальное_не_попадает_в_AL29_и_наоборот(db):
    """Разведение AL29/AL30 — суть решения: у «ambiguous» обеих семей один статус, и
    только режим пометки говорит, чей он. Слитый класс отправил бы инженера искать
    топик в структуре базы."""
    бд = _node(db, "Хранилище")
    брокер = _node(db, "Kafka")
    сервис = _node(db, "Заказы")
    _таблица(db, бд, "orders")
    _канал(db, брокер, "созданные")
    _док(db, сервис, "POST /orders", 'A["пишет: ordrs<br>публикует: создание"]')
    db.commit()

    отчёт = get_alerts(db=db, project=ensure_project(db), _=None)

    [табличный] = отчёт.unresolved_data_refs
    [канальный] = отчёт.unresolved_channel_refs
    assert (табличный.ref, табличный.reason) == ("ordrs", "unknown_table")
    assert (канальный.ref, канальный.reason) == ("создание", "unknown_channel")


# ====== 11) Связи с брокером, не называющие канал (AL31) ======
# Решение пользователя №4 (§4 plan-broker-docs.md): стрелка «сервис → брокер» обязана
# назвать топик. Канал на связи — ссылка по ИМЕНИ, не FK, поэтому шов между стрелкой и
# структурой брокера держит ТОЛЬКО этот алерт.


def _связи_брокеров(db):
    return get_alerts(db=db, project=ensure_project(db), _=None).broker_edge_channels


def test_связь_в_брокер_без_канала_даёт_missing(db):
    сервис = _node(db, "Заказы")
    брокер = _node(db, "Kafka", shape="broker")
    _edge(db, сервис, брокер)
    db.commit()

    [алерт] = _связи_брокеров(db)

    assert (алерт.source_name, алерт.target_name) == ("Заказы", "Kafka")
    # Брокер назван отдельно: по нему инженер понимает, ГДЕ описывать канал.
    assert алерт.broker_name == "Kafka"
    assert (алерт.reason, алерт.channel) == ("missing", None)


def test_пробелы_вместо_имени_канала_это_тоже_missing(db):
    сервис = _node(db, "Заказы")
    брокер = _node(db, "Kafka", shape="broker")
    _канал(db, брокер, "созданные")
    _edge(db, сервис, брокер, channel="   ")
    db.commit()

    [алерт] = _связи_брокеров(db)
    assert алерт.reason == "missing"


def test_канал_связи_не_найденный_у_брокера_даёт_unknown(db):
    сервис = _node(db, "Заказы")
    брокер = _node(db, "Kafka", shape="broker")
    _канал(db, брокер, "orders.created")
    _edge(db, сервис, брокер, channel="orders.creted")  # опечатка
    db.commit()

    [алерт] = _связи_брокеров(db)

    assert алерт.reason == "unknown"
    # Как написано на связи — чинить придётся именно эту строку.
    assert алерт.channel == "orders.creted"


def test_канал_найденный_точным_именем_алерта_не_даёт(db):
    сервис = _node(db, "Заказы")
    брокер = _node(db, "Kafka", shape="broker")
    _канал(db, брокер, "созданные")
    _edge(db, сервис, брокер, channel="созданные")
    db.commit()

    assert _связи_брокеров(db) == []


def test_канал_адресуется_группой_и_именем_с_точками(db):
    # Те же послабления, что у пометок (Ф2в): «группа.канал» (vhost/namespace) и имя
    # С ТОЧКАМИ целиком («orders.created» — норма Kafka, а не «группа orders»).
    сервис = _node(db, "Заказы")
    rabbit = _node(db, "RabbitMQ", shape="broker")
    kafka = _node(db, "Kafka", shape="broker")
    _канал(db, rabbit, "оплаты", group="billing")
    _канал(db, kafka, "orders.created")
    _edge(db, сервис, rabbit, channel="billing.оплаты")
    _edge(db, сервис, kafka, channel="orders.created")
    db.commit()

    assert _связи_брокеров(db) == []


def test_оба_конца_брокеры_канал_ищется_у_обоих(db):
    # Мост между брокерами: канал описан только у одного конца — этого достаточно.
    kafka = _node(db, "Kafka", shape="broker")
    rabbit = _node(db, "RabbitMQ", shape="broker")
    _канал(db, rabbit, "зеркало")
    мост = _edge(db, kafka, rabbit, channel="зеркало")
    db.commit()

    assert _связи_брокеров(db) == []

    # Канала нет ни у одного — алерт есть, и брокер в нём назван первым концом.
    мост.channel = "нет_такого"
    db.commit()
    [алерт] = _связи_брокеров(db)
    assert (алерт.reason, алерт.broker_name) == ("unknown", "Kafka")


def test_связи_без_брокера_не_проверяются(db):
    # У обычной связи канала и не бывает: проверка стреляет ТОЛЬКО по концу-брокеру.
    сервис = _node(db, "Заказы")
    бд = _node(db, "Хранилище", shape="database")
    человек = _node(db, "Покупатель", shape="person")
    _edge(db, сервис, бд)
    _edge(db, человек, сервис)
    db.commit()

    assert _связи_брокеров(db) == []


def test_связи_чужого_проекта_не_видны(db):
    # Тест, который на этом проекте регулярно теряли: скоуп — только свой проект.
    from app.models.project import Project

    свой = ensure_project(db)
    чужой = Project(id=uuid.uuid4(), name="Чужой")
    db.add(чужой)
    db.flush()
    чужой_сервис = Node(id=uuid.uuid4(), name="Их сервис", project_id=чужой.id)
    чужой_брокер = Node(id=uuid.uuid4(), name="Их Kafka", project_id=чужой.id, shape="broker")
    db.add_all([чужой_сервис, чужой_брокер])
    db.flush()
    db.add(
        Edge(
            id=uuid.uuid4(),
            project_id=чужой.id,
            source_id=чужой_сервис.id,
            target_id=чужой_брокер.id,
        )
    )
    db.commit()

    assert get_alerts(db=db, project=свой, _=None).broker_edge_channels == []


# ====== 12) Связи узла с собственным потомком (AL32) ======
# Паритет с превью импорта (К4, docs/plan-tuning-round2.md): вложенность уже выражена
# иерархией, стрелка семантически пуста. До AL32 такая связь приезжала классом «связи
# в контейнер» с советом «уточните конец до конкретного компонента» — а конец УЖЕ
# компонент, притом этого же контейнера. Превью после К4 советует связь удалить, и
# панель проекта обязана говорить то же самое, а не обратное.


def _свои_потомки(db):
    return get_alerts(db=db, project=ensure_project(db), _=None).descendant_edges


def test_связь_в_собственного_ребёнка_это_свой_класс(db):
    контейнер = _node(db, "background-workers")
    ребёнок = _node(db, "email-senders", контейнер)
    _edge(db, контейнер, ребёнок)
    db.commit()

    [алерт] = _свои_потомки(db)

    assert (алерт.source_name, алерт.target_name) == ("background-workers", "email-senders")
    # Часть — приёмник: флаг говорит, кто внутри кого, и по нему строится текст.
    assert алерт.source_is_part is False
    # И этой же связи в «связях в контейнер» больше нет: два совета противоречили бы.
    assert get_alerts(db=db, project=ensure_project(db), _=None).intermediate_edges == []


def test_связь_во_внука_тоже_свой_класс(db):
    контейнер = _node(db, "background-workers")
    ребёнок = _node(db, "email-senders", контейнер)
    внук = _node(db, "smtp-client", ребёнок)
    _edge(db, контейнер, внук)
    db.commit()

    [алерт] = _свои_потомки(db)
    assert (алерт.source_name, алерт.target_name) == ("background-workers", "smtp-client")
    assert алерт.source_is_part is False


def test_связь_потомка_в_свой_контейнер_помечает_источник(db):
    контейнер = _node(db, "background-workers")
    ребёнок = _node(db, "email-senders", контейнер)
    _edge(db, ребёнок, контейнер)
    db.commit()

    [алерт] = _свои_потомки(db)
    assert алерт.source_is_part is True


def test_связь_в_чужой_контейнер_остаётся_прежним_классом(db):
    # Не путать с законной связью в ДРУГОЙ контейнер: её конец уточняют до компонента.
    первый = _node(db, "background-workers")
    _node(db, "email-senders", первый)
    второй = _node(db, "zulip-web")
    _node(db, "django-app", второй)
    _edge(db, первый, второй)
    db.commit()

    res = get_alerts(db=db, project=ensure_project(db), _=None)

    assert res.descendant_edges == []
    assert len(res.intermediate_edges) == 1


def test_связь_в_собственный_брокер_про_канал_не_спрашивают(db):
    # Брокер внутри своего же контейнера: AL31 велел бы дописать канал, AL32 — удалить
    # связь. Совет должен быть ОДИН (то же правило, что в превью импорта).
    контейнер = _node(db, "Заказы")
    брокер = _node(db, "Kafka", контейнер, shape="broker")
    _edge(db, контейнер, брокер)
    db.commit()

    res = get_alerts(db=db, project=ensure_project(db), _=None)

    assert len(res.descendant_edges) == 1
    assert res.broker_edge_channels == []
    assert res.intermediate_edges == []


def test_связь_между_детьми_одного_контейнера_алерта_не_даёт(db):
    # Сиблинги — законная связь: ни один конец не является частью другого.
    контейнер = _node(db, "Ярмарка")
    a = _node(db, "vote", контейнер)
    b = _node(db, "redis", контейнер)
    _edge(db, a, b)
    db.commit()

    assert _свои_потомки(db) == []


# ====== 12) Пометки конфигурации, не нашедшие параметра (AL33) ======
# Третий отдельный класс: своя починка — «опишите ручку в разделе „Конфигурация“
# этого объекта». Ни причины, ни режима в записи нет — у семьи они единственные.


def _параметр(db, узел, name="FEATURE_X"):
    from app.models.config_param import ConfigParam

    p = ConfigParam(id=uuid.uuid4(), node_id=узел.id, name=name)
    db.add(p)
    db.flush()
    return p


def _конфиг(db):
    return get_alerts(db=db, project=ensure_project(db), _=None).unresolved_config_refs


def test_битая_конфигурационная_пометка_даёт_алерт(db):
    сервис = _node(db, "Заказы")
    _параметр(db, сервис, "FEATURE_NEW_CHECKOUT")
    _док(db, сервис, "POST /orders", 'A["Новая корзина?<br>зависит от: FEATURE_CHECKOUT"]')
    db.commit()

    [алерт] = _конфиг(db)
    assert (алерт.node_name, алерт.doc_name) == ("Заказы", "POST /orders")
    assert алерт.ref == "FEATURE_CHECKOUT"


def test_здоровая_конфигурационная_пометка_алерта_не_даёт(db):
    сервис = _node(db, "Заказы")
    _параметр(db, сервис, "FEATURE_X")
    _док(db, сервис, content='A["зависит от: FEATURE_X"]')
    _док(db, сервис, "Обзор")  # док без текста: не падаем и не шумим
    db.commit()

    assert _конфиг(db) == []


def test_параметр_соседа_своим_не_становится(db):
    """Суть третьей семьи: конфигурация ищется ТОЛЬКО у владельца схемы. Ручка с тем
    же именем у соседнего сервиса пометку не спасает — иначе карта утверждала бы, что
    развилка зависит от чужой переменной окружения."""
    заказы = _node(db, "Заказы")
    платежи = _node(db, "Платежи")
    _параметр(db, платежи, "FEATURE_X")
    _док(db, заказы, "POST /orders", 'A["зависит от: FEATURE_X"]')
    db.commit()

    [алерт] = _конфиг(db)
    assert (алерт.node_name, алерт.ref) == ("Заказы", "FEATURE_X")

    # Своя ручка с тем же именем — алерт снимается: дубликат у каждого сервиса это
    # норма (решение §2.2 плана), а не повод считать пометку разрешённой заранее.
    _параметр(db, заказы, "FEATURE_X")
    db.commit()
    assert _конфиг(db) == []


def test_проза_с_двоеточием_попадает_в_класс_осознанно(db):
    """«зависит от: нагрузки» — обычная фраза, и она даёт замечание. Это не баг:
    маркер с двоеточием — обещание факта. Тест фиксирует поведение, чтобы правку
    «убрать шум» нельзя было внести молча — у неё есть цена (спрятать можно всё)."""
    сервис = _node(db, "Заказы")
    _параметр(db, сервис, "TIMEOUT_MS")
    _док(db, сервис, "Обзор", 'A["Время ответа зависит от: нагрузки сети"]')
    db.commit()

    [алерт] = _конфиг(db)
    assert алерт.ref == "нагрузки сети"


def test_классы_трёх_семей_не_смешиваются(db):
    """Каждая битая пометка едет в СВОЙ класс: инженеру нельзя предлагать искать
    переменную окружения в структуре базы."""
    бд = _node(db, "Хранилище")
    брокер = _node(db, "Kafka")
    сервис = _node(db, "Заказы")
    _таблица(db, бд, "orders")
    _канал(db, брокер, "созданные")
    _параметр(db, сервис, "FEATURE_X")
    _док(
        db,
        сервис,
        "POST /orders",
        'A["пишет: ordrs<br>публикует: создание<br>зависит от: FEATURE_Y"]',
    )
    db.commit()

    отчёт = get_alerts(db=db, project=ensure_project(db), _=None)
    [табличный] = отчёт.unresolved_data_refs
    [канальный] = отчёт.unresolved_channel_refs
    [конфигурационный] = отчёт.unresolved_config_refs
    assert (табличный.ref, канальный.ref, конфигурационный.ref) == (
        "ordrs",
        "создание",
        "FEATURE_Y",
    )


def test_шаг_без_схемы_логики_даёт_алерт_полноты(db):
    """AL34, решение Р4: замечание на ЛЮБОЙ шаг с doc_id = NULL — включая
    самосообщение (внутренняя операция тоже документируется схемой). Привязанный
    шаг в класс не попадает — алерт гаснет работой, а не живёт вечно."""
    from app.models.business_process import BusinessProcess
    from app.models.node_doc import NodeDoc
    from app.models.process_message import ProcessMessage
    from app.models.process_participant import ProcessParticipant

    витрина = _node(db, "Веб-витрина")
    заказы = _node(db, "Сервис заказов")
    связь = _edge(db, витрина, заказы)
    схема = NodeDoc(id=uuid.uuid4(), node_id=заказы.id, name="POST /orders",
                    kind="operation", operation="POST /orders", content="graph TD\n A")
    db.add(схема)
    процесс = BusinessProcess(id=uuid.uuid4(), name="Оформление заказа",
                              project_id=ensure_project(db).id)
    db.add(процесс)
    db.flush()
    клиент = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id,
                                node_id=витрина.id, name=витрина.name, order=0)
    сервис = ProcessParticipant(id=uuid.uuid4(), process_id=процесс.id,
                                node_id=заказы.id, name=заказы.name, order=1)
    db.add_all([клиент, сервис])
    db.flush()
    db.add_all([
        # Привязанный шаг — в алерт не попадает.
        ProcessMessage(id=uuid.uuid4(), process_id=процесс.id, order=0,
                       edge_id=связь.id, leg="forward", doc_id=схема.id,
                       from_participant_id=клиент.id, to_participant_id=сервис.id,
                       caption="создать заказ"),
        # Непривязанный шаг на живой связи — попадает.
        ProcessMessage(id=uuid.uuid4(), process_id=процесс.id, order=1,
                       edge_id=связь.id, leg="return",
                       from_participant_id=сервис.id, to_participant_id=клиент.id,
                       caption="номер заказа"),
        # Самосообщение без привязки — тоже попадает (наравне со всеми).
        ProcessMessage(id=uuid.uuid4(), process_id=процесс.id, order=2,
                       edge_id=None, leg="forward",
                       from_participant_id=сервис.id, to_participant_id=сервис.id,
                       caption="посчитать скидку"),
    ])
    db.commit()

    out = get_alerts(db=db, project=ensure_project(db), _=None).unlinked_messages
    assert [(m.caption, m.from_name, m.to_name) for m in out] == [
        ("номер заказа", "Сервис заказов", "Веб-витрина"),
        ("посчитать скидку", "Сервис заказов", "Сервис заказов"),
    ]
    assert all(m.process_name == "Оформление заказа" for m in out)
