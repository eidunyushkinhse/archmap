"""Глобальные алерты незавершённости схемы.

Доменный алгоритм, который раньше жил прямо в HTTP-слое (routers.nodes.get_alerts):
по всей схеме проекта находит три класса проблем — «подвисшие» атомарные узлы без
единой связи, связи с концом в промежуточном (контейнерном) узле и изолированные
группы (связные компоненты графа рёбер). HTTP-слой лишь отдаёт готовый ответ.
"""

import uuid

from sqlalchemy.orm import Session, aliased

from app.models.business_process import BusinessProcess
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.process_message import ProcessMessage
from app.models.process_participant import ProcessParticipant
from app.schemas.node import (
    AlertsResponse,
    ContainerOwnDocsAlert,
    DanglingMessageAlert,
    DisconnectedNodeAlert,
    IntermediateEdgeAlert,
    IsolatedGroupAlert,
    OrphanLegAlert,
    PersonInsideAlert,
    UnboundParticipantAlert,
)


def compute_alerts(db: Session, project_id: uuid.UUID) -> AlertsResponse:
    """Глобальные алерты незавершённости схемы проекта:
    1) атомарные (листовые) узлы без единой связи — «подвисшие»;
    2) связи, у которых хотя бы один конец упирается в промежуточный
       (контейнерный) узел, а не в атомарный;
    3) изолированные группы — связные компоненты графа рёбер;
    4) контейнеры с СОБСТВЕННЫМИ доками/спекой (grandfather) — логика и спеки
       должны жить на атомарных детях, такие доки распределяют по детям;
    5) люди (shape=person), вложенные в другой узел — по C4 актор живёт на
       контекстном уровне, ВНЕ границы системы;
    6) повисшие сообщения процессов — связь, которой шло сообщение, удалена
       из схемы (edge_id = NULL).
    Контейнеры в проверке (1) не участвуют: прямых связей у них быть не должно
    (это как раз ловит проверка 2), а группировку детей за «подвисание» не считаем.
    """
    all_nodes = db.query(Node).filter(Node.project_id == project_id).all()
    all_edges = db.query(Edge).filter(Edge.project_id == project_id).all()
    name_by_id = {n.id: n.name for n in all_nodes}

    # Промежуточные узлы = те, что являются чьим-то родителем (есть дети)
    intermediate_ids = {
        pid
        for (pid,) in db.query(Node.parent_id)
        .filter(Node.project_id == project_id, Node.parent_id.isnot(None))
        .distinct()
        .all()
    }

    # Узлы, у которых есть хоть одна связь (по сырым концам рёбер)
    connected_ids: set[uuid.UUID] = set()
    for e in all_edges:
        connected_ids.add(e.source_id)
        connected_ids.add(e.target_id)

    disconnected = [
        DisconnectedNodeAlert(node_id=n.id, node_name=n.name)
        for n in all_nodes
        if n.id not in intermediate_ids and n.id not in connected_ids
    ]

    intermediate_edges: list[IntermediateEdgeAlert] = []
    for e in all_edges:
        src_inter = e.source_id in intermediate_ids
        tgt_inter = e.target_id in intermediate_ids
        if src_inter or tgt_inter:
            intermediate_edges.append(
                IntermediateEdgeAlert(
                    edge_id=e.id,
                    label=e.label,
                    source_id=e.source_id,
                    source_name=name_by_id.get(e.source_id, "?"),
                    target_id=e.target_id,
                    target_name=name_by_id.get(e.target_id, "?"),
                    source_is_intermediate=src_inter,
                    target_is_intermediate=tgt_inter,
                )
            )

    # 3) Изолированные группы — связные компоненты графа РЁБЕР (иерархию
    #    parent_id игнорируем: иначе всё связано через дерево). Узлы без
    #    единой связи сюда не попадают (их ловит проверка 1). Алерт зажигаем,
    #    только если связных групп (≥2 узла) больше одной — иначе это просто
    #    единственный кластер плюс висячие узлы, и фрагментации нет.
    adjacency: dict[uuid.UUID, set[uuid.UUID]] = {}
    for e in all_edges:
        adjacency.setdefault(e.source_id, set()).add(e.target_id)
        adjacency.setdefault(e.target_id, set()).add(e.source_id)

    visited: set[uuid.UUID] = set()
    components: list[list[uuid.UUID]] = []
    for start in adjacency:
        if start in visited:
            continue
        stack = [start]
        visited.add(start)
        comp: list[uuid.UUID] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nxt in adjacency[cur]:
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append(nxt)
        if len(comp) >= 2:
            components.append(comp)

    isolated_groups: list[IsolatedGroupAlert] = []
    if len(components) >= 2:
        for comp in components:
            isolated_groups.append(
                IsolatedGroupAlert(
                    node_ids=comp,
                    node_names=[name_by_id.get(nid, "?") for nid in comp],
                )
            )

    # 4) Контейнеры с собственными доками/спекой (grandfather). Контейнер =
    #    service с детьми. Алерт: узел стал контейнером, но логика/спека
    #    остались на нём — надо распределить по детям.
    node_ids = [n.id for n in all_nodes]
    doc_owner_flat: set[uuid.UUID] = set()
    if node_ids:
        rows = db.query(NodeDoc.node_id).filter(NodeDoc.node_id.in_(node_ids)).distinct().all()
        doc_owner_flat = {nid for (nid,) in rows}

    container_own_docs: list[ContainerOwnDocsAlert] = []
    for n in all_nodes:
        if n.id not in intermediate_ids or n.shape != "service":
            continue
        has_docs = n.id in doc_owner_flat
        has_spec = bool(n.openapi_spec)
        if has_docs or has_spec:
            container_own_docs.append(
                ContainerOwnDocsAlert(
                    node_id=n.id,
                    node_name=n.name,
                    has_docs=has_docs,
                    has_spec=has_spec,
                )
            )

    # 5) Люди внутри системы. Правило C4: актор не может быть частью контейнера.
    #    Промпт импорта его требует, отчёт слияния предупреждает — но объекты,
    #    заведённые РУКАМИ, не проверял никто (остаток находки 2026-08-08).
    persons_inside = [
        PersonInsideAlert(
            node_id=n.id,
            node_name=n.name,
            parent_id=n.parent_id,
            parent_name=name_by_id.get(n.parent_id, "?"),
        )
        for n in all_nodes
        if n.shape == "person" and n.parent_id is not None
    ]

    # 6) Повисшие сообщения процессов. Удаление связи из схемы НЕ сносит сообщение
    #    (ON DELETE SET NULL) — расхождение процесса со схемой должно быть видно, а
    #    не происходить тихо. До сих пор оно было видно только ВНУТРИ окна процесса;
    #    здесь тот же факт поднимается на уровень схемы. Самосообщения исключены:
    #    у внутренней операции участника связи C4 и не было.
    from_p = aliased(ProcessParticipant)
    to_p = aliased(ProcessParticipant)
    dangling_messages = [
        DanglingMessageAlert(
            process_id=proc_id,
            process_name=proc_name,
            message_id=msg_id,
            caption=caption,
            # Живое имя узла, а у непривязанного участника — его собственное:
            # иначе конец повисшего шага показывался бы как «?».
            from_name=name_by_id.get(from_node) or from_own,
            to_name=name_by_id.get(to_node) or to_own,
        )
        for proc_id, proc_name, msg_id, caption, from_node, to_node, from_own, to_own in (
            db.query(
                BusinessProcess.id,
                BusinessProcess.name,
                ProcessMessage.id,
                ProcessMessage.caption,
                from_p.node_id,
                to_p.node_id,
                from_p.name,
                to_p.name,
            )
            .join(ProcessMessage, ProcessMessage.process_id == BusinessProcess.id)
            .join(from_p, from_p.id == ProcessMessage.from_participant_id)
            .join(to_p, to_p.id == ProcessMessage.to_participant_id)
            .filter(
                BusinessProcess.project_id == project_id,
                ProcessMessage.edge_id.is_(None),
                ProcessMessage.from_participant_id != ProcessMessage.to_participant_id,
            )
            .order_by(BusinessProcess.name, ProcessMessage.order)
            .all()
        )
    ]

    # 7) Участники процессов без узла схемы (AL27). Симметрично повисшему сообщению:
    #    линия жизни на диаграмме есть, объекта архитектуры за ней нет. Путь
    #    исправления — привязка участника к узлу прямо на его шапке.
    unbound_participants = [
        UnboundParticipantAlert(
            process_id=proc_id, process_name=proc_name, participant_id=part_id, name=name
        )
        for proc_id, proc_name, part_id, name in (
            db.query(
                BusinessProcess.id,
                BusinessProcess.name,
                ProcessParticipant.id,
                ProcessParticipant.name,
            )
            .join(ProcessParticipant, ProcessParticipant.process_id == BusinessProcess.id)
            .filter(
                BusinessProcess.project_id == project_id,
                ProcessParticipant.node_id.is_(None),
            )
            .order_by(BusinessProcess.name, ProcessParticipant.order)
            .all()
        )
    ]

    # 8) Шаги, у которых пропало ПЛЕЧО канала (AL28). Связь на месте — исчезло
    #    именно плечо: канал сменили на асинхронный уже после создания шага-ответа.
    #    Сравнение с False, а не «not True»: is_synchronous nullable, и NULL значит
    #    синхронный по умолчанию (edge_is_synchronous) — такой шаг цел.
    orphan_legs = [
        OrphanLegAlert(
            process_id=proc_id,
            process_name=proc_name,
            message_id=msg_id,
            caption=caption,
            edge_label=edge_label,
            from_name=name_by_id.get(from_node) or from_own,
            to_name=name_by_id.get(to_node) or to_own,
        )
        for proc_id, proc_name, msg_id, caption, edge_label, from_node, to_node, from_own, to_own in (
            db.query(
                BusinessProcess.id,
                BusinessProcess.name,
                ProcessMessage.id,
                ProcessMessage.caption,
                Edge.label,
                from_p.node_id,
                to_p.node_id,
                from_p.name,
                to_p.name,
            )
            .join(ProcessMessage, ProcessMessage.process_id == BusinessProcess.id)
            .join(Edge, Edge.id == ProcessMessage.edge_id)
            .join(from_p, from_p.id == ProcessMessage.from_participant_id)
            .join(to_p, to_p.id == ProcessMessage.to_participant_id)
            .filter(
                BusinessProcess.project_id == project_id,
                ProcessMessage.leg == "return",
                Edge.is_synchronous.is_(False),
            )
            .order_by(BusinessProcess.name, ProcessMessage.order)
            .all()
        )
    ]

    return AlertsResponse(
        disconnected_nodes=disconnected,
        intermediate_edges=intermediate_edges,
        isolated_groups=isolated_groups,
        container_own_docs=container_own_docs,
        persons_inside=persons_inside,
        dangling_messages=dangling_messages,
        unbound_participants=unbound_participants,
        orphan_legs=orphan_legs,
    )
