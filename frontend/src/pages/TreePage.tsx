import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import type { Edge, EdgePoint, GhostNode, Node, NodeShape, SchemaAlerts as Alerts } from "../types";
import EdgeIntoPicker from "../components/EdgeIntoPicker";
import EdgeQuickCreate from "../components/EdgeQuickCreate";
import SchemaAlerts from "../components/SchemaAlerts";
import EdgeDetailModal from "../components/EdgeDetailModal";
import EdgeChoiceModal from "../components/EdgeChoiceModal";
import NodeModal from "../components/NodeModal";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import NodeContextModal from "../components/NodeContextModal";
import LevelGraph from "../components/LevelGraph";
import EmptyLevelHint from "../components/EmptyLevelHint";
import NodeTreePanel from "../components/NodeTreePanel";

interface Props {
  onLogout: () => void;
}

export default function TreePage({ onLogout }: Props) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [ghostNodes, setGhostNodes] = useState<GhostNode[]>([]);
  // сохранённые координаты гостей на уровне (ключ — id отображаемой сущности:
  // лист-гость или предок-контейнер, в который гость свёрнут)
  const [levelPositions, setLevelPositions] = useState<
    Record<string, { pos_x: number; pos_y: number }>
  >({});
  // Сохранённые хэндлы гостевых концов рёбер на уровне: edge_id → список значений
  // (по одному на проекцию гостевого конца — лист-гость и/или предок-контейнер).
  const [levelEdgeHandles, setLevelEdgeHandles] = useState<
    Record<string, string[]>
  >({});
  // Сохранённые пути (изломы) гостевых стрелок на уровне: edge_id → точки-сгибы.
  const [levelEdgeWaypoints, setLevelEdgeWaypoints] = useState<
    Record<string, EdgePoint[]>
  >({});
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
  // протянули стрелку на узел с детьми — выбор его потомка как дальнего конца связи
  const [intoPicker, setIntoPicker] = useState<{
    sourceId: string;
    containerId: string;
    containerName: string;
    // хэндл узла-источника, из которого протянули стрелку (дальний конец — дефолт)
    sourceHandle: string | null;
  } | null>(null);
  // протянули стрелку на хэндл (прямая связь) — упрощённый поповер: описание+технология.
  // Хэндлы из жеста: при дропе на хэндл оба, на тело листа — только исходный.
  const [edgeQuick, setEdgeQuick] = useState<{
    sourceId: string;
    targetId: string;
    sourceHandle: string | null;
    targetHandle: string | null;
  } | null>(null);
  const [edgeDetailModal, setEdgeDetailModal] = useState<Edge | null>(null);
  // выбор связи из «мастер-стрелки» (несколько слитых связей одного направления)
  const [edgeChoice, setEdgeChoice] = useState<Edge[] | null>(null);
  // узел, для которого открыта контекстная схема (клик по дереву слева)
  const [contextNode, setContextNode] = useState<Node | null>(null);
  // узел, который удаляют с канваса по Backspace/Delete → подтверждение со связями
  const [pendingDelete, setPendingDelete] = useState<Node | null>(null);
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
      // ?? {} — на случай старого бэкенда без поля: без позиций, но не белый экран
      setLevelPositions(graph.level_positions ?? {});
      setLevelEdgeHandles(graph.level_edge_handles ?? {});
      setLevelEdgeWaypoints(graph.level_edge_waypoints ?? {});
      setEdges(
        graph.edges.map((ge) => ({
          id: ge.id,
          label: ge.label,
          technology: ge.technology,
          source_id: ge.source_id,
          target_id: ge.target_id,
          source_handle: ge.source_handle,
          target_handle: ge.target_handle,
          waypoints: ge.waypoints,
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

  // Reconnect в LevelGraph сохранил новые хэндлы (в БД и в локальные rfEdges).
  // Синхронизируем стейт уровня теми же значениями, что вернул бы рефетч графа —
  // иначе пересчёт раскладки (сворачивание/разворачивание контейнеров без рефетча)
  // откатил бы привязку к autoHandles. Хэндл локального конца — в колонку ребра,
  // хэндл гостевого конца — в level_edge_handles (по проекции node_id).
  function updateEdgeHandles(
    edgeId: string,
    changes: {
      column?: { source_handle?: string; target_handle?: string };
      ghost?: { node_id: string; handle: string };
    },
  ) {
    if (changes.column) {
      const col = changes.column;
      setEdges((prev) =>
        prev.map((e) => (e.id === edgeId ? { ...e, ...col } : e)),
      );
    }
    if (changes.ghost) {
      const { node_id, handle } = changes.ghost;
      setLevelEdgeHandles((prev) => {
        // одна проекция (node_id) = один хэндл: выкидываем прежний для этого узла
        const rest = (prev[edgeId] ?? []).filter(
          (h) => !h.startsWith(node_id + "--"),
        );
        return { ...prev, [edgeId]: [...rest, handle] };
      });
    }
  }

  // Путь стрелки изменён жестом (изломы) и сохранён в БД (useEdgeWaypoints) — зеркалируем
  // waypoints в стейт уровня теми же значениями, что вернул бы рефетч. Иначе пересчёт
  // раскладки без рефетча (напр. сворачивание контейнера) откатил бы излом к авто-маршруту.
  function updateEdgeWaypoints(edgeId: string, waypoints: EdgePoint[]) {
    setEdges((prev) =>
      prev.map((e) => (e.id === edgeId ? { ...e, waypoints } : e)),
    );
  }

  // То же для ГОСТЕВОЙ стрелки — путь живёт в пер-уровневом слое (level_edge_waypoints),
  // а не в колонке ребра. Зеркалируем теми же значениями, что вернул бы рефетч.
  function updateLevelEdgeWaypoints(edgeId: string, waypoints: EdgePoint[]) {
    setLevelEdgeWaypoints((prev) => ({ ...prev, [edgeId]: waypoints }));
  }

  // Узел перетащили — позиция уже сохранена в БД (useSnapAlignment), здесь
  // зеркалируем её в стейт уровня теми же значениями, что вернул бы рефетч. Иначе
  // пересчёт раскладки БЕЗ рефетча (локальный setEdges при реконнекте хэндла)
  // откатил бы узел на прежнюю сохранённую позицию. Локальный узел (block) хранит
  // координаты в самом узле, гость/контейнер — в levelPositions по id сущности.
  function handleNodeMoved(
    id: string,
    kind: "block" | "ghost" | "container",
    pos: { pos_x: number; pos_y: number },
  ) {
    if (kind === "block") {
      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, pos_x: pos.pos_x, pos_y: pos.pos_y } : n)),
      );
    } else {
      setLevelPositions((prev) => ({ ...prev, [id]: pos }));
    }
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

  // Протянули стрелку на хэндл/листовой узел — открываем упрощённый поповер, чтобы
  // сразу заполнить описание и технологию (связь создаётся по «Создать», см. EdgeQuickCreate).
  // Хэндлы из жеста прокидываем в поповер, чтобы связь создалась с ними, а не с дефолтными.
  function handleCreateEdge(
    sourceId: string, targetId: string,
    sourceHandle: string | null, targetHandle: string | null,
  ) {
    setEdgeQuick({ sourceId, targetId, sourceHandle, targetHandle });
  }

  function handleQuickCreated() {
    setEdgeQuick(null);
    load(currentParentId);
  }

  // Протянули стрелку на узел С ДЕТЬМИ — открываем выбор его потомка. Хэндл источника
  // сохраняем (дальний конец — дефолт, см. EdgeIntoPicker).
  function handleConnectInto(
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null,
  ) {
    setIntoPicker({ sourceId, containerId, containerName, sourceHandle });
  }

  function handleIntoCreated() {
    setIntoPicker(null);
    load(currentParentId);
  }

  // Шаблон узла отпустили на схему (LevelGraph посчитал координаты в системе графа) —
  // открываем модалку создания с выбранной формой и точкой дропа.
  function handleDropNode(shape: NodeShape, pos: { x: number; y: number }) {
    setNodeModal({ open: true, node: null, shape, pos });
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
            Контекст
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
          {/* Создание узла — перетаскиванием шаблона из боковой панели (секция
              «Добавить узел»), связи — протягиванием стрелки от хэндла узла.
              Отдельных кнопок создания в шапке больше нет. */}
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
          {/* Подсказка про пустой уровень — тостом в правом верхнем углу. Холст
              (даже пустой) рендерим всегда, чтобы сразу была видна канва и в неё
              можно было дропнуть первый узел; подсказка уезжает после добавления. */}
          <EmptyLevelHint visible={!loading && !hasNodes} isArchitect={isArchitect} />
          {loading ? (
            <p style={{ color: "#6b7280", padding: 24 }}>Загрузка...</p>
          ) : (
            <LevelGraph
              nodes={nodes}
              ghostNodes={ghostNodes}
              levelPositions={levelPositions}
              levelEdgeHandles={levelEdgeHandles}
              levelEdgeWaypoints={levelEdgeWaypoints}
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
              onEdgeHandlesChanged={updateEdgeHandles}
              onEdgeWaypointsChanged={updateEdgeWaypoints}
              onLevelEdgeWaypointsChanged={updateLevelEdgeWaypoints}
              onNodeMoved={handleNodeMoved}
              onDropNode={handleDropNode}
              onCreateEdge={handleCreateEdge}
              onConnectInto={handleConnectInto}
              onRequestDeleteNode={setPendingDelete}
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
      {/* Подтверждение удаления узла, инициированное с канваса (Backspace/Delete) —
          то же предупреждение со списком связей, что и из модалки узла */}
      {pendingDelete && (
        <NodeDeleteConfirm
          node={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onDeleted={(id) => { setPendingDelete(null); handleNodeDeleted(id); }}
        />
      )}
      {edgeQuick && (
        <EdgeQuickCreate
          sourceId={edgeQuick.sourceId}
          targetId={edgeQuick.targetId}
          sourceHandle={edgeQuick.sourceHandle}
          targetHandle={edgeQuick.targetHandle}
          sourceLabel={findNodeLabel(edgeQuick.sourceId)}
          targetLabel={findNodeLabel(edgeQuick.targetId)}
          onClose={() => setEdgeQuick(null)}
          onCreated={handleQuickCreated}
        />
      )}
      {intoPicker && (
        <EdgeIntoPicker
          sourceId={intoPicker.sourceId}
          sourceLabel={findNodeLabel(intoPicker.sourceId)}
          sourceHandle={intoPicker.sourceHandle}
          containerId={intoPicker.containerId}
          containerName={intoPicker.containerName}
          onClose={() => setIntoPicker(null)}
          onCreated={handleIntoCreated}
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
const logoutBtn: CSSProperties = {
  padding: "6px 12px",
  background: "none",
  color: "#6b7280",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};
