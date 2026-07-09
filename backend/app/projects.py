"""Глубокая копия схемы проекта (POST /projects со start="copy:<projectId>").

Копирует узлы, связи, бизнес-процессы и весь раскладочный слой в новый проект
с НОВЫМИ id, перемэппивая все внутренние ссылки. Исходный проект не меняется.
"""

import uuid

from sqlalchemy.orm import Session

from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.process_fragment import ProcessFragment
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.models.view_layout import ViewLayoutItem


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
                is_external=n.is_external,
                shape=n.shape,
                status=n.status,
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
                is_synchronous=e.is_synchronous,
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

    # Раскладочный слой (view_layout): ремапим вид и все uuid внутри строкового
    # ключа (позиции — сам uuid узла; пучки — "b:<src>><tgt>"; хэндлы в payload
    # несут uuid узла префиксом `<id>--...`; anchor — uuid узла-якоря).
    if not nmap:
        return
    str_map = {str(old): str(new) for old, new in nmap.items()}

    def remap_str(s: str) -> str:
        for old, new in str_map.items():
            if old in s:
                s = s.replace(old, new)
        return s

    for it in db.query(ViewLayoutItem).filter(ViewLayoutItem.project_id == src_id):
        new_view = nmap.get(it.view_id) if it.view_id is not None else None
        if it.view_id is not None and new_view is None:
            continue  # вид ссылался на несуществующий узел — мусор, не копируем
        payload = dict(it.payload)
        for key in ("source_handle", "target_handle", "anchor"):
            if isinstance(payload.get(key), str):
                payload[key] = remap_str(payload[key])
        db.add(
            ViewLayoutItem(
                id=uuid.uuid4(),
                project_id=dst_id,
                view_id=new_view,
                item_id=remap_str(it.item_id),
                payload=payload,
            )
        )
