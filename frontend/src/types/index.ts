export type NodeShape = "service" | "database" | "broker" | "person";

export interface Node {
  id: string;
  name: string;
  description: string | null;
  role: string | null;
  technology: string | null;
  parent_id: string | null;
  flowchart: string | null;
  openapi_spec: string | null;
  pos_x: number | null;
  pos_y: number | null;
  is_external: boolean;
  shape: NodeShape;
  has_children: boolean;
  created_at: string;
  updated_at: string;
}

export interface NodeCreate {
  name: string;
  description?: string | null;
  role?: string | null;
  technology?: string | null;
  parent_id?: string | null;
  flowchart?: string | null;
  openapi_spec?: string | null;
  is_external?: boolean;
  shape?: NodeShape;
  // координаты узла при создании перетаскиванием шаблона на схему
  pos_x?: number | null;
  pos_y?: number | null;
}

export interface NodeUpdate {
  name?: string;
  description?: string | null;
  role?: string | null;
  technology?: string | null;
  parent_id?: string | null;
  flowchart?: string | null;
  openapi_spec?: string | null;
  pos_x?: number | null;
  pos_y?: number | null;
  is_external?: boolean;
  shape?: NodeShape;
}

export interface Edge {
  id: string;
  label: string | null;
  technology: string | null;
  source_id: string;
  target_id: string;
  source_handle: string | null;
  target_handle: string | null;
  created_at: string;
}

export interface EdgeUpdate {
  label?: string | null;
  technology?: string | null;
  source_id?: string;
  target_id?: string;
  source_handle?: string | null;
  target_handle?: string | null;
}

export interface EdgeCreate {
  label?: string | null;
  technology?: string | null;
  source_id: string;
  target_id: string;
}

export interface AncestorRef {
  id: string;
  name: string;
}

export interface GhostNode {
  id: string;
  name: string;
  role: string | null;
  technology: string | null;
  is_external: boolean;
  shape: NodeShape;
  node_depth: number;
  // цепочка предков (корень → непосредственный родитель)
  ancestors: AncestorRef[];
  pos_x: number | null;
  pos_y: number | null;
  is_ghost: true;
}

export interface GraphEdge {
  id: string;
  label: string | null;
  technology: string | null;
  source_id: string;
  target_id: string;
  original_source_id: string;
  original_target_id: string;
  source_handle: string | null;
  target_handle: string | null;
}

export interface GraphResponse {
  nodes: Node[];
  edges: GraphEdge[];
  ghost_nodes: GhostNode[];
  // Сохранённые координаты гостей на уровне, ключ — id ОТОБРАЖАЕМОЙ сущности
  // (лист-гость ИЛИ предок-контейнер, в который гость свёрнут).
  level_positions: Record<string, { pos_x: number; pos_y: number }>;
}

// Контекстная схема узла: сам узел + его прямые соседи (другой конец связей,
// выходящих за пределы поддерева фокуса). Соседи — «гости» (пунктир),
// focus_ancestors — цепочка предков для рамок вокруг фокуса.
export interface NodeContext {
  focus: Node;
  focus_ancestors: AncestorRef[];
  neighbors: GhostNode[];
  edges: GraphEdge[];
}

export interface NodeEdgeInfo {
  id: string;
  label: string | null;
  technology: string | null;
  direction: "outgoing" | "incoming";
  other_node_id: string;
  other_node_name: string;
}

// Алерты незавершённости схемы (глобальные, видны только архитектору)
export interface DisconnectedNodeAlert {
  node_id: string;
  node_name: string;
}

export interface IntermediateEdgeAlert {
  edge_id: string;
  label: string | null;
  source_id: string;
  source_name: string;
  target_id: string;
  target_name: string;
  source_is_intermediate: boolean;
  target_is_intermediate: boolean;
}

export interface SchemaAlerts {
  disconnected_nodes: DisconnectedNodeAlert[];
  intermediate_edges: IntermediateEdgeAlert[];
}

export interface Token {
  access_token: string;
  token_type: string;
}

export type UserRole = "architect" | "viewer";
