import { api } from "./client";
import type { Edge, EdgeCreate, EdgeUpdate, GraphResponse, Node, NodeContext, NodeCreate, NodeEdgeInfo, NodeUpdate, SchemaAlerts } from "../types";

export const nodesApi = {
  list: (parentId?: string | null): Promise<Node[]> => {
    const query = parentId ? `?parent_id=${parentId}` : "";
    return api.get<Node[]>(`/nodes/${query}`);
  },
  get: (id: string): Promise<Node> => api.get<Node>(`/nodes/${id}`),
  getChildren: (id: string): Promise<Node[]> =>
    api.get<Node[]>(`/nodes/${id}/children`),
  // Связи узла (обоих направлений) с именами связанных узлов — для модалки удаления
  getEdges: (id: string): Promise<NodeEdgeInfo[]> =>
    api.get<NodeEdgeInfo[]>(`/nodes/${id}/edges`),
  // parentId=null — корневой уровень, иначе — уровень конкретного узла
  getGraph: (parentId: string | null): Promise<GraphResponse> =>
    parentId
      ? api.get<GraphResponse>(`/nodes/${parentId}/graph`)
      : api.get<GraphResponse>(`/nodes/graph`),
  search: (q: string): Promise<Node[]> =>
    api.get<Node[]>(`/nodes/search?q=${encodeURIComponent(q)}`),
  // Контекстная схема узла: фокус + прямые соседи + спроецированные рёбра
  getContext: (id: string): Promise<NodeContext> =>
    api.get<NodeContext>(`/nodes/${id}/context`),
  // Глобальные алерты незавершённости схемы (только архитектор)
  getAlerts: (): Promise<SchemaAlerts> =>
    api.get<SchemaAlerts>(`/nodes/alerts`),
  create: (data: NodeCreate): Promise<Node> => api.post<Node>("/nodes/", data),
  update: (id: string, data: NodeUpdate): Promise<Node> =>
    api.patch<Node>(`/nodes/${id}`, data),
  delete: (id: string): Promise<void> => api.delete(`/nodes/${id}`),
  // Сохранить координаты гостевого узла на уровне containerId
  saveGhostPosition: (
    containerId: string,
    nodeId: string,
    pos: { pos_x: number; pos_y: number },
  ): Promise<void> =>
    api.put(`/nodes/${containerId}/ghost-positions/${nodeId}`, pos),
};

export const edgesApi = {
  list: (): Promise<Edge[]> => api.get<Edge[]>("/edges/"),
  create: (data: EdgeCreate): Promise<Edge> => api.post<Edge>("/edges/", data),
  update: (id: string, data: EdgeUpdate): Promise<Edge> =>
    api.patch<Edge>(`/edges/${id}`, data),
  delete: (id: string): Promise<void> => api.delete(`/edges/${id}`),
};
