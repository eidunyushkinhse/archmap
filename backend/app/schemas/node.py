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
    pos_x: float | None
    pos_y: float | None
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


class GhostPositionUpdate(BaseModel):
    # Абсолютные координаты гостя на уровне (own-on-first-render)
    pos_x: float
    pos_y: float


class GhostEdgeHandleUpdate(BaseModel):
    # Хэндл гостевого конца ребра на уровне, привязанный к id ОТОБРАЖАЕМОЙ сущности
    # (лист-гость ИЛИ предок-контейнер), к которой пристыкован конец стрелки.
    node_id: uuid.UUID
    handle: str


class EdgeWaypointsUpdate(BaseModel):
    # Кастомный путь (изломы) гостевой стрелки на уровне. Пустой список — сброс
    # в авто-маршрут (строка пер-уровневого слоя удаляется).
    waypoints: list[Point]
    # Идентичность якоря излома (Ф3). Не null — точки это ОФСЕТ от позиции узла
    # anchor_node_id (гостевой конец-потомок раскрытой рамки); null — абсолют уровня.
    anchor_node_id: uuid.UUID | None = None


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
    # сохранённые хэндлы точек стыковки «домашних» (локальных) концов
    source_handle: str | None
    target_handle: str | None
    # кастомные точки-сгибы пути (ручные «обходы» локальной стрелки)
    waypoints: list[Point] | None = None
    # позиция плашки вдоль стрелки (доля пути 0..1); null — по центру
    label_t: float | None = None


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
    source_handle: str | None
    target_handle: str | None


class PosXY(BaseModel):
    pos_x: float
    pos_y: float


class LevelWaypoints(BaseModel):
    # Изломы гостевой стрелки на уровне + идентичность якоря (Ф3). anchor_node_id не null →
    # точки waypoints это офсеты от позиции узла anchor_node_id; null → абсолют уровня.
    waypoints: list[Point]
    anchor_node_id: uuid.UUID | None = None


class GraphResponse(BaseModel):
    nodes: list[NodeResponse]
    edges: list[GraphEdgeResponse]
    # Реестр КОНЦОВ рёбер, не являющихся локальными узлами уровня: и внешние
    # (гости), и глубокие внутри поддерева (концы сквозных связей в детях).
    # Несут цепочку предков — по ней фронтовая проекция поднимает конец к
    # ближайшему видимому представителю и строит рамки/раскрытие.
    endpoints: list[GhostNodeResponse]
    # Сохранённые координаты гостей на этом уровне, ключ — id ОТОБРАЖАЕМОЙ сущности
    # (id самого гостя-листа ИЛИ id предка-контейнера, в который гость свёрнут).
    # Фронт expand/collapse-состояние знает только он, поэтому сюда кладём позиции
    # для всех возможных проекций (гость + его предки ниже общей с уровнем рамки).
    level_positions: dict[str, PosXY] = {}
    # Сохранённые хэндлы гостевых концов рёбер на этом уровне: edge_id → список
    # значений хэндлов (по одному на проекцию гостевого конца — лист-гость и/или
    # предок-контейнер). Фронт выбирает тот, чей префикс совпадает с id отображаемой
    # на данный момент сущности; остальные концы — из колонок ребра / autoHandles.
    level_edge_handles: dict[str, list[str]] = {}
    # Кастомные пути (изломы) ГОСТЕВЫХ стрелок на этом уровне: edge_id → путь + идентичность
    # якоря излома (anchor_node_id, Ф3). Локальные стрелки путь хранят в колонке самого ребра.
    level_edge_waypoints: dict[str, LevelWaypoints] = {}


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
