"""Глубокая копия схемы проекта (POST /projects со start="copy:<projectId>").

Копирует узлы, связи, бизнес-процессы и весь раскладочный слой в новый проект
с НОВЫМИ id, перемэппивая все внутренние ссылки. Исходный проект не меняется.
"""

import uuid

from sqlalchemy.orm import Session

from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.edge_waypoint import EdgeWaypoint
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node
from app.models.process_fragment import ProcessFragment
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant


def copy_project_schema(db: Session, src_id: uuid.UUID, dst_id: uuid.UUID) -> None:
    """Скопировать всю схему проекта src_id в проект dst_id с новыми id. Коммит —
    на вызывающей стороне. Узлы вставляются родителями раньше детей (FK parent_id)."""
    nmap: dict[uuid.UUID, uuid.UUID] = {}  # старый node id → новый
    emap: dict[uuid.UUID, uuid.UUID] = {}  # старый edge id → новый
    pmap: dict[uuid.UUID, uuid.UUID] = {}  # старый process id → новый
    partmap: dict[uuid.UUID, uuid.UUID] = {}  # старый participant id → новый

    nodes = db.query(Node).filter(Node.project_id == src_id).all()
    # Заранее выделяем новые id, чтобы перемэппить parent_id без учёта порядка.
    for n in nodes:
        nmap[n.id] = uuid.uuid4()
    # Сортировка по глубине: родитель (его новый id уже в nmap) существует до ребёнка.
    by_id = {n.id: n for n in nodes}

    def depth(n: Node) -> int:
        d, cur = 0, n
        while cur.parent_id is not None and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            d += 1
        return d

    for n in sorted(nodes, key=depth):
        db.add(
            Node(
                id=nmap[n.id],
                project_id=dst_id,
                name=n.name,
                description=n.description,
                role=n.role,
                technology=n.technology,
                parent_id=nmap.get(n.parent_id) if n.parent_id else None,
                flowchart=n.flowchart,
                openapi_spec=n.openapi_spec,
                pos_x=n.pos_x,
                pos_y=n.pos_y,
                is_external=n.is_external,
                shape=n.shape,
            )
        )
    db.flush()

    for e in db.query(Edge).filter(Edge.project_id == src_id).all():
        emap[e.id] = uuid.uuid4()
        db.add(
            Edge(
                id=emap[e.id],
                project_id=dst_id,
                label=e.label,
                technology=e.technology,
                source_id=nmap[e.source_id],
                target_id=nmap[e.target_id],
                source_handle=e.source_handle,
                target_handle=e.target_handle,
                is_synchronous=e.is_synchronous,
                waypoints=e.waypoints,
                label_t=e.label_t,
            )
        )
    db.flush()

    # Бизнес-процессы + их участники/сообщения/фрагменты.
    procs = db.query(BusinessProcess).filter(BusinessProcess.project_id == src_id).all()
    for p in procs:
        pmap[p.id] = uuid.uuid4()
        db.add(
            BusinessProcess(
                id=pmap[p.id],
                project_id=dst_id,
                name=p.name,
                scope_node_id=nmap.get(p.scope_node_id) if p.scope_node_id else None,
            )
        )
    db.flush()
    if procs:
        old_pids = list(pmap.keys())
        for part in db.query(ProcessParticipant).filter(
            ProcessParticipant.process_id.in_(old_pids)
        ):
            partmap[part.id] = uuid.uuid4()
            db.add(
                ProcessParticipant(
                    id=partmap[part.id],
                    process_id=pmap[part.process_id],
                    node_id=nmap[part.node_id],
                    order=part.order,
                )
            )
        db.flush()
        for msg in db.query(ProcessMessage).filter(ProcessMessage.process_id.in_(old_pids)):
            db.add(
                ProcessMessage(
                    id=uuid.uuid4(),
                    process_id=pmap[msg.process_id],
                    order=msg.order,
                    edge_id=emap.get(msg.edge_id) if msg.edge_id else None,
                    leg=msg.leg,
                    from_participant_id=partmap[msg.from_participant_id],
                    to_participant_id=partmap[msg.to_participant_id],
                    caption=msg.caption,
                )
            )
        for frag in db.query(ProcessFragment).filter(ProcessFragment.process_id.in_(old_pids)):
            db.add(
                ProcessFragment(
                    id=uuid.uuid4(),
                    process_id=pmap[frag.process_id],
                    kind=frag.kind,
                    from_order=frag.from_order,
                    to_order=frag.to_order,
                    guard=frag.guard,
                    else_guard=frag.else_guard,
                    else_order=frag.else_order,
                )
            )

    # Раскладочный слой: ключи — id узлов/рёбер, перемэппиваем теми же картами.
    # container_id и node_id — узлы; edge_id — связь. Пустой исходник — нечего копировать.
    if not nmap:
        return
    node_keys = list(nmap.keys())
    for gp in db.query(GhostPosition).filter(GhostPosition.container_id.in_(node_keys)):
        if gp.node_id not in nmap:
            continue
        db.add(
            GhostPosition(
                id=uuid.uuid4(),
                container_id=nmap[gp.container_id],
                node_id=nmap[gp.node_id],
                pos_x=gp.pos_x,
                pos_y=gp.pos_y,
            )
        )
    for gh in db.query(GhostEdgeHandle).filter(GhostEdgeHandle.container_id.in_(node_keys)):
        if gh.edge_id not in emap or gh.node_id not in nmap:
            continue
        db.add(
            GhostEdgeHandle(
                id=uuid.uuid4(),
                container_id=nmap[gh.container_id],
                edge_id=emap[gh.edge_id],
                node_id=nmap[gh.node_id],
                handle=gh.handle,
            )
        )
    for ew in db.query(EdgeWaypoint).filter(EdgeWaypoint.container_id.in_(node_keys)):
        if ew.edge_id not in emap:
            continue
        db.add(
            EdgeWaypoint(
                id=uuid.uuid4(),
                container_id=nmap[ew.container_id],
                edge_id=emap[ew.edge_id],
                waypoints=ew.waypoints,
                anchor_node_id=nmap[ew.anchor_node_id] if ew.anchor_node_id else None,
            )
        )
