// Фасад типов контракта. Источник правды — бэкенд: интерфейсы ниже сгенерированы
// из OpenAPI в ./api.gen.ts (npm run gen:api) и здесь лишь переименованы в
// привычные фронту имена-алиасы. Менять контракт — правкой Pydantic-схем +
// перегенерацией, НЕ здесь. Рукописным остаётся только чисто фронтовое
// (canHaveChildren, UserRole); NodeShape и EdgePoint выводятся из генерата.
import type { components } from "./api.gen";

type Schemas = components["schemas"];

// C4-формы узла — выводим из сгенерированного контракта (Literal на бэке).
export type NodeShape = Schemas["NodeResponse"]["shape"];

// Узел-контейнер (можно «провалиться» внутрь и заводить детей) — ТОЛЬКО сервис.
// БД, брокер и пользователь — атомарные: drill-down/контекст внутрь не ведёт,
// детей у них не заводим, на схеме они не «зона входа» для сквозной связи.
export const canHaveChildren = (shape: NodeShape): boolean => shape === "service";

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

// Точка-сгиб кастомного пути стрелки в координатах графа уровня.
export type EdgePoint = Schemas["Point"];

export type Edge = Schemas["EdgeResponse"];
export type EdgeUpdate = Schemas["EdgeUpdate"];
export type EdgeCreate = Schemas["EdgeCreate"];

export type AncestorRef = Schemas["AncestorRef"];
export type GhostNode = Schemas["GhostNodeResponse"];
export type GraphEdge = Schemas["GraphEdgeResponse"];

// Ребро в стейте уровня/контекста: контрактное EdgeResponse (его source_id/target_id —
// ЭФФЕКТИВНЫЕ, спроецированные на уровень концы, нужные раскладке) плюс РЕАЛЬНЫЕ концы
// ребра (original_*), которые граф-эндпоинт отдаёт отдельно. Реальные концы и их имена
// нужны модалке деталей связи, чтобы показывать/править настоящие узлы, а не их проекцию
// (на верхнем уровне дочерний узел B сворачивается в контейнер C — раскладке нужен C,
// а модалке — B).
export type LevelEdge = Edge &
  Pick<
    GraphEdge,
    | "original_source_id"
    | "original_target_id"
    | "original_source_name"
    | "original_target_name"
  >;
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
export type DeletionSnapshot = Schemas["DeletionSnapshot-Output"];

// Экспорт схемы (или поддерева) в текст для скармливания LLM.
export type ExportResponse = Schemas["ExportResponse"];

export type UserRole = "architect" | "viewer";
