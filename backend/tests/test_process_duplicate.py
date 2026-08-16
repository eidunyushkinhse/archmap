"""Дублирование процесса серверной ручкой (POST /processes/{id}/duplicate).

Копия обязана повторять источник ЦЕЛИКОМ, включая состояния, которые публичные
ручки сознательно отвергают (их 422 — инварианты, ослаблять их нельзя): участник без
узла, повисший шаг, самосообщение, шаг-ответ на канале, ставшем асинхронным. Плюс
согласованность позиций: фрагмент адресует ДИАПАЗОН order, а рендер считает строку
РАНГОМ (числом шагов с меньшим order) — на поредевшем наборе те же границы накрыли бы
другие строки.
"""

import uuid

from conftest import ensure_architect, ensure_project

from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.routers.processes import duplicate_process_endpoint


# ── Хелперы ───────────────────────────────────────────────────────────────────
def _node(db, name):
    n = Node(id=uuid.uuid4(), name=name, project_id=ensure_project(db).id)
    db.add(n)
    return n


def _process(db, name="Оплата"):
    p = BusinessProcess(id=uuid.uuid4(), name=name, project_id=ensure_project(db).id)
    db.add(p)
    return p


def _participant(db, proc, name, order, node=None):
    p = ProcessParticipant(
        id=uuid.uuid4(),
        process_id=proc.id,
        node_id=node.id if node else None,
        name=name,
        order=order,
    )
    db.add(p)
    return p


def _message(db, proc, frm, to, order, leg="forward", edge=None, caption=None):
    m = ProcessMessage(
        id=uuid.uuid4(),
        process_id=proc.id,
        order=order,
        edge_id=edge.id if edge else None,
        leg=leg,
        from_participant_id=frm.id,
        to_participant_id=to.id,
        caption=caption,
    )
    db.add(m)
    return m


def _duplicate(db, proc_id):
    return duplicate_process_endpoint(
        proc_id, db=db, project=ensure_project(db), user=ensure_architect(db)
    )


def _rows(db, model, proc_id, key):
    return sorted(db.query(model).filter(model.process_id == proc_id).all(), key=key)


# ── 1. Незадокументированность переносится, а не отбрасывается ────────────────
def test_duplicate_carries_unbound_participant_dangling_self_and_async_return(db):
    """Четыре состояния, на которых спотыкалась фронтовая оркестрация, — в одном
    процессе. Имя участника проверяем ОСОБО: оно заморожено на момент заведения и за
    переименованием узла не следует, а прежняя копия брала его из узла."""
    svc = _node(db, "Сервис оплаты")  # имя узла НЕ совпадает с именем участника
    billing = _node(db, "Биллинг")
    async_edge = Edge(
        id=uuid.uuid4(),
        source_id=svc.id,
        target_id=billing.id,
        is_synchronous=False,  # у асинхронного канала плеча «ответ» не существует
        project_id=ensure_project(db).id,
    )
    db.add(async_edge)
    proc = _process(db)
    db.flush()

    bound = _participant(db, proc, "Платёжный шлюз", 0, node=svc)  # замороженное имя
    unbound = _participant(db, proc, "Внешний биллинг", 1)  # узла нет вовсе
    billing_part = _participant(db, proc, "Биллинг", 2, node=billing)
    db.flush()
    _message(db, proc, bound, bound, order=0, caption="проверяет лимит")  # самосообщение
    _message(db, proc, bound, unbound, order=1, caption="списать")  # повисший
    _message(
        db, proc, billing_part, bound, order=2, leg="return", edge=async_edge, caption="ответ"
    )  # ответ на канале, который стал асинхронным
    db.commit()
    proc_id = proc.id

    detail = _duplicate(db, proc_id)

    assert detail.name == "Оплата (копия)"
    assert detail.id != proc_id
    # Участники: все три, с порядком и привязкой. Имя берём ИЗ СТРОКИ копии — в
    # выдаче у привязанного участника показывается живое имя узла, а нам важно, что
    # копия унесла замороженное.
    parts = _rows(db, ProcessParticipant, detail.id, lambda p: p.order)
    assert [(p.name, p.node_id) for p in parts] == [
        ("Платёжный шлюз", svc.id),
        ("Внешний биллинг", None),
        ("Биллинг", billing.id),
    ]

    msgs = _rows(db, ProcessMessage, detail.id, lambda m: m.order)
    assert len(msgs) == 3
    # Самосообщение: оба конца — один и тот же участник копии, связи нет.
    assert msgs[0].from_participant_id == msgs[0].to_participant_id == parts[0].id
    assert msgs[0].edge_id is None and msgs[0].caption == "проверяет лимит"
    # Повисший шаг остался повисшим, конец ведёт на непривязанного участника копии.
    assert msgs[1].edge_id is None and msgs[1].caption == "списать"
    assert (msgs[1].from_participant_id, msgs[1].to_participant_id) == (parts[0].id, parts[1].id)
    # Ответ на асинхронном канале: плечо и связь сохранены как есть.
    assert msgs[2].leg == "return" and msgs[2].edge_id == async_edge.id
    assert (msgs[2].from_participant_id, msgs[2].to_participant_id) == (parts[2].id, parts[0].id)
    # Концы шагов копии не ведут на участников источника.
    src_part_ids = {p.id for p in _rows(db, ProcessParticipant, proc_id, lambda p: p.order)}
    assert not src_part_ids & {m.from_participant_id for m in msgs}

    # Источник не тронут.
    assert len(_rows(db, ProcessParticipant, proc_id, lambda p: p.order)) == 3
    assert len(_rows(db, ProcessMessage, proc_id, lambda m: m.order)) == 3
    assert db.get(BusinessProcess, proc_id).name == "Оплата"


