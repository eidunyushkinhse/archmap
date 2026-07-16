"""Снимок удаляемого поддерева и его восстановление (Undo удаления узла).

Удаление узла сносит БД-каскадом не только само поддерево, но и инцидентные рёбра
и строки раскладки (view_layout: свои виды — каскадом view_id, ссылки из чужих
видов — явной чисткой delete_node). Снимок собирается на бэке: только он знает
всё, что исчезнет. Схемы несут исходные id явно — restore воссоздаёт строки с их
сохранением (обычный create_node генерит новый id, поэтому здесь отдельный путь).
"""

import uuid

from pydantic import BaseModel

from app.schemas.node import NodeShape, NodeStatus
from app.schemas.node_doc import NodeDocKind


class NodeSnapshot(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    role: str | None = None
    technology: str | None = None
    parent_id: uuid.UUID | None = None
    openapi_spec: str | None = None
    is_external: bool = False
    shape: NodeShape = "service"
    status: NodeStatus = "existing"

    model_config = {"from_attributes": True}


class NodeDocSnapshot(BaseModel):
    """Док логики узла (node_docs) — умирает БД-каскадом вместе с узлом,
    восстанавливается с исходным id."""

    id: uuid.UUID
    node_id: uuid.UUID
    name: str
    kind: NodeDocKind = "overview"
    operation: str | None = None
    content: str = ""

    model_config = {"from_attributes": True}


class EdgeSnapshot(BaseModel):
    id: uuid.UUID
    label: str | None = None
    technology: str | None = None
    source_id: uuid.UUID
    target_id: uuid.UUID
    is_synchronous: bool | None = None

    model_config = {"from_attributes": True}


class ViewLayoutItemSnapshot(BaseModel):
    """Строка раскладки (view_layout), которую снесёт удаление: позиция узла или
    геометрия пучка — на любом виде, где поддерево участвовало."""
    view_id: uuid.UUID | None = None
    item_id: str
    payload: dict

    model_config = {"from_attributes": True}


class DeletionSnapshot(BaseModel):
    """Полный снимок того, что исчезнет при удалении узла: поддерево узлов,
    их доки логики, инцидентные рёбра и строки раскладки. Достаточно для
    точного восстановления."""

    nodes: list[NodeSnapshot]
    edges: list[EdgeSnapshot]
    layout_items: list[ViewLayoutItemSnapshot] = []
    # Дефолт [] — снимки, снятые до появления доков (в памяти живой сессии), валидны
    node_docs: list[NodeDocSnapshot] = []
