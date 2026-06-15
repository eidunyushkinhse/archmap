"""Сборка снимка удаляемого поддерева и восстановление из снимка (Undo удаления).

Снимок (build_deletion_snapshot) собирается ДО удаления и повторяет ровно то, что
снесёт БД-каскад: поддерево узлов, инцидентные рёбра (источник/цель в поддереве) и
ghost-метаданные, где под каскад попал container_id, node_id или edge_id. Восстановление
(restore_from_snapshot) воссоздаёт всё это С СОХРАНЕНИЕМ исходных id, чтобы вернувшиеся
узлы/рёбра были теми же сущностями (ссылки извне, история, redo=повторное удаление по id).
"""

import uuid

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import tree
from app.models.edge import Edge
from app.models.edge_waypoint import EdgeWaypoint
from app.models.ghost_edge_handle import GhostEdgeHandle
from app.models.ghost_position import GhostPosition
from app.models.node import Node
from app.schemas.restore import (
    DeletionSnapshot,
    EdgeSnapshot,
    EdgeWaypointSnapshot,
    GhostEdgeHandleSnapshot,
    GhostPositionSnapshot,
    NodeSnapshot,
)


def build_deletion_snapshot(db: Session, root_id: uuid.UUID) -> DeletionSnapshot:
    """Снимок всего, что исчезнет при удалении узла root_id (вызывать ДО delete)."""
    subtree = tree.collect_subtree_ids_db(db, root_id)

    nodes = db.query(Node).filter(Node.id.in_(subtree)).all()
    # Рёбра с любым концом в поддереве — их снесёт каскад (source_id/target_id CASCADE).
    edges = (
        db.query(Edge)
        .filter(or_(Edge.source_id.in_(subtree), Edge.target_id.in_(subtree)))
        .all()
    )
    edge_ids = {e.id for e in edges}

    # ghost-строки гибнут, если под каскад попал container_id ИЛИ node_id (а для
    # хэндлов/изломов — ещё и edge_id удаляемого ребра).
    ghost_positions = (
        db.query(GhostPosition)
        .filter(
            or_(
                GhostPosition.container_id.in_(subtree),
                GhostPosition.node_id.in_(subtree),
            )
        )
        .all()
    )
    ghost_edge_handles = (
        db.query(GhostEdgeHandle)
        .filter(
            or_(
                GhostEdgeHandle.container_id.in_(subtree),
                GhostEdgeHandle.node_id.in_(subtree),
                GhostEdgeHandle.edge_id.in_(edge_ids),
            )
        )
        .all()
    )
    edge_waypoints = (
        db.query(EdgeWaypoint)
        .filter(
            or_(
                EdgeWaypoint.container_id.in_(subtree),
                EdgeWaypoint.edge_id.in_(edge_ids),
            )
        )
        .all()
    )

    return DeletionSnapshot(
        nodes=[NodeSnapshot.model_validate(n) for n in nodes],
        edges=[EdgeSnapshot.model_validate(e) for e in edges],
        ghost_positions=[GhostPositionSnapshot.model_validate(g) for g in ghost_positions],
        ghost_edge_handles=[
            GhostEdgeHandleSnapshot.model_validate(g) for g in ghost_edge_handles
        ],
        edge_waypoints=[EdgeWaypointSnapshot.model_validate(w) for w in edge_waypoints],
    )


def build_edge_deletion_snapshot(db: Session, edge_id: uuid.UUID) -> DeletionSnapshot:
    """Снимок одной связи и её ghost-метаданных (Undo удаления/создания связи).

    Симметричен build_deletion_snapshot, но узкий: узлы не трогаются (связь их не
    каскадит), снимок несёт само ребро + ghost-хэндлы и изломы по этому edge_id на
    всех уровнях — их снёс бы каскад при удалении связи. Восстанавливается тем же
    restore_from_snapshot (nodes=[]) с сохранением исходного id.
    """
    edge = db.get(Edge, edge_id)
    ghost_edge_handles = (
        db.query(GhostEdgeHandle).filter(GhostEdgeHandle.edge_id == edge_id).all()
    )
    edge_waypoints = (
        db.query(EdgeWaypoint).filter(EdgeWaypoint.edge_id == edge_id).all()
    )
    return DeletionSnapshot(
        nodes=[],
        edges=[EdgeSnapshot.model_validate(edge)] if edge is not None else [],
        ghost_positions=[],
        ghost_edge_handles=[
            GhostEdgeHandleSnapshot.model_validate(g) for g in ghost_edge_handles
        ],
        edge_waypoints=[EdgeWaypointSnapshot.model_validate(w) for w in edge_waypoints],
    )


def restore_from_snapshot(db: Session, snapshot: DeletionSnapshot) -> None:
    """Воссоздать узлы/рёбра/ghost-строки из снимка с сохранением исходных id.

    Узлы вставляются родителями раньше детей: FK parent_id проверяется сразу, а
    корень поддерева ссылается на уцелевший (внешний) узел уровня. Рёбра и ghost-строки
    — после узлов (их FK на nodes/edges уже валидны).
    """
    by_id = {n.id: n for n in snapshot.nodes}

    def depth(n: NodeSnapshot) -> int:
        d = 0
        cur = n
        while cur.parent_id is not None and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            d += 1
        return d

    for ns in sorted(snapshot.nodes, key=depth):
        db.add(
            Node(
                id=ns.id,
                name=ns.name,
                description=ns.description,
                role=ns.role,
                technology=ns.technology,
                parent_id=ns.parent_id,
                flowchart=ns.flowchart,
                openapi_spec=ns.openapi_spec,
                pos_x=ns.pos_x,
                pos_y=ns.pos_y,
                is_external=ns.is_external,
                shape=ns.shape,
            )
        )
    db.flush()  # узлы существуют до рёбер/ghost-строк

    for es in snapshot.edges:
        db.add(
            Edge(
                id=es.id,
                label=es.label,
                technology=es.technology,
                source_id=es.source_id,
                target_id=es.target_id,
                source_handle=es.source_handle,
                target_handle=es.target_handle,
                waypoints=[p.model_dump() for p in es.waypoints]
                if es.waypoints is not None
                else None,
                label_t=es.label_t,
            )
        )
    db.flush()

    for gp in snapshot.ghost_positions:
        db.add(
            GhostPosition(
                container_id=gp.container_id,
                node_id=gp.node_id,
                pos_x=gp.pos_x,
                pos_y=gp.pos_y,
                anchor_rel=gp.anchor_rel,
            )
        )
    for gh in snapshot.ghost_edge_handles:
        db.add(
            GhostEdgeHandle(
                container_id=gh.container_id,
                edge_id=gh.edge_id,
                node_id=gh.node_id,
                handle=gh.handle,
            )
        )
    for ew in snapshot.edge_waypoints:
        db.add(
            EdgeWaypoint(
                container_id=ew.container_id,
                edge_id=ew.edge_id,
                waypoints=[p.model_dump() for p in ew.waypoints],
            )
        )

    db.commit()