# ── 2. Фрагменты: охват, ветви и РАНГИ границ ─────────────────────────────────
def test_duplicate_keeps_fragment_span_and_branches(db):
    """Фрагмент с ветвями поверх набора, где есть и повисший шаг, и самосообщение.

    Проверяем не только совпадение чисел from/to/start, но и РАНГ каждой границы —
    сколько шагов лежит выше неё. Именно ранг рисует строку, и именно он ехал, когда
    копия недосчитывалась шагов.
    """
    svc = _node(db, "Сервис")
    proc = _process(db, name="Заказ")
    db.flush()
    a = _participant(db, proc, "Сервис", 0, node=svc)
    b = _participant(db, proc, "Внешний", 1)  # непривязанный: его шаги повисшие
    db.flush()
    for i in range(4):
        _message(db, proc, a, b if i % 2 else a, order=i, caption=f"шаг {i}")
    db.add(
        ProcessFragment(
            id=uuid.uuid4(),
            process_id=proc.id,
            kind="alt",
            from_order=1,
            to_order=3,
            guard="успех",
            branches=[
                ProcessFragmentBranch(start_order=2, guard="отказ"),
                ProcessFragmentBranch(start_order=3, guard="таймаут"),
            ],
        )
    )
    db.commit()
    proc_id = proc.id

    detail = _duplicate(db, proc_id)

    src_frag = _rows(db, ProcessFragment, proc_id, lambda f: f.from_order)[0]
    copy_frag = _rows(db, ProcessFragment, detail.id, lambda f: f.from_order)[0]
    assert (copy_frag.kind, copy_frag.from_order, copy_frag.to_order, copy_frag.guard) == (
        "alt",
        1,
        3,
        "успех",
    )
    assert [(b.start_order, b.guard) for b in copy_frag.branches] == [(2, "отказ"), (3, "таймаут")]

    # Ранг границы = число шагов выше неё. В копии он обязан совпасть с источником —
    # иначе блок накрыл бы другие строки, хотя числа границ те же.
    def rank(proc_id_, boundary):
        return sum(1 for m in _rows(db, ProcessMessage, proc_id_, lambda m: m.order)
                   if m.order < boundary)

    boundaries = [src_frag.from_order, src_frag.to_order] + [
        br.start_order for br in src_frag.branches
    ]
    assert [rank(detail.id, x) for x in boundaries] == [rank(proc_id, x) for x in boundaries]
    # И сами шаги на месте: копия несёт весь набор позиций, а не поредевший.
    assert [m.order for m in _rows(db, ProcessMessage, detail.id, lambda m: m.order)] == [
        0,
        1,
        2,
        3,
    ]
