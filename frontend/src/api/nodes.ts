import { api } from "./client";
import type { TableUsage, BrokerChannel, ChannelUsage, BrokerChannelCreate, BrokerChannelUpdate, ChannelField, ChannelFieldCreate, ChannelFieldUpdate, DbColumn, DbColumnCreate, DbColumnUpdate, DbTable, DbTableCreate, DbTableUpdate, DeletionSnapshot, DistributeDocsIn, DistributeDocsOut, Edge, EdgeCreate, EdgeUpdate, ExportResponse, GraphResponse, Node, NodeCreate, NodeDoc, NodeDocCreate, NodeDocUpdate, NodeEdgeInfo, NodeUpdate, ProcessListItem, SchemaAlerts, TransitionApplyOut, TransitionPreview, ViewLayoutPayload, ViewLayoutResult, ViewState } from "../types";

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
  // Снимок раскладки, которую снимет ПЕРЕНОС узла на другой уровень: позиции
  // поддерева во внешних видах. Берётся ПЕРЕД сменой parent_id, возвращается тем же
  // restore (узлы/связи в нём пусты — перенос ничего не сносит, кроме позиций).
  moveSnapshot: (id: string): Promise<DeletionSnapshot> =>
    api.get<DeletionSnapshot>(`/nodes/${id}/move-snapshot`),
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
  // «Распределить по детям» (правила контейнеров): перенос grandfather-доков/спеки
  // контейнера на его непосредственных детей.
  distribute: (nodeId: string, data: DistributeDocsIn): Promise<DistributeDocsOut> =>
    api.post<DistributeDocsOut>(`/nodes/${nodeId}/docs/distribute`, data),
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

// «Принять переход»: превью (что уедет и что повысится) и применение с курсором
// схемы — если схему изменили после показа плана, бэк отвечает 409.
export const transitionApi = {
  preview: (): Promise<TransitionPreview> => api.get<TransitionPreview>("/nodes/transition"),
  apply: (baseGraphRev: number): Promise<TransitionApplyOut> =>
    api.post<TransitionApplyOut>("/nodes/transition", { base_graph_rev: baseGraphRev }),
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

// Структура БД узла (таблицы с колонками) — контракт базы. Обращения к ней своего
// ввода не имеют: они живут пометками «читает:/пишет:» в тексте схем логики
// вызывающих, и usage собирает их разбором на чтении (docs/plan-db-docs.md §9).
export const dbTablesApi = {
  list: (nodeId: string): Promise<DbTable[]> =>
    api.get<DbTable[]>(`/nodes/${nodeId}/tables`),
  create: (nodeId: string, data: DbTableCreate): Promise<DbTable> =>
    api.post<DbTable>(`/nodes/${nodeId}/tables`, data),
  update: (nodeId: string, tableId: string, data: DbTableUpdate): Promise<DbTable> =>
    api.patch<DbTable>(`/nodes/${nodeId}/tables/${tableId}`, data),
  delete: (nodeId: string, tableId: string): Promise<void> =>
    api.delete(`/nodes/${nodeId}/tables/${tableId}`),
  createColumn: (nodeId: string, tableId: string, data: DbColumnCreate): Promise<DbColumn> =>
    api.post<DbColumn>(`/nodes/${nodeId}/tables/${tableId}/columns`, data),
  updateColumn: (
    nodeId: string, tableId: string, columnId: string, data: DbColumnUpdate,
  ): Promise<DbColumn> =>
    api.patch<DbColumn>(`/nodes/${nodeId}/tables/${tableId}/columns/${columnId}`, data),
  deleteColumn: (nodeId: string, tableId: string, columnId: string): Promise<void> =>
    api.delete(`/nodes/${nodeId}/tables/${tableId}/columns/${columnId}`),
  // Кто обращается к таблицам этой базы — разворот пометок из схем логики проекта.
  usage: (nodeId: string): Promise<TableUsage[]> =>
    api.get<TableUsage[]>(`/nodes/${nodeId}/tables/usage`),
};

// Структура брокера (каналы с полями сообщений) — тот же «контракт» узла, что таблицы
// у базы, но своей сущностью: у канала есть мета доставки (ключ партиционирования,
// гарантия, retention), которой у таблицы не бывает. Кто публикует и кто потребляет —
// пометки «публикует:/потребляет:» в текстах схем логики, здесь их нет и не будет
// (docs/plan-broker-docs.md §1). Адреса — /nodes/{id}/channels (Ф0, без слеша на конце:
// префикс роутера уже содержит путь целиком).
export const brokerChannelsApi = {
  list: (nodeId: string): Promise<BrokerChannel[]> =>
    api.get<BrokerChannel[]>(`/nodes/${nodeId}/channels`),
  create: (nodeId: string, data: BrokerChannelCreate): Promise<BrokerChannel> =>
    api.post<BrokerChannel>(`/nodes/${nodeId}/channels`, data),
  update: (
    nodeId: string, channelId: string, data: BrokerChannelUpdate,
  ): Promise<BrokerChannel> =>
    api.patch<BrokerChannel>(`/nodes/${nodeId}/channels/${channelId}`, data),
  delete: (nodeId: string, channelId: string): Promise<void> =>
    api.delete(`/nodes/${nodeId}/channels/${channelId}`),
  createField: (
    nodeId: string, channelId: string, data: ChannelFieldCreate,
  ): Promise<ChannelField> =>
    api.post<ChannelField>(`/nodes/${nodeId}/channels/${channelId}/fields`, data),
  updateField: (
    nodeId: string, channelId: string, fieldId: string, data: ChannelFieldUpdate,
  ): Promise<ChannelField> =>
    api.patch<ChannelField>(`/nodes/${nodeId}/channels/${channelId}/fields/${fieldId}`, data),
  deleteField: (nodeId: string, channelId: string, fieldId: string): Promise<void> =>
    api.delete(`/nodes/${nodeId}/channels/${channelId}/fields/${fieldId}`),
  // Кто публикует и кто потребляет каналы этого брокера — разворот пометок
  // «публикует:/потребляет:» из схем логики проекта (записей обращений нет).
  usage: (nodeId: string): Promise<ChannelUsage[]> =>
    api.get<ChannelUsage[]>(`/nodes/${nodeId}/channels/usage`),
};
