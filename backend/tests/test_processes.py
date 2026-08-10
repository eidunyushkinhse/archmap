"""Тесты бизнес-процессов (ТЗ §6).

Дёргаем функции роутера напрямую с db=db (как остальные тесты): зависимость
require_architect/get_current_user не используется телом и остаётся Depends-сентинелом.
Покрываем «запертый слой»: легальность плеч, проекцию концов (вкл. сквозные связи),
повисшие сообщения, эвристику синхронности.
"""

import uuid

import pytest
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException

from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_fragment import ProcessFragment, ProcessFragmentBranch
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.processes import edge_is_synchronous, resolve_to_participant
from app.routers.processes import (
    add_participant,
    bind_participant,
    create_fragment,
    create_message,
    delete_fragment,
    delete_message,
    get_process,
    list_channels,
    list_directions,
    reorder_messages,
    reorder_participants,
    update_fragment,
)
from app.schemas.process import (
    BranchIn,
    FragmentCreate,
    FragmentUpdate,
    MessageCreate,
    ParticipantBind,
    ParticipantCreate,
    ReorderPayload,
)


# ── Хелперы ───────────────────────────────────────────────────────────────────
def _node(db, name, parent=None, shape="service"):
    n = Node(
        id=uuid.uuid4(),
        name=name,
        parent_id=parent.id if parent else None,
        shape=shape,
        project_id=ensure_project(db).id,
    )
    db.add(n)
    return n


def _edge(db, src, tgt, technology=None, is_sync=None, label=None):
    e = Edge(
        id=uuid.uuid4(),
        source_id=src.id,
        target_id=tgt.id,
        technology=technology,
        is_synchronous=is_sync,
        label=label,
        project_id=ensure_project(db).id,
    )
    db.add(e)
    return e


def _process(db, scope=None, name="P"):
    p = BusinessProcess(
        id=uuid.uuid4(),
        name=name,
        scope_node_id=scope.id if scope else None,
        project_id=ensure_project(db).id,
    )
    db.add(p)
    return p


