import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.broker_channel import ChannelAccessMode
from app.schemas.db_doc import DataAccessMode
from app.schemas.node_doc import NodeDocMeta

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
    # Логика узла (mermaid) в создание не входит: доки — коллекция node_docs,
    # создаются после узла своим API (POST /nodes/{id}/docs).
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
    openapi_spec: str | None = None
    is_external: bool | None = None
    shape: NodeShape | None = None
    status: NodeStatus | None = None
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
    # Канонический ключ источника (импорт/синк из репозитория). Только на чтение:
    # ставится прогоном агента, в NodeUpdate его нет.
    source_ref: str | None = None
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


class ViewLayoutPayload(BaseModel):
    """Геометрия одного объекта раскладки на виде (R3, единое хранилище view_layout).

    Для узла/отображаемой сущности — x/y (позиция, own-on-first-render) и
    expanded (R5: контейнер раскрыт инлайн в рамку с детьми; часть состояния
    ВИДА — view = (root, expanded set), переживает перезаход).
    Все поля опциональны — хранится только заданное.

    Ручной слой стрелок (хэндлы/изломы/якорь/label_t пучков "b:<src>><tgt>")
    УДАЛЁН 2026-07-09: геометрию стрелок целиком ведёт авто-раскладка. Легаси-
    строки пучков в БД безвредны (лишние ключи payload игнорируются) и уходят
    при «Переразложить уровень» / удалении узлов.
    """
    x: float | None = None
    y: float | None = None
    expanded: bool | None = None


class ViewLayoutBatch(BaseModel):
    """Батч-запись раскладки вида: item_id → payload; null — удалить строку
    (сброс объекта в авто-геометрию)."""
    items: dict[str, ViewLayoutPayload | None]
    # Fence (этап 0 конкурентности): версия вида, от которой клиент делал правку.
    # Не совпала с текущей → 409 (мир вида изменён другой сессией, клиент делает
    # ресинк и переигрывает интент пользователя). None — без проверки (совместимость).
    base_version: int | None = None


class ViewLayoutResult(BaseModel):
    """Ответ записи раскладки: новая версия вида (fence) и курсор изменений
    проекта (поллинг этапа 1) — клиент отслеживает их без рефетча
    (echo-suppression: свои записи не выглядят чужими)."""
    version: int
    graph_rev: int


class ViewStateResponse(BaseModel):
    """Лёгкий опрос свежести (этап 1): версия вида + курсоры проекта (схема/мета)."""
    version: int
    graph_rev: int
    # Курсор меты (атрибуты узлов/доки) — поллинг страницы объекта: «данные
    # изменились в другой сессии» vs «схема изменилась» (graph_rev).
    meta_rev: int = 0
    # Курсор процессов (Д9) — поллинг страницы процесса; дефолт 0 бережёт старых
    # клиентов, как meta_rev.
    process_rev: int = 0


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


class DescendantEdgeAlert(BaseModel):
    """Связь между узлом и его СОБСТВЕННЫМ потомком (ребёнком, внуком, любой
    глубины и в любую сторону): вложенность уже выражена иерархией, и стрелка
    ничего к ней не добавляет — её удаляют либо перевешивают на другой узел.

    Отдельный класс от IntermediateEdgeAlert: там конец уточняют до компонента, а
    здесь конец УЖЕ компонент — этого же контейнера, и совет «уточните» бессмыслен."""
    edge_id: uuid.UUID
    label: str | None
    source_id: uuid.UUID
    source_name: str
    target_id: uuid.UUID
    target_name: str
    # Какой конец является ЧАСТЬЮ другого: True — источник внутри приёмника,
    # False — приёмник внутри источника. Одного флага хватает: обоими частями
    # друг друга концы быть не могут.
    source_is_part: bool


class IsolatedGroupAlert(BaseModel):
    """Изолированная группа: связная компонента графа рёбер (≥2 узла),
    не имеющая ни одной связи с другими частями схемы. Считается только
    по рёбрам (иерархия parent_id игнорируется)."""
    node_ids: list[uuid.UUID]
    node_names: list[str]


