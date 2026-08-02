import { api } from "./client";
import type { DeletionSnapshot, Edge, EdgeCreate, EdgeUpdate, ExportResponse, GraphResponse, Node, NodeCreate, NodeDoc, NodeDocCreate, NodeDocUpdate, NodeEdgeInfo, NodeUpdate, ProcessListItem, SchemaAlerts, ViewLayoutPayload, ViewLayoutResult, ViewState } from "../types";

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
  // «Схема» страницы объекта (single-schema): контекст в формате СЫРОГО графа
  // уровня — виртуальный корневой уровень (фокус + представители соседей +
  // сырые рёбра + реестр концов + раскладка корневого вида). Рендерится тем же
  // level-конвейером, что и обычный уровень.
  getContextGraph: (id: string): Promise<GraphResponse> =>
    api.get<GraphResponse>(`/nodes/${id}/context-graph`),
  // «Переразложить» страницу объекта: сбрасывает раскладку ВИДА ФОКУСА
  // (view_id = id узла) — позиции и инлайн-раскрытия → свежий ELK. Соседние виды
  // (другие страницы, уровни редактора) нетронуты. 204 No Content; после вызова
  // контекст нужно перезагрузить (getContextGraph).
  relayoutContext: (id: string): Promise<void> =>
    api.post(`/nodes/${id}/context-relayout`, {}),
  // Процессы с участием узла или его поддерева — секция «Участвует в процессах»
  // страницы объекта (форма — ProcessListItem, как у списка процессов).
  getNodeProcesses: (id: string): Promise<ProcessListItem[]> =>
    api.get<ProcessListItem[]>(`/nodes/${id}/processes`),
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
  // undefined (не void): void как type-parameter нарушает no-invalid-void-type
  restore: (snapshot: DeletionSnapshot): Promise<void> =>
    api.post<undefined>(`/nodes/restore`, snapshot),
  // «Переразложить уровень»: стирает ВСЕ строки view_layout уровня (позиции
  // локалов и гостей, раскрытия expanded, легаси) → возврат к авто-виду.
  // containerId=null — корневой уровень. После вызова уровень нужно перезагрузить.
  relayoutLevel: (containerId: string | null): Promise<void> =>
    api.post(containerId ? `/nodes/${containerId}/relayout` : `/nodes/relayout`, {}),
};

// Именованные схемы логики узла (node_docs). Полные доки (с контентом) тянутся
// лениво при открытии оверлея «Логика»; мета для строки инспектора едет в Node.docs.
// PATCH — под optimistic CAS (base_version), как правки самого узла.
export const nodeDocsApi = {
  list: (nodeId: string): Promise<NodeDoc[]> => api.get<NodeDoc[]>(`/nodes/${nodeId}/docs`),
  create: (nodeId: string, data: NodeDocCreate): Promise<NodeDoc> =>
    api.post<NodeDoc>(`/nodes/${nodeId}/docs`, data),
  update: (nodeId: string, docId: string, data: NodeDocUpdate): Promise<NodeDoc> =>
    api.patch<NodeDoc>(`/nodes/${nodeId}/docs/${docId}`, data),
  delete: (nodeId: string, docId: string): Promise<void> =>
    api.delete(`/nodes/${nodeId}/docs/${docId}`),
};

export const viewsApi = {
  // Батч-запись раскладки вида (R3, единое хранилище view_layout): item_id →
  // payload; null — удалить строку (сброс объекта в авто-геометрию).
  // viewId=null — корневой вид. ВАЖНО: payload заменяет строку ЦЕЛИКОМ —
  // частичные правки мержит вызывающий (commitLayout в LevelGraph).
  // baseVersion — fence конкурентных сессий (этап 0): устаревшая версия вида →
  // 409, ничего не применяется; ответ несёт новую версию + graph_rev.
  saveLayout: (
    viewId: string | null,
    items: Record<string, ViewLayoutPayload | null>,
    baseVersion?: number,
  ): Promise<ViewLayoutResult> =>
    api.put<ViewLayoutResult>(`/views/${viewId ?? "root"}/layout`, {
      items,
      ...(baseVersion !== undefined ? { base_version: baseVersion } : {}),
    }),
  // Лёгкий опрос свежести вида/проекта (поллинг этапа 1; доступен обеим ролям).
  state: (viewId: string | null): Promise<ViewState> =>
    api.get<ViewState>(`/views/${viewId ?? "root"}/state`),
};

export const exportApi = {
  // Экспорт всей схемы или поддерева от узла в текст (YAML) для LLM.
  all: (): Promise<ExportResponse> => api.get<ExportResponse>("/export"),
  subtree: (nodeId: string): Promise<ExportResponse> =>
    api.get<ExportResponse>(`/export/${nodeId}`),
};

export const edgesApi = {
  list: (): Promise<Edge[]> => api.get<Edge[]>("/edges/"),
  get: (id: string): Promise<Edge> => api.get<Edge>(`/edges/${id}`),
  create: (data: EdgeCreate): Promise<Edge> => api.post<Edge>("/edges/", data),
  update: (id: string, data: EdgeUpdate): Promise<Edge> =>
    api.patch<Edge>(`/edges/${id}`, data),
  delete: (id: string): Promise<void> => api.delete(`/edges/${id}`),
  // Снимок связи для отката создания/удаления через POST /nodes/restore с
  // сохранением исходного id (Undo). Геометрия пучка удаление связи переживает
  // (R3) и в снимке не нужна.
  deletionSnapshot: (id: string): Promise<DeletionSnapshot> =>
    api.get<DeletionSnapshot>(`/edges/${id}/deletion-snapshot`),
};
