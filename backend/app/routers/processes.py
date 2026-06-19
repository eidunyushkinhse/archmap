"""API бизнес-процессов: /api/v1/processes.

Точка enforcement «запертого слоя»: сообщение можно создать только на легальное плечо
существующего канала, концы которого сходятся по проекции на участников (ТЗ §3.2).
Раскладку диаграммы не храним — она выводится на фронте из order/kind.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_architect
from app.database import get_db
from app.deps import get_current_project, scoped_edge, touch_project
from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_fragment import ProcessFragment
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.project import Project
from app.models.user import User
from app.processes import edge_is_synchronous, legs_for_edge, resolve_to_participant
from app.schemas.process import (
    ChannelOut,
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
from app.tree import subtree_ids

router = APIRouter(prefix="/processes", tags=["processes"])


# ── Вспомогательные ───────────────────────────────────────────────────────────
def _load_nodes(db: Session, project: Project) -> dict[uuid.UUID, Node]:
    """Карта узлов ТЕКУЩЕГО проекта — для проекции концов и проверки области."""
    return {n.id: n for n in db.query(Node).filter(Node.project_id == project.id).all()}


def _get_process(db: Session, process_id: uuid.UUID, project: Project) -> BusinessProcess:
    """Процесс текущего проекта, иначе 404 (чужой процесс недоступен — изоляция)."""
    proc = db.get(BusinessProcess, process_id)
    if proc is None or proc.project_id != project.id:
        raise HTTPException(status_code=404, detail="Процесс не найден")
    return proc


def _message_kind(leg: str, edge: Edge | None) -> str:
    """Стиль стрелки: return → return; forward на async-канале → async; иначе forward."""
    if leg == "return":
        return "return"
    if edge is not None and not edge_is_synchronous(edge):
        return "async"
    return "forward"


def _default_caption(leg: str, edge: Edge | None) -> str | None:
    if leg == "return":
        return "ответ"
    return edge.label if edge is not None else None


def _participant_out(p: ProcessParticipant, node: Node) -> ParticipantOut:
    return ParticipantOut(
        id=p.id,
        node_id=p.node_id,
        name=node.name,
        role=node.role,
        shape=node.shape,  # type: ignore[arg-type]
        is_external=node.is_external,
        status=node.status,  # type: ignore[arg-type]
        order=p.order,
    )


def _message_out(
    msg: ProcessMessage, edge: Edge | None, part_by_id: dict[uuid.UUID, ProcessParticipant]
) -> MessageOut:
    caption = msg.caption if msg.caption is not None else _default_caption(msg.leg, edge)
    return MessageOut(
        id=msg.id,
        order=msg.order,
        edge_id=msg.edge_id,
        leg=msg.leg,  # type: ignore[arg-type]
        kind=_message_kind(msg.leg, edge),  # type: ignore[arg-type]
        caption=caption,
        technology=edge.technology if edge is not None else None,
        from_id=part_by_id[msg.from_participant_id].node_id,
        to_id=part_by_id[msg.to_participant_id].node_id,
        valid=msg.edge_id is not None,
    )


def _build_detail(db: Session, proc: BusinessProcess, all_nodes: dict[uuid.UUID, Node]) -> ProcessDetail:
    parts = sorted(proc.participants, key=lambda p: p.order)
    part_by_id = {p.id: p for p in parts}
    edge_cache: dict[uuid.UUID, Edge | None] = {}

    def edge_of(eid: uuid.UUID | None) -> Edge | None:
        if eid is None:
            return None
        if eid not in edge_cache:
            edge_cache[eid] = db.get(Edge, eid)
        return edge_cache[eid]

    messages = [
        _message_out(m, edge_of(m.edge_id), part_by_id)
        for m in sorted(proc.messages, key=lambda m: m.order)
    ]
    fragments = [
        FragmentOut(
            id=f.id,
            kind=f.kind,  # type: ignore[arg-type]
            from_order=f.from_order,
            to_order=f.to_order,
            guard=f.guard,
            else_guard=f.else_guard,
            else_order=f.else_order,
        )
        for f in sorted(proc.fragments, key=lambda f: f.from_order)
    ]
    scope_node = all_nodes.get(proc.scope_node_id) if proc.scope_node_id else None
    return ProcessDetail(
        id=proc.id,
        name=proc.name,
        scope_node_id=proc.scope_node_id,
        scope_name=scope_node.name if scope_node else None,
        participants=[_participant_out(p, all_nodes[p.node_id]) for p in parts],
        messages=messages,
        fragments=fragments,
    )


def _scope_node_ids(all_nodes: dict[uuid.UUID, Node], scope_node_id: uuid.UUID | None) -> set[uuid.UUID]:
    """Множество узлов, из которых можно брать участников: поддерево scope или вся схема."""
    if scope_node_id is None:
        return set(all_nodes.keys())
    return subtree_ids(all_nodes, scope_node_id)


# ── Процессы ──────────────────────────────────────────────────────────────────
@router.get("", response_model=list[ProcessListItem])
def list_processes(
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> list[ProcessListItem]:
    all_nodes = _load_nodes(db, project)
    # Счётчик сообщений только по процессам текущего проекта (join к BusinessProcess).
    counts = dict(
        db.query(ProcessMessage.process_id, func.count(ProcessMessage.id))
        .join(BusinessProcess, BusinessProcess.id == ProcessMessage.process_id)
        .filter(BusinessProcess.project_id == project.id)
        .group_by(ProcessMessage.process_id)
        .all()
    )
    # Статусы узлов-участников по процессам — для производного бейджа в списке.
    proc_statuses: dict[uuid.UUID, set[str]] = {}
    for proc_id, node_id in (
        db.query(ProcessParticipant.process_id, ProcessParticipant.node_id)
        .join(BusinessProcess, BusinessProcess.id == ProcessParticipant.process_id)
        .filter(BusinessProcess.project_id == project.id)
        .all()
    ):
        node = all_nodes.get(node_id)
        if node is not None:
            proc_statuses.setdefault(proc_id, set()).add(node.status)
    out: list[ProcessListItem] = []
    for proc in (
        db.query(BusinessProcess)
        .filter(BusinessProcess.project_id == project.id)
        .order_by(BusinessProcess.created_at)
        .all()
    ):
        scope = all_nodes.get(proc.scope_node_id) if proc.scope_node_id else None
        out.append(
            ProcessListItem(
                id=proc.id,
                name=proc.name,
                scope_node_id=proc.scope_node_id,
                scope_name=scope.name if scope else None,
                message_count=counts.get(proc.id, 0),
                statuses=sorted(proc_statuses.get(proc.id, set())),  # type: ignore[arg-type]
            )
        )
    return out


@router.post("", response_model=ProcessDetail, status_code=status.HTTP_201_CREATED)
def create_process(
    payload: ProcessCreate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ProcessDetail:
    all_nodes = _load_nodes(db, project)
    if payload.scope_node_id is not None and payload.scope_node_id not in all_nodes:
        raise HTTPException(status_code=404, detail="Узел области не найден")
    proc = BusinessProcess(
        name=payload.name, scope_node_id=payload.scope_node_id, project_id=project.id
    )
    db.add(proc)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(proc)
    return _build_detail(db, proc, all_nodes)


@router.get("/{process_id}", response_model=ProcessDetail)
def get_process(
    process_id: uuid.UUID,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    _: User = Depends(get_current_user),
) -> ProcessDetail:
    proc = _get_process(db, process_id, project)
    return _build_detail(db, proc, _load_nodes(db, project))


@router.patch("/{process_id}", response_model=ProcessDetail)
def update_process(
    process_id: uuid.UUID,
    payload: ProcessUpdate,
    db: Session = Depends(get_db),
    project: Project = Depends(get_current_project),
    user: User = Depends(require_architect),
) -> ProcessDetail:
    proc = _get_process(db, process_id, project)
    all_nodes = _load_nodes(db, project)
    data = payload.model_dump(exclude_unset=True)
    if "scope_node_id" in data and data["scope_node_id"] is not None:
        if data["scope_node_id"] not in all_nodes:
            raise HTTPException(status_code=404, detail="Узел области не найден")
    for field, value in data.items():
        setattr(proc, field, value)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(proc)
    return _build_detail(db, proc, all_nodes)


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
    all_nodes = _load_nodes(db, project)
    node = all_nodes.get(payload.node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Узел не найден")
    if payload.node_id not in _scope_node_ids(all_nodes, proc.scope_node_id):
        raise HTTPException(status_code=422, detail="Узел вне области процесса")
    if any(p.node_id == payload.node_id for p in proc.participants):
        raise HTTPException(status_code=409, detail="Узел уже участвует в процессе")
    part = ProcessParticipant(process_id=proc.id, node_id=payload.node_id, order=payload.order)
    db.add(part)
    touch_project(db, project, user.id)
    db.commit()
    db.refresh(part)
    return _participant_out(part, node)


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
    all_nodes = _load_nodes(db, project)
    parts = sorted(proc.participants, key=lambda p: p.order)
    return [_participant_out(p, all_nodes[p.node_id]) for p in parts]


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
    all_nodes = _load_nodes(db, project)
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
    return _message_out(msg, edge, part_by_id)


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
    return _message_out(msg, db.get(Edge, msg.edge_id) if msg.edge_id else None, part_by_id)


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
    all_nodes = _load_nodes(db, project)
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
