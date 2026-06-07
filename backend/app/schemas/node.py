import uuid
from datetime import datetime

from pydantic import BaseModel


class NodeCreate(BaseModel):
    name: str
    description: str | None = None
    role: str | None = None
    technology: str | None = None
    parent_id: uuid.UUID | None = None
    flowchart: str | None = None
    openapi_spec: str | None = None
    is_external: bool = False
    shape: str = "service"
    # Координаты раскладки: проставляются при создании узла перетаскиванием
    # шаблона из боковой панели на схему (узел появляется там, где его бросили)
    pos_x: float | None = None
    pos_y: float | None = None


class NodeUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    role: str | None = None
    technology: str | None = None
    parent_id: uuid.UUID | None = None
    flowchart: str | None = None
    openapi_spec: str | None = None
    pos_x: float | None = None
    pos_y: float | None = None
    is_external: bool | None = None
    shape: str | None = None


class NodeResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    role: str | None
    technology: str | None
    parent_id: uuid.UUID | None
    flowchart: str | None
    openapi_spec: str | None
    pos_x: float | None
    pos_y: float | None
    is_external: bool
    shape: str
    # Вычисляемый флаг: есть ли у узла дочерние узлы (для дерева в UI).
    # Проставляется в роутере, в БД не хранится.
    has_children: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AncestorRef(BaseModel):
    id: uuid.UUID
    name: str


class GhostNodeResponse(BaseModel):
    id: uuid.UUID
    name: str
    role: str | None
    technology: str | None
    is_external: bool
    shape: str
    node_depth: int
    # цепочка предков гостя (корень → непосредственный родитель) —
    # для вложенных рамок-контейнеров на схеме уровня
    ancestors: list[AncestorRef] = []
    # сохранённые координаты гостя на текущем уровне (null — ещё не двигали)
    pos_x: float | None = None
    pos_y: float | None = None
    is_ghost: bool = True

    model_config = {"from_attributes": True}


class GhostPositionUpdate(BaseModel):
    pos_x: float
    pos_y: float


class GhostEdgeHandleUpdate(BaseModel):
    # Хэндл гостевого конца ребра на уровне. Передаётся только та сторона, что
    # спроецирована на гостя; не указанная сторона не трогается (exclude_unset).
    source_handle: str | None = None
    target_handle: str | None = None


class GraphEdgeResponse(BaseModel):
    id: uuid.UUID
    label: str | None
    technology: str | None
    # эффективные концы ребра на данном уровне (после проекции)
    source_id: uuid.UUID
    target_id: uuid.UUID
    # исходные концы ребра (реальные узлы, могут быть с другого уровня)
    original_source_id: uuid.UUID
    original_target_id: uuid.UUID
    # сохранённые хэндлы точек стыковки
    source_handle: str | None
    target_handle: str | None


class PosXY(BaseModel):
    pos_x: float
    pos_y: float


class GraphResponse(BaseModel):
    nodes: list[NodeResponse]
    edges: list[GraphEdgeResponse]
    ghost_nodes: list[GhostNodeResponse]
    # Сохранённые координаты гостей на этом уровне, ключ — id ОТОБРАЖАЕМОЙ сущности
    # (id самого гостя-листа ИЛИ id предка-контейнера, в который гость свёрнут).
    # Фронт expand/collapse-состояние знает только он, поэтому сюда кладём позиции
    # для всех возможных проекций (гость + его предки ниже общей с уровнем рамки).
    level_positions: dict[str, PosXY] = {}


class NodeContextResponse(BaseModel):
    """«Контекстная схема» узла: сам узел + его прямые соседи.
    Сосед — другой конец любой связи, у которой ровно один конец лежит в поддереве
    фокуса (сам узел или любой его потомок). Рёбра спроецированы: конец внутри
    поддерева свёрнут на фокус, внешний конец указывает на узел-соседа.
    Соседи отдаются как «гости» (пунктир), focus_ancestors — для рамок предков.
    """
    focus: NodeResponse
    focus_ancestors: list[AncestorRef] = []
    neighbors: list[GhostNodeResponse] = []
    edges: list[GraphEdgeResponse] = []


class NodeEdgeInfo(BaseModel):
    """Связь узла для предупреждения при удалении: направление + имя связанного узла."""
    id: uuid.UUID
    label: str | None
    technology: str | None
    # "outgoing" — связь идёт ОТ удаляемого узла; "incoming" — К нему
    direction: str
    other_node_id: uuid.UUID
    other_node_name: str


# --- Алерты незавершённости схемы (глобальные, только для архитектора) ---

class DisconnectedNodeAlert(BaseModel):
    """Атомарный узел без единой связи («подвисший»)."""
    node_id: uuid.UUID
    node_name: str


class IntermediateEdgeAlert(BaseModel):
    """Связь, у которой хотя бы один конец упирается в промежуточный
    (контейнерный) узел, а не в атомарный."""
    edge_id: uuid.UUID
    label: str | None
    source_id: uuid.UUID
    source_name: str
    target_id: uuid.UUID
    target_name: str
    # какой из концов является промежуточным узлом
    source_is_intermediate: bool
    target_is_intermediate: bool


class AlertsResponse(BaseModel):
    disconnected_nodes: list[DisconnectedNodeAlert] = []
    intermediate_edges: list[IntermediateEdgeAlert] = []
