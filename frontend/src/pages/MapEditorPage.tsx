// Редактор-карта (MapEditorPage) — полноэкранный редактор схем (pages_pivot, Фаза 4).
// Роут: #/p/<pid>/map/<nodeId?>. Топбар: breadcrumb + undo/redo + «Готово».
// Слева: дерево объектов (дизайн страниц + секция «Добавить объект» внизу).
// Центр: LevelGraph со всеми жестами. Справа: ObjectInspector (272px).
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi, nodeDocsApi, edgesApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import type {
  AncestorRef, DeletionSnapshot, Edge, EdgeUpdate, GhostNode, LevelEdge,
  Node, NodeDoc, NodeDocMeta, NodeShape, NodeStatus, NodeUpdate,
  ViewLayout, ViewLayoutPayload,
} from "../types";
import { useHistory } from "../components/graph/interaction/useHistory";
import { guardPersist } from "../components/graph/interaction/persistGuard";
import { liftEdgesToLevel } from "../components/graph/projection";
import CrossLevelEdgePicker from "../components/CrossLevelEdgePicker";
import EdgeQuickCreate from "../components/EdgeQuickCreate";
import { useEdgeChoice } from "../components/graph/interaction/useEdgeChoice";
import NodeModal from "../components/NodeModal";
import NodeTreePanel from "../components/NodeTreePanel";
import "../components/NodeTreePanel.css";
import NodeDeleteConfirm from "../components/NodeDeleteConfirm";
import NodesDeleteConfirm from "../components/NodesDeleteConfirm";
import RelayoutConfirm from "../components/RelayoutConfirm";
import DocsAgentModal from "../components/docsImport/DocsAgentModal";
import LevelGraph, { type ViewMetaState, type LocateRequest } from "../components/LevelGraph";
import { useRemoteSync } from "./useRemoteSync";
import { useSchemaAlerts, resolveAlertLocate, PENDING_ALERT_LOCATE_KEY } from "./useSchemaAlerts";
import { toLevelEdges } from "../components/pageSchema";
import SchemaAlerts, { type LocateTarget } from "../components/SchemaAlerts";
import ObjectInspector, { type Selected } from "../components/inspector/ObjectInspector";
import type { NodeDocEvent } from "../components/inspector/FlowchartDocs";
import { readSchemaView, SCHEMA_VIEW_KEY, type SchemaView } from "../components/schemaView";
import { SchemaViewFilter } from "../components/SchemaViewFilter";
import { LogoMark, RelayoutIcon, ChevronIcon } from "../ui/icons";
import "../ui/chrome.css";

interface Props {
  projectId: string;
  // null = корневой уровень, иначе — уровень узла
  nodeId: string | null;
  // Узел для временной подсветки (locate, Ф11) — пульс ~2.5с при открытии
  locateNodeId?: string | null;
  // «Готово»/Esc → возврат туда, откуда открыли (роут не меняется, Ф12)
  onDone: () => void;
  // Двойной клик по гостю → его страница
  onNavigateNode: (nodeId: string) => void;
}

