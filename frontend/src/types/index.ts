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
export type GraphResponse = Schemas["GraphResponse"];
export type NodeContext = Schemas["NodeContextResponse"];
export type NodeEdgeInfo = Schemas["NodeEdgeInfo"];

export type DisconnectedNodeAlert = Schemas["DisconnectedNodeAlert"];
export type IntermediateEdgeAlert = Schemas["IntermediateEdgeAlert"];
export type SchemaAlerts = Schemas["AlertsResponse"];

export type Token = Schemas["Token"];

export type UserRole = "architect" | "viewer";
