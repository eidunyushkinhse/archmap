"""Снимок удаляемого поддерева и его восстановление (Undo удаления узла).

Удаление узла сносит БД-каскадом не только само поддерево, но и инцидентные рёбра
и ghost-метаданные (позиции/хэндлы/изломы) — в т.ч. на ДРУГИХ уровнях, которых на
фронте нет в памяти. Поэтому снимок собирается на бэке: только он знает всё, что
исчезнет. Схемы несут исходные id явно — restore воссоздаёт строки с их сохранением
(обычный create_node генерит новый id, поэтому здесь отдельный путь).
"""

import uuid

from pydantic import BaseModel

from app.schemas.edge import Point
from app.schemas.node import NodeShape


class NodeSnapshot(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    role: str | None = None
    technology: str | None = None
    parent_id: uuid.UUID | None = None
    flowchart: str | None = None
    openapi_spec: str | None = None
    pos_x: float | None = None
    pos_y: float | None = None
    is_external: bool = False
    shape: NodeShape = "service"

    model_config = {"from_attributes": True}


class EdgeSnapshot(BaseModel):
    id: uuid.UUID
    label: str | None = None
    technology: str | None = None
    source_id: uuid.UUID
    target_id: uuid.UUID
    source_handle: str | None = None
    target_handle: str | None = None
    waypoints: list[Point] | None = None
    label_t: float | None = None

    model_config = {"from_attributes": True}


class GhostPositionSnapshot(BaseModel):
    container_id: uuid.UUID
    node_id: uuid.UUID
    pos_x: float
    pos_y: float
    anchor_rel: bool = False

    model_config = {"from_attributes": True}


class GhostEdgeHandleSnapshot(BaseModel):
    container_id: uuid.UUID
    edge_id: uuid.UUID
    node_id: uuid.UUID
    handle: str

    model_config = {"from_attributes": True}


class EdgeWaypointSnapshot(BaseModel):
    container_id: uuid.UUID
    edge_id: uuid.UUID
    waypoints: list[Point]

    model_config = {"from_attributes": True}


class DeletionSnapshot(BaseModel):
    """Полный снимок того, что снёс БД-каскад при удалении узла: поддерево узлов,
    инцидентные рёбра и ghost-метаданные. Достаточно для точного восстановления."""

    nodes: list[NodeSnapshot]
    edges: list[EdgeSnapshot]
    ghost_positions: list[GhostPositionSnapshot]
    ghost_edge_handles: list[GhostEdgeHandleSnapshot]
    edge_waypoints: list[EdgeWaypointSnapshot]
