"""API бизнес-процессов: /api/v1/processes.

Точка enforcement «запертого слоя»: сообщение можно создать только на легальное плечо
существующего канала, концы которого сходятся по проекции на участников (ТЗ §3.2).
Раскладку диаграммы не храним — она выводится на фронте из order/kind.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_edge, touch_project
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.process_fragment import ProcessFragment
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.processes import (
    build_process_detail,
    edge_is_synchronous,
    legal_directions,
    legs_for_edge,
    load_nodes,
    message_out,
    participant_out,
    process_list_items,
    resolve_to_participant,
    scope_node_ids,
)
from app.schemas.process import (
    ChannelOut,
    DirectionOut,
    FragmentCreate,
    FragmentOut,
    FragmentUpdate,
    LegOut,
    MessageCreate,
    MessageOut,
    MessageUpdate,
    ParticipantCreate,
    ParticipantOut,
    ProcessCreate,
    ProcessDetail,
    ProcessListItem,
    ProcessUpdate,
    ReorderPayload,
)

router = APIRouter(prefix="/processes", tags=["processes"])


# ── Вспомогательные ───────────────────────────────────────────────────────────
def _get_process(db: Session, process_id: uuid.UUID, project: Project) -> BusinessProcess:
    """Процесс текущего проекта, иначе 404 (чужой процесс недоступен — изоляция).
    HTTP-перевод «не найдено»; доменные запросы/сериализация — в app/processes.py."""
    proc = db.get(BusinessProcess, process_id)
    if proc is None or proc.project_id != project.id:
        raise HTTPException(status_code=404, detail="Процесс не найден")
    return proc


# ── Процессы ──────────────────────────────────────────────────────────────────
@router.get("", response_model=list[ProcessListItem])
def list_processes(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ProcessListItem]:
    all_nodes = load_nodes(db, project.id)
    return process_list_items(db, project.id, all_nodes)


@router.post("", response_model=ProcessDetail, status_code=status.HTTP_201_CREATED)
def create_process(
    payload: ProcessCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ProcessDetail:
    all_nodes = load_nodes(db, project.id)
    if payload.scope_node_id is not None and payload.scope_node_id not in all_nodes:
        raise HTTPException(status_code=404, detail="Узел области не найден")
    proc = BusinessProcess(
        name=payload.name, scope_node_id=payload.scope_node_id, project_id=project.id
    )
    db.add(proc)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(proc)
    return build_process_detail(db, proc, all_nodes)


@router.get("/{process_id}", response_model=ProcessDetail)
def get_process(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> ProcessDetail:
    proc = _get_process(db, process_id, project)
    return build_process_detail(db, proc, load_nodes(db, project.id))


@router.patch("/{process_id}", response_model=ProcessDetail)
def update_process(
    process_id: uuid.UUID,
    payload: ProcessUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ProcessDetail:
    proc = _get_process(db, process_id, project)
    all_nodes = load_nodes(db, project.id)
    data = payload.model_dump(exclude_unset=True)
    if "scope_node_id" in data and data["scope_node_id"] is not None:
        if data["scope_node_id"] not in all_nodes:
            raise HTTPException(status_code=404, detail="Узел области не найден")
    for field, value in data.items():
        setattr(proc, field, value)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(proc)
    return build_process_detail(db, proc, all_nodes)


@router.delete("/{process_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_process(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    proc = _get_process(db, process_id, project)
    db.delete(proc)  # каскад сносит участников/сообщения/фрагменты
    touch_project(db, project, user.id)
    db.commit()


# ── Участники ─────────────────────────────────────────────────────────────────
@router.post(
    "/{process_id}/participants",
    response_model=ParticipantOut,
    status_code=status.HTTP_201_CREATED,
)
def add_participant(
    process_id: uuid.UUID,
    payload: ParticipantCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ParticipantOut:
    proc = _get_process(db, process_id, project)
    all_nodes = load_nodes(db, project.id)
    node = all_nodes.get(payload.node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Узел не найден")
    if payload.node_id not in scope_node_ids(all_nodes, proc.scope_node_id):
        raise HTTPException(status_code=422, detail="Узел вне области процесса")
    if any(p.node_id == payload.node_id for p in proc.participants):
        raise HTTPException(status_code=409, detail="Узел уже участвует в процессе")
    part = ProcessParticipant(process_id=proc.id, node_id=payload.node_id, order=payload.order)
    db.add(part)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(part)
    return participant_out(part, node)


@router.patch("/{process_id}/participants/reorder", response_model=list[ParticipantOut])
def reorder_participants(
    process_id: uuid.UUID,
    payload: ReorderPayload,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> list[ParticipantOut]:
    proc = _get_process(db, process_id, project)
    by_id = {p.id: p for p in proc.participants}
    for index, pid in enumerate(payload.ids):
        part = by_id.get(pid)
        if part is None:
            raise HTTPException(status_code=422, detail="Участник не из этого процесса")
        part.order = index
    touch_project(db, project, user.id)
    db.commit()
    all_nodes = load_nodes(db, project.id)
    parts = sorted(proc.participants, key=lambda p: p.order)
    return [participant_out(p, all_nodes[p.node_id]) for p in parts]


@router.delete(
    "/{process_id}/participants/{participant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_participant(
    process_id: uuid.UUID,
    participant_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    proc = _get_process(db, process_id, project)
    part = db.get(ProcessParticipant, participant_id)
    if part is None or part.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Участник не найден")
    db.delete(part)  # каскад сносит сообщения с этим концом (FK ON DELETE CASCADE)
    touch_project(db, project, user.id)
    db.commit()


# ── Сообщения (точка enforcement) ─────────────────────────────────────────────
@router.post(
    "/{process_id}/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
def create_message(
    process_id: uuid.UUID,
    payload: MessageCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> MessageOut:
    proc = _get_process(db, process_id, project)
    # Самосообщение: внутренняя операция участника — НЕ плечо канала C4, поэтому
    # «запертый слой» к нему не применяется (концы совпадают, связи нет). Это
    # сознательное исключение из правила «сообщение = плечо существующего канала».
    if payload.from_participant_id == payload.to_participant_id:
        if payload.edge_id is not None:
            raise HTTPException(status_code=422, detail="Самосообщение не привязывается к связи")
        frm = db.get(ProcessParticipant, payload.from_participant_id)
        if frm is None or frm.process_id != proc.id:
            raise HTTPException(status_code=422, detail="Участник не из этого процесса")
        msg = ProcessMessage(
            process_id=proc.id,
            order=payload.order,
            edge_id=None,
            leg=payload.leg,
            from_participant_id=frm.id,
            to_participant_id=frm.id,
            caption=payload.caption,
        )
        db.add(msg)
        touch_project(db, project, user.id)
        db.commit()
        db.refresh(msg)
        part_by_id = {p.id: p for p in proc.participants}
        return message_out(msg, None, part_by_id)
    if payload.edge_id is None:
        raise HTTPException(status_code=422, detail="Не указана связь")
    edge = scoped_edge(db, payload.edge_id, project)
    if edge is None:
        raise HTTPException(status_code=404, detail="Связь не найдена")
    # 2) leg легален: return только для синхронного канала
    if payload.leg == "return" and not edge_is_synchronous(edge):
        raise HTTPException(status_code=422, detail="Канал асинхронный — плеча «ответ» нет")
    # 3) концы — участники этого процесса
    frm = db.get(ProcessParticipant, payload.from_participant_id)
    to = db.get(ProcessParticipant, payload.to_participant_id)
    if frm is None or frm.process_id != proc.id:
        raise HTTPException(status_code=422, detail="Отправитель не участник процесса")
    if to is None or to.process_id != proc.id:
        raise HTTPException(status_code=422, detail="Получатель не участник процесса")
    # 4) проекция сырых концов плеча сходится именно на этих участников
    all_nodes = load_nodes(db, project.id)
    participant_ids = {p.node_id for p in proc.participants}
    leg = next((leg for leg in legs_for_edge(edge) if leg.leg == payload.leg), None)
    if leg is None:
        raise HTTPException(status_code=422, detail="Недопустимое плечо для этой связи")
    if (
        resolve_to_participant(leg.from_id, participant_ids, all_nodes) != frm.node_id
        or resolve_to_participant(leg.to_id, participant_ids, all_nodes) != to.node_id
    ):
        raise HTTPException(
            status_code=422,
            detail="Концы связи не проецируются на выбранных участников",
        )
    msg = ProcessMessage(
        process_id=proc.id,
        order=payload.order,
        edge_id=edge.id,
        leg=payload.leg,
        from_participant_id=frm.id,
        to_participant_id=to.id,
        caption=payload.caption,
    )
    db.add(msg)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(msg)
    part_by_id = {p.id: p for p in proc.participants}
    return message_out(msg, edge, part_by_id)


@router.patch("/{process_id}/messages/{message_id}", response_model=MessageOut)
def update_message(
    process_id: uuid.UUID,
    message_id: uuid.UUID,
    payload: MessageUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> MessageOut:
    proc = _get_process(db, process_id, project)
    msg = db.get(ProcessMessage, message_id)
    if msg is None or msg.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(msg, field, value)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(msg)
    part_by_id = {p.id: p for p in proc.participants}
    return message_out(msg, db.get(Edge, msg.edge_id) if msg.edge_id else None, part_by_id)


@router.delete(
    "/{process_id}/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_message(
    process_id: uuid.UUID,
    message_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    proc = _get_process(db, process_id, project)
    msg = db.get(ProcessMessage, message_id)
    if msg is None or msg.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    db.delete(msg)
    touch_project(db, project, user.id)
    db.commit()


# ── Фрагменты (свободный слой) ────────────────────────────────────────────────
@router.post(
    "/{process_id}/fragments",
    response_model=FragmentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_fragment(
    process_id: uuid.UUID,
    payload: FragmentCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> FragmentOut:
    proc = _get_process(db, process_id, project)
    if payload.from_order > payload.to_order:
        raise HTTPException(status_code=422, detail="from_order должен быть ≤ to_order")
    frag = ProcessFragment(
        process_id=proc.id,
        kind=payload.kind,
        from_order=payload.from_order,
        to_order=payload.to_order,
        guard=payload.guard,
        else_guard=payload.else_guard,
        else_order=payload.else_order,
    )
    db.add(frag)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(frag)
    return FragmentOut(
        id=frag.id,
        kind=frag.kind,  # type: ignore[arg-type]
        from_order=frag.from_order,
        to_order=frag.to_order,
        guard=frag.guard,
        else_guard=frag.else_guard,
        else_order=frag.else_order,
    )


@router.patch("/{process_id}/fragments/{fragment_id}", response_model=FragmentOut)
def update_fragment(
    process_id: uuid.UUID,
    fragment_id: uuid.UUID,
    payload: FragmentUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> FragmentOut:
    proc = _get_process(db, process_id, project)
    frag = db.get(ProcessFragment, fragment_id)
    if frag is None or frag.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Фрагмент не найден")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(frag, field, value)
    if frag.from_order > frag.to_order:
        raise HTTPException(status_code=422, detail="from_order должен быть ≤ to_order")
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(frag)
    return FragmentOut(
        id=frag.id,
        kind=frag.kind,  # type: ignore[arg-type]
        from_order=frag.from_order,
        to_order=frag.to_order,
        guard=frag.guard,
        else_guard=frag.else_guard,
        else_order=frag.else_order,
    )


@router.delete(
    "/{process_id}/fragments/{fragment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_fragment(
    process_id: uuid.UUID,
    fragment_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> None:
    proc = _get_process(db, process_id, project)
    frag = db.get(ProcessFragment, fragment_id)
    if frag is None or frag.process_id != proc.id:
        raise HTTPException(status_code=404, detail="Фрагмент не найден")
    db.delete(frag)
    touch_project(db, project, user.id)
    db.commit()


# ── Композитор: каналы между парой участников ─────────────────────────────────
@router.get("/{process_id}/directions", response_model=list[DirectionOut])
def list_directions(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[DirectionOut]:
    """Куда МОЖНО завести сообщение — сразу для всех пар участников процесса.

    Композитор спрашивает про одну пару (/channels); индикации при протягивании
    нужна вся картина, и считать её на клиенте нельзя: проекция концов связи через
    предков живёт здесь, и вторая реализация неизбежно разошлась бы с валидатором.
    """
    proc = _get_process(db, process_id, project)
    all_nodes = load_nodes(db, project.id)
    participant_ids = {p.node_id for p in proc.participants}
    edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    return [
        DirectionOut(from_id=f, to_id=t)
        for f, t in sorted(legal_directions(edges, participant_ids, all_nodes))
    ]


@router.get("/{process_id}/channels", response_model=list[ChannelOut])
def list_channels(
    process_id: uuid.UUID,
    a: uuid.UUID,
    b: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ChannelOut]:
    proc = _get_process(db, process_id, project)
    all_nodes = load_nodes(db, project.id)
    participant_ids = {p.node_id for p in proc.participants}
    pair = {a, b}
    out: list[ChannelOut] = []
    for edge in db.query(Edge).filter(Edge.project_id == project.id).all():
        p = resolve_to_participant(edge.source_id, participant_ids, all_nodes)
        q = resolve_to_participant(edge.target_id, participant_ids, all_nodes)
        if p is None or q is None or p == q or {p, q} != pair:
            continue
        legs_out: list[LegOut] = []
        for leg in legs_for_edge(edge):
            # Концы плеча проецируем на участников — фронт пришлёт их в POST /messages
            f = resolve_to_participant(leg.from_id, participant_ids, all_nodes)
            t = resolve_to_participant(leg.to_id, participant_ids, all_nodes)
            if f is None or t is None:
                continue
            legs_out.append(
                LegOut(
                    leg=leg.leg,  # type: ignore[arg-type]
                    kind=leg.kind,  # type: ignore[arg-type]
                    from_id=f,
                    to_id=t,
                    default_caption=leg.default_caption,
                )
            )
        out.append(
            ChannelOut(
                edge_id=edge.id,
                source_id=edge.source_id,
                target_id=edge.target_id,
                technology=edge.technology,
                label=edge.label,
                synchronous=edge_is_synchronous(edge),
                legs=legs_out,
            )
        )
    return out