class ContainerOwnDocsAlert(BaseModel):
    """Контейнер с СОБСТВЕННЫМИ доками/спекой (grandfather): узел стал
    контейнером (появились дети), но логика/спека остались на нём самом.
    Правила контейнеров: логика и спеки живут на атомарных детях — такие
    доки надо распределить по детям (модалка «Распределить по детям»)."""
    node_id: uuid.UUID
    node_name: str
    has_docs: bool
    has_spec: bool


class PersonInsideAlert(BaseModel):
    """Узел-человек (shape=person), вложенный в другой узел. По C4 люди живут на
    контекстном уровне, ВНЕ границы системы: актор не может быть частью
    контейнера. Правило уже требует промпт импорта и предупреждает отчёт
    слияния, но объекты, заведённые РУКАМИ, до этого алерта не проверял никто."""
    node_id: uuid.UUID
    node_name: str
    parent_id: uuid.UUID
    parent_name: str


class DanglingMessageAlert(BaseModel):
    """Сообщение процесса, потерявшее опору в схеме: связь, которой оно шло,
    удалили (edge_id → NULL по ON DELETE SET NULL — удаление связи НЕ сносит
    сообщение, чтобы расхождение было видно, а не происходило тихо).

    Самосообщения сюда не попадают: у внутренней операции участника связи C4 и
    не было (valid всегда true)."""
    process_id: uuid.UUID
    process_name: str
    message_id: uuid.UUID
    caption: str | None
    from_name: str
    to_name: str


class UnboundParticipantAlert(BaseModel):
    """Участник процесса без узла схемы (node_id = NULL). Появляется двумя путями:
    импортом диаграммы, где имя не сопоставили ни с одним узлом, и удалением узла —
    FK гасит ссылку (SET NULL), процесс переживает удаление вместо того, чтобы молча
    лишиться участника и всех его шагов.

    Вторая ось «незадокументированности», симметричная повисшему сообщению: линия
    жизни на схеме процесса есть, а объекта архитектуры за ней нет."""
    process_id: uuid.UUID
    process_name: str
    participant_id: uuid.UUID
    name: str  # имя из диаграммы либо имя узла на момент, когда он ещё был


class OrphanLegAlert(BaseModel):
    """Шаг процесса, чьё ПЛЕЧО у канала исчезло, хотя сама связь на месте.

    Единственный способ это получить — сменить синхронность канала на асинхронную
    после того, как шаг-ответ уже создан: у асинхронного канала плеча «ответ» нет
    (legs_for_edge), и create_message такое отклоняет, а существующее переживало
    смену молча. Отдельно от «сообщений без связи» (AL26) потому, что чинится
    иначе: «Восстановить связи» тут бессильна — она ищет канал повисшему шагу, а
    здесь канал есть.
    """
    process_id: uuid.UUID
    process_name: str
    message_id: uuid.UUID
    caption: str | None
    # Метка канала, у которого пропало плечо — по ней связь узнают на схеме.
    edge_label: str | None
    from_name: str
    to_name: str


class UnlinkedMessageAlert(BaseModel):
    """Шаг процесса без привязки к схеме логики (doc_id = NULL) — алерт ПОЛНОТЫ.

    Решение Р4 (2026-08-18): замечание на ЛЮБОЙ непривязанный шаг, не различая
    «не привязывали» и «схему удалили» (ON DELETE SET NULL гасит ссылку молча) —
    «шумно, зато консистентно». Это не «сломалось», а «шаг не документирован» —
    та же семья, что «не описана» у разведки: класс стартует со всех шагов
    проекта и гаснет работой по привязке. Самосообщения участвуют наравне:
    внутренняя операция участника тоже документируется схемой логики."""
    process_id: uuid.UUID
    process_name: str
    message_id: uuid.UUID
    caption: str | None
    from_name: str
    to_name: str


