// Фасад типов контракта. Источник правды — бэкенд: интерфейсы ниже сгенерированы
// из OpenAPI в ./api.gen.ts (npm run gen:api) и здесь лишь переименованы в
// привычные фронту имена-алиасы. Менять контракт — правкой Pydantic-схем +
// перегенерацией, НЕ здесь. Рукописным остаётся только чисто фронтовое
// (canHaveChildren, UserRole); NodeShape и EdgePoint выводятся из генерата.
import type { components, operations } from "./api.gen";

type Schemas = components["schemas"];
// Параметры ручек (query) генерируются отдельно от схем — берём их отсюда.
type Operations = operations;

// C4-формы узла — выводим из сгенерированного контракта (Literal на бэке).
export type NodeShape = Schemas["NodeResponse"]["shape"];

// Статус жизненного цикла узла (as-is/to-be/deprecated) — Literal из контракта.
export type NodeStatus = Schemas["NodeResponse"]["status"];

// Узел-контейнер (можно «провалиться» внутрь и заводить детей) — ТОЛЬКО сервис.
// БД, брокер и пользователь — атомарные: drill-down/контекст внутрь не ведёт,
// детей у них не заводим, на схеме они не «зона входа» для сквозной связи.
export const canHaveChildren = (shape: NodeShape): boolean => shape === "service";

// Какая документация уместна форме узла (docs/plan-db-docs.md §1). Логика (mermaid)
// и OpenAPI — артефакты СЕРВИСА: они описывают его код и его API. У базы данных ни
// того, ни другого не бывает — её «контракт» это СТРУКТУРА (таблицы/колонки); промпт
// агента это правило проговаривает давно («у узла без собственного HTTP API спеки нет
// вовсе»), а страница объекта до 2026-08-12 всё равно предлагала слоты под них.
// У брокера «контракт» свой — КАНАЛЫ с полями сообщений (docs/plan-broker-docs.md).
// Конфигурация (переменные окружения, флаги) — тоже артефакт СЕРВИСА, как логика и
// спека: у базы и брокера свои настройки бывают, но ArchMap описывает свои сервисы, а
// инфраструктуру — чёрным ящиком с контрактом (docs/plan-config-docs.md §4).
export interface ShapeDocs {
  logic: boolean;
  spec: boolean;
  structure: boolean;
  channels: boolean;
  config: boolean;
}
export const shapeDocs = (shape: NodeShape): ShapeDocs => ({
  logic: shape === "service",
  spec: shape === "service",
  structure: shape === "database",
  channels: shape === "broker",
  config: shape === "service",
});

// Проект — изолированная схема. Мета (счётчики/редактор/даты) считается бэком.
export type Project = Schemas["ProjectResponse"];
export type ProjectCreate = Schemas["ProjectCreate"];
export type ProjectUpdate = Schemas["ProjectUpdate"];
export type ProjectPreview = Schemas["ProjectPreview"];

// Стартовые шаблоны проекта (витрина создания) + сводка dry-run импорта YAML.
export type TemplateOut = Schemas["TemplateOut"];
// Отчёт импорта архива знания (zip): счётчики категорий + родные отчёты семей.
export type ArchiveImportResult = Schemas["ArchiveImportResult"];
export type TemplateNode = Schemas["TemplateNodeOut"];
export type TemplateEdge = Schemas["TemplateEdgeOut"];
export type ImportPreviewOut = Schemas["ImportPreviewOut"];
export type ImportPromptOut = Schemas["ImportPromptOut"];

// Вариант BYOA-промпта, общий для всех четырёх промпт-ручек: строительный
// (дефолт, прежний байт-в-байт), оркестраторная обёртка с аудитом вторым
// агентом-скептиком и отдельный промпт аудита. Литерал ВЫВОДИМ из генерата —
// значения контракта руками не переписываем.
export type PromptVariant = NonNullable<
  NonNullable<Operations["data_prompt_api_v1_data_import_prompt_get"]["parameters"]["query"]>["variant"]
>;

// Синхронизация живого проекта со свежим прогоном агента (docs/plan-arch-sync.md):
// dry-run плана и отчёт применения.
// Пара участников, между которыми есть плечо канала (индикация в композиторе).
export type MessageDirection = Schemas["DirectionOut"];
export type SyncPreviewOut = Schemas["SyncPreviewOut"];
// «Принять переход»: план стал фактом (новое → существующее, выводимое → удалить).
export type TransitionPreview = Schemas["TransitionPreviewOut"];
export type TransitionApplyOut = Schemas["TransitionApplyOut"];
export type SyncApplyOut = Schemas["SyncApplyOut"];
export type SyncNodeAction = Schemas["SyncNodeActionOut"];
export type SyncEdgeAction = Schemas["SyncEdgeActionOut"];

