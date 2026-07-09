// Фасад типов контракта. Источник правды — бэкенд: интерфейсы ниже сгенерированы
// из OpenAPI в ./api.gen.ts (npm run gen:api) и здесь лишь переименованы в
// привычные фронту имена-алиасы. Менять контракт — правкой Pydantic-схем +
// перегенерацией, НЕ здесь. Рукописным остаётся только чисто фронтовое
// (canHaveChildren, UserRole); NodeShape и EdgePoint выводятся из генерата.
import type { components } from "./api.gen";

type Schemas = components["schemas"];

// C4-формы узла — выводим из сгенерированного контракта (Literal на бэке).
export type NodeShape = Schemas["NodeResponse"]["shape"];

// Статус жизненного цикла узла (as-is/to-be/deprecated) — Literal из контракта.
export type NodeStatus = Schemas["NodeResponse"]["status"];

// Узел-контейнер (можно «провалиться» внутрь и заводить детей) — ТОЛЬКО сервис.
// БД, брокер и пользователь — атомарные: drill-down/контекст внутрь не ведёт,
// детей у них не заводим, на схеме они не «зона входа» для сквозной связи.
export const canHaveChildren = (shape: NodeShape): boolean => shape === "service";

// Проект — изолированная схема. Мета (счётчики/редактор/даты) считается бэком.
export type Project = Schemas["ProjectResponse"];
export type ProjectCreate = Schemas["ProjectCreate"];
export type ProjectUpdate = Schemas["ProjectUpdate"];
export type ProjectPreview = Schemas["ProjectPreview"];

export type Node = Schemas["NodeResponse"];

// Порядок узлов-сиблингов в дереве: «главное» (с бОльшим числом прямых детей) —
// выше; при равенстве — по алфавиту. child_count считает бэкенд (_mark_has_children).
export const compareByRank = (a: Node, b: Node): number =>
  b.child_count - a.child_count || a.name.localeCompare(b.name);

// Узлы-«пользователи» (shape: person) в дереве-навигаторе не показываем: дерево —
// навигатор детализации, «провалиться» внутрь пользователя нечего. Общий отсев для
// боковой панели (NodeTreePanel) и ветки детей в модалке (NodeModal).
export const withoutPersons = (nodes: Node[]): Node[] =>
  nodes.filter((n) => n.shape !== "person");

export type NodeCreate = Schemas["NodeCreate"];
export type NodeUpdate = Schemas["NodeUpdate"];

// Точка ортогональной ломаной стрелки в координатах графа (чисто фронтовое:
// авто-маршруты роутера; в контракте геометрии стрелок больше нет).
export type EdgePoint = { x: number; y: number };

// Геометрия одного объекта раскладки на виде (единое хранилище view_layout):
// x/y — позиция (own-on-first-render), expanded — раскрытие контейнера. Ручной
// слой стрелок (пучки "b:…" с хэндлами/изломами/label_t) удалён 2026-07-09.
export type ViewLayoutPayload = Schemas["ViewLayoutPayload"];
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
// Ребро контекст-схемы: концы спроецированы сервером + original_* (реальные).
export type ContextEdge = Schemas["ContextEdgeResponse"];

// Ребро в стейте уровня/контекста: EdgeResponse-подобное (source_id/target_id —
// РЕАЛЬНЫЕ концы, R2) плюс синтезируемые original_* — те же реальные концы с
// именами для деталей связи. Поля original_* остаются в типе ради модалок
// (EdgeInspector/EdgeDetailModal); на уровне их заполняет TreePage.load из
// реестра endpoints, в контексте — сервер (ContextEdgeResponse).
export type LevelEdge = Edge & {
  original_source_id: string;
  original_target_id: string;
  original_source_name: string;
  original_target_name: string;
};
export type GraphResponse = Schemas["GraphResponse"];
export type NodeContext = Schemas["NodeContextResponse"];
export type NodeEdgeInfo = Schemas["NodeEdgeInfo"];

export type DisconnectedNodeAlert = Schemas["DisconnectedNodeAlert"];
export type IntermediateEdgeAlert = Schemas["IntermediateEdgeAlert"];
export type IsolatedGroupAlert = Schemas["IsolatedGroupAlert"];
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
export type ChannelLeg = Schemas["LegOut"];
export type ParticipantCreate = Schemas["ParticipantCreate"];
export type MessageCreate = Schemas["MessageCreate"];
export type MessageUpdate = Schemas["MessageUpdate"];
export type FragmentCreate = Schemas["FragmentCreate"];
export type FragmentUpdate = Schemas["FragmentUpdate"];
// Плечо сообщения (хранимое) и стиль стрелки (производный) — Literal из контракта.
export type MessageLeg = Schemas["MessageOut"]["leg"];
export type MessageKind = Schemas["MessageOut"]["kind"];
export type FragmentKind = Schemas["FragmentOut"]["kind"];