class UndescribedDocsAlert(BaseModel):
    """Объект с неописанными схемами логики (AL35) — алерт ПОЛНОТЫ.

    Заглушка разведки — строка перечня точек входа без тела (docs/plan-recon.md):
    не схема, а обещание её написать. ОДНА запись на объект, а не на заглушку:
    после разведки монолита заглушек две сотни, и панель алертов из двухсот строк —
    стена, а не сигнал; построчный бэклог живёт на странице объекта (блок
    «Не описано» под чертой в «Логике»). count — сколько заглушек у объекта."""
    node_id: uuid.UUID
    node_name: str
    count: int


class UnresolvedDataRefAlert(BaseModel):
    """Пометка «читает:/пишет:» в схеме логики, не нашедшая свою таблицу.

    Пометка — ОБЕЩАНИЕ ФАКТА (пивот §9 plan-db-docs.md): текст утверждает, что
    операция трогает такие-то данные. Невыполненное обещание молчать не должно —
    обратный индекс базы нерезолвнутую пометку не показывает вовсе, а обращение с
    несуществующей колонкой показывает как обращение к таблице ЦЕЛИКОМ, и алерт
    остаётся единственным местом, где расхождение текста со структурой видно.
    """

    # Узел-ВЛАДЕЛЕЦ дока (вызывающий), а не база: чинят текст пометки у него.
    node_id: uuid.UUID
    node_name: str
    doc_id: uuid.UUID
    doc_name: str
    ref: str  # ссылка как написана в тексте
    mode: DataAccessMode
    # Почему не срослось: таблицы нет / имя подходит нескольким целям / колонки нет
    # в найденной таблице. Зеркало app.data_refs.RefStatus без «ok».
    reason: Literal["unknown_table", "ambiguous", "unknown_column"]


class UnresolvedChannelRefAlert(BaseModel):
    """Пометка «публикует:/потребляет:» в схеме логики, не нашедшая свой канал.

    ОТДЕЛЬНЫЙ класс, а не расширение AL29 (решение §7.4 plan-broker-docs.md): у
    каналов свой каталог, свои причины и свои слова починки — «укажите „Брокер /
    канал“» вместо «„БД / таблица“». Смешать их значило бы предложить инженеру
    искать топик в структуре базы.
    """

    # Узел-ВЛАДЕЛЕЦ дока (публикующий/потребляющий), а не брокер: чинят текст у него.
    node_id: uuid.UUID
    node_name: str
    doc_id: uuid.UUID
    doc_name: str
    ref: str  # ссылка как написана в тексте
    mode: ChannelAccessMode
    # Почему не срослось: канала нет / имя подходит нескольким / поля нет в канале.
    reason: Literal["unknown_channel", "ambiguous", "unknown_field"]


class UnresolvedConfigRefAlert(BaseModel):
    """Пометка «зависит от:» в схеме логики, не нашедшая параметра конфигурации.

    Третий отдельный класс по той же причине, что и второй: своя починка — «опишите
    ручку в разделе „Конфигурация“ этого объекта или поправьте имя». Ни поля reason,
    ни поля mode здесь НЕТ, и это не экономия: у семьи ровно одна причина промаха
    (параметра с таким именем у объекта нет) и ровно один режим — неоднозначность и
    «нет члена» невозможны по построению (docs/plan-config-docs.md §3).

    ⚠️ Класс заведомо ловит и ПРОЗУ: «зависит от: нагрузки» — обычная русская фраза,
    а не ссылка. Так и задумано (маркер с двоеточием — обещание факта), поэтому текст
    замечания в интерфейсе обязан подсказывать оба выхода: описать параметр либо
    переписать фразу без двоеточия.
    """

    # Узел-ВЛАДЕЛЕЦ дока: он же и владелец параметра — искать негде больше.
    node_id: uuid.UUID
    node_name: str
    doc_id: uuid.UUID
    doc_name: str
    ref: str  # ссылка как написана в тексте