export type Node = Schemas["NodeResponse"];

// Порядок узлов-сиблингов в дереве: РАНГ ФОРМЫ — сервисы с детьми (ядро системы),
// затем атомарные сервисы, затем БД, брокеры и персоны (без разделов — одним
// списком). Внутри ранга — ВНУТРЕННИЕ раньше внешних (по собственному is_external
// узла), при равенстве — по алфавиту. child_count считает бэкенд
// (_mark_has_children). Наследуется на всех уровнях дерева.
const siblingRank = (n: Node): number =>
  n.shape === "service" ? (n.child_count > 0 ? 0 : 1)
  : n.shape === "database" ? 2
  : n.shape === "broker" ? 3
  : 4; // person

export const compareByRank = (a: Node, b: Node): number =>
  siblingRank(a) - siblingRank(b) ||
  Number(a.is_external) - Number(b.is_external) ||
  a.name.localeCompare(b.name);

// Узлы-«пользователи» (shape: person) в дереве-навигаторе не показываем: дерево —
// навигатор детализации, «провалиться» внутрь пользователя нечего. Общий отсев для
// боковой панели (NodeTreePanel) и ветки детей в модалке (NodeModal).
export const withoutPersons = (nodes: Node[]): Node[] =>
  nodes.filter((n) => n.shape !== "person");

export type NodeCreate = Schemas["NodeCreate"];
export type NodeUpdate = Schemas["NodeUpdate"];

// Именованные схемы логики узла (node_docs): мета едет в Node.docs, полный док
// (с контентом) — лениво GET-ом при открытии оверлея «Логика».
export type NodeDoc = Schemas["NodeDocResponse"];
export type NodeDocMeta = Schemas["NodeDocMeta"];
export type NodeDocKind = NodeDocMeta["kind"];
export type NodeDocCreate = Schemas["NodeDocCreate"];
export type NodeDocUpdate = Schemas["NodeDocUpdate"];

// «Распределить по детям» (правила контейнеров): перенос grandfather-доков/спеки
// контейнера на его непосредственных детей.
export type DistributeDocAssignment = Schemas["DistributeDocAssignment"];
export type DistributeDocsIn = Schemas["DistributeDocsIn"];
export type DistributeDocsOut = Schemas["DistributeDocsOut"];

// Дозаливка доков от ИИ-агента: отчёт превью/применения пакета archmap-docs.
export type DocsImportReport = Schemas["DocsImportReport"];
export type DocsLogicItem = Schemas["DocsLogicItem"];
export type DocsSpecItem = Schemas["DocsSpecItem"];

// Точка ортогональной ломаной стрелки в координатах графа (чисто фронтовое:
// авто-маршруты роутера; в контракте геометрии стрелок больше нет).
export type EdgePoint = { x: number; y: number };

// Геометрия одного объекта раскладки на виде (единое хранилище view_layout):
// x/y — позиция (own-on-first-render), expanded — раскрытие контейнера. Ручной
// слой стрелок (пучки "b:…" с хэндлами/изломами/label_t) удалён 2026-07-09.
export type ViewLayoutPayload = Schemas["ViewLayoutPayload"];
// Ответ записи раскладки: новая версия вида (fence) + курсор проекта (поллинг).
export type ViewLayoutResult = Schemas["ViewLayoutResult"];
// Лёгкий опрос свежести (поллинг этапа 1): версия вида + курсор проекта.
export type ViewState = Schemas["ViewStateResponse"];
// Раскладка вида целиком: item_id → payload (как отдаёт GraphResponse.layout).
export type ViewLayout = Record<string, ViewLayoutPayload>;
// Владеемая позиция сущности на виде (внутренний формат модулей раскладки:
// кольца/разведение/keep-out). Производится конвейером из ViewLayout.
export type LevelPos = { pos_x: number; pos_y: number };

export type Edge = Schemas["EdgeResponse"];
export type EdgeUpdate = Schemas["EdgeUpdate"];
export type EdgeCreate = Schemas["EdgeCreate"];

// Ребро в конвейере раскладки. После смерти ручного слоя (2026-07-09) геометрии
// на рёбрах нет вовсе — алиас оставлен, чтобы сигнатуры модулей раскладки
// читались как «ребро уровня в раскладке», а не «сырое ребро БД».
export type LayoutEdge = Edge;