export default function MapEditorPage({ projectId: _projectId, nodeId, locateNodeId, onDone, onNavigateNode }: Props) {
  // ── Стейт уровня (адаптация TreePage) ────────────────────────────
  const [nodes, setNodes] = useState<Node[]>([]);
  const [endpoints, setEndpoints] = useState<GhostNode[]>([]);
  const [viewLayout, setViewLayout] = useState<ViewLayout>({});
  const [edges, setEdges] = useState<LevelEdge[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<AncestorRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedObject, setSelectedObject] = useState<Selected>(null);
  const [nodeModal, setNodeModal] = useState<{
    open: boolean; node: Node | null; shape?: NodeShape;
    pos?: { x: number; y: number } | null;
    parentId?: string | null; posView?: string | null;
  }>({ open: false, node: null });
  const [childRefresh, setChildRefresh] = useState<{ id: string; token: number } | null>(null);
  const childRefreshTok = useRef(0);
  const [intoPicker, setIntoPicker] = useState<{
    sourceId: string; containerId: string; containerName: string;
    sourceHandle: string | null; sourceName?: string;
  } | null>(null);
  const [outPicker, setOutPicker] = useState<{
    sourceId: string; sourceHandle: string | null; sourceName?: string;
  } | null>(null);
  const [edgeQuick, setEdgeQuick] = useState<{
    sourceId: string; targetId: string;
    sourceHandle: string | null; targetHandle: string | null;
    sourceName?: string; targetName?: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Node | null>(null);
  const [pendingMultiDelete, setPendingMultiDelete] = useState<Node[] | null>(null);
  const [relayoutOpen, setRelayoutOpen] = useState(false);
  const [dragShape, setDragShape] = useState<NodeShape | null>(null);
  // Сигнал перезагрузки дерева (создание/удаление узла, undo/redo)
  const [treeReload, setTreeReload] = useState(0);
  // Модалка «Доки от агента» (BYOA-дозаливка схем логики и OpenAPI-спек)
  const [docsAgentOpen, setDocsAgentOpen] = useState(false);
  const [schemaView, setSchemaView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { localStorage.setItem(SCHEMA_VIEW_KEY, schemaView); }, [schemaView]);
  const [remoteToast, setRemoteToast] = useState(false);
  const remoteToastTimer = useRef<number | null>(null);
  useEffect(() => () => { if (remoteToastTimer.current) window.clearTimeout(remoteToastTimer.current); }, []);

  const history = useHistory();
  const isArchitect = getUserRole() === "architect";
  const currentParent = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : null;
  const currentParentId = currentParent?.id ?? null;

  const viewMetaRef = useRef<ViewMetaState>({ version: 0, graphRev: 0 });
  const gestureActiveRef = useRef(false);
  const layoutRetrySeq = useRef(0);
  const [layoutRetry, setLayoutRetry] = useState<{
    patch: Record<string, Partial<ViewLayoutPayload> | null>; token: number;
  } | null>(null);

  // Locate-подсветка узла (Ф11): пульс ~2.5с при открытии редактора со страницы.
  const [locate, setLocate] = useState<LocateRequest | null>(
    () => (locateNodeId ? { kind: "node", ids: [locateNodeId], token: 1 } : null),
  );
  useEffect(() => {
    if (!locate) return;
    const t = window.setTimeout(() => setLocate(null), 2600);
    return () => window.clearTimeout(t);
  }, [locate]);

  // ── Загрузка уровня ──────────────────────────────────────────────
  // Возвращает загруженные узлы уровня (дерево выбирает свежий объект после прыжка).
  async function load(parentId: string | null): Promise<Node[]> {
    setLoading(true);
    setLayoutRetry(null);
    try {
      const graph = await nodesApi.getGraph(parentId);
      viewMetaRef.current = { version: graph.version, graphRev: graph.graph_rev };
      setNodes(graph.nodes);
      setEndpoints(graph.endpoints);
      setViewLayout(graph.layout ?? {});
      setEdges(toLevelEdges(graph));
      reloadAlerts(); // алерты глобальные — освежаем при каждой загрузке/мутации уровня
      return graph.nodes;
    } finally {
      setLoading(false);
    }
  }

  // Начальная загрузка: breadcrumb по nodeId + граф уровня
  useEffect(() => {
    (async () => {
      if (nodeId) {
        const all = await nodesApi.getAll();
        const byId = new Map(all.map((n) => [n.id, n]));
        const path: AncestorRef[] = [];
        let cur = byId.get(nodeId);
        while (cur) {
          path.unshift({ id: cur.id, name: cur.name, is_external: cur.is_external });
          cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        }
        setBreadcrumb(path);
      }
      await load(nodeId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Поллинг
  useRemoteSync({
    currentParentId,
    viewMeta: viewMetaRef,
    gestureActiveRef,
    onRemoteChange: () => {
      void load(currentParentId);
      setRemoteToast(true);
      if (remoteToastTimer.current) window.clearTimeout(remoteToastTimer.current);
      remoteToastTimer.current = window.setTimeout(() => setRemoteToast(false), 4000);
    },
  });

  const resyncingRef = useRef<Promise<void> | null>(null);
  function resyncOnPersistError(): Promise<void> {
    if (resyncingRef.current) return resyncingRef.current;
    const p = load(currentParentId).then(() => undefined).finally(() => { resyncingRef.current = null; });
    resyncingRef.current = p;
    return p;
  }
  function handlePersistConflict(patch: Record<string, Partial<ViewLayoutPayload> | null>) {
    void resyncOnPersistError().then(() => {
      setLayoutRetry({ patch, token: ++layoutRetrySeq.current });
    });
  }

  // ── Навигация по уровням (внутри редактора) ──────────────────────
  // Возвращает узлы загруженного уровня (undefined — переход не состоялся).
  async function navigateToLevel(level: string | null): Promise<Node[] | undefined> {
    if (level === currentParentId) return;
    setSelectedObject(null);
    if (level === null) { setBreadcrumb([]); return load(null); }
    const all = await nodesApi.getAll();
    const byId = new Map(all.map((n) => [n.id, n]));
    const path: AncestorRef[] = [];
    let cur: Node | undefined = byId.get(level);
    while (cur) {
      path.unshift({ id: cur.id, name: cur.name, is_external: cur.is_external });
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    setBreadcrumb(path);
    return load(level);
  }

  function drillDown(node: Node) {
    setSelectedObject(null);
    setBreadcrumb((prev) => [...prev, node]);
    load(node.id);
  }

  function drillToPath(path: AncestorRef[]) {
    if (path.length === 0) return;
    setSelectedObject(null);
    setBreadcrumb(path);
    load(path[path.length - 1].id);
  }

  function navigateTo(index: number) {
    setSelectedObject(null);
    const next = breadcrumb.slice(0, index + 1);
    setBreadcrumb(next);
    load(next[next.length - 1].id);
  }

  // ── Навигация из дерева объектов ─────────────────────────────────
  // Счётчик токенов locate: пульс пере-триггерится на каждый новый запрос.
  const locateSeq = useRef(1);

  // Алерты незавершённости схемы (индикатор «!» в рейле холста, архитектор).
  const { alerts, loaded: alertsLoaded, reload: reloadAlerts } = useSchemaAlerts(isArchitect);

  // Переход к проблемному объекту/связи/группе из алертов: общий предок → уровень,
  // затем центрирование + вспышка (портировано из TreePage.handleLocate).
  async function handleLocate(target: LocateTarget) {
    const all = await nodesApi.getAll();
    const { level, request } = resolveAlertLocate(all, target, alerts, ++locateSeq.current);
    if (level !== currentParentId) await navigateToLevel(level);
    setLocate(request);
  }

  // Цель алерта из шапки ProjectShell (переход «знак → карта»): применяется после
  // загрузки алертов (нужны концы связей), затем ключ очищается.
  useEffect(() => {
    if (!alertsLoaded) return;
    const raw = sessionStorage.getItem(PENDING_ALERT_LOCATE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_ALERT_LOCATE_KEY);
    try {
      void handleLocate(JSON.parse(raw) as LocateTarget);
    } catch { /* повреждённые данные цели — игнорируем */ }
    // handleLocate намеренно вне зависимостей: эффект срабатывает раз на загрузку алертов
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertsLoaded]);

  // Клик по контейнеру → дрилл на его слой (путь собран деревом).
  function drillFromTree(path: Node[]) {
    drillToPath(path.map((n) => ({ id: n.id, name: n.name, is_external: n.is_external })));
  }

  // Клик по листу → прыжок на его слой (слой родителя), выделение и пульс.
  async function pickFromTree(node: Node) {
    let pool = nodes;
    if (node.parent_id !== currentParentId) {
      pool = (await navigateToLevel(node.parent_id)) ?? pool;
    }
    const fresh = pool.find((n) => n.id === node.id) ?? node;
    setSelectedObject({ kind: "node", node: fresh });
    setLocate({ kind: "node", ids: [node.id], token: ++locateSeq.current });
  }

  // ── Undo/Redo ────────────────────────────────────────────────────
  async function dispatchUndo() {
    const cmd = history.peekUndo();
    if (!cmd) return;
    if (cmd.level !== undefined && cmd.level !== currentParentId) await navigateToLevel(cmd.level);
    history.undo();
    setTreeReload((t) => t + 1);
  }
  async function dispatchRedo() {
    const cmd = history.peekRedo();
    if (!cmd) return;
    if (cmd.level !== undefined && cmd.level !== currentParentId) await navigateToLevel(cmd.level);
    history.redo();
    setTreeReload((t) => t + 1);
  }

  // Esc = «Готово»
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  // ── Обработчики (порты из TreePage) ──────────────────────────────
  const refetchLevel = (level: string | null) => () => { load(level); };

  function nodeFields(n: Node): NodeUpdate {
    return { name: n.name, description: n.description, role: n.role, technology: n.technology, openapi_spec: n.openapi_spec, is_external: n.is_external, shape: n.shape };
  }

  function handleNodeSaved(saved: Node, isCreate: boolean, before?: Node) {
    const intoFrame = isCreate && saved.parent_id != null && saved.parent_id !== currentParentId;
    if (intoFrame) {
      if (nodeModal.pos) handleLayoutChanged({ [saved.id]: { x: nodeModal.pos.x, y: nodeModal.pos.y } });
      childRefreshTok.current += 1;
      setChildRefresh({ id: saved.parent_id!, token: childRefreshTok.current });
    } else {
      setNodes((prev) => prev.some((n) => n.id === saved.id) ? prev.map((n) => (n.id === saved.id ? saved : n)) : [...prev, saved]);
    }
    setNodeModal({ open: false, node: null });
    setSelectedObject((sel) => sel?.kind === "node" && sel.node.id === saved.id ? { kind: "node", node: saved } : sel);
    if (!isArchitect) return;
    if (isCreate) {
      setTreeReload((t) => t + 1);
      const levelAtCreate = currentParentId;
      const frameParent = intoFrame ? saved.parent_id : null;
      const refetch = () => { refetchLevel(levelAtCreate)(); if (frameParent) { childRefreshTok.current += 1; setChildRefresh({ id: frameParent, token: childRefreshTok.current }); } };
      let snap: DeletionSnapshot | null = null;
      history.push({ label: "Создание объекта", level: levelAtCreate,
        undo: () => { guardPersist(nodesApi.deletionSnapshot(saved.id).then((s) => { snap = s; return nodesApi.delete(saved.id); }).then(refetch), resyncOnPersistError); },
        redo: () => { guardPersist((snap ? nodesApi.restore(snap) : Promise.resolve()).then(refetch), resyncOnPersistError); },
      });
    } else if (before) {
      const apply = (n: Node) => { setNodes((prev) => prev.map((x) => (x.id === n.id ? n : x))); };
      history.push({ label: "Правка объекта", level: currentParentId,
        undo: () => { apply(before); guardPersist(nodesApi.update(before.id, nodeFields(before)), resyncOnPersistError); },
        redo: () => { apply(saved); guardPersist(nodesApi.update(saved.id, nodeFields(saved)), resyncOnPersistError); },
      });
    }
  }

  function applyDocsMeta(nodeId2: string, mut: (docs: NodeDocMeta[]) => NodeDocMeta[]) {
    const patch = (n: Node): Node => (n.id === nodeId2 ? { ...n, docs: mut(n.docs) } : n);
    setNodes((prev) => prev.map(patch));
    setSelectedObject((sel) => (sel?.kind === "node" && sel.node.id === nodeId2 ? { kind: "node", node: patch(sel.node) } : sel));
  }

  function handleDocEvent(evt: NodeDocEvent) {
    const meta = (d: NodeDoc): NodeDocMeta => ({ id: d.id, name: d.name, kind: d.kind, operation: d.operation, version: d.version });
    const fields = (d: NodeDoc) => ({ name: d.name, kind: d.kind, operation: d.operation, content: d.content });
    const level = currentParentId;
    if (evt.type === "edit") {
      const { nodeId: nid, before, after } = evt;
      applyDocsMeta(nid, (ds) => ds.map((m) => (m.id === after.id ? meta(after) : m)));
      history.push({ label: "Правка схемы логики", level,
        undo: () => { applyDocsMeta(nid, (ds) => ds.map((m) => (m.id === before.id ? meta(before) : m))); guardPersist(nodeDocsApi.update(nid, before.id, fields(before)), resyncOnPersistError); },
        redo: () => { applyDocsMeta(nid, (ds) => ds.map((m) => (m.id === after.id ? meta(after) : m))); guardPersist(nodeDocsApi.update(nid, after.id, fields(after)), resyncOnPersistError); },
      });
      return;
    }
    const { nodeId: nid } = evt;
    let cur = evt.doc;
    const recreate = () => guardPersist(nodeDocsApi.create(nid, fields(cur)).then((d) => { cur = d; applyDocsMeta(nid, (ds) => [...ds, meta(d)]); }), resyncOnPersistError);
    const remove = () => { applyDocsMeta(nid, (ds) => ds.filter((m) => m.id !== cur.id)); guardPersist(nodeDocsApi.delete(nid, cur.id), resyncOnPersistError); };
    if (evt.type === "create") {
      applyDocsMeta(nid, (ds) => [...ds, meta(evt.doc)]);
      history.push({ label: "Создание схемы логики", level, undo: remove, redo: recreate });
    } else {
      applyDocsMeta(nid, (ds) => ds.filter((m) => m.id !== evt.doc.id));
      history.push({ label: "Удаление схемы логики", level, undo: recreate, redo: remove });
    }
  }

  function handleNodeDeleted(id: string, snapshot?: DeletionSnapshot) {
    setNodeModal({ open: false, node: null });
    setSelectedObject(null);
    setTreeReload((t) => t + 1);
    load(currentParentId);
    if (!snapshot) return;
    const levelAtDelete = currentParentId;
    const refetch = refetchLevel(levelAtDelete);
    history.push({ label: "Удаление объекта", level: levelAtDelete,
      undo: () => { guardPersist(nodesApi.restore(snapshot).then(refetch), resyncOnPersistError); },
      redo: () => { guardPersist(nodesApi.delete(id).then(refetch), resyncOnPersistError); },
    });
  }

  function handleNodesDeleted(ids: string[], snapshots: DeletionSnapshot[]) {
    setTreeReload((t) => t + 1);
    load(currentParentId);
    if (snapshots.length === 0) return;
    const levelAtDelete = currentParentId;
    const refetch = refetchLevel(levelAtDelete);
    history.push({ label: `Удаление объектов (${ids.length})`, level: levelAtDelete,
      undo: () => { guardPersist(Promise.all(snapshots.map((s) => nodesApi.restore(s))).then(refetch), resyncOnPersistError); },
      redo: () => { guardPersist(Promise.all(ids.map((id2) => nodesApi.delete(id2))).then(refetch), resyncOnPersistError); },
    });
  }

  function handleLayoutChanged(items: Record<string, ViewLayoutPayload | null>) {
    setViewLayout((prev) => {
      const next = { ...prev };
      for (const [k, p] of Object.entries(items)) { if (p === null) delete next[k]; else next[k] = p; }
      return next;
    });
  }

  function handleEdgeDeleted(id: string, snapshot?: DeletionSnapshot) {
    setSelectedObject(null);
    load(currentParentId);
    if (!snapshot || !isArchitect) return;
    const levelAtDelete = currentParentId;
    const refetch = () => load(levelAtDelete);
    history.push({ label: "Удаление связи", level: levelAtDelete,
      undo: () => { guardPersist(nodesApi.restore(snapshot).then(refetch), resyncOnPersistError); },
      redo: () => { guardPersist(edgesApi.delete(id).then(refetch), resyncOnPersistError); },
    });
  }

  function handleEdgeSaved(updated: Edge, undoPayload?: EdgeUpdate, redoPayload?: EdgeUpdate) {
    load(currentParentId);
    if (!undoPayload || !redoPayload || !isArchitect) return;
    const levelAtEdit = currentParentId;
    const refetch = () => load(levelAtEdit);
    history.push({ label: "Правка связи", level: levelAtEdit,
      undo: () => { guardPersist(edgesApi.update(updated.id, undoPayload).then(refetch), resyncOnPersistError); },
      redo: () => { guardPersist(edgesApi.update(updated.id, redoPayload).then(refetch), resyncOnPersistError); },
    });
  }

  function pushEdgeCreate(created: Edge) {
    if (!isArchitect) return;
    const levelAtCreate = currentParentId;
    const refetch = () => load(levelAtCreate);
    let snap: DeletionSnapshot | null = null;
    history.push({ label: "Создание связи", level: levelAtCreate,
      undo: () => { guardPersist(edgesApi.deletionSnapshot(created.id).then((s) => { snap = s; return edgesApi.delete(created.id); }).then(refetch), resyncOnPersistError); },
      redo: () => { guardPersist((snap ? nodesApi.restore(snap) : Promise.resolve()).then(refetch), resyncOnPersistError); },
    });
  }

  const findLevelEdge = (id: string): LevelEdge | null => edges.find((e) => e.id === id) ?? null;
  const findNodeLabel = (id: string): string => nodes.find((n) => n.id === id)?.name ?? endpoints.find((ep) => ep.id === id)?.name ?? id;

  const levelGhosts = useMemo(() =>
    liftEdgesToLevel({ edges, endpoints, localIds: new Set(nodes.map((n) => n.id)), containerId: currentParentId }).ghosts,
    [edges, endpoints, nodes, currentParentId]);

  const linkedHighlight = useMemo((): { kind: "node" | "edge"; id: string } | null => {
    if (!selectedObject) return null;
    if (selectedObject.kind === "edge") return { kind: "edge", id: selectedObject.edge.id };
    if (selectedObject.kind === "ghost") return { kind: "node", id: selectedObject.ghost.id };
    return { kind: "node", id: selectedObject.node.id };
  }, [selectedObject]);

  const hasNodes = nodes.length + levelGhosts.length > 0;
  const hasStatusInfo = nodes.some((n) => n.status !== "existing") || levelGhosts.some((g) => g.status !== "existing");
  const statusCounts = useMemo<Record<NodeStatus, number>>(() => {
    const c: Record<NodeStatus, number> = { existing: 0, planned: 0, deprecated: 0 };
    for (const n of nodes) c[n.status]++;
    for (const g of levelGhosts) c[g.status]++;
    return c;
  }, [nodes, levelGhosts]);

  const inspectEdge = (edge: LevelEdge) => { setSelectedObject({ kind: "edge", edge }); };
  // Выбор связи (общая оркестрация с просмотром — useEdgeChoice): модалки выбора
  // и резолв группы рёбер там; семантика «выбрать» здесь — открыть инспектор
  // (inspectEdge), «дозаписать связь» (архитектор) — EdgeQuickCreate.
  const { onEdgesChoice, onTrunkChoice, choiceModal } = useEdgeChoice({
    resolveEdge: findLevelEdge,
    labelOf: findNodeLabel,
    onPick: inspectEdge,
    onAddFromChoice: isArchitect
      ? (rep) => setEdgeQuick({ sourceId: rep.source_id, targetId: rep.target_id, sourceHandle: null, targetHandle: null })
      : undefined,
  });

  // ── Рендер ───────────────────────────────────────────────────────
  return (
    <div style={page}>
      {/* Топбар */}
      <div style={topBar}>
        <div style={topLeft}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <LogoMark />
            <span style={{ fontSize: 14, fontWeight: 700, color: "#2563eb" }}>Карта</span>
          </div>
          <span style={divider} />
          {/* Breadcrumb уровней */}
          <button className="crumb" style={crumbLink} onClick={() => { void navigateToLevel(null); }}>
            {breadcrumb.length === 0 ? "Контекст" : "Проект"}
          </button>
          {breadcrumb.map((n, i) => (
            <span key={n.id} style={{ display: "flex", alignItems: "center" }}>
              <span style={crumbSep}><ChevronIcon /></span>
              {i < breadcrumb.length - 1 ? (
                <button className="crumb" style={crumbLink} onClick={() => navigateTo(i)}>{n.name}</button>
              ) : (
                <button style={crumbCurrent} disabled>{n.name}</button>
              )}
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Undo/Redo */}
          <button className="icon-btn" style={iconBtn} onClick={() => void dispatchUndo()} disabled={!history.canUndo()} title="Отменить · Ctrl+Z">
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 10h13a4 4 0 0 1 0 8H7" /><path d="M3 10 7 6" /><path d="M3 10 7 14" /></svg>
          </button>
          <button className="icon-btn" style={iconBtn} onClick={() => void dispatchRedo()} disabled={!history.canRedo()} title="Повторить · Ctrl+Shift+Z">
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 10H8a4 4 0 0 0 0 8h9" /><path d="m21 10-4-4" /><path d="m21 10-4 4" /></svg>
          </button>
          {isArchitect && (
            <button className="icon-btn" style={iconBtn} onClick={() => setRelayoutOpen(true)} disabled={!hasNodes} title="Переразложить уровень">
              <RelayoutIcon />
            </button>
          )}
          {/* Доки от агента (BYOA): наполнить схемы логики и OpenAPI-спеки по репозиторию.
              Область «текущий контейнер» = текущий уровень (breadcrumb). */}
          {isArchitect && (
            <button
              className="icon-btn"
              style={iconBtn}
              onClick={() => setDocsAgentOpen(true)}
              title="Доки от агента — наполнить схемы логики и OpenAPI-спеки ИИ-агентом по репозиторию"
              aria-label="Доки от агента"
            >
              <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="9" width="14" height="9" rx="2" />
                <path d="M12 9V6" /><circle cx="12" cy="4.6" r="1.3" />
                <path d="M9.2 13.5h.01M14.8 13.5h.01" />
                <path d="M2.8 12.5v3M21.2 12.5v3" />
              </svg>
            </button>
          )}
          {hasStatusInfo && <SchemaViewFilter view={schemaView} onChange={setSchemaView} />}
          <button style={doneBtn} onClick={() => onDone()}>Готово</button>
        </div>
      </div>

      {/* Тело: дерево + холст + инспектор */}
      <div style={bodyRow}>
        {/* Дерево объектов: тот же плоский дизайн, что на страницах (ProjectShell),
            но клик навигирует внутри редактора (контейнер → дрилл на слой,
            лист → прыжок на слой родителя + выделение + пульс) и внизу есть
            секция «Добавить объект» — единственное отличие от дерева страниц. */}
        <NodeTreePanel
          isArchitect={isArchitect}
          reloadToken={treeReload}
          currentNodeId={currentParentId}
          onDrillTo={drillFromTree}
          onPickLeaf={(node) => { void pickFromTree(node); }}
          onCreateChild={(parentId) => setNodeModal({ open: true, node: null, parentId, pos: null })}
          onTemplateDrag={setDragShape}
        />

        {/* Холст */}
        <div style={graphArea}>
          {/* Рейл тостов холста (правый верхний угол, спека AL10): индикатор
              незавершённости схемы + тост чужой сессии. Прозрачен для мыши,
              интерактивны только знак и панель (pointerEvents у них auto). */}
          <div style={toastRail}>
            {isArchitect && <SchemaAlerts alerts={alerts} onLocate={handleLocate} />}
            {remoteToast && <div style={remoteToastStyle}>Схема обновлена в другой сессии</div>}
          </div>
          {loading ? (
            <p style={{ color: "#6b7280", padding: 24 }}>Загрузка...</p>
          ) : (
            <LevelGraph
              nodes={nodes} endpoints={endpoints} viewLayout={viewLayout} edges={edges}
              depth={breadcrumb.length} containerId={currentParentId}
              ancestorNames={breadcrumb.map((b) => b.name)} ancestorIds={breadcrumb.map((b) => b.id)}
              isArchitect={isArchitect}
              onDrillDown={drillDown} onEnterNode={drillToPath}
              onEditNode={(node) => { setSelectedObject({ kind: "node", node }); }}
              onInspectGhost={(ghost) => { onNavigateNode(ghost.id); }}
              linkedHighlight={linkedHighlight}
              onClearSelection={() => setSelectedObject(null)}
              onEdgesChoice={onEdgesChoice}
              onTrunkChoice={onTrunkChoice}
              onLayoutChanged={handleLayoutChanged}
              onDropNode={(shape, pos, dropParentId) => {
                if (dropParentId) setNodeModal({ open: true, node: null, shape, pos, parentId: dropParentId, posView: currentParentId });
                else setNodeModal({ open: true, node: null, shape, pos });
              }}
              refreshChildrenOf={childRefresh}
              onCreateEdge={(s, t, sh, th, sn, tn) => setEdgeQuick({ sourceId: s, targetId: t, sourceHandle: sh, targetHandle: th, sourceName: sn, targetName: tn })}
              onConnectInto={(s, cid, cn, sh, sn) => setIntoPicker({ sourceId: s, containerId: cid, containerName: cn, sourceHandle: sh, sourceName: sn })}
              onExitUp={(s, sh, sn) => setOutPicker({ sourceId: s, sourceHandle: sh, sourceName: sn })}
              onRequestDeleteNode={setPendingDelete}
              onRequestDeleteNodes={setPendingMultiDelete}
              dragShape={dragShape}
              history={history} onUndo={dispatchUndo} onRedo={dispatchRedo}
              onPersistError={resyncOnPersistError} onPersistConflict={handlePersistConflict}
              retryPatch={layoutRetry} viewMeta={viewMetaRef} gestureActiveRef={gestureActiveRef}
              schemaView={schemaView} locate={locate}
            />
          )}
        </div>

        {/* Инспектор */}
        <aside style={rightPanel}>
          <ObjectInspector
            hasStatusInfo={hasStatusInfo} view={schemaView} onViewChange={setSchemaView}
            counts={statusCounts} selected={selectedObject} isArchitect={isArchitect}
            onNodeSaved={handleNodeSaved} onNodeDeleted={handleNodeDeleted}
            onDocEvent={handleDocEvent} onEdgeSaved={handleEdgeSaved} onEdgeDeleted={handleEdgeDeleted}
            onGhostGoToSource={(ghost) => { onNavigateNode(ghost.id); }}
          />
        </aside>
      </div>

      {/* Модалки */}
      {nodeModal.open && (
        <NodeModal
          parentId={nodeModal.parentId !== undefined ? nodeModal.parentId : currentParentId}
          shape={nodeModal.shape} initialPos={nodeModal.pos ?? null} posView={nodeModal.posView}
          onClose={() => setNodeModal({ open: false, node: null })} onSaved={handleNodeSaved}
        />
      )}
      {pendingDelete && (
        <NodeDeleteConfirm node={pendingDelete} onCancel={() => setPendingDelete(null)}
          onDeleted={(id, snapshot) => { setPendingDelete(null); handleNodeDeleted(id, snapshot); }} />
      )}
      {pendingMultiDelete && (
        <NodesDeleteConfirm nodes={pendingMultiDelete} onCancel={() => setPendingMultiDelete(null)}
          onDeleted={(ids, snapshots) => { setPendingMultiDelete(null); handleNodesDeleted(ids, snapshots); }} />
      )}
      {relayoutOpen && (
        <RelayoutConfirm containerId={currentParentId} levelName={currentParent?.name}
          onCancel={() => setRelayoutOpen(false)}
          onDone={() => { setRelayoutOpen(false); load(currentParentId); history.clear(); }} />
      )}
      {docsAgentOpen && (
        <DocsAgentModal
          currentParentId={currentParentId}
          currentParentName={currentParent?.name ?? null}
          onClose={() => setDocsAgentOpen(false)}
          onApplied={() => { setDocsAgentOpen(false); load(currentParentId); setTreeReload((t) => t + 1); }}
        />
      )}
      {edgeQuick && (
        <EdgeQuickCreate sourceId={edgeQuick.sourceId} targetId={edgeQuick.targetId}
          sourceLabel={edgeQuick.sourceName ?? findNodeLabel(edgeQuick.sourceId)}
          targetLabel={edgeQuick.targetName ?? findNodeLabel(edgeQuick.targetId)}
          onClose={() => setEdgeQuick(null)}
          onCreated={(created) => { setEdgeQuick(null); load(currentParentId); pushEdgeCreate(created); }} />
      )}
      {intoPicker && (
        <CrossLevelEdgePicker title={`Связь внутрь «${intoPicker.containerName}»`}
          subtitle="Выберите объект-потомок — дальний конец межуровневой связи."
          sourceId={intoPicker.sourceId} sourceLabel={intoPicker.sourceName ?? findNodeLabel(intoPicker.sourceId)}
          loadNodes={() => nodesApi.getDescendants(intoPicker.containerId)} scopeKey={intoPicker.containerId}
          rootParentId={intoPicker.containerId} slotPlaceholder={`Объект внутри «${intoPicker.containerName}»…`}
          onClose={() => setIntoPicker(null)}
          onCreated={(created) => { setIntoPicker(null); load(currentParentId); pushEdgeCreate(created); }} />
      )}
      {outPicker && (
        <CrossLevelEdgePicker title="Связь с объектом вне уровня"
          subtitle="Выберите объект из любой части схемы — связь станет сквозной."
          sourceId={outPicker.sourceId} sourceLabel={outPicker.sourceName ?? findNodeLabel(outPicker.sourceId)}
          loadNodes={() => nodesApi.getAll()} scopeKey="all" rootParentId={null} slotPlaceholder="Объект вне уровня…"
          excludeIds={new Set<string>([outPicker.sourceId, ...nodes.map((n) => n.id), ...levelGhosts.map((g) => g.id)])}
          onClose={() => setOutPicker(null)}
          onCreated={(created) => { setOutPicker(null); load(currentParentId); pushEdgeCreate(created); }} />
      )}
      {/* Выбор связи (обычный / общее плечо) — рендерит useEdgeChoice */}
      {choiceModal}
    </div>
  );
}

// ── Стили ───────────────────────────────────────────────────────────

const page: CSSProperties = { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui, -apple-system, sans-serif", overflow: "hidden", background: "#f8fafc" };
const topBar: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 16px", borderBottom: "1px solid #e2e8f0", background: "#fff", flexShrink: 0, gap: 12, flexWrap: "wrap" };
const topLeft: CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 14, flexWrap: "wrap", flex: 1, minWidth: 0 };
const divider: CSSProperties = { width: 1, height: 22, background: "#e2e8f0", flex: "none", margin: "0 4px" };
const bodyRow: CSSProperties = { flex: 1, display: "flex", minHeight: 0, overflow: "hidden" };
const graphArea: CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", padding: 12, display: "flex", flexDirection: "column", position: "relative" };
const rightPanel: CSSProperties = { width: 272, flexShrink: 0, borderLeft: "1px solid #e2e8f0", background: "#fbfcfd", overflowY: "auto", padding: "14px 14px", scrollbarGutter: "stable" };
const doneBtn: CSSProperties = { padding: "7px 20px", fontSize: 13.5, fontWeight: 600, color: "#fff", background: "#2563eb", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" };
const crumbLink: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "3px 7px", borderRadius: 7, fontSize: 13.5, color: "#64748b", cursor: "pointer", background: "none", border: "none" };
const crumbCurrent: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "3px 7px", fontSize: 13.5, color: "#1e293b", fontWeight: 600, background: "none", border: "none", cursor: "default" };
const crumbSep: CSSProperties = { color: "#cbd5e1", display: "inline-flex", alignItems: "center", margin: "0 1px" };
const iconBtn: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, flex: "none", background: "#fff", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer" };
// Рейл тостов холста (правый верхний угол): колонка, прозрачна для мыши —
// интерактивны только вложенные знак/панель алертов и тост (у них pointerEvents auto).
const toastRail: CSSProperties = { position: "absolute", top: 12, right: 12, zIndex: 6, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, pointerEvents: "none" };
const remoteToastStyle: CSSProperties = { background: "#eef2ff", border: "1px solid #c7d2fe", color: "#3730a3", borderRadius: 10, padding: "7px 12px", fontSize: 13, boxShadow: "0 4px 12px rgba(30,41,59,.10)", pointerEvents: "auto" };
