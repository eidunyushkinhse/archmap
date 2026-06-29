import { api } from "./client";
import type { DeletionSnapshot, Edge, EdgeCreate, EdgePoint, EdgeUpdate, ExportResponse, GraphResponse, Node, NodeContext, NodeCreate, NodeEdgeInfo, NodeUpdate, SchemaAlerts } from "../types";

export const nodesApi = {
  list: (parentId?: string | null): Promise<Node[]> => {
    const query = parentId ? `?parent_id=${parentId}` : "";
    return api.get<Node[]>(`/nodes/${query}`);
  },
  get: (id: string): Promise<Node> => api.get<Node>(`/nodes/${id}`),
  getChildren: (id: string): Promise<Node[]> =>
    api.get<Node[]>(`/nodes/${id}/children`),
  // Все потомки узла на любой глубине (без самого узла) — скоупленный выбор
  // дальнего конца межуровневой связи при протягивании стрелки на контейнер
  getDescendants: (id: string): Promise<Node[]> =>
    api.get<Node[]>(`/nodes/${id}/descendants`),
  // Все узлы схемы (плоско) — выбор дальнего конца связи к узлу ВНЕ уровня
  getAll: (): Promise<Node[]> => api.get<Node[]>(`/nodes/all`),
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
  // Снимок всего, что снесёт удаление узла (поддерево + рёбра + ghost-метаданные).
  // Берётся ПЕРЕД delete, чтобы откатить удаление через restore (Undo).
  deletionSnapshot: (id: string): Promise<DeletionSnapshot> =>
    api.get<DeletionSnapshot>(`/nodes/${id}/deletion-snapshot`),
  // Восстановить удалённое поддерево из снимка (Undo удаления) — с исходными id.
  restore: (snapshot: DeletionSnapshot): Promise<void> =>
    api.post<void>(`/nodes/restore`, snapshot),
  // Сохранить координаты гостевого узла на уровне containerId
  saveGhostPosition: (
    containerId: string,
    nodeId: string,
    // абсолютные координаты гостя на уровне (own-on-first-render)
    pos: { pos_x: number; pos_y: number },
  ): Promise<void> =>
    api.put(`/nodes/${containerId}/ghost-positions/${nodeId}`, pos),
  // Сохранить хэндл гостевого конца ребра на уровне containerId, привязанный к id
  // отображаемой сущности (лист-гость ИЛИ предок-контейнер), к которой пристыкован.
  saveGhostEdgeHandle: (
    containerId: string,
    edgeId: string,
    handle: { node_id: string; handle: string },
  ): Promise<void> =>
    api.put(`/nodes/${containerId}/ghost-edge-handles/${edgeId}`, handle),
  // Сохранить кастомный путь (изломы) ГОСТЕВОЙ стрелки на уровне containerId.
  // Пустой массив — сброс в авто-маршрут (строка пер-уровневого слоя удаляется).
  saveEdgeWaypoints: (
    containerId: string,
    edgeId: string,
    waypoints: EdgePoint[],
    // anchorNodeId не null → точки это ОФСЕТ от позиции узла anchorNodeId (излом владеемой
    // группы, Ф3, едет с узлом и гаснет при его сворачивании); null — абсолют уровня
    anchorNodeId: string | null = null,
  ): Promise<void> =>
    api.put(`/nodes/${containerId}/edge-waypoints/${edgeId}`, { waypoints, anchor_node_id: anchorNodeId }),
  // «Переразложить уровень»: стирает весь ручной layout уровня (позиции локалов и
  // гостей, хэндлы гостевых концов, изломы стрелок) → возврат к авто-раскладке.
  // containerId=null — корневой уровень. После вызова уровень нужно перезагрузить.
  relayoutLevel: (containerId: string | null): Promise<void> =>
    api.post(containerId ? `/nodes/${containerId}/relayout` : `/nodes/relayout`, {}),
};

export const exportApi = {
  // Экспорт всей схемы или поддерева от узла в текст (YAML) для LLM.
  all: (): Promise<ExportResponse> => api.get<ExportResponse>("/export"),
  subtree: (nodeId: string): Promise<ExportResponse> =>
    api.get<ExportResponse>(`/export/${nodeId}`),
};

export const edgesApi = {
  list: (): Promise<Edge[]> => api.get<Edge[]>("/edges/"),
  create: (data: EdgeCreate): Promise<Edge> => api.post<Edge>("/edges/", data),
  update: (id: string, data: EdgeUpdate): Promise<Edge> =>
    api.patch<Edge>(`/edges/${id}`, data),
  delete: (id: string): Promise<void> => api.delete(`/edges/${id}`),
  // Снимок связи + её ghost-метаданных (хэндлы/изломы по edge_id) для отката
  // создания/удаления связи через POST /nodes/restore с сохранением исходного id (Undo).
  deletionSnapshot: (id: string): Promise<DeletionSnapshot> =>
    api.get<DeletionSnapshot>(`/edges/${id}/deletion-snapshot`),
};