export type AncestorRef = Schemas["AncestorRef"];
// Инфо о конце ребра, не являющемся локальным узлом уровня (реестр endpoints
// графа): и внешние концы (гости), и глубокие внутри поддерева. Имя типа
// историческое — контекст-эндпоинт отдаёт той же схемой своих «соседей».
export type GhostNode = Schemas["GhostNodeResponse"];
// СЫРОЕ ребро графа уровня (R2): source_id/target_id — реальные концы; проекцию
// на видимые сущности делает graph/projection.ts на фронте.
export type GraphEdge = Schemas["GraphEdgeResponse"];

// Ребро в стейте уровня: EdgeResponse-подобное (source_id/target_id — РЕАЛЬНЫЕ
// концы, R2) плюс синтезируемые original_* — те же реальные концы с именами для
// деталей связи. Поля original_* остаются в типе ради панели EdgeInspector;
// заполняются из реестра endpoints (toLevelEdges в pageSchema.ts).
export type LevelEdge = Edge & {
  original_source_id: string;
  original_target_id: string;
  original_source_name: string;
  original_target_name: string;
};
export type GraphResponse = Schemas["GraphResponse"];
export type NodeEdgeInfo = Schemas["NodeEdgeInfo"];

export type DisconnectedNodeAlert = Schemas["DisconnectedNodeAlert"];
export type IntermediateEdgeAlert = Schemas["IntermediateEdgeAlert"];
export type IsolatedGroupAlert = Schemas["IsolatedGroupAlert"];
export type ContainerOwnDocsAlert = Schemas["ContainerOwnDocsAlert"];
// Пометка «читает:/пишет:» в схеме логики, не нашедшая таблицу структуры (AL29).
export type UnresolvedDataRefAlert = Schemas["UnresolvedDataRefAlert"];
// То же для событий: «публикует:/потребляет:» без канала у брокеров (AL30).
export type UnresolvedChannelRefAlert = Schemas["UnresolvedChannelRefAlert"];
// И то же для конфигурации: «зависит от:» без параметра у САМОГО объекта (AL33).
// Полей reason и mode у класса нет — причина и режим у него единственные.
export type UnresolvedConfigRefAlert = Schemas["UnresolvedConfigRefAlert"];
// Связь с брокером, не назвавшая канал (missing) либо назвавшая неизвестный (unknown) —
// шов «стрелка ↔ структура брокера», который держат алерты, а не FK (AL31).
export type BrokerEdgeChannelAlert = Schemas["BrokerEdgeChannelAlert"];
// Связь узла с его собственным потомком: вложенность уже выражена иерархией (AL32).
export type DescendantEdgeAlert = Schemas["DescendantEdgeAlert"];
export type SchemaAlerts = Schemas["AlertsResponse"];

export type Token = Schemas["Token"];

// Снимок удаляемого поддерева (узлы + рёбра + ghost-метаданные) для отката удаления
// через Undo: берётся ПЕРЕД delete, восстанавливается через POST /nodes/restore.
// openapi-typescript разводит Input/Output (у полей снимка есть дефолты) — берём
// Output (то, что отдаёт GET, со всеми полями); он присваиваем во входной body restore.
export type DeletionSnapshot = Schemas["DeletionSnapshot"];

// Экспорт схемы (или поддерева) в текст для скармливания LLM.
export type ExportResponse = Schemas["ExportResponse"];

export type UserRole = "architect" | "viewer";

// ── Бизнес-процессы (sequence-конструктор) ────────────────────────────────────
export type ProcessListItem = Schemas["ProcessListItem"];
export type ProcessDetail = Schemas["ProcessDetail"];
export type ProcessCreate = Schemas["ProcessCreate"];
export type ProcessUpdate = Schemas["ProcessUpdate"];
export type ProcessParticipant = Schemas["ParticipantOut"];
export type ProcessMessage = Schemas["MessageOut"];
export type ProcessFragment = Schemas["FragmentOut"];
export type Channel = Schemas["ChannelOut"];
// Каталог схем для привязки шага: строки + владелец для подстановки. Считает бэк —
// правило владельца и скоуп поддеревьев там же, где проекция концов связи.
export type MessageDocCatalog = Schemas["MessageDocCatalog"];
export type DocChoice = Schemas["DocChoiceOut"];
export type ChannelLeg = Schemas["LegOut"];
export type ParticipantCreate = Schemas["ParticipantCreate"];
export type MessageCreate = Schemas["MessageCreate"];
export type MessageUpdate = Schemas["MessageUpdate"];
export type FragmentCreate = Schemas["FragmentCreate"];
export type FragmentUpdate = Schemas["FragmentUpdate"];
// Ветвь [иначе] у alt: со второй и дальше (первая начинается с from_order фрагмента).
export type BindResult = Schemas["BindResult"];
export type ReattachResult = Schemas["ReattachResult"];
// Импорт процесса из mermaid: превью → применение.
export type ProcessImportIn = Schemas["ProcessImportIn"];
export type ProcessImportApply = Schemas["ProcessImportApply"];
export type ProcessImportPreview = Schemas["ProcessImportPreview"];
export type ProcessImportResult = Schemas["ProcessImportResult"];
export type FragmentBranch = Schemas["BranchOut"];
export type BranchIn = Schemas["BranchIn"];
// Плечо сообщения (хранимое) и стиль стрелки (производный) — Literal из контракта.
export type MessageLeg = Schemas["MessageOut"]["leg"];
export type MessageKind = Schemas["MessageOut"]["kind"];
export type FragmentKind = Schemas["FragmentOut"]["kind"];

