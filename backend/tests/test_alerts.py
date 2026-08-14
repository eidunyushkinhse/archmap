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


def _node(db, name, parent=None):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _edge(db, src, tgt):
    e = Edge(id=uuid.uuid4(), source_id=src.id, target_id=tgt.id, project_id=ensure_project(db).id)
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