def _participants(db, proc, nodes):
    """Добавляет участников по порядку, возвращает {node_id: participant_id}."""
    out = {}
    for i, node in enumerate(nodes):
        p = add_participant(
            proc.id,
            ParticipantCreate(node_id=node.id, order=i),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
        out[node.id] = p.id
    return out


# ── 1. return на асинхронном канале → отказ ───────────────────────────────────
def test_return_on_async_edge_rejected(db):
    a, b = _node(db, "A"), _node(db, "B")
    edge = _edge(db, a, b, is_sync=False)  # async
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, b])

    with pytest.raises(HTTPException) as exc:
        create_message(
            proc.id,
            MessageCreate(
                edge_id=edge.id, leg="return",
                from_participant_id=parts[b.id], to_participant_id=parts[a.id], order=0,
            ),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert exc.value.status_code == 422


# ── 2. конец плеча не покрыт участником → отказ ────────────────────────────────
def test_message_end_not_participant_rejected(db):
    a, b, c = _node(db, "A"), _node(db, "B"), _node(db, "C")
    edge = _edge(db, a, b, technology="REST")  # реальная цель — B
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, c])  # B НЕ участник

    # forward A→B, но получателем указываем C: цель B не проецируется на C → 422
    with pytest.raises(HTTPException) as exc:
        create_message(
            proc.id,
            MessageCreate(
                edge_id=edge.id, leg="forward",
                from_participant_id=parts[a.id], to_participant_id=parts[c.id], order=0,
            ),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert exc.value.status_code == 422


# ── 3. легальные forward+return → 201 и корректный GET ────────────────────────
def test_legal_forward_and_return(db):
    a, b = _node(db, "A"), _node(db, "B")
    edge = _edge(db, a, b, technology="REST", label="POST /x")  # sync
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, b])

    fwd = create_message(
        proc.id,
        MessageCreate(edge_id=edge.id, leg="forward",
                      from_participant_id=parts[a.id], to_participant_id=parts[b.id], order=0),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    ret = create_message(
        proc.id,
        MessageCreate(edge_id=edge.id, leg="return",
                      from_participant_id=parts[b.id], to_participant_id=parts[a.id], order=1),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert fwd.kind == "forward" and fwd.caption == "POST /x"
    assert fwd.from_participant_id == parts[a.id] and fwd.to_participant_id == parts[b.id]
    assert ret.kind == "return" and ret.caption == "ответ"
    assert ret.from_participant_id == parts[b.id] and ret.to_participant_id == parts[a.id]

    detail = get_process(proc.id, db=db, project=ensure_project(db))
    assert [m.kind for m in detail.messages] == ["forward", "return"]
    assert detail.messages[0].valid and detail.messages[1].valid


# ── 4. /channels: 2 плеча для sync, 1 для async, пусто без рёбер ───────────────
def test_channels_legs_count_and_empty(db):
    a, b, c, d = _node(db, "A"), _node(db, "B"), _node(db, "C"), _node(db, "D")
    _edge(db, a, b)                 # sync (дефолт)
    _edge(db, c, d, is_sync=False)  # async
    proc = _process(db)
    db.commit()
    _participants(db, proc, [a, b, c, d])

    sync_ch = list_channels(proc.id, a=a.id, b=b.id, db=db, project=ensure_project(db))
    assert len(sync_ch) == 1 and len(sync_ch[0].legs) == 2 and sync_ch[0].synchronous

    async_ch = list_channels(proc.id, a=c.id, b=d.id, db=db, project=ensure_project(db))
    assert len(async_ch) == 1 and len(async_ch[0].legs) == 1 and not async_ch[0].synchronous

    assert list_channels(proc.id, a=a.id, b=d.id, db=db, project=ensure_project(db)) == []


# ── 4б. /directions: куда МОЖНО тянуть — сразу по всем парам ──────────────────
def test_directions_учитывают_направление_и_асинхронность(db):
    a, b, c, d = _node(db, "A"), _node(db, "B"), _node(db, "C"), _node(db, "D")
    _edge(db, a, b)                 # sync: есть и forward, и ответ
    _edge(db, c, d, is_sync=False)  # async: ответного плеча не бывает
    proc = _process(db)
    db.commit()
    _participants(db, proc, [a, b, c, d])

    pairs = {
        (x.from_id, x.to_id)
        for x in list_directions(proc.id, db=db, project=ensure_project(db))
    }

    assert (a.id, b.id) in pairs and (b.id, a.id) in pairs  # синхронный — обе стороны
    assert (c.id, d.id) in pairs and (d.id, c.id) not in pairs  # асинхронный — только вперёд
    assert (a.id, d.id) not in pairs  # связи между парой нет вовсе


def test_directions_проецируют_сквозную_связь_на_участника(db):
    # Тот же резолв, что у валидатора: конец вглубь чужого поддерева проецируется
    # на предка-участника. Ради этого индикация и считается на бэке.
    a, b = _node(db, "A"), _node(db, "B")
    inner = _node(db, "B-inner", parent=b)
    _edge(db, a, inner)
    proc = _process(db)
    db.commit()
    _participants(db, proc, [a, b])

    pairs = {
        (x.from_id, x.to_id)
        for x in list_directions(proc.id, db=db, project=ensure_project(db))
    }

    assert (a.id, b.id) in pairs


# ── 5. сквозная связь A→C (C под B): канал A–B, фиксирует from=A,to=B ──────────
def test_cross_level_channel_and_message(db):
    a = _node(db, "A")
    b = _node(db, "B")
    c = _node(db, "C", parent=b)  # C — потомок B
    edge = _edge(db, a, c, technology="REST")  # ребро вглубь чужого поддерева
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, b])  # участники A и B (не C)

    ch = list_channels(proc.id, a=a.id, b=b.id, db=db, project=ensure_project(db))
    assert len(ch) == 1
    fwd = next(leg for leg in ch[0].legs if leg.leg == "forward")
    assert fwd.from_id == a.id and fwd.to_id == b.id  # спроецировано на B

    msg = create_message(
        proc.id,
        MessageCreate(edge_id=edge.id, leg="forward",
                      from_participant_id=parts[a.id], to_participant_id=parts[b.id], order=0),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert msg.from_participant_id == parts[a.id] and msg.to_participant_id == parts[b.id]
    detail = get_process(proc.id, db=db, project=ensure_project(db))
    got = detail.messages[0]
    assert got.from_participant_id == parts[a.id] and got.to_participant_id == parts[b.id]

    # Если же участник — сам C, канал идёт A→C напрямую
    proc2 = _process(db, name="P2")
    db.commit()
    _participants(db, proc2, [a, c])
    ch2 = list_channels(proc2.id, a=a.id, b=c.id, db=db, project=ensure_project(db))
    fwd2 = next(leg for leg in ch2[0].legs if leg.leg == "forward")
    assert fwd2.from_id == a.id and fwd2.to_id == c.id


# ── 6. resolve_to_participant: при вложенных участниках побеждает глубочайший ──
def test_resolve_picks_deepest_participant(db):
    b = _node(db, "B")
    d = _node(db, "D", parent=b)
    x = _node(db, "X", parent=d)  # конец ребра — под D, под B
    db.commit()
    all_nodes = {n.id: n for n in db.query(Node).all()}
    assert resolve_to_participant(x.id, {b.id, d.id}, all_nodes) == d.id  # не B


# ── 7. удаление Edge → edge_id=null, valid=false, сообщение не исчезает ────────
def test_delete_edge_orphans_message(db):
    a, b = _node(db, "A"), _node(db, "B")
    edge = _edge(db, a, b, technology="REST")
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, b])
    create_message(
        proc.id,
        MessageCreate(edge_id=edge.id, leg="forward",
                      from_participant_id=parts[a.id], to_participant_id=parts[b.id], order=0),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )

    db.delete(edge)  # связь удалена из схемы → ON DELETE SET NULL
    db.commit()
    db.expire_all()

    detail = get_process(proc.id, db=db, project=ensure_project(db))
    assert len(detail.messages) == 1  # сообщение на месте
    assert detail.messages[0].edge_id is None and detail.messages[0].valid is False