// Структура БД (docs/plan-db-docs.md): «контракт» узла-базы — таблицы и колонки
// ЗАПИСЯМИ, а не текстом mermaid; ER-диаграмма из них производна. Обращения к данным
// (кто читает/пишет в рамках операции) записями НЕ хранятся: их истина — пометки
// «читает:/пишет:» в тексте схем логики вызывающих (пивот §9).
export type DbTable = Schemas["DbTableResponse"];
export type DbTableCreate = Schemas["DbTableCreate"];
export type DbTableUpdate = Schemas["DbTableUpdate"];
export type DbColumn = Schemas["DbColumnResponse"];
export type DbColumnCreate = Schemas["DbColumnCreate"];
export type DbColumnUpdate = Schemas["DbColumnUpdate"];
// Обратный индекс базы («кто ко мне ходит») — разворот тех же пометок на чтении.
export type TableUsage = Schemas["TableUsage"];
// Обратный индекс схемы логики («используется в процессах») — разворот привязок
// шагов (doc_id) на чтении, третья реализация приёма после таблиц и каналов.
export type NodeDocUsage = Schemas["NodeDocUsage"];

// Структура брокера (docs/plan-broker-docs.md): каналы и поля сообщений — тот же
// «контракт» узла, что таблицы у базы, но своей сущностью (у канала своя мета:
// доставка, ключ партиционирования, retention). Кто публикует и кто потребляет —
// пометки «публикует:/потребляет:» в текстах схем логики, записями не хранятся.
export type BrokerChannel = Schemas["BrokerChannelResponse"];
export type BrokerChannelCreate = Schemas["BrokerChannelCreate"];
export type BrokerChannelUpdate = Schemas["BrokerChannelUpdate"];
export type ChannelField = Schemas["ChannelFieldResponse"];
export type ChannelFieldCreate = Schemas["ChannelFieldCreate"];
export type ChannelFieldUpdate = Schemas["ChannelFieldUpdate"];
// Обратный индекс брокера («кто публикует / кто потребляет») — разворот пометок.
export type ChannelUsage = Schemas["ChannelUsage"];

// Конфигурация сервиса (docs/plan-config-docs.md): переменные окружения и параметры,
// от которых зависят развилки схем логики. Владелец — САМ сервис, а не отдельный узел,
// поэтому семья плоская: второго уровня, как колонки у таблиц, здесь нет. ЗНАЧЕНИЙ НЕТ:
// default_value — текст дефолта из кода, не значение среды.
export type ConfigParam = Schemas["ConfigParamResponse"];
export type ConfigParamCreate = Schemas["ConfigParamCreate"];
export type ConfigParamUpdate = Schemas["ConfigParamUpdate"];
// Обратный индекс конфигурации («какие схемы зависят от ручки») — разворот пометок.
// Узла в строке нет: сослаться может только схема того же объекта.
export type ConfigParamUsage = Schemas["ConfigParamUsage"];
// Живая плашка редактора дока: что означает каждая пометка присланного ТЕКСТА
// (POST /data-refs/preview) — статус резолва и готовая подпись цели.
export type DataRefPreviewItem = Schemas["DataRefPreviewItem"];
// Дозаливка структуры БД от агента: отчёт превью/применения.
export type DataImportReport = Schemas["DataImportReport"];
// Дозаливка каналов брокера от агента: свой отчёт — у канала своя мета и свои поля.
export type ChannelsImportReport = Schemas["ChannelsImportReport"];
// Дозаливка конфигурации сервиса: свой отчёт — параметры плоские, полей у них нет.
export type ConfigImportReport = Schemas["ConfigImportReport"];
// Разведка точек входа: отчёт превью/применения перечня и его строка. Действия свои
// (create/unchanged/described/vanished) — у разведки нет ни перезаписи, ни удалений.
export type ReconImportReport = Schemas["ReconImportReport"];
export type ReconItem = Schemas["ReconItem"];
export type ReconAction = ReconItem["action"];
