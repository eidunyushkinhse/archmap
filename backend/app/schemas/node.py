import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.edge import Point

# C4-формы узла. Источник правды контракта — этот Literal; фронтовый NodeShape
# генерируется из него (openapi-typescript). Заодно серверная валидация shape.
NodeShape = Literal["service", "database", "broker", "person"]

# Статус жизненного цикла узла. Источник правды контракта — этот Literal.
NodeStatus = Literal["existing", "planned", "deprecated"]


class NodeCreate(BaseModel):
    name: str
    description: str | None = None
    role: str | None = None
    technology: str | None = None
    parent_id: uuid.UUID | None = None
    flowchart: str | None = None
    openapi_spec: str | None = None
    is_external: bool = False
    shape: NodeShape = "service"
    status: NodeStatus = "existing"
    # Координаты раскладки при создании перетаскиванием шаблона на схему: сервер
    # кладёт их строкой view_layout в вид РОДИТЕЛЯ (в колонках узла позиций больше
    # нет — R3, единое хранилище раскладки). Узел появляется там, где его бросили.
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
    is_external: bool | None = None
    shape: NodeShape | None = None
    status: NodeStatus | None = None


class NodeResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    role: str | None
    technology: str | None
    parent_id: uuid.UUID | None
    flowchart: str | None
    openapi_spec: str | None
    is_external: bool
    shape: NodeShape
    status: NodeStatus
    # Вычисляемые в роутере (в БД не хранятся): число прямых детей и булев флаг
    # их наличия. child_count — для ранжирования узлов в дереве UI («главное» сверху).
    child_count: int = 0
    has_children: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AncestorRef(BaseModel):
    id: uuid.UUID
    name: str
    # внешний ли узел-предок — нужно для цвета свёрнутого гостя-контейнера на схеме
    is_external: bool = False


class GhostNodeResponse(BaseModel):
    id: uuid.UUID
    name: str
    role: str | None
    technology: str | None
    is_external: bool
    shape: NodeShape
    status: NodeStatus = "existing"
    node_depth: int
    # есть ли у гостя дети: промежуточному госту даём кнопку «Войти» (провалиться
    # на его слой-схему компонентов), атомарному (лист) проваливаться некуда.
    has_children: bool = False
    # число прямых детей — для бейджа «есть дети (N)» на узле-госте схемы уровня.
    child_count: int = 0
    # цепочка предков (корень → непосредственный родитель) — по ней фронт
    # проецирует конец на видимого представителя и строит вложенные рамки
    ancestors: list[AncestorRef] = []
    is_ghost: Literal[True] = True

    model_config = {"from_attributes": True}


class ViewLayoutPayload(BaseModel):
    """Геометрия одного объекта раскладки на виде (R3, единое хранилище view_layout).

    Для узла/отображаемой сущности — x/y (позиция, own-on-first-render).
    Для ПУЧКА рёбер (item_id "b:<src>><tgt>") — хэндлы концов, изломы waypoints
    (+ anchor: не null → точки это ОФСЕТ от позиции узла-якоря, Ф3) и доля плашки
    label_t (теперь пер-вид). Все поля опциональны — хранится только заданное.
    """
    x: float | None = None
    y: float | None = None
    source_handle: str | None = None
    target_handle: str | None = None
    waypoints: list[Point] | None = None
    anchor: uuid.UUID | None = None
    label_t: float | None = None


class ViewLayoutBatch(BaseModel):
    """Батч-запись раскладки вида: item_id → payload; null — удалить строку
    (сброс объекта в авто-геометрию)."""
    items: dict[str, ViewLayoutPayload | None]


class GraphEdgeResponse(BaseModel):
    """Ребро графа уровня — СЫРОЕ (R2 вид-центричного движка, C4_ENGINE_AUDIT.md).

    source_id/target_id — РЕАЛЬНЫЕ концы (узел может лежать глубоко в поддереве
    ребёнка или вовсе вне уровня). Проекцию концов на видимые сущности («подъём к
    ближайшему видимому представителю») делает фронтенд (graph/projection.ts):
    она зависит от expand/collapse-состояния, известного только ему. Сервер лишь
    отбирает рёбра, затрагивающие поддерево уровня.
    """
    id: uuid.UUID
    label: str | None
    technology: str | None
    source_id: uuid.UUID
    target_id: uuid.UUID


class ContextEdgeResponse(BaseModel):
    """Ребро контекст-схемы: концы СПРОЕЦИРОВАНЫ сервером (внутренний конец →
    фокус), original_* — реальные узлы для деталей связи. Контекст сознательно
    остаётся серверной проекцией (Д5 аудита: не трогаем до R6); waypoints/label_t
    не отдаются — раскладка звезды эфемерна и живёт в своей системе координат.
    """
    id: uuid.UUID
    label: str | None
    technology: str | None
    source_id: uuid.UUID
    target_id: uuid.UUID
    original_source_id: uuid.UUID
    original_target_id: uuid.UUID
    original_source_name: str
    original_target_name: str


class GraphResponse(BaseModel):
    nodes: list[NodeResponse]
    edges: list[GraphEdgeResponse]
    # Реестр КОНЦОВ рёбер, не являющихся локальными узлами уровня: и внешние
    # (гости), и глубокие внутри поддерева (концы сквозных связей в детях).
    # Несут цепочку предков — по ней фронтовая проекция поднимает конец к
    # ближайшему видимому представителю и строит рамки/раскрытие.
    endpoints: list[GhostNodeResponse]
    # Раскладка вида как есть (все строки view_layout этого вида): item_id →
    # payload. Ключи: uuid узла/сущности (позиция) и "b:<src>><tgt>" (пучок).
    # Какая проекция показана — решает фронт; лишние ключи безвредны (F6а).
    layout: dict[str, ViewLayoutPayload] = {}


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
    edges: list[ContextEdgeResponse] = []


class NodeEdgeInfo(BaseModel):
    """Связь узла для предупреждения при удалении: направление + имя связанного узла."""
    id: uuid.UUID
    label: str | None
    technology: str | None
    # "outgoing" — связь идёт ОТ удаляемого узла; "incoming" — К нему
    direction: Literal["outgoing", "incoming"]
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


class IsolatedGroupAlert(BaseModel):
    """Изолированная группа: связная компонента графа рёбер (≥2 узла),
    не имеющая ни одной связи с другими частями схемы. Считается только
    по рёбрам (иерархия parent_id игнорируется)."""
    node_ids: list[uuid.UUID]
    node_names: list[str]


class AlertsResponse(BaseModel):
    disconnected_nodes: list[DisconnectedNodeAlert] = []
    intermediate_edges: list[IntermediateEdgeAlert] = []
    isolated_groups: list[IsolatedGroupAlert] = []