# ── 8. edge_is_synchronous: только явный флаг; null → дефолт sync (без эвристики) ─
def test_edge_is_synchronous_explicit(db):
    a, b = _node(db, "A"), _node(db, "B")
    db.commit()
    # Явный флаг определяет всё; технология больше ни на что не влияет.
    assert edge_is_synchronous(_edge(db, a, b, is_sync=False)) is False
    assert edge_is_synchronous(_edge(db, a, b, is_sync=True)) is True
    assert edge_is_synchronous(_edge(db, a, b, technology="Kafka", is_sync=True)) is True
    assert edge_is_synchronous(_edge(db, a, b, technology="Kafka")) is True  # без флага → дефолт sync
    assert edge_is_synchronous(_edge(db, a, b, technology=None)) is True


# delete_message импортируем для покрытия пути удаления (smoke).
def test_delete_message_smoke(db):
    a, b = _node(db, "A"), _node(db, "B")
    edge = _edge(db, a, b, technology="REST")
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, b])
    msg = create_message(
        proc.id,
        MessageCreate(edge_id=edge.id, leg="forward",
                      from_participant_id=parts[a.id], to_participant_id=parts[b.id], order=0),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    delete_message(proc.id, msg.id, db=db, project=ensure_project(db), user=ensure_architect(db))
    assert get_process(proc.id, db=db, project=ensure_project(db)).messages == []


# ── Самосообщение (внутренняя операция участника): from==to, без связи C4 ──────
def test_self_message_created_without_edge(db):
    a, b = _node(db, "A"), _node(db, "B")
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, b])

    msg = create_message(
        proc.id,
        MessageCreate(leg="forward", from_participant_id=parts[a.id],
                      to_participant_id=parts[a.id], caption="валидация", order=0),
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    assert msg.kind == "self"
    assert msg.valid is True  # это не повисшая связь — её тут и не было
    assert msg.edge_id is None
    assert msg.from_participant_id == msg.to_participant_id == parts[a.id]
    assert msg.caption == "валидация"


def test_self_message_rejects_explicit_edge(db):
    a, b = _node(db, "A"), _node(db, "B")
    edge = _edge(db, a, b)
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a])

    # from==to, но передан edge_id — противоречие (самосообщение связи не несёт) → 422
    with pytest.raises(HTTPException) as exc:
        create_message(
            proc.id,
            MessageCreate(edge_id=edge.id, leg="forward",
                          from_participant_id=parts[a.id], to_participant_id=parts[a.id], order=0),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert exc.value.status_code == 422


# ── reorder участников: новый порядок → order=index, GET отражает перестановку ─
def test_reorder_participants_changes_order(db):
    a, b, c = _node(db, "A"), _node(db, "B"), _node(db, "C")
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, b, c])  # исходный порядок A(0), B(1), C(2)

    out = reorder_participants(
        proc.id,
        ReorderPayload(ids=[parts[c.id], parts[a.id], parts[b.id]]),  # новый: C, A, B
        db=db,
        project=ensure_project(db),
        user=ensure_architect(db),
    )
    # Возвращается список, отсортированный по новому order: C, A, B
    assert [p.node_id for p in out] == [c.id, a.id, b.id]
    assert [p.order for p in out] == [0, 1, 2]

    # GET процесса отражает новый порядок линий жизни
    detail = get_process(proc.id, db=db, project=ensure_project(db))
    assert [p.node_id for p in detail.participants] == [c.id, a.id, b.id]


