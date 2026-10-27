import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.domain_types import NodeApproval, NodeShape, NodeStatus, SiteKind
from app.schemas.node_doc import NodeDocMeta
from app.schemas.view import ViewLayoutPayload

# C4-формы и статусы узла — словари предметной области (app/domain_types): из них
# же генерируются фронтовые NodeShape/NodeStatus и валидируется вход.


class NodeSource(BaseModel):
    """ЯКОРЬ узла — чем ArchMap опознаёт объект при обновлениях из кода
    (docs/plan-anchor-ux.md). Видов ровно два, и они взаимоисключающи:

    • КОД — repo (+ path внутри него) у объектов, чей код лежит в продукте;
    • ИМЯ ЗАВИСИМОСТИ — host: как продукт САМ называет базу, брокер или соседний
      продукт в своих манифестах и дефолтах. Не адрес среды.

    В ОТВЕТЕ repo и host никогда не заполнены одновременно: хранится один
    канонический ключ (nodes.source_ref), и словарь — его разбор. В ЗАПРОСЕ
    (NodeUpdate) прислать оба — 422: вид якоря надо выбрать."""

    repo: str | None = None
    path: str | None = None
    host: str | None = None


class AnchorPreviewOut(BaseModel):
    """Ответ dry-run проверки якоря (POST /nodes/anchor-preview).

    Форма якоря неинтуитивна: архитектор вставляет адрес клона или путь как в
    файловой системе и не обязан знать, во что это превратится. Ручка отвечает
    ровно то, что записал бы PATCH, НИЧЕГО не записывая: нормализованный блок
    source (или null — очистка), вид якоря словом для UI и канонический ключ
    хранения. Отказы — те же 422, что у PATCH (общая функция валидации)."""

    source: NodeSource | None = None
    # Вид якоря для подписи в UI: код (репозиторий и путь) или имя зависимости.
    kind: Literal["code", "dependency"] | None = None
    # Канонический ключ (nodes.source_ref) — то, чем узел будет опознаваться.
    key: str | None = None


class NodeSiteOut(BaseModel):
    """Площадка, на которой стоит объект (строка «Размещение» страницы объекта и
    карточка MCP; docs/tasks/deployment-view.md).

    id — площадка; parent_id и parent_name — площадка, в которую она вложена («в
    Облако»); имя — в ответе, чтобы строке «Размещение» и карточке MCP не ходить за
    списком площадок. partial — только у контейнера: на площадке стоит часть его
    объектов, а не все (у объекта всегда False)."""

    id: uuid.UUID
    name: str
    kind: SiteKind
    parent_id: uuid.UUID | None = None
    parent_name: str | None = None
    partial: bool = False

    model_config = {"from_attributes": True}


class NodeCreate(BaseModel):
    name: str
    description: str | None = None
    role: str | None = None
    technology: str | None = None
    parent_id: uuid.UUID | None = None
    # Логика узла (mermaid) в создание не входит: доки — коллекция node_docs,
    # создаются после узла своим API (POST /nodes/{id}/docs).
    openapi_spec: str | None = None
    is_external: bool = False
    shape: NodeShape = "service"
    status: NodeStatus = "existing"
    # ЯКОРЬ узла при создании: объект может родиться сразу опознаваемым из кода
    # (агент MCP создаёт узел и тут же привязывает его к репозиторию — иначе
    # понадобился бы второй PATCH). Правила и отказы те же, что у NodeUpdate.source:
    # вид один на объект, путь живёт при репозитории, адреса сред якорем не бывают.
    # Не прислан (или пуст) — узел без якоря, как и раньше: опознаётся по имени.
    source: NodeSource | None = None
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
    openapi_spec: str | None = None
    is_external: bool | None = None
    shape: NodeShape | None = None
    status: NodeStatus | None = None
    # Статус СТРАНИЦЫ (docs/tasks/page-status.md). Не прислан — не трогаем (фронт шлёт
    # его только из пилюли, отдельным PATCH). У контейнера (есть дети) — 422: его
    # статус складывается из детей. В NodeCreate поля нет: новый объект всегда «в работе».
    approval: NodeApproval | None = None
    # ЯКОРЬ узла. Поле НЕ ПРИСЛАНО — якорь не трогаем (фронт шлёт полный payload
    # свойств и не обязан знать про якорь); прислан null или объект без значимых
    # полей — якорь очищается; объект с полями — нормализуется (app/identity) и
    # кладётся в source_ref сильнейшим ключом. Разбор и отказы — в routers.nodes,
    # чтобы 422 приходил в общем формате {"detail": "…"}, а не списком pydantic.
    source: NodeSource | None = None
    # РАЗМЕЩЕНИЕ — набор площадок, где объект крутится, ЦЕЛИКОМ (как PUT
    # /deployment/placements для одного объекта). Не прислано (или null) — не
    # трогаем; [] — снять всё своё размещение (останется унаследованное от предка).
    # У «Пользователя» — 422: он живёт вне системы. CAS узла правка размещения не
    # двигает: это не колонка узла, а набор строк экземпляров.
    site_ids: list[uuid.UUID] | None = None
    # CAS (этап 0 конкурентности): версия узла, от которой клиент правил. Не
    # совпала с текущей → 409 (узел изменён другой сессией — критично для текста
    # openapi_spec). None — без проверки (компенсации undo, совместимость).
    # У доков логики (node_docs) — свой version/base_version в их PATCH.
    base_version: int | None = None


class NodeResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    role: str | None
    technology: str | None
    parent_id: uuid.UUID | None
    openapi_spec: str | None
    # Мета доков логики (без content — контент лениво GET /nodes/{id}/docs при
    # открытии оверлея). Наполняется relationship Node.docs (lazy="selectin").
    docs: list[NodeDocMeta] = []
    is_external: bool
    shape: NodeShape
    status: NodeStatus
    # Вычисляемые в роутере (в БД не хранятся): число прямых детей и булев флаг
    # их наличия. child_count — для ранжирования узлов в дереве UI («главное» сверху).
    child_count: int = 0
    has_children: bool = False
    # Статус СТРАНИЦЫ объекта (не жизненный цикл status): approval — хранимое значение
    # (ставит редактор у листа), approval_effective — вычисленное с учётом детей
    # (app/approval.py): у листа совпадает с хранимым, у контейнера — approved, только
    # если согласованы все дети. Показывать надо approval_effective.
    approval: NodeApproval = "in_progress"
    approval_effective: NodeApproval = "in_progress"
    # Якорь узла: канонический ключ хранения (source_ref) и он же разобранный
    # по видам (source). Ставится прогоном агента ИЛИ рукой архитектора —
    # PATCH принимает source (см. NodeUpdate). Разобранный вид — для карточки
    # объекта, ключ — для синка и внутренних сверок.
    source_ref: str | None = None
    source: NodeSource | None = None
    # Размещение (app/deployment.mark_sites): площадки объекта, у контейнера —
    # площадки его объектов (где стоит часть — partial). Вычисляется в выдачах
    # роутера узлов; граф уровня и контекст-схема его НЕ заполняют (холст объектов
    # размещение не показывает) — там всегда [].
    sites: list[NodeSiteOut] = []
    # Версия для optimistic CAS: клиент шлёт её обратно как base_version в PATCH.
    version: int = 1
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
    # Канал брокера, названный связью: в уровневом контракте он есть (в отличие от
    # is_synchronous), потому что его правят прямо в инспекторе редактора-карты —
    # без значения поле показывало бы пустоту при заполненной связи.
    channel: str | None = None
    # Версия связи для optimistic CAS правок из инспектора (base_version в PATCH).
    version: int = 1


class GraphResponse(BaseModel):
    nodes: list[NodeResponse]
    edges: list[GraphEdgeResponse]
    # Реестр КОНЦОВ рёбер, не являющихся локальными узлами уровня: и внешние
    # (гости), и глубокие внутри поддерева (концы сквозных связей в детях).
    # Несут цепочку предков — по ней фронтовая проекция поднимает конец к
    # ближайшему видимому представителю и строит рамки/раскрытие.
    endpoints: list[GhostNodeResponse]
    # Раскладка вида (строки view_layout этого вида): item_id → payload.
    # Ключи — uuid узла/сущности (позиция/expanded); легаси-строки без живых
    # полей (например, пучки "b:") в отдачу не попадают — отфильтрованы.
    # Какая проекция показана — решает фронт; лишние ключи безвредны (F6а).
    layout: dict[str, ViewLayoutPayload] = {}
    # Версия вида (fence записей раскладки) и курсоры изменений проекта (поллинг):
    # базовая точка отсчёта клиента при загрузке уровня (этапы 0/1 конкурентности).
    version: int = 0
    graph_rev: int = 0
    meta_rev: int = 0
    # Есть ли в ПРОЕКТЕ узлы planned/deprecated. Признак проектный (не уровневый):
    # им фронт решает, показывать ли «Вид схемы» и «Принять переход» — обе вещи
    # относятся ко всему проекту. Считает project_has_status_info.
    has_status_info: bool = False


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

class DistributeDocAssignment(BaseModel):
    """Назначение одного собственного дока контейнера конкретному ребёнку."""
    doc_id: uuid.UUID
    child_id: uuid.UUID


class DistributeDocsIn(BaseModel):
    """Вход переноса: маппинг доков по детям + опциональный ребёнок для спеки.

    openapi_spec у узла один: переносится целиком на ОДНОГО ребёнка
    (spec_child_id). Если детей несколько и спека есть — пользователь в
    модалке выбирает, кому она отойдёт."""
    doc_assignments: list[DistributeDocAssignment] = []
    spec_child_id: uuid.UUID | None = None


class DistributeDocsOut(BaseModel):
    """Отчёт переноса."""
    moved_docs: int
    spec_moved: bool