class BrokerEdgeChannelAlert(BaseModel):
    """Связь с брокером, которая не называет канал либо называет несуществующий.

    Решение пользователя №4 (docs/plan-broker-docs.md §4): стрелка «сервис → брокер»
    ОБЯЗАНА назвать топик/очередь — без этого схема не отвечает на «откуда взялось
    событие». Канал на связи — ссылка по ИМЕНИ, а не FK, поэтому шов держит алерт:
    `missing` — канал не указан вовсе, `unknown` — указан, но структура брокера-конца
    такого канала не знает (опечатка либо канал не описан).
    """

    edge_id: uuid.UUID
    source_name: str
    target_name: str
    # Конец-БРОКЕР, по чьей структуре искали канал (оба конца брокеры — назван первый:
    # искали у обоих, и починка начинается с любого).
    broker_name: str
    # Как написано на связи; null — не указан вовсе (reason=missing).
    channel: str | None = None
    reason: Literal["missing", "unknown"]


class AlertsResponse(BaseModel):
    disconnected_nodes: list[DisconnectedNodeAlert] = []
    intermediate_edges: list[IntermediateEdgeAlert] = []
    isolated_groups: list[IsolatedGroupAlert] = []
    container_own_docs: list[ContainerOwnDocsAlert] = []
    persons_inside: list[PersonInsideAlert] = []
    dangling_messages: list[DanglingMessageAlert] = []
    unbound_participants: list[UnboundParticipantAlert] = []
    orphan_legs: list[OrphanLegAlert] = []
    unresolved_data_refs: list[UnresolvedDataRefAlert] = []
    # Дефолт [] обязателен: старые клиенты (в т.ч. MCP-сервер пользователя) читают
    # ответ, ничего не зная о новом классе, и обязательное поле сломало бы их.
    unresolved_channel_refs: list[UnresolvedChannelRefAlert] = []
    # Связи с брокером без канала / с неизвестным каналом (AL31) — дефолт [] по той же
    # причине.
    broker_edge_channels: list[BrokerEdgeChannelAlert] = []
    # Связи узла с собственным потомком (AL32) — дефолт [] по той же причине.
    descendant_edges: list[DescendantEdgeAlert] = []
    # Пометки «зависит от:», не нашедшие параметра (AL33) — дефолт [] по той же причине.
    unresolved_config_refs: list[UnresolvedConfigRefAlert] = []
    # Шаги процессов без привязки к схеме логики (AL34) — дефолт [] по той же причине.
    unlinked_messages: list[UnlinkedMessageAlert] = []
    # Объекты с неописанными схемами логики (AL35) — дефолт [] по той же причине.
    undescribed_docs: list[UndescribedDocsAlert] = []


# --- Перенос grandfather-доков/спеки контейнера на его детей («Распределить по детям») ---

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


class TransitionNodeOut(BaseModel):
    """Объект в плане перехода: показываем именем и путём — id нужен только коду."""

    id: uuid.UUID
    name: str
    path: str


class TransitionPreviewOut(BaseModel):
    """Что произойдёт, если принять переход. Ничего не записано."""

    graph_rev: int
    is_noop: bool
    # Верхние выводимые узлы (их поддеревья уедут каскадом).
    delete: list[TransitionNodeOut] = []
    # Сколько узлов исчезнет ВСЕГО, вместе с потомками.
    delete_total: int = 0
    # Уезжающие ЗАОДНО: устаревшими их никто не помечал, они просто лежат внутри.
    # Главное, что должно быть видно до подтверждения.
    collateral: list[TransitionNodeOut] = []
    delete_edges: int = 0
    delete_docs: int = 0
    delete_specs: int = 0
    promote: list[TransitionNodeOut] = []


class TransitionApplyIn(BaseModel):
    """Курсор схемы, увиденный в превью: если схему успели изменить, применение
    отклоняется, а не выполняет вслепую не то, что человек видел."""

    base_graph_rev: int | None = None


class TransitionApplyOut(BaseModel):
    deleted_nodes: int
    promoted_nodes: int
