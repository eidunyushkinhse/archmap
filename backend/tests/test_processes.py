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
from app.models.process_fragment import ProcessFragment
from app.models.process_message import ProcessMessage
from app.processes import edge_is_synchronous, resolve_to_participant
from app.routers.processes import (
    add_participant,
    create_fragment,
    create_message,
    delete_message,
    get_process,
    list_channels,
    list_directions,
    reorder_messages,
    reorder_participants,
    update_fragment,
)
from app.schemas.process import (
    FragmentCreate,
    FragmentUpdate,
    MessageCreate,
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
    assert fwd.from_id == a.id and fwd.to_id == b.id
    assert ret.kind == "return" and ret.caption == "ответ"
    assert ret.from_id == b.id and ret.to_id == a.id

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
    assert msg.from_id == a.id and msg.to_id == b.id
    detail = get_process(proc.id, db=db, project=ensure_project(db))
    assert detail.messages[0].from_id == a.id and detail.messages[0].to_id == b.id

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
    assert msg.from_id == a.id and msg.to_id == a.id
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


# ── Ветка «иначе» у alt (2026-08-10) ──────────────────────────────────────────
def _фрагмент(db, proc, **over):
    payload = dict(kind="alt", from_order=0, to_order=2, guard=None, else_guard=None, else_order=None)
    payload.update(over)
    return create_fragment(
        proc.id, FragmentCreate(**payload),
        db=db, project=ensure_project(db), user=ensure_architect(db),
    )


def test_ветка_иначе_внутри_охвата_принимается(db):
    proc, _ = _три_шага(db)

    out = _фрагмент(db, proc, else_order=1, else_guard="отказ")

    assert (out.else_order, out.else_guard) == (1, "отказ")


@pytest.mark.parametrize("bad", [0, 3, 9])
def test_ветка_вне_охвата_отклоняется(db, bad):
    # else == from оставил бы первую половину пустой, else > to — ветка вне рамки.
    proc, _ = _три_шага(db)

    with pytest.raises(HTTPException) as exc:
        _фрагмент(db, proc, else_order=bad)

    assert exc.value.status_code == 422


def test_ветка_только_у_alt(db):
    proc, _ = _три_шага(db)

    with pytest.raises(HTTPException) as exc:
        _фрагмент(db, proc, kind="loop", else_order=1)

    assert exc.value.status_code == 422


def test_правка_охвата_не_может_выбросить_ветку_наружу(db):
    # Частичный патч не упоминает else_order, но ломает инвариант — проверяем
    # РЕЗУЛЬТАТ, а не вход.
    proc, _ = _три_шага(db)
    frag = _фрагмент(db, proc, else_order=2, else_guard="отказ")

    with pytest.raises(HTTPException) as exc:
        update_fragment(
            proc.id, frag.id, FragmentUpdate(to_order=1),
            db=db, project=ensure_project(db), user=ensure_architect(db),
        )

    assert exc.value.status_code == 422
    assert db.query(ProcessFragment).one().to_order == 2  # откат, ничего не записано