def test_reorder_rejects_foreign_participant(db):
    a, b = _node(db, "A"), _node(db, "B")
    proc = _process(db, name="P1")
    other = _process(db, name="P2")
    db.commit()
    parts = _participants(db, proc, [a])
    other_parts = _participants(db, other, [b])

    # id участника из ЧУЖОГО процесса в списке → 422
    with pytest.raises(HTTPException) as exc:
        reorder_participants(
            proc.id,
            ReorderPayload(ids=[parts[a.id], other_parts[b.id]]),
            db=db,
            project=ensure_project(db),
            user=ensure_architect(db),
        )
    assert exc.value.status_code == 422


# ── Перестановка шагов сценария (2026-08-10) ──────────────────────────────────
def _три_шага(db):
    """Процесс из трёх сообщений A→B: возвращает (proc, [msg0, msg1, msg2])."""
    a, b = _node(db, "A"), _node(db, "B")
    edge = _edge(db, a, b, technology="REST", is_sync=False)  # async: только forward
    proc = _process(db)
    db.commit()
    parts = _participants(db, proc, [a, b])
    msgs = [
        create_message(
            proc.id,
            MessageCreate(edge_id=edge.id, leg="forward",
                          from_participant_id=parts[a.id], to_participant_id=parts[b.id],
                          order=i, caption=f"шаг{i}"),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )
        for i in range(3)
    ]
    return proc, msgs


