import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { nodesApi, edgesApi, exportApi } from "../api/nodes";
import { getUserRole } from "../api/auth";
import type { AncestorRef, DeletionSnapshot, Edge, EdgePoint, EdgeUpdate, GhostNode, LevelEdge, Node, NodeShape, NodeUpdate, SchemaAlerts as Alerts } from "../types";
import { useHistory } from "../components/graph/interaction/useHistory";
import CrossLevelEdgePicker from "../components/CrossLevelEdgePicker";
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
import ExportModal from "../components/ExportModal";

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
  const [edges, setEdges] = useState<LevelEdge[]>([]);
  // Хлебный путь хранит только id+name каждого уровня (этого достаточно для рендера
  // и навигации вверх). Лёгкий тип нужен, чтобы заходить и к госту из другой ветки:
  // его полный путь известен только как ancestors (AncestorRef), без целого Node.
  const [breadcrumb, setBreadcrumb] = useState<AncestorRef[]>([]);
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
  // протянули стрелку на верхнюю плитку «вне уровня» — выбор дальнего конца из ВСЕЙ
  // схемы (узел, которого нет на текущем холсте). Доступно только на не-корневом уровне.
  const [outPicker, setOutPicker] = useState<{
    sourceId: string;
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
  const [edgeDetailModal, setEdgeDetailModal] = useState<LevelEdge | null>(null);
  // выбор связи из «мастер-стрелки» (несколько слитых связей одного направления)
  const [edgeChoice, setEdgeChoice] = useState<LevelEdge[] | null>(null);
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
    isolated_groups: [],
  });

  // сигнал перезагрузки бокового дерева: бампаем после создания/удаления узла,
  // чтобы новый узел сразу попал в дерево без перезагрузки страницы
  const [treeReload, setTreeReload] = useState(0);

  // экспорт схемы в YAML для LLM. Область снимаем на момент открытия (nodeId=null —
  // вся схема, иначе поддерево узла), чтобы навигация её не сбила.
  const [exportScope, setExportScope] = useState<{
    key: string;
    title: string;
    nodeId: string | null;
  } | null>(null);

  // История Undo/Redo всего вида уровня: команды перемещений/изломов кладёт LevelGraph,
  // команду удаления — handleNodeDeleted (удаление инициируется здесь). История
  // per-level-view: чистим при смене уровня. Чистка живёт ЗДЕСЬ, а не в LevelGraph,
  // потому что после удаления load() на миг подменяет LevelGraph спиннером — его
  // эффект-на-mount затёр бы только что положенную команду удаления. TreePage на load
  // не ремаунтится, поэтому эффект на currentParentId срабатывает лишь на реальной навигации.
  const history = useHistory();

  const isArchitect = getUserRole() === "architect";
  const currentParent =
    breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1] : null;
  const currentParentId = currentParent?.id ?? null;

  // Открыть экспорт по текущей области: на корне — вся схема, внутри узла — его поддерево.
  const openExport = () => {
    if (currentParent) {
      setExportScope({
        key: currentParent.id,
        title: `Экспорт поддерева «${currentParent.name}»`,
        nodeId: currentParent.id,
      });
    } else {
      setExportScope({ key: "all", title: "Экспорт схемы", nodeId: null });
    }
  };

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
          // реальные концы ребра — нужны модалке деталей (см. LevelEdge)
          original_source_id: ge.original_source_id,
          original_target_id: ge.original_target_id,
          original_source_name: ge.original_source_name,
          original_target_name: ge.original_target_name,
          source_handle: ge.source_handle,
          target_handle: ge.target_handle,
          waypoints: ge.waypoints,
          label_t: ge.label_t,
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

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- первичная загрузка при маунте; load() синхронно зовётся и из навигации, в deps зациклил бы эффект
  useEffect(() => { load(null); }, []);

  // История per-level-view: чистим при переходе на другой уровень (но НЕ при удалении —
  // там currentParentId не меняется, команда удаления остаётся доступной для Undo).
  useEffect(() => { history.clear(); }, [currentParentId, history]);

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
  function drillToPath(path: AncestorRef[]) {
    if (path.length === 0) return;
    setContextNode(null); // если была открыта контекст-модалка — закрываем
    setBreadcrumb(path);
    load(path[path.length - 1].id);
  }

  // Семантические (версионируемые) поля узла для отката правки — без раскладки
  // (pos/handle) и parent_id (через модалку не меняется). Совпадает с payload правки
  // в NodeModal, поэтому update(before)/update(after) точно отменяют/повторяют правку.
  function nodeFields(n: Node): NodeUpdate {
    return {
      name: n.name,
      description: n.description,
      role: n.role,
      technology: n.technology,
      flowchart: n.flowchart,
      openapi_spec: n.openapi_spec,
      is_external: n.is_external,
      shape: n.shape,
    };
  }

  function handleNodeSaved(saved: Node, isCreate: boolean) {
    // before — оригинал из открытой модалки (для правки полей нужен «как было»).
    const before = nodeModal.node;
    setNodes((prev) =>
      prev.some((n) => n.id === saved.id)
        ? prev.map((n) => (n.id === saved.id ? saved : n))
        : [...prev, saved]
    );
    setNodeModal({ open: false, node: null });
    // Этот обработчик не перезагружает уровень (правит локальный стейт) —
    // алерты обновляем явно: добавленный/изменённый узел мог стать «подвисшим».
    void loadAlerts();
    // боковое дерево перечитываем: новый узел должен появиться, у правленого мог
    // смениться name/форма/число детей (порядок ранжирования)
    setTreeReload((t) => t + 1);

    if (!isArchitect) return;
    if (isCreate) {
      // Создание узла (Undo): структурная операция, как удаление — undo снимает снимок
      // и удаляет (с сохранением id), redo восстанавливает; уровень перечитываем.
      const levelAtCreate = currentParentId;
      const refetch = () => { load(levelAtCreate); setTreeReload((t) => t + 1); };
      let snap: DeletionSnapshot | null = null;
      history.push({
        label: "Создание объекта",
        undo: () => {
          void nodesApi.deletionSnapshot(saved.id)
            .then((s) => { snap = s; return nodesApi.delete(saved.id); })
            .then(refetch);
        },
        redo: () => {
          void (snap ? nodesApi.restore(snap) : Promise.resolve()).then(refetch);
        },
      });
    } else if (before) {
      // Правка полей (Undo): возвращаем/повторяем семантику через update, зеркаля в
      // локальный стейт сразу (мгновенно, как перемещения) + обновляя алерты/дерево.
      const apply = (n: Node) => {
        setNodes((prev) => prev.map((x) => (x.id === n.id ? n : x)));
        void loadAlerts();
        setTreeReload((t) => t + 1);
      };
      history.push({
        label: "Правка объекта",
        undo: () => { apply(before); void nodesApi.update(before.id, nodeFields(before)); },
        redo: () => { apply(saved); void nodesApi.update(saved.id, nodeFields(saved)); },
      });
    }
  }

  function handleNodeDeleted(id: string, snapshot?: DeletionSnapshot) {
    // Перезагружаем уровень: вместе с узлом удалились его связи (в т.ч. сквозные),
    // поэтому проецированные рёбра и гости без связей должны пересчитаться.
    setNodeModal({ open: false, node: null });
    load(currentParentId);
    setTreeReload((t) => t + 1); // удалённый узел должен уйти и из бокового дерева

    // Откат удаления (Undo): restore воссоздаёт поддерево с исходными id, redo —
    // повторное удаление по тому же id. В отличие от перемещений (мгновенное зеркало
    // в стейт), структурное восстановление требует серверной проекции гостей/рёбер,
    // поэтому undo/redo перечитывают уровень — та же цена, что и у самого удаления.
    // Уровень фиксируем на момент удаления: история чистится при навигации, так что
    // на момент undo пользователь на том же уровне.
    if (!snapshot) return;
    const levelAtDelete = currentParentId;
    const refetch = () => {
      load(levelAtDelete);
      setTreeReload((t) => t + 1);
    };
    history.push({
      label: "Удаление объекта",
      undo: () => {
        void nodesApi.restore(snapshot).then(refetch);
      },
      redo: () => {
        void nodesApi.delete(id).then(refetch);
      },
    });
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

  // Плашку подписи перетащили — доля label_t сохранена в колонку ребра (commitLabelT).
  // Зеркалим в стейт уровня теми же значениями, что вернул бы рефетч (доля одна на ребро).
  function updateEdgeLabelT(edgeId: string, t: number | null) {
    setEdges((prev) => prev.map((e) => (e.id === edgeId ? { ...e, label_t: t } : e)));
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

  function handleEdgeDeleted(id: string, snapshot?: DeletionSnapshot) {
    setEdgeDetailModal(null);
    load(currentParentId);
    // Откат удаления связи (Undo): restore воссоздаёт связь с исходным id, redo —
    // повторное удаление. Симметрично удалению узла (та же цена — рефетч уровня).
    if (!snapshot || !isArchitect) return;
    const levelAtDelete = currentParentId;
    const refetch = () => load(levelAtDelete);
    history.push({
      label: "Удаление связи",
      undo: () => { void nodesApi.restore(snapshot).then(refetch); },
      redo: () => { void edgesApi.delete(id).then(refetch); },
    });
  }

  function handleEdgeSaved(updated: Edge, undoPayload?: EdgeUpdate, redoPayload?: EdgeUpdate) {
    // Перезагружаем уровень — метка/технология/концы обновятся на стрелке. Саму модалку
    // не трогаем: её концы — спроецированные (а PATCH вернул бы сырые), а новые
    // метка/технология уже показаны из локального состояния модалки.
    load(currentParentId);
    // Откат ПРАВКИ полей связи (Undo): update(undoPayload)/update(redoPayload), рефетч —
    // смена концов меняет проекцию гостей/рёбер, поэтому зеркалить в стейт нельзя.
    if (!undoPayload || !redoPayload || !isArchitect) return;
    const levelAtEdit = currentParentId;
    const refetch = () => load(levelAtEdit);
    history.push({
      label: "Правка связи",
      undo: () => { void edgesApi.update(updated.id, undoPayload).then(refetch); },
      redo: () => { void edgesApi.update(updated.id, redoPayload).then(refetch); },
    });
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

  // Откат СОЗДАНИЯ связи (Undo): структурная операция, как создание узла — undo снимает
  // снимок связи (само ребро + ghost-хэндлы/изломы) и удаляет, redo восстанавливает с
  // сохранением id. Уровень перечитываем (связь могла спроецироваться гостем).
  function pushEdgeCreate(created: Edge) {
    if (!isArchitect) return;
    const levelAtCreate = currentParentId;
    const refetch = () => load(levelAtCreate);
    let snap: DeletionSnapshot | null = null;
    history.push({
      label: "Создание связи",
      undo: () => {
        void edgesApi.deletionSnapshot(created.id)
          .then((s) => { snap = s; return edgesApi.delete(created.id); })
          .then(refetch);
      },
      redo: () => {
        void (snap ? nodesApi.restore(snap) : Promise.resolve()).then(refetch);
      },
    });
  }

  function handleQuickCreated(created: Edge) {
    setEdgeQuick(null);
    load(currentParentId);
    pushEdgeCreate(created);
  }

  // Протянули стрелку на узел С ДЕТЬМИ — открываем выбор его потомка. Хэндл источника
  // сохраняем (дальний конец — дефолт, см. CrossLevelEdgePicker).
  function handleConnectInto(
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null,
  ) {
    setIntoPicker({ sourceId, containerId, containerName, sourceHandle });
  }

  function handleIntoCreated(created: Edge) {
    setIntoPicker(null);
    load(currentParentId);
    pushEdgeCreate(created);
  }

  // Шаблон узла отпустили на схему (LevelGraph посчитал координаты в системе графа) —
  // открываем модалку создания с выбранной формой и точкой дропа.
  function handleDropNode(shape: NodeShape, pos: { x: number; y: number }) {
    setNodeModal({ open: true, node: null, shape, pos });
  }

  // Полное ребро уровня по id — LevelGraph отдаёт в колбэках суженный до Edge тип
  // (без original_*), а модалке деталей нужны реальные концы. Это тот же объект из
  // стейта (LevelGraph искал его в том же массиве), просто восстанавливаем тип.
  const findLevelEdge = (id: string): LevelEdge | null =>
    edges.find((e) => e.id === id) ?? null;

  const findNodeLabel = (id: string): string =>
    nodes.find((n) => n.id === id)?.name ??
    ghostNodes.find((g) => g.id === id)?.name ??
    id;

  // Имя конца связи для заголовка «Выберите связь». Берём ФАКТИЧЕСКИЙ конец ребра
  // (может быть дочерним узлом при сквозной связи), а не спроецированный на уровень
  // узел. У членов мастер-стрелки фактические концы могут различаться (общий лишь
  // спроецированный конец, по нему и сгруппированы) — если расходятся, показываем
  // спроецированный общий конец (findNodeLabel по общему source_id/target_id группы).
  const edgeEndLabel = (originalNames: string[], projectedId: string): string => {
    const uniq = new Set(originalNames);
    return uniq.size === 1 ? originalNames[0] : findNodeLabel(projectedId);
  };

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
          <button
            onClick={openExport}
            style={exportBtn}
            title="Скопировать схему (или текущее поддерево) в YAML для LLM"
          >
            ⤓ Экспорт в YAML
          </button>
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
          reloadToken={treeReload}
        />

        {/* Область графа — заполняет оставшееся пространство */}
        <div style={graphArea}>
          {/* Индикатор незавершённости схемы (только архитектор) */}
          {isArchitect && <SchemaAlerts alerts={alerts} />}
          {/* Подсказка про пустой уровень — тостом в правом верхнем углу. Холст
              (даже пустой) рендерим всегда, чтобы сразу была видна канва и в неё
              можно было дропнуть первый узел. Тост уезжает уже при открытии окна
              создания узла: пользователь до него дошёл — значит инструкцию прочёл,
              дальше тост только отвлекает. */}
          <EmptyLevelHint
            visible={!loading && !hasNodes && !nodeModal.open}
            isArchitect={isArchitect}
          />
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
              onEnterNode={drillToPath}
              onEditNode={(node) => setNodeModal({ open: true, node })}
              onEdgesChoice={(group) =>
                setEdgeChoice(
                  group
                    .map((g) => findLevelEdge(g.id))
                    .filter((e): e is LevelEdge => e != null),
                )
              }
              onEdgeHandlesChanged={updateEdgeHandles}
              onEdgeWaypointsChanged={updateEdgeWaypoints}
              onLevelEdgeWaypointsChanged={updateLevelEdgeWaypoints}
              onEdgeLabelTChanged={updateEdgeLabelT}
              onNodeMoved={handleNodeMoved}
              onDropNode={handleDropNode}
              onCreateEdge={handleCreateEdge}
              onConnectInto={handleConnectInto}
              onExitUp={(sourceId, sourceHandle) => setOutPicker({ sourceId, sourceHandle })}
              onRequestDeleteNode={setPendingDelete}
              dragShape={dragShape}
              history={history}
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
          onDeleted={(id, snapshot) => { setPendingDelete(null); handleNodeDeleted(id, snapshot); }}
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
        <CrossLevelEdgePicker
          title={`Связь внутрь «${intoPicker.containerName}»`}
          subtitle="Выберите узел-потомок — дальний конец межуровневой связи."
          sourceId={intoPicker.sourceId}
          sourceLabel={findNodeLabel(intoPicker.sourceId)}
          sourceHandle={intoPicker.sourceHandle}
          loadNodes={() => nodesApi.getDescendants(intoPicker.containerId)}
          scopeKey={intoPicker.containerId}
          rootParentId={intoPicker.containerId}
          slotPlaceholder={`Узел внутри «${intoPicker.containerName}»…`}
          onClose={() => setIntoPicker(null)}
          onCreated={handleIntoCreated}
        />
      )}
      {outPicker && (
        <CrossLevelEdgePicker
          title="Связь с узлом вне уровня"
          subtitle="Выберите узел из любой части схемы — связь станет сквозной."
          sourceId={outPicker.sourceId}
          sourceLabel={findNodeLabel(outPicker.sourceId)}
          sourceHandle={outPicker.sourceHandle}
          loadNodes={() => nodesApi.getAll()}
          scopeKey="all"
          rootParentId={null}
          slotPlaceholder="Узел вне уровня…"
          // на этом уровне уже видны локальные узлы и гости — их (и сам источник)
          // выбирать незачем: к ним тянут связь прямо на холсте
          excludeIds={
            new Set<string>([
              outPicker.sourceId,
              ...nodes.map((n) => n.id),
              ...ghostNodes.map((g) => g.id),
            ])
          }
          onClose={() => setOutPicker(null)}
          onCreated={(created) => { setOutPicker(null); load(currentParentId); pushEdgeCreate(created); }}
        />
      )}
      {edgeDetailModal && (
        <EdgeDetailModal
          edge={edgeDetailModal}
          sourceId={edgeDetailModal.original_source_id}
          targetId={edgeDetailModal.original_target_id}
          sourceLabel={edgeDetailModal.original_source_name}
          targetLabel={edgeDetailModal.original_target_name}
          isArchitect={isArchitect}
          onClose={() => setEdgeDetailModal(null)}
          onDeleted={handleEdgeDeleted}
          onSaved={handleEdgeSaved}
        />
      )}
      {edgeChoice && edgeChoice.length > 0 && (
        <EdgeChoiceModal
          edges={edgeChoice}
          sourceLabel={edgeEndLabel(edgeChoice.map((e) => e.original_source_name), edgeChoice[0].source_id)}
          targetLabel={edgeEndLabel(edgeChoice.map((e) => e.original_target_name), edgeChoice[0].target_id)}
          onPick={(edge) => { setEdgeChoice(null); setEdgeDetailModal(edge); }}
          // Архитектору — дозаписать новую связь в том же направлении (концы как у
          // стрелки на схеме, хэндлы дефолтные). Открываем тот же поповер, что и жест.
          onAdd={
            isArchitect
              ? () => {
                  const dir = edgeChoice[0];
                  setEdgeChoice(null);
                  setEdgeQuick({
                    sourceId: dir.source_id,
                    targetId: dir.target_id,
                    sourceHandle: null,
                    targetHandle: null,
                  });
                }
              : undefined
          }
          onClose={() => setEdgeChoice(null)}
        />
      )}
      {contextNode && (
        <NodeContextModal
          node={contextNode}
          onClose={() => setContextNode(null)}
        />
      )}

      {exportScope && (
        <ExportModal
          title={exportScope.title}
          loadKey={exportScope.key}
          load={() =>
            exportScope.nodeId ? exportApi.subtree(exportScope.nodeId) : exportApi.all()
          }
          onClose={() => setExportScope(null)}
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
const exportBtn: CSSProperties = {
  padding: "6px 12px",
  background: "#eef2ff",
  color: "#4338ca",
  border: "1px solid #c7d2fe",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};
