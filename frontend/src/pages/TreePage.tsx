import { useEffect, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { nodesApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import type { Edge, GhostNode, Node, NodeShape, SchemaAlerts as Alerts } from "../types";
import EdgeModal from "../components/EdgeModal";
import SchemaAlerts from "../components/SchemaAlerts";
import EdgeDetailModal from "../components/EdgeDetailModal";
import EdgeChoiceModal from "../components/EdgeChoiceModal";
import NodeModal from "../components/NodeModal";
import NodeContextModal from "../components/NodeContextModal";
import LevelGraph from "../components/LevelGraph";
import NodeTreePanel, { NODE_DRAG_MIME } from "../components/NodeTreePanel";

interface Props {
  onLogout: () => void;
}

export default function TreePage({ onLogout }: Props) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [ghostNodes, setGhostNodes] = useState<GhostNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<Node[]>([]);
  const [loading, setLoading] = useState(false);

  // node — редактируемый узел (null = создание). При создании перетаскиванием
  // шаблона на схему сюда кладутся выбранная форма (shape) и точка дропа (pos).
  const [nodeModal, setNodeModal] = useState<{
    open: boolean;
    node: Node | null;
    shape?: NodeShape;
    pos?: { x: number; y: number } | null;
  }>({
    open: false,
    node: null,
  });
  const [edgeCreateModal, setEdgeCreateModal] = useState(false);
  const [edgeDetailModal, setEdgeDetailModal] = useState<Edge | null>(null);
  // выбор связи из «мастер-стрелки» (несколько слитых связей одного направления)
  const [edgeChoice, setEdgeChoice] = useState<Edge[] | null>(null);
  // узел, для которого открыта контекстная схема (клик по дереву слева)
  const [contextNode, setContextNode] = useState<Node | null>(null);
  // форма шаблона, который сейчас тянут из палитры (null — драга нет). Прокидываем
  // в LevelGraph, чтобы он рисовал превью-рамку будущего узла под курсором.
  const [dragShape, setDragShape] = useState<NodeShape | null>(null);
  // Глобальные алерты незавершённости схемы (только для архитектора)
  const [alerts, setAlerts] = useState<Alerts>({
    disconnected_nodes: [],
    intermediate_edges: [],
  });

  const isArchitect = getUserRole() === "architect";
  const currentParent =
    breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : null;
  const currentParentId = currentParent?.id ?? null;

  async function load(parentId: string | null) {
    setLoading(true);
    try {
      const graph = await nodesApi.getGraph(parentId);
      setNodes(graph.nodes);
      setGhostNodes(graph.ghost_nodes);
      setEdges(
        graph.edges.map((ge) => ({
          id: ge.id,
          label: ge.label,
          technology: ge.technology,
          source_id: ge.source_id,
          target_id: ge.target_id,
          source_handle: ge.source_handle,
          target_handle: ge.target_handle,
          created_at: "",
        }))
      );
    } finally {
      setLoading(false);
    }
    // Алерты глобальные — обновляем при каждой перезагрузке уровня (после правок
    // узлов/связей и навигации). Fire-and-forget: индикатор не блокирует граф.
    void loadAlerts();
  }

  // Алерты считаются на бэке по всей схеме; viewer'у эндпоинт недоступен.
  async function loadAlerts() {
    if (!isArchitect) return;
    try {
      setAlerts(await nodesApi.getAlerts());
    } catch {
      // вспомогательный индикатор — ошибку молча гасим, граф важнее
    }
  }

  useEffect(() => { load(null); }, []);

  function drillDown(node: Node) {
    setBreadcrumb((prev) => [...prev, node]);
    load(node.id);
  }

  function goUp() {
    const prev = breadcrumb.slice(0, -1);
    setBreadcrumb(prev);
    load(prev.length > 0 ? prev[prev.length - 1].id : null);
  }

  function navigateTo(index: number) {
    const next = breadcrumb.slice(0, index + 1);
    setBreadcrumb(next);
    load(next[next.length - 1].id);
  }

  // Клик по промежуточному узлу в дереве → перейти на его слой основной схемы.
  // path — полный путь от корня до узла включительно (последний элемент = открываемый слой).
  function drillToPath(path: Node[]) {
    if (path.length === 0) return;
    setContextNode(null); // если была открыта контекст-модалка — закрываем
    setBreadcrumb(path);
    load(path[path.length - 1].id);
  }

  function handleNodeSaved(saved: Node) {
    setNodes((prev) =>
      prev.some((n) => n.id === saved.id)
        ? prev.map((n) => (n.id === saved.id ? saved : n))
        : [...prev, saved]
    );
    setNodeModal({ open: false, node: null });
    // Этот обработчик не перезагружает уровень (правит локальный стейт) —
    // алерты обновляем явно: добавленный/изменённый узел мог стать «подвисшим».
    void loadAlerts();
  }

  function handleNodeDeleted(_id: string) {
    // Перезагружаем уровень: вместе с узлом удалились его связи (в т.ч. сквозные),
    // поэтому проецированные рёбра и гости без связей должны пересчитаться.
    setNodeModal({ open: false, node: null });
    load(currentParentId);
  }

  function handleEdgeDeleted(_id: string) {
    setEdgeDetailModal(null);
    load(currentParentId);
  }

  function handleEdgeSaved(_saved: Edge) {
    // Перезагружаем уровень — метка/технология обновятся на стрелке. Саму модалку
    // не трогаем: её концы — спроецированные (а PATCH вернул бы сырые), а новые
    // метка/технология уже показаны из локального состояния модалки.
    load(currentParentId);
  }

  function handleEdgeCreated() {
    setEdgeCreateModal(false);
    load(currentParentId);
  }

  // Шаблон узла отпустили на схему (LevelGraph посчитал координаты в системе графа) —
  // открываем модалку создания с выбранной формой и точкой дропа.
  function handleDropNode(shape: NodeShape, pos: { x: number; y: number }) {
    setNodeModal({ open: true, node: null, shape, pos });
  }

  // Дроп на пустой уровень (графа ещё нет — некуда считать координаты): создаём узел
  // с дефолтной позицией, дальше его можно подвинуть.
  function handleEmptyDragOver(e: DragEvent) {
    if (!isArchitect || !e.dataTransfer.types.includes(NODE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function handleEmptyDrop(e: DragEvent) {
    if (!isArchitect) return;
    const shape = e.dataTransfer.getData(NODE_DRAG_MIME);
    if (!shape) return;
    e.preventDefault();
    handleDropNode(shape as NodeShape, { x: 80, y: 80 });
  }

  const findNodeLabel = (id: string): string =>
    nodes.find((n) => n.id === id)?.name ??
    ghostNodes.find((g) => g.id === id)?.name ??
    id;

  const hasNodes = nodes.length + ghostNodes.length > 0;

  return (
    <div style={page}>
      {/* Шапка + панель управления */}
      <div style={topBar}>
        <div style={topLeft}>
          <span style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginRight: 20 }}>
            ArchMap
          </span>
          {/* Хлебные крошки */}
          <span
            style={crumbLink}
            onClick={() => { setBreadcrumb([]); load(null); }}
          >
            Корень
          </span>
          {breadcrumb.map((n, i) => (
            <span key={n.id} style={{ display: "flex", alignItems: "center" }}>
              <span style={{ color: "#9ca3af", margin: "0 6px" }}>/</span>
              {i < breadcrumb.length - 1 ? (
                <span style={crumbLink} onClick={() => navigateTo(i)}>{n.name}</span>
              ) : (
                <span style={{ color: "#374151" }}>{n.name}</span>
              )}
            </span>
          ))}
          {breadcrumb.length > 0 && (
            <button onClick={goUp} style={upBtn}>↑ Наверх</button>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Создание узла переехало в боковую панель → секцию «Добавить узел»
              (перетаскивание шаблона на схему). */}
          {isArchitect && hasNodes && (
            <button onClick={() => setEdgeCreateModal(true)} style={secondaryBtn}>
              + Связь
            </button>
          )}
          <button onClick={onLogout} style={logoutBtn}>Выйти</button>
        </div>
      </div>

      {/* Тело: боковая панель слева + область графа справа */}
      <div style={bodyRow}>
        <NodeTreePanel
          onDrillTo={drillToPath}
          onNodeContext={setContextNode}
          isArchitect={isArchitect}
          onTemplateDrag={setDragShape}
        />

        {/* Область графа — заполняет оставшееся пространство */}
        <div style={graphArea}>
          {/* Индикатор незавершённости схемы (только архитектор) */}
          {isArchitect && <SchemaAlerts alerts={alerts} />}
          {loading ? (
            <p style={{ color: "#6b7280", padding: 24 }}>Загрузка...</p>
          ) : !hasNodes ? (
            // Пустой уровень — тоже drop-зона: можно бросить первый узел из палитры
            <div
              style={emptyDrop}
              onDragOver={handleEmptyDragOver}
              onDrop={handleEmptyDrop}
            >
              {isArchitect
                ? "Нет узлов на этом уровне. Перетащите сюда форму из раздела «Добавить узел»."
                : "Нет узлов на этом уровне"}
            </div>
          ) : (
            <LevelGraph
              nodes={nodes}
              ghostNodes={ghostNodes}
              edges={edges}
              depth={breadcrumb.length}
              containerId={currentParentId}
              ancestorNames={breadcrumb.map((b) => b.name)}
              ancestorIds={breadcrumb.map((b) => b.id)}
              isArchitect={isArchitect}
              onDrillDown={drillDown}
              onEditNode={(node) => setNodeModal({ open: true, node })}
              onEdgeClick={(edge) => setEdgeDetailModal(edge)}
              onEdgesChoice={(group) => setEdgeChoice(group)}
              onDropNode={handleDropNode}
              dragShape={dragShape}
            />
          )}
        </div>
      </div>

      {nodeModal.open && (
        <NodeModal
          node={nodeModal.node}
          parentId={currentParentId}
          shape={nodeModal.shape}
          initialPos={nodeModal.pos ?? null}
          onClose={() => setNodeModal({ open: false, node: null })}
          onSaved={handleNodeSaved}
          onDeleted={handleNodeDeleted}
        />
      )}
      {edgeCreateModal && (
        <EdgeModal
          onClose={() => setEdgeCreateModal(false)}
          onCreated={handleEdgeCreated}
        />
      )}
      {edgeDetailModal && (
        <EdgeDetailModal
          edge={edgeDetailModal}
          sourceLabel={findNodeLabel(edgeDetailModal.source_id)}
          targetLabel={findNodeLabel(edgeDetailModal.target_id)}
          isArchitect={isArchitect}
          onClose={() => setEdgeDetailModal(null)}
          onDeleted={handleEdgeDeleted}
          onSaved={handleEdgeSaved}
        />
      )}
      {edgeChoice && edgeChoice.length > 0 && (
        <EdgeChoiceModal
          edges={edgeChoice}
          sourceLabel={findNodeLabel(edgeChoice[0].source_id)}
          targetLabel={findNodeLabel(edgeChoice[0].target_id)}
          onPick={(edge) => { setEdgeChoice(null); setEdgeDetailModal(edge); }}
          onClose={() => setEdgeChoice(null)}
        />
      )}
      {contextNode && (
        <NodeContextModal
          node={contextNode}
          onClose={() => setContextNode(null)}
        />
      )}
    </div>
  );
}

const page: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  fontFamily: "system-ui, -apple-system, sans-serif",
  overflow: "hidden",
};
const topBar: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px 20px",
  borderBottom: "1px solid #e5e7eb",
  background: "#fff",
  flexShrink: 0,
  gap: 12,
  flexWrap: "wrap",
};
const topLeft: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 14,
  flexWrap: "wrap",
  flex: 1,
  minWidth: 0,
};
const bodyRow: CSSProperties = {
  flex: 1,
  display: "flex",
  minHeight: 0,
  overflow: "hidden",
};
const graphArea: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  padding: "16px 20px 20px",
  display: "flex",
  flexDirection: "column",
  position: "relative", // якорь для абсолютного индикатора алертов
};
const emptyDrop: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: 24,
  color: "#9ca3af",
  fontSize: 14,
  border: "1px dashed #d1d5db",
  borderRadius: 8,
};
const crumbLink: CSSProperties = {
  cursor: "pointer",
  color: "#2563eb",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};
const upBtn: CSSProperties = {
  marginLeft: 8,
  padding: "3px 10px",
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 13,
};
const secondaryBtn: CSSProperties = {
  padding: "6px 14px",
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};
const logoutBtn: CSSProperties = {
  padding: "6px 12px",
  background: "none",
  color: "#6b7280",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};