def test_перестановка_шагов_переписывает_order_подряд(db):
    proc, msgs = _три_шага(db)

    out = reorder_messages(
        proc.id,
        ReorderPayload(ids=[msgs[2].id, msgs[0].id, msgs[1].id]),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert [m.caption for m in out] == ["шаг2", "шаг0", "шаг1"]
    assert [m.order for m in out] == [0, 1, 2]  # плотная нумерация, без дыр


def test_неполный_перечень_отклоняется(db):
    # Частичный список оставил бы дубли позиций — а по позициям фрагменты держат
    # свой диапазон, и блок накрыл бы не то, что видел пользователь.
    proc, msgs = _три_шага(db)

    with pytest.raises(HTTPException) as exc:
        reorder_messages(
            proc.id,
            ReorderPayload(ids=[msgs[1].id, msgs[0].id]),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 422
    assert [m.order for m in db.query(ProcessMessage).all()] == [0, 1, 2]  # ничего не тронуто


def test_дубль_в_перечне_отклоняется(db):
    proc, msgs = _три_шага(db)

    with pytest.raises(HTTPException) as exc:
        reorder_messages(
            proc.id,
            ReorderPayload(ids=[msgs[0].id, msgs[0].id, msgs[1].id]),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 422


def test_чужое_сообщение_в_перечне_отклоняется(db):
    proc, msgs = _три_шага(db)

    with pytest.raises(HTTPException) as exc:
        reorder_messages(
            proc.id,
            ReorderPayload(ids=[msgs[0].id, msgs[1].id, uuid.uuid4()]),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 422


def test_границы_фрагмента_остаются_на_месте(db):
    # Решение пользователя 2026-08-10: фрагмент — диапазон ПОЗИЦИЙ. Кто въехал в
    # строки блока, тот в нём и есть; границы за содержимым не едут.
    proc, msgs = _три_шага(db)
    db.add(ProcessFragment(
        id=uuid.uuid4(), process_id=proc.id, kind="alt",
        from_order=1, to_order=2, guard="успех",
    ))
    db.commit()

    reorder_messages(
        proc.id,
        ReorderPayload(ids=[msgs[2].id, msgs[0].id, msgs[1].id]),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    frag = db.query(ProcessFragment).one()
    assert (frag.from_order, frag.to_order) == (1, 2)
    # На позициях 1..2 теперь шаг0 и шаг1 — состав блока изменился осознанно.
    inside = [m.caption for m in sorted(proc.messages, key=lambda m: m.order)[1:3]]
    assert inside == ["шаг0", "шаг1"]


# ── Ветви «иначе» у alt (2026-08-10) ──────────────────────────────────────────
# Ветвей может быть сколько угодно (mermaid их числом не ограничивает — проверено
# парсером 11.15.0). Первая ветвь строкой не является: она начинается с from_order,
# её условие лежит в guard самого фрагмента.
def _фрагмент(db, proc, **over):
    payload = dict(kind="alt", from_order=0, to_order=2, guard=None, branches=[])
    payload.update(over)
    return create_fragment(
        proc.id, FragmentCreate(**payload),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )


def _ветвь(start_order, guard=None):
    return BranchIn(start_order=start_order, guard=guard)


def test_ветвь_внутри_охвата_принимается(db):
    proc, _ = _три_шага(db)

    out = _фрагмент(db, proc, branches=[_ветвь(1, "отказ")])

    assert [(b.start_order, b.guard) for b in out.branches] == [(1, "отказ")]


def test_несколько_ветвей_принимаются(db):
    # Ради этого весь эпик: у alt их столько, сколько влезает шагов в охват.
    proc, _ = _три_шага(db)

    out = _фрагмент(db, proc, guard="успех", branches=[_ветвь(1, "отказ"), _ветвь(2, "таймаут")])

    assert [(b.start_order, b.guard) for b in out.branches] == [(1, "отказ"), (2, "таймаут")]


@pytest.mark.parametrize("bad", [0, 3, 9])
def test_ветвь_вне_охвата_отклоняется(db, bad):
    # start == from оставил бы первую ветвь пустой, start > to — ветвь вне рамки.
    proc, _ = _три_шага(db)

    with pytest.raises(HTTPException) as exc:
        _фрагмент(db, proc, branches=[_ветвь(bad)])

    assert exc.value.status_code == 422


@pytest.mark.parametrize("плохие", [[1, 1], [2, 1]])
def test_границы_ветвей_обязаны_строго_возрастать(db, плохие):
    # Две ветви с одной границей неразличимы, убывающие — перепутаны местами.
    proc, _ = _три_шага(db)

    with pytest.raises(HTTPException) as exc:
        _фрагмент(db, proc, branches=[_ветвь(s) for s in плохие])

    assert exc.value.status_code == 422


def test_ветвей_не_больше_чем_шагов_в_охвате(db):
    """Ветвь без единого шага бессмысленна: первая ветвь тоже занимает шаг, поэтому
    строк должно быть строго меньше, чем шагов в охвате.

    Проверка кусается только на РАЗРЕЖЕННЫХ order (сюда приводит удаление сообщений:
    нумерация после него дыр не закрывает). При плотных order то же самое уже держит
    строгое возрастание границ — свободных значений внутри охвата просто нет.
    """
    proc, msgs = _три_шага(db)  # order 0,1,2
    create_message(  # четвёртый шаг далеко впереди — между 2 и 10 дыра
        proc.id,
        MessageCreate(edge_id=msgs[0].edge_id, leg="forward",
                      from_participant_id=msgs[0].from_participant_id,
                      to_participant_id=msgs[0].to_participant_id,
                      order=10, caption="далёкий"),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    # Охват 0..10 накрывает 4 шага → максимум 3 строки ветвей.
    ok = _фрагмент(db, proc, from_order=0, to_order=10, branches=[_ветвь(4), _ветвь(5), _ветвь(6)])
    assert len(ok.branches) == 3

    with pytest.raises(HTTPException) as exc:
        _фрагмент(db, proc, from_order=0, to_order=10,
                  branches=[_ветвь(4), _ветвь(5), _ветвь(6), _ветвь(7)])

    assert exc.value.status_code == 422


def test_ветви_только_у_alt(db):
    proc, _ = _три_шага(db)

    with pytest.raises(HTTPException) as exc:
        _фрагмент(db, proc, kind="loop", branches=[_ветвь(1)])

    assert exc.value.status_code == 422


def test_правка_охвата_не_может_выбросить_ветвь_наружу(db):
    # Частичный патч не упоминает ветви, но ломает инвариант — проверяем РЕЗУЛЬТАТ,
    # а не вход.
    proc, _ = _три_шага(db)
    frag = _фрагмент(db, proc, branches=[_ветвь(2, "отказ")])

    with pytest.raises(HTTPException) as exc:
        update_fragment(
            proc.id, frag.id, FragmentUpdate(to_order=1),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 422
    assert db.query(ProcessFragment).one().to_order == 2  # откат, ничего не записано


def test_фрагмент_остаётся_правимым_когда_шаги_из_под_него_удалили(db):
    """Счётную проверку применяем только к ПРИСЛАННОМУ списку ветвей.

    Иначе так: у alt три ветви, пользователь удаляет пару шагов внутри охвата — и
    фрагмент запирается насмерть, потому что любой патч (хоть правка условия) упирался
    бы в старые ветви, которых стало больше, чем шагов.
    """
    proc, msgs = _три_шага(db)
    frag = _фрагмент(db, proc, branches=[_ветвь(1, "отказ"), _ветвь(2, "таймаут")])
    delete_message(
        proc.id, msgs[1].id,
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    out = update_fragment(
        proc.id, frag.id, FragmentUpdate(guard="успех"),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert out.guard == "успех"
    assert len(out.branches) == 2  # ветви на месте, править фрагмент по-прежнему можно


def test_патч_без_ветвей_их_не_трогает(db):
    proc, _ = _три_шага(db)
    frag = _фрагмент(db, proc, branches=[_ветвь(1, "отказ")])

    out = update_fragment(
        proc.id, frag.id, FragmentUpdate(guard="успех"),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert out.guard == "успех"
    assert [(b.start_order, b.guard) for b in out.branches] == [(1, "отказ")]


def test_присланный_список_ветвей_заменяет_прежний_целиком(db):
    proc, _ = _три_шага(db)
    frag = _фрагмент(db, proc, branches=[_ветвь(1, "отказ"), _ветвь(2, "таймаут")])

    out = update_fragment(
        proc.id, frag.id, FragmentUpdate(branches=[_ветвь(2, "иначе")]),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert [(b.start_order, b.guard) for b in out.branches] == [(2, "иначе")]
    assert db.query(ProcessFragmentBranch).count() == 1  # прежние строки удалены


def test_удаление_фрагмента_уносит_ветви(db):
    proc, _ = _три_шага(db)
    frag = _фрагмент(db, proc, branches=[_ветвь(1), _ветвь(2)])

    delete_fragment(
        proc.id, frag.id,
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert db.query(ProcessFragmentBranch).count() == 0


# ── Непривязанный участник (2026-08-10) ───────────────────────────────────────
# Участник перестал быть обязательно узлом C4: node_id может быть NULL. Так бывает
# после удаления узла (FK гасит ссылку) и после импорта диаграммы, где имя не
# сопоставили. Вторая ось «незадокументированности», симметричная повисшему сообщению.
def test_участник_запоминает_имя_узла(db):
    # Имя нужно осиротевшему участнику: удаление узла делает БД-каскад по поддереву,
    # перехватить имя в тот момент негде.
    proc, _ = _три_шага(db)

    part = db.query(ProcessParticipant).filter(ProcessParticipant.order == 0).one()

    assert part.name == "A"


def test_удаление_узла_оставляет_участника_непривязанным(db):
    """Смена принятого поведения (решение пользователя 2026-08-10): было CASCADE —
    участник и все его шаги молча исчезали. Стало SET NULL: процесс переживает
    удаление узла, а расхождение со схемой остаётся видимым."""
    proc, _ = _три_шага(db)
    узел_a = db.query(Node).filter(Node.name == "A").one()

    db.delete(узел_a)
    db.commit()

    parts = db.query(ProcessParticipant).filter(ProcessParticipant.process_id == proc.id).all()
    assert len(parts) == 2  # участник на месте, а не снесён каскадом
    осиротевший = next(p for p in parts if p.node_id is None)
    assert осиротевший.name == "A"  # имя не потерялось
    # Шаги живы и стали повисшими: связи узла ушли вместе с ним (SET NULL у edge_id).
    шаги = db.query(ProcessMessage).filter(ProcessMessage.process_id == proc.id).all()
    assert len(шаги) == 3
    assert all(m.edge_id is None for m in шаги)


def test_детали_процесса_отдают_непривязанного_участника(db):
    proc, _ = _три_шага(db)
    db.delete(db.query(Node).filter(Node.name == "A").one())
    db.commit()

    detail = get_process(proc.id, db=db, project=ensure_project(db), _=ensure_architect(db))

    p = next(p for p in detail.participants if p.node_id is None)
    assert p.name == "A"
    # Свойств узла нет и придумывать их нельзя: «сервис existing» по умолчанию
    # выглядел бы на схеме как настоящий узел.
    assert (p.shape, p.status, p.is_external, p.role) == (None, None, None, None)


def test_перестановка_переживает_непривязанного(db):
    # Тихая мина: до этой правки reorder_participants индексировал all_nodes[p.node_id].
    proc, _ = _три_шага(db)
    db.delete(db.query(Node).filter(Node.name == "A").one())
    db.commit()
    parts = sorted(proc.participants, key=lambda p: p.order)

    out = reorder_participants(
        proc.id, ReorderPayload(ids=[parts[1].id, parts[0].id]),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert [p.name for p in out] == ["B", "A"]


def test_сообщение_на_непривязанного_отклоняется_внятно(db):
    proc, _ = _три_шага(db)
    b_id = db.query(Node).filter(Node.name == "B").one().id
    edge_id = db.query(Edge).one().id  # запоминаем ДО удаления: каскад унесёт связь
    db.delete(db.query(Node).filter(Node.name == "A").one())
    db.commit()
    parts = {p.node_id: p for p in proc.participants}
    непривязанный = next(p for p in proc.participants if p.node_id is None)

    with pytest.raises(HTTPException) as exc:
        create_message(
            proc.id,
            MessageCreate(edge_id=edge_id, leg="forward",
                          from_participant_id=непривязанный.id,
                          to_participant_id=parts[b_id].id, order=9),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 422
    assert "не привязан" in exc.value.detail


# ── Привязка непривязанного участника к узлу (Ф4) ─────────────────────────────
# Без неё алерт «участник без узла» был бы тупиком: расхождение видно, исправить
# нечем — ровно то, на что пользователь указывал на приёмке алерта про людей
# внутри системы.
def _осиротить(db):
    """Процесс из трёх шагов, у которого удалили узел A: возвращает (proc, участник)."""
    proc, _ = _три_шага(db)
    db.delete(db.query(Node).filter(Node.name == "A").one())
    db.commit()
    return proc, next(p for p in proc.participants if p.node_id is None)


def test_привязка_возвращает_участника_в_схему(db):
    proc, сирота = _осиротить(db)
    новый = _node(db, "A2")
    db.commit()

    out = bind_participant(
        proc.id, сирота.id, ParticipantBind(node_id=новый.id),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert out.node_id == новый.id
    assert out.shape is not None  # свойства узла снова есть
    # Имя-запас обновилось: оно про НОВЫЙ узел. Видно это только когда узел исчезнет —
    # в ответе имя всегда живое, из самого узла.
    db.delete(новый)
    db.commit()
    assert db.get(ProcessParticipant, сирота.id).name == "A2"


def test_привязка_к_занятому_узлу_отклоняется(db):
    # Узел уже участвует в процессе — второй линии жизни того же узла быть не может.
    proc, сирота = _осиротить(db)
    b = db.query(Node).filter(Node.name == "B").one()

    with pytest.raises(HTTPException) as exc:
        bind_participant(
            proc.id, сирота.id, ParticipantBind(node_id=b.id),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 409


def test_перепривязка_привязанного_запрещена(db):
    """Сообщения участника опираются на плечи каналов ЕГО узла: подмена узла молча
    сделала бы их бессмысленными."""
    proc, _ = _три_шага(db)
    привязанный = next(p for p in proc.participants if p.node_id is not None)
    другой = _node(db, "Другой")
    db.commit()

    with pytest.raises(HTTPException) as exc:
        bind_participant(
            proc.id, привязанный.id, ParticipantBind(node_id=другой.id),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 409


def test_снятие_привязки_оставляет_имя(db):
    # Компенсирующая операция для undo. Без имени линия жизни стала бы безымянной.
    proc, _ = _три_шага(db)
    привязанный = next(p for p in proc.participants if p.name == "A")

    out = bind_participant(
        proc.id, привязанный.id, ParticipantBind(node_id=None),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )

    assert out.node_id is None
    assert out.name == "A"


def test_привязка_к_несуществующему_узлу(db):
    proc, сирота = _осиротить(db)

    with pytest.raises(HTTPException) as exc:
        bind_participant(
            proc.id, сирота.id, ParticipantBind(node_id=uuid.uuid4()),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 404


def test_привязка_чужого_участника_не_проходит(db):
    proc, сирота = _осиротить(db)
    другой_процесс = _process(db, name="Другой")
    db.commit()
    узел = _node(db, "A2")
    db.commit()

    with pytest.raises(HTTPException) as exc:
        bind_participant(
            другой_процесс.id, сирота.id, ParticipantBind(node_id=узел.id),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 404
