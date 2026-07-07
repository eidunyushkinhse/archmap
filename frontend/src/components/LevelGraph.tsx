import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ConnectionMode,
  SelectionMode,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ViewportPortal,
  type Node as RFNode,
  type Edge as RFEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./LevelGraph.css";
import { UndoIcon, RedoIcon } from "../ui/icons";
import { edgesApi, nodesApi } from "../api/nodes";
import type { Node as AppNode, GhostNode, Edge as AppEdge, NodeShape, NodeStatus, EdgePoint, AncestorRef, LevelPos, LevelWaypoints } from "../types";
import { canHaveChildren } from "../types";
import {
  NODE_W, NODE_H,
  CTX_LABEL_W,
} from "./graph/constants";
import type {
  WrappedEdgeData,
  BlockData, GhostData, ContainerData,
  QuickConnectHandlers,
} from "./graph/types";
import type { EdgeSide } from "./graph/edgePath";
import { edgeText } from "./graph/text";
import { getNodeColors, STATUS_META } from "./graph/colors";
import { viewShows, type SchemaView } from "./schemaView";
import { computeViewLayout, type LayoutResult } from "./graph/layout/pipeline";
import { NodeShapeSvg } from "./graph/shapes";
import { nodeTypes } from "./graph/nodes";
import { edgeTypes } from "./graph/edges";
import { EdgeJumpProvider } from "./graph/EdgeJumpContext";
import ConnectionLine from "./graph/ConnectionLine";
import { LevelBoundary, AlignmentGuides } from "./graph/boundaries";
import ReconnectBlockedToast from "./graph/ReconnectBlockedToast";
import { useAlignmentGuides } from "./graph/interaction/useAlignmentGuides";
import { useSnapAlignment } from "./graph/interaction/useSnapAlignment";
import { useTemplateDrop } from "./graph/interaction/useTemplateDrop";
import { useReconnectHandles } from "./graph/interaction/useReconnectHandles";
import { useEdgeWaypoints } from "./graph/interaction/useEdgeWaypoints";
import { useHistory } from "./graph/interaction/useHistory";
import type { History } from "./graph/interaction/useHistory";
import { useCanvasDelete } from "./graph/interaction/useCanvasDelete";
import { useEdgeConnect, type ConnectTarget } from "./graph/interaction/useEdgeConnect";
import { findQuickConnectTarget, type QcNode } from "./graph/interaction/quickConnect";
import QuickConnectPreview from "./graph/QuickConnectPreview";
import { useGroupEdgeDrag } from "./graph/interaction/useGroupEdgeDrag";
import { useLiveDragHandles, type LiveHandleInputs } from "./graph/interaction/useLiveDragHandles";
import { guardPersist } from "./graph/interaction/persistGuard";

// --- Основной компонент ---

// Стабильный пустой дефолт для levelEdgeHandles: дефолт-параметр `= {}` создавал бы
// НОВЫЙ объект на каждый рендер, а он — зависимость async-эффекта раскладки → лишний
// перезапуск ELK и мигание. Один модульный объект держит ссылку стабильной.
const EMPTY_LEVEL_HANDLES: Record<string, string[]> = {};
// Тот же приём для пер-уровневых путей гостевых стрелок: стабильная ссылка дефолта,
// чтобы не дёргать сборку рёбер лишний раз.
const EMPTY_LEVEL_WAYPOINTS: Record<string, LevelWaypoints> = {};

// Стиль приглушения узла, скрытого фильтром «Вид схемы» (мгновенно, без transition —
// см. ТЗ: fade на opacity в наших прогонах вёл себя нестабильно).
const DIM_STYLE = { opacity: 0.12, pointerEvents: "none" as const };

interface LevelGraphProps {
  nodes: AppNode[];
  ghostNodes: GhostNode[];
  // сохранённые координаты гостей на уровне, ключ — id отображаемой сущности
  // (лист-гость ИЛИ предок-контейнер, в который гость свёрнут)
  levelPositions: Record<string, LevelPos>;
  // сохранённые хэндлы гостевых концов рёбер: edge_id → список значений хэндлов
  // (по одному на проекцию). Применяются к концу, чей текущий показанный узел
  // совпадает с префиксом хэндла; остальные — из колонок ребра / autoHandles.
  // Необязателен: контекст-схема (mode="context") хэндлы не сохраняет — там {}.
  levelEdgeHandles?: Record<string, string[]>;
  // сохранённые пути гостевых стрелок на уровне: edge_id → точки-сгибы
  levelEdgeWaypoints?: Record<string, LevelWaypoints>;
  edges: AppEdge[];
  depth: number;
  /** id узла-контейнера текущего уровня (null — корень) */
  containerId: string | null;
  /** имена предков из breadcrumb (корень → непосредственный родитель) —
      подписи вложенных рамок уровней; пусто на корне */
  ancestorNames: string[];
  /** id тех же предков (параллельно ancestorNames) — для сопоставления гостей */
  ancestorIds: string[];
  isArchitect: boolean;
  onDrillDown: (node: AppNode) => void;
  // войти к компонентам гостя/контейнера — открыть слой-схему узла по его полному пути
  // (предки + сам узел). Путь строит граф: гость/контейнер — из другой ветки дерева,
  // аппендить к текущему breadcrumb нельзя.
  onEnterNode?: (path: AncestorRef[]) => void;
  onEditNode: (node: AppNode) => void;
  // клик по описанию связи (одиночной или «мастер-стрелке») — список для выбора.
  // Даже одиночная связь открывает «Выберите связь»: оттуда можно дозаписать новую
  // связь в том же направлении, а не городить отдельную стрелку.
  onEdgesChoice: (edges: AppEdge[]) => void;
  // reconnect сохранил новые хэндлы конца стрелки — родитель синхронизирует стейт
  // уровня, чтобы пересчёт раскладки не откатывал их к autoHandles. column — хэндл
  // локального конца (колонка ребра), ghost — гостевого конца (по проекции node_id).
  onEdgeHandlesChanged?: (
    edgeId: string,
    changes: {
      column?: { source_handle?: string; target_handle?: string };
      ghost?: { node_id: string; handle: string };
    },
  ) => void;
  // путь ЛОКАЛЬНОЙ стрелки изменён жестом и сохранён в колонку ребра — родитель
  // синхронизирует стейт уровня теми же waypoints, чтобы пересчёт раскладки их не откатил.
  onEdgeWaypointsChanged?: (edgeId: string, waypoints: EdgePoint[]) => void;
  // то же для ГОСТЕВОЙ стрелки — путь сохранён в пер-уровневый слой (level_edge_waypoints).
  onLevelEdgeWaypointsChanged?: (edgeId: string, waypoints: EdgePoint[], anchorNodeId?: string | null) => void;
  // плашку подписи перетащили вдоль стрелки и доля сохранена в колонку ребра (label_t) —
  // родитель зеркалит в стейт уровня теми же значениями, что вернул бы рефетч.
  onEdgeLabelTChanged?: (edgeId: string, t: number | null) => void;
  // узел перетащили и его позиция сохранена в БД — родитель синхронизирует стейт
  // уровня теми же значениями, чтобы пересчёт раскладки БЕЗ рефетча (напр. локальный
  // setEdges при реконнекте хэндла) не откатил узел на прежнюю сохранённую позицию.
  onNodeMoved?: (
    id: string,
    kind: "block" | "ghost" | "container",
    pos: { pos_x: number; pos_y: number },
  ) => void;
  // отпускание перетянутого из боковой палитры шаблона на схему: shape — выбранная
  // форма, pos — координаты в системе графа (левый-верхний угол узла)
  onDropNode?: (shape: NodeShape, pos: { x: number; y: number }) => void;
  // протянули стрелку от узла sourceId на ЛИСТОВОЙ узел/хэндл targetId — создать связь.
  // Хэндлы из жеста: при дропе на хэндл известны оба, на тело листа — только исходный.
  onCreateEdge?: (
    sourceId: string, targetId: string,
    sourceHandle: string | null, targetHandle: string | null,
  ) => void;
  // протянули стрелку на узел С ДЕТЬМИ (containerId) — открыть выбор его потомка
  // как дальнего конца межуровневой связи (источник — sourceId, его хэндл — sourceHandle)
  onConnectInto?: (
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null,
  ) => void;
  // конец стрелки отпустили на плитку «вне уровня» — открыть выбор дальнего конца
  // из всей схемы (узла, которого нет на текущем холсте)
  onExitUp?: (sourceId: string, sourceHandle: string | null) => void;
  // запрос на удаление узла прямо с канваса (Backspace/Delete по выбранному
  // узлу) — открыть подтверждение со списком связей (как кнопка «Удалить» в
  // модалке узла). Само удаление React Flow отключено (deleteKeyCode=null).
  onRequestDeleteNode?: (node: AppNode) => void;
  // запрос на удаление НЕСКОЛЬКИХ выбранных узлов (Backspace/Delete по рамке
  // выделения) — открыть агрегированное подтверждение (мультиудаление).
  onRequestDeleteNodes?: (nodes: AppNode[]) => void;
  // форма шаблона, который СЕЙЧАС перетаскивают из палитры (null — драга нет).
  // Нужна, чтобы во время dragover показать на схеме превью-рамку будущего узла:
  // dataTransfer.getData в dragover недоступен (только на drop), поэтому форму
  // прокидываем через состояние из TreePage.
  dragShape?: NodeShape | null;
  // Общая история Undo/Redo, поднятая в TreePage: команды перемещений/изломов кладёт
  // сам LevelGraph, а команду удаления — TreePage (удаление инициируется там, в
  // NodeDeleteConfirm). Если не передана (контекст-модалка) — заводим свою локальную.
  history?: History;
  // Дисптчеры Undo/Redo из TreePage: они умеют редиректить на уровень правки перед
  // откатом (кросс-уровневый Undo). Кнопки и клавиши канваса зовут именно их, а не
  // history.undo/redo напрямую. В контекст-модалке не передаются (истории там нет).
  onUndo?: () => void;
  onRedo?: () => void;
  // фоновый («оптимистичный»/компенсирующий) персист правки канваса упал — родитель
  // возвращает зеркало к истине, перезагружая уровень из БД. Без него зеркало и БД
  // молча расходятся при сетевой ошибке/409. В контекст-модалке не нужен (read-only).
  onPersistError?: (e: unknown) => void;
  // "level" (по умолчанию) — обычный уровень; "context" — контекстная схема узла
  // из дерева: фокус-блок без кнопок, координаты не сохраняются.
  mode?: "level" | "context";
  // Выбранный «Вид схемы» (as-is/переход/to-be) — поднят в TreePage (живёт в правой
  // панели). Управляет приглушением узлов/рёбер и легендой. В контексте не применяется
  // (дефолт «переход» — ничего не гасит).
  schemaView?: SchemaView;
  // Запрос «показать на схеме» из индикатора незавершённости (SchemaAlerts → TreePage).
  // TreePage сперва приводит holст к нужному уровню (navigateToLevel), затем кладёт сюда
  // запрос. Холст центрируется на цели и коротко её подсвечивает. token меняется на
  // КАЖДЫЙ клик — повторный клик по тому же объекту снова сфокусирует. Раскладка async,
  // поэтому фокус срабатывает отложенно — как только цель появится в rfNodes/rfEdges.
  locate?: LocateRequest | null;
}

// Запрос фокуса на объекте/связи/группе. ids: для node — [nodeId]; для edge — [edgeId];
// для group — id всех узлов кластера. token — монотонный счётчик из TreePage.
export type LocateRequest = {
  kind: "node" | "edge" | "group";
  ids: string[];
  token: number;
};

function LevelGraphInner({
  nodes,
  ghostNodes,
  levelPositions,
  levelEdgeHandles = EMPTY_LEVEL_HANDLES,
  levelEdgeWaypoints = EMPTY_LEVEL_WAYPOINTS,
  edges,
  depth,
  containerId,
  ancestorNames,
  ancestorIds,
  isArchitect,
  onDrillDown,
  onEnterNode,
  onEditNode,
  onEdgesChoice,
  onEdgeHandlesChanged,
  onEdgeWaypointsChanged,
  onLevelEdgeWaypointsChanged,
  onEdgeLabelTChanged,
  onNodeMoved,
  onDropNode,
  onCreateEdge,
  onConnectInto,
  onExitUp,
  onRequestDeleteNode,
  onRequestDeleteNodes,
  dragShape,
  history: historyProp,
  onUndo,
  onRedo,
  onPersistError,
  mode = "level",
  schemaView = "all",
  locate,
}: LevelGraphProps) {
  const isContext = mode === "context";
  const { screenToFlowPosition, setCenter, fitBounds, getInternalNode } = useReactFlow();
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);

  // Развёрнутые соседние контейнеры (свёрнуты по умолчанию). Эфемерно: сбрасываем
  // при переходе на другой уровень.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс expand-состояния на смену уровня — осознанный reset-on-prop-change
    setExpanded(new Set());
  }, [containerId]);

  const expandContainer = useCallback((id: string) => {
    setExpanded((prev) => new Set(prev).add(id));
  }, []);
  const collapseContainer = useCallback((id: string) => {
    setExpanded((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  // Состояние центральных направляющих магнитного выравнивания (общее для snap-драга
  // и drop-шаблона).
  const { guides, setGuides, clearGuides } = useAlignmentGuides();

  // История Undo/Redo (Ctrl+Z / Ctrl+Shift+Z). На основном канвасе её поднимают в
  // TreePage (туда же кладутся структурные команды и дисптчеры с кросс-уровневым
  // редиректом); ownHistory — фолбэк для контекст-модалки, где истории не нужно.
  const ownHistory = useHistory();
  const baseHistory = historyProp ?? ownHistory;
  // Команды этого канваса (перемещения/изломы/доля/хэндлы) ШТАМПУЕМ текущим containerId,
  // чтобы кросс-уровневый Undo знал, на какой уровень вернуть пользователя перед откатом.
  // Адаптер оборачивает только push; остальные методы — как есть.
  const history = useMemo<History>(
    () => ({
      ...baseHistory,
      push: (cmd) => baseHistory.push({ ...cmd, level: containerId ?? null }),
    }),
    [baseHistory, containerId],
  );
  // Клавиши/кнопки зовут дисптчеры из TreePage (кросс-уровневый редирект). В контекст-
  // модалке дисптчеров нет — там Undo/Redo и так не показываются. Мемоизируем, чтобы не
  // пересоздавать слушатель клавиш на каждый рендер.
  const runUndo = useMemo(() => onUndo ?? (() => { history.undo(); }), [onUndo, history]);
  const runRedo = useMemo(() => onRedo ?? (() => { history.redo(); }), [onRedo, history]);

  // Клавиши Undo/Redo — ГЛОБАЛЬНО на window (не через onKeyDown канваса): у .lg-canvas
  // нет tabIndex, поэтому его onKeyDown срабатывает лишь при фокусе внутри холста, а
  // Ctrl+Z жмут и без выбранного узла (фокус на body). Только архитектор и не контекст
  // (read-only). В полях ввода не перехватываем — там нативная отмена текста.
  useEffect(() => {
    if (!isArchitect || isContext) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = document.activeElement as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); runUndo(); }
      else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); runRedo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isArchitect, isContext, runUndo, runRedo]);


  // Магнитное выравнивание узлов при драге + персист позиции по отпусканию.
  const { handleNodesChange, handleNodeDragStop, handleSelectionDragStop, noteDragStart } = useSnapAlignment({
    rfNodes, onNodesChange, setGuides, isArchitect, isContext, containerId,
    ancestorIds, ancestorNames, onNodeMoved, push: history.push, onPersistError,
  });

  // Жёсткий перенос стрелок между двумя перетаскиваемыми узлами (изломы едут вместе с
  // узлами, а не растягиваются хвостами). См. useGroupEdgeDrag.
  const groupEdgeDrag = useGroupEdgeDrag({ rfEdges, setRfEdges });

  // Живой пересчёт авто-хэндлов локальных стрелок во время драга (WYSIWYG: превью =
  // итог по отпускании). Снимок входов раскладки кладём в ref в конце async-раскладки.
  const liveHandleInputs = useRef<LiveHandleInputs | null>(null);
  const liveDragHandles = useLiveDragHandles({ inputsRef: liveHandleInputs, setRfEdges });

  // Идёт ли драг узлов/рамки выделения. На время драга замораживаем реестр «мостиков»
  // (paused у EdgeJumpProvider): иначе его пересчёт каждый кадр перерисовывал бы ВСЕ
  // рёбра по два прохода — лаги и краш на хаотичном мультидраге многих узлов. Старт —
  // на onNodeDragStart/onSelectionDragStart, сброс — в обёртках над стоп-обработчиками.
  // Те же точки жеста кормят groupEdgeDrag: старт фиксирует базу, drag переносит изломы,
  // стоп персистит их.
  const [dragging, setDragging] = useState(false);
  const handleNodeDragStart = useCallback(
    (_e: MouseEvent, n: RFNode, ns: RFNode[]) => {
      setDragging(true);
      const grp = ns.length > 0 ? ns : [n];
      groupEdgeDrag.begin(grp);
      liveDragHandles.begin(rfNodes); // база позиций всех узлов на старте жеста
      noteDragStart(grp); // фиксируем «старые» позиции для инверсии перемещения
    },
    [groupEdgeDrag, liveDragHandles, rfNodes, noteDragStart],
  );
  const handleSelectionDragStart = useCallback(
    (_e: MouseEvent, ns: RFNode[]) => {
      setDragging(true);
      groupEdgeDrag.begin(ns);
      liveDragHandles.begin(rfNodes);
      noteDragStart(ns);
    },
    [groupEdgeDrag, liveDragHandles, rfNodes, noteDragStart],
  );
  const handleNodeDrag = useCallback(
    (_e: MouseEvent, _n: RFNode, ns: RFNode[]) => { groupEdgeDrag.move(ns); liveDragHandles.move(ns); },
    [groupEdgeDrag, liveDragHandles],
  );
  const handleSelectionDrag = useCallback(
    (_e: MouseEvent, ns: RFNode[]) => { groupEdgeDrag.move(ns); liveDragHandles.move(ns); },
    [groupEdgeDrag, liveDragHandles],
  );
  // Отпускание драга: весь жест (перенос изломов в groupEdgeDrag.end + персист позиций в
  // handleNodeDragStop) сворачиваем в ОДНУ команду истории через beginGroup/commitGroup —
  // иначе мультидраг узлов с изломанными рёбрами между ними давал бы 1+N шагов Undo.
  const handleNodeDragStopP = useCallback(
    (e: MouseEvent, n: RFNode, ns: RFNode[]) => {
      setDragging(false);
      history.beginGroup();
      try {
        liveDragHandles.end();
        groupEdgeDrag.end(ns);
        handleNodeDragStop(e, n, ns);
      } finally {
        history.commitGroup("Перемещение группы");
      }
    },
    [groupEdgeDrag, liveDragHandles, handleNodeDragStop, history],
  );
  const handleSelectionDragStopP = useCallback(
    (e: MouseEvent, ns: RFNode[]) => {
      setDragging(false);
      history.beginGroup();
      try {
        liveDragHandles.end();
        groupEdgeDrag.end(ns);
        handleSelectionDragStop(e, ns);
      } finally {
        history.commitGroup("Перемещение группы");
      }
    },
    [groupEdgeDrag, liveDragHandles, handleSelectionDragStop, history],
  );

  // Удаление выбранного узла с клавиатуры через подтверждение.
  const { handleKeyDown } = useCanvasDelete({
    rfNodes, isArchitect, isContext, onRequestDeleteNode, onRequestDeleteNodes,
  });


  // Персист кастомного пути стрелки (изломы) по отпусканию драга сегмента: локальная —
  // в колонку ребра, гостевая — в пер-уровневый слой. Объявлен до реконнекта: тот при
  // смене хэндла сбрасывает waypoints (пустой массив) — старый путь считался относительно
  // прежних концов и после смены хэндла кривой; дефолтный авто-маршрут корректнее.
  const { commitWaypoints } = useEdgeWaypoints({
    isArchitect, containerId, onEdgeWaypointsChanged, onLevelEdgeWaypointsChanged, onPersistError,
  });

  // Персист позиции плашки (доля label_t) по отпусканию её драга. Доля геометрия-
  // независима → хранится в колонке ребра (одна на ребро, не пер-уровень). У мастер-
  // стрелки путь общий — «размазываем» долю по всем её членам. Зеркалим в стейт уровня.
  const commitLabelT = useCallback(
    (edgeIds: string[], t: number | null) => {
      if (!isArchitect) return;
      for (const edgeId of edgeIds) {
        guardPersist(edgesApi.update(edgeId, { label_t: t }), onPersistError);
        onEdgeLabelTChanged?.(edgeId, t);
      }
    },
    [isArchitect, onEdgeLabelTChanged, onPersistError],
  );

  // Реконнект концов рёбер (смена хэндла на том же узле + персист). commitWaypoints —
  // на смену хэндла дропаем изломы в дефолт, он же восстанавливает старый путь в Undo.
  const {
    handleReconnectStart, handleReconnect, handleReconnectEnd,
    isValidConnection: isValidReconnect, isReconnecting, reconnectBlocked, reconnectChildDrill,
    consumeReconnectClick,
  } = useReconnectHandles({
    setRfEdges, nodes, isArchitect, containerId, onEdgeHandlesChanged,
    commitWaypoints, push: history.push, onPersistError,
  });

  // Классификация узла-цели при протягивании новой связи. Контейнер и узел с детьми —
  // «зона входа» (связь нельзя замкнуть на него самого, это алерт-кейс → выбираем
  // потомка); лист (block без детей или гость) — связываем напрямую; распорка — игнор.
  const resolveTarget = useCallback(
    (id: string): ConnectTarget => {
      const n = rfNodes.find((x) => x.id === id);
      if (!n) return null;
      if (n.type === "container") return { kind: "into", name: (n.data as ContainerData).name };
      if (n.type === "block") {
        const an = (n.data as BlockData).appNode;
        // зона входа — только сервис с детьми; БД/брокер связываем напрямую
        return an.has_children && canHaveChildren(an.shape)
          ? { kind: "into", name: an.name }
          : { kind: "direct" };
      }
      if (n.type === "ghost") return { kind: "direct" };
      return null; // spacer и прочее
    },
    [rfNodes],
  );

  // Создание новой связи протягиванием стрелки (хэндл → напрямую, тело контейнера →
  // выбор потомка).
  const { connecting, handleConnectStart, handleConnect, handleConnectEnd, isValidNewConnection } =
    useEdgeConnect({
      isArchitect, isContext, isReconnecting, resolveTarget,
      onCreate: onCreateEdge, onInto: onConnectInto, onExitUp,
    });

  // Общий isValidConnection для двух потоков: при реконнекте — правила реконнекта
  // (тот же узел), при протягивании новой связи — правила новой связи. Развод по
  // isReconnecting, иначе «новые» правила разрешали бы реконнект на чужой узел.
  const isValidConnection = useCallback(
    (conn: Parameters<typeof isValidReconnect>[0]) =>
      isReconnecting() ? isValidReconnect(conn) : isValidNewConnection(conn),
    [isReconnecting, isValidReconnect, isValidNewConnection],
  );

  // --- «Быстрая связь»: стрелка-кнопка у хэндла предлагает связать с подходящим соседним
  // узлом. enter (навели на стрелку) → подбираем цель и рисуем превью; leave → гасим;
  // activate (клик) → создаём связь через ту же модалку, что и ручное протягивание.
  const [qc, setQc] = useState<{ sourceId: string; sourceHandle: string; side: EdgeSide; frac: number } | null>(null);
  // Кандидат-цель для текущего qc — из геометрии узлов уровня (фикс. размер NODE_W×NODE_H).
  const qcCandidate = useMemo(() => {
    if (!qc) return null;
    const src = rfNodes.find((n) => n.id === qc.sourceId);
    if (!src) return null;
    const cands: QcNode[] = rfNodes
      .filter((n) => n.type !== "spacer" && n.id !== qc.sourceId)
      .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
    return findQuickConnectTarget(
      qc.sourceId, qc.side, qc.frac,
      { id: src.id, x: src.position.x, y: src.position.y }, cands,
    );
  }, [qc, rfNodes]);
  // latest-refs для стабильного activate: handlers кладём в data узлов, и они НЕ должны
  // менять идентичность (иначе пересборка раскладки на каждый ховер). Обновляем в эффекте
  // без зависимостей (как cbRef ниже) — activate читает их в обработчике клика, после рендера.
  const qcRef = useRef(qc);
  const qcCandidateRef = useRef(qcCandidate);
  const onCreateEdgeRef = useRef(onCreateEdge);
  useEffect(() => {
    qcRef.current = qc;
    qcCandidateRef.current = qcCandidate;
    onCreateEdgeRef.current = onCreateEdge;
  });
  const quickConnectHandlers = useMemo<QuickConnectHandlers>(() => ({
    enter: (sourceId, sourceHandle, side, frac) => setQc({ sourceId, sourceHandle, side, frac }),
    leave: () => setQc(null),
    activate: () => {
      const q = qcRef.current, c = qcCandidateRef.current;
      setQc(null);
      if (q && c) onCreateEdgeRef.current?.(q.sourceId, c.targetId, q.sourceHandle, c.targetHandle);
    },
  }), []);

  // Стабилизируем массив id предков ПО ЗНАЧЕНИЮ: родители отдают новый массив с тем
  // же содержимым на каждый рендер, а пересчитывать раскладку (и сбрасывать драг/
  // выделение) нужно только при реальной смене breadcrumb. Раньше эту роль играл
  // костыль `ancestorIds.join("|")` в deps отключённого эффекта.
  const ancestorKey = ancestorIds.join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- зависим от значения (ancestorKey), а не от ссылки массива
  const stableAncestorIds = useMemo(() => ancestorIds, [ancestorKey]);

  // Колбэки-данные узлов (drill-down/edit/expand) держим в ref: это НЕ вход
  // вычисления раскладки, а нагрузка, которую узел вызовет позже. Родители отдают их
  // нестабильными (новые функции каждый рендер); будь они зависимостями сборки,
  // массив rfNodes пересоздавался бы на каждый рендер родителя и сбрасывал выделение/
  // драг. Через ref сборка зависит только от данных — без широкого eslint-disable.
  // Открыть список связей по их членам — всегда через «Выберите связь», даже для
  // одиночной связи: так в модалке доступна кнопка «Добавить связь» (дозапись новой
  // связи того же направления). Общая логика для клика по линии (там, где он доходит)
  // и по плашке с описанием (триггер на основной схеме, т.к. клик по линии
  // перехватывают грипы изломов).
  const openEdgeMembers = useCallback(
    (memberIds: string[]) => {
      const members = memberIds
        .map((mid) => edges.find((e) => e.id === mid))
        .filter((e): e is AppEdge => e != null);
      if (members.length === 0) return;
      onEdgesChoice(members);
    },
    [edges, onEdgesChoice],
  );

  // Персист засева владения (own-on-first-render): гость без сохранённой позиции
  // получает её навсегда. Применяет интент seed-ghost-positions конвейера через cbRef
  // (latest-ref), чтобы не тащить containerId/isArchitect/колбэки в зависимости эффекта
  // раскладки. Зеркало (onNodeMoved) кладёт абсолют в levelPositions → следующий рендер
  // видит absolute и засев его пропускает. Только архитектор и основной канвас.
  const migrateGhostPositions = useCallback(
    (seeds: { id: string; entityKind: "ghost" | "container"; pos_x: number; pos_y: number }[]) => {
      if (!isArchitect || !containerId) return;
      for (const m of seeds) {
        const abs = { pos_x: m.pos_x, pos_y: m.pos_y };
        guardPersist(nodesApi.saveGhostPosition(containerId, m.id, abs), onPersistError);
        onNodeMoved?.(m.id, m.entityKind, abs);
      }
    },
    [isArchitect, containerId, onNodeMoved, onPersistError],
  );

  // Персист приобретения якоря изломом: абсолютный путь к потомку раскрытой рамки → офсет от
  // узла-якоря с явным anchor_node_id (Ф3) — зеркало migrateGhostPositions для пути. На экране
  // излом не двигается; дальше он едет с узлом по идентичности и гаснет при его сворачивании.
  const migrateLevelWaypoints = useCallback(
    (migrations: { edge_id: string; anchor_node_id: string; waypoints: EdgePoint[] }[]) => {
      if (!isArchitect || !containerId) return;
      for (const m of migrations) {
        guardPersist(nodesApi.saveEdgeWaypoints(containerId, m.edge_id, m.waypoints, m.anchor_node_id), onPersistError);
        onLevelEdgeWaypointsChanged?.(m.edge_id, m.waypoints, m.anchor_node_id);
      }
    },
    [isArchitect, containerId, onLevelEdgeWaypointsChanged, onPersistError],
  );

  const cbRef = useRef({ onDrillDown, onEnterNode, onEditNode, expandContainer, commitWaypoints, commitLabelT, openEdgeMembers, pushHistory: history.push, migrateGhostPositions, migrateLevelWaypoints, quickConnect: quickConnectHandlers });
  // Канонический latest-ref: обновляем cbRef.current в эффекте БЕЗ зависимостей (после
  // каждого рендера). Объявлен ДО эффекта сборки ниже — порядок исполнения эффектов =
  // порядок объявления, поэтому сборка читает уже свежий cbRef.current. Поведенчески
  // ноль: и события узлов, и эффекты исполняются после рендера.
  useEffect(() => {
    cbRef.current = { onDrillDown, onEnterNode, onEditNode, expandContainer, commitWaypoints, commitLabelT, openEdgeMembers, pushHistory: history.push, migrateGhostPositions, migrateLevelWaypoints, quickConnect: quickConnectHandlers };
  });

  // Раскладка вида: ВЕСЬ конвейер (проекция гостей → слияние мастеров → ELK/контекст →
  // кольца → разведение → keep-out → изломы → A10 → роутер → плашки → детуры → nudge)
  // живёт чистым модулем graph/layout/pipeline (computeViewLayout) — здесь только вызов.
  // Считаем в ASYNC-эффекте: движок ELK асинхронный, поэтому результат не может жить в
  // useMemo рендера. Эффект перезапускается только при смене ДАННЫХ раскладки (не при
  // драге/выделении — те идут в контролируемый стейт RF), поэтому интерактив сохраняется.
  // Предыдущий layout держим до резолва нового (не сбрасываем в null) — нет мигания.
  // Конвейер НЕ пишет в БД: побочные записи (засев владения, миграции якорей изломов)
  // приходят интентами и применяются здесь же — только если прогон не устарел (cancelled).
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { layout: next, liveInputs, intents } = await computeViewLayout({
        nodes, ghostNodes, edges, levelPositions, levelEdgeHandles, levelEdgeWaypoints,
        ancestorIds: stableAncestorIds, expanded, isContext,
      });
      if (cancelled) return; // устаревший прогон: ни снапшота, ни персиста интентов
      liveHandleInputs.current = liveInputs;
      for (const intent of intents) {
        if (intent.kind === "seed-ghost-positions") cbRef.current.migrateGhostPositions(intent.seeds);
        else cbRef.current.migrateLevelWaypoints(intent.migrations);
      }
      setLayout(next);
    })();
    return () => { cancelled = true; };
    // levelEdgeWaypoints не влияет на позиции/хэндлы, НО включён в зависимости намеренно:
    // гостевые изломы читает эффект-сборщик ниже, и он должен работать с ОДНИМ снапшотом
    // (layout). Иначе при реконнекте гостя смена хэндла (async-раскладка) и сброс изломов
    // (sync-стейт) рассинхронятся: сборщик сработал бы со старым layout → ребро прыгнуло бы
    // на исходный хэндл. Прогон через раскладку гарантирует свежий layout у сборщика.
  }, [nodes, ghostNodes, levelPositions, levelEdgeHandles, levelEdgeWaypoints, edges, isContext, expanded, stableAncestorIds]);

  // Сборка RF-узлов/рёбер из раскладки и синхронизация в контролируемый стейт RF.
  // Стейт нужен мутабельным: onNodesChange/onEdgesChange пишут туда драг и выделение
  // МЕЖДУ пересчётами. Эффект срабатывает ровно тогда же, когда раньше — при смене
  // данных раскладки / isArchitect / depth, — поэтому интерактив сохраняется. Колбэки
  // берём из ref (см. cbRef), потому в зависимостях только данные.
  useEffect(() => {
    if (!layout) return; // первый рендер до резолва async-раскладки
    // nodes берём ИЗ layout (снимок, по которому он посчитан), а не из пропа — чтобы
    // позиции и данные узлов были согласованы и эффект не срабатывал со старым layout
    // при смене пропа nodes до резолва async-ELK (иначе узел прыгал на исходную позицию).
    const { nodes: layoutNodes, entities, positions, edgeHandles, edgeShelves, edgeLoops, autoRoutes, labelPlacements, levelWaypoints, groupArr, spacers } = layout;
    const cb = cbRef.current;
    // локальные узлы уровня — у редактируемой жестом стрелки оба конца должны быть
    // локальны (waypoints в координатах этого уровня; гость/контейнер — чужая система)
    const localIds = new Set(layoutNodes.map((n) => n.id));
    // Статус каждой ОТОБРАЖАЕМОЙ сущности (для цвета рёбер и фильтра вида). Блок —
    // свой status; гость-лист — статус реального узла; свёрнутый контейнер статуса
    // не носит → existing. Ключ — id отображаемой сущности (как в g.source/g.target).
    const statusOf = new Map<string, NodeStatus>();
    for (const n of layoutNodes) statusOf.set(n.id, n.status);
    for (const ent of entities) {
      statusOf.set(ent.id, ent.kind === "leaf" ? ent.ghost.status : "existing");
    }
    // Самый «сильный» статус конца ребра: deprecated > planned > existing.
    const edgeStatus = (s: string, t: string): NodeStatus => {
      const a = statusOf.get(s) ?? "existing";
      const b = statusOf.get(t) ?? "existing";
      if (a === "deprecated" || b === "deprecated") return "deprecated";
      if (a === "planned" || b === "planned") return "planned";
      return "existing";
    };
    // Приглушён ли узел статуса st фильтром вида (в контексте фильтра нет). Скрытый
    // узел НЕ удаляем — гасим opacity, сохраняя пространственную память раскладки.
    const dimNode = (st: NodeStatus): boolean => !isContext && !viewShows(schemaView, st);
    setRfNodes([
      ...layoutNodes.map((n) => ({
        id: n.id,
        type: "block" as const,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        ...(dimNode(n.status) ? { style: DIM_STYLE } : null),
        data: {
          appNode: n,
          onDrillDown: cb.onDrillDown,
          isArchitect,
          colors: getNodeColors(n.is_external, depth, n.status),
          hideActions: isContext,
          connectable: isArchitect && !isContext,
          quickConnect: isArchitect && !isContext ? cb.quickConnect : undefined,
        } satisfies BlockData,
      })),
      ...entities.map((ent) => {
        const position = positions.get(ent.id) ?? { x: 0, y: 0 };
        if (ent.kind === "leaf") {
          return {
            id: ent.id,
            type: "ghost" as const,
            position,
            ...(dimNode(ent.ghost.status) ? { style: DIM_STYLE } : null),
            data: {
              appNode: ent.ghost,
              colors: getNodeColors(ent.ghost.is_external, ent.ghost.node_depth, ent.ghost.status),
              connectable: isArchitect && !isContext,
              quickConnect: isArchitect && !isContext ? cb.quickConnect : undefined,
              // в контекст-режиме навигация по слоям отключена (схема — внутри модалки).
              // Путь гостя = его предки + он сам (другая ветка дерева).
              onEnter: isContext
                ? undefined
                : () => cb.onEnterNode?.([...(ent.ghost.ancestors ?? []), { id: ent.ghost.id, name: ent.ghost.name, is_external: ent.ghost.is_external }]),
            } satisfies GhostData,
          };
        }
        return {
          id: ent.id,
          type: "container" as const,
          position,
          data: {
            id: ent.id,
            name: ent.name,
            depth: ent.depth,
            ancestors: ent.ancestors,
            colors: getNodeColors(ent.is_external, ent.depth),
            onExpand: cb.expandContainer,
            // Путь контейнера = его предки + он сам. Контейнер всегда промежуточный.
            onEnter: isContext
              ? undefined
              : () => cb.onEnterNode?.([...ent.ancestors, { id: ent.id, name: ent.name, is_external: ent.is_external }]),
            connectable: isArchitect && !isContext,
            quickConnect: isArchitect && !isContext ? cb.quickConnect : undefined,
          } satisfies ContainerData,
        };
      }),
      ...spacers,
    ]);

    setRfEdges(
      groupArr.map((g) => {
        const h = edgeHandles.get(g.id);
        const isMaster = g.members.length > 1;
        const single = g.members[0];
        const singleText = [single.label, single.technology].filter(Boolean).join(" · ") || undefined;
        const data: WrappedEdgeData = isMaster
          ? { items: g.members.map((m) => edgeText(m)), memberIds: g.members.map((m) => m.id) }
          : { label: singleText, memberIds: [single.id] };
        // Кастомный путь (изломы): архитектор, не контекст. Мастер-стрелка тоже
        // редактируется — путь общий для всех её членов (одна линия), поэтому читаем
        // у первого члена с геометрией, а коммит «размазываем» по всем memberIds.
        // Локальная (оба конца на уровне) — путь в колонке ребра; гостевая/сквозная —
        // в пер-уровневом слое (geometry уникальна для уровня). bothLocal разводит и
        // источник waypoints, и слой коммита. Гость возможен только при containerId != null.
        const bothLocal = localIds.has(g.source) && localIds.has(g.target);
        const editable = isArchitect && !isContext && (bothLocal || containerId != null);
        if (editable) {
          const memberIds = g.members.map((m) => m.id);
          // гостевой путь — из РЕКОНСТРУИРОВАННОГО снимка (владеемой группы = anchorG +
          // офсет, ТЗ D8), а не из сырого пропа: иначе изломы не ехали бы за рамкой
          const wpOf = (m: AppEdge) => (bothLocal ? m.waypoints : levelWaypoints[m.id]);
          const rep = g.members.find((m) => { const w = wpOf(m); return w != null && w.length > 0; });
          data.editable = true;
          data.waypoints = (rep ? wpOf(rep) : undefined) ?? undefined;
          // «Старые» геометрия/доля на момент сборки = последнее закоммиченное значение
          // (драг-превью живёт в локальном стейте edges.tsx и сюда не доходит). Это и есть
          // состояние для инверсии. undefined-путь инвертируется пустым массивом (сброс в авто).
          const oldWp = data.waypoints;
          const oldT = g.members.find((m) => m.label_t != null)?.label_t ?? null;
          data.onWaypointsCommit = (wp) => {
            cb.commitWaypoints(memberIds, wp, !bothLocal);
            cb.pushHistory({
              label: "Изменение пути связи",
              undo: () => cb.commitWaypoints(memberIds, oldWp ?? [], !bothLocal),
              redo: () => cb.commitWaypoints(memberIds, wp, !bothLocal),
            });
          };
          // Перетаскивание плашки доступно только архитектору (editable) — коммит доли
          // «размазываем» по всем членам мастер-стрелки (путь у них общий).
          data.onLabelTCommit = (t) => {
            cb.commitLabelT(memberIds, t);
            cb.pushHistory({
              label: "Перемещение подписи",
              undo: () => cb.commitLabelT(memberIds, oldT),
              redo: () => cb.commitLabelT(memberIds, t),
            });
          };
        }
        // Позиция плашки (доля label_t) — общая для членов; читаем у первого с
        // сохранённой долей. Ставим и viewer'у (отображение сдвига), не только редактору.
        // null → центр. Контекст-полки долю игнорируют (своя геометрия плашки).
        if (!isContext) {
          const lt = g.members.find((m) => m.label_t != null)?.label_t;
          if (lt != null) data.labelT = lt;
        }
        // Триггер детализации связи на плашке с описанием (клик по линии на основной схеме
        // перехватывают грипы изломов). В контексте схема только для просмотра — не вешаем.
        if (!isContext) data.onOpenDetails = () => cb.openEdgeMembers(data.memberIds);
        if (!isContext) {
          // Авто-маршрут (R1+R3): ставим, если для этой группы он посчитан (не customized).
          // edges.tsx рисует его ортоломаной с минимумом пересечений.
          const ar = autoRoutes?.get(g.id);
          if (ar) data.autoRoute = ar;
          // Авто-размещение плашки (R2+R4): центр/якорь/режим. edges.tsx ставит плашку в
          // center, а в режиме leader рисует поводок center↔anchor.
          const lp = labelPlacements?.get(g.id);
          if (lp) data.labelPlacement = lp;
        }
        // в контекст-схеме ограничиваем ширину плашки — зазор колонок рассчитан под неё —
        // и кладём подпись на приузловую полку (shelf), если раскладка её посчитала
        if (isContext) {
          data.maxWidth = CTX_LABEL_W;
          const lp = edgeLoops?.get(g.id);
          const sh = edgeShelves?.get(g.id);
          if (lp) data.loop = lp;       // не родная стрелка bidi — обход
          else if (sh) data.shelf = sh; // родная/обычная — приузловая полка
        }
        // Цвет ребра по статусу сильнейшего конца; deprecated — пунктир («связь уходит»).
        const est = edgeStatus(g.source, g.target);
        const eColor = STATUS_META[est].edge;
        // Приглушаем ребро, если приглушён ЛЮБОЙ его конец (фильтр вида).
        const eDimmed = dimNode(statusOf.get(g.source) ?? "existing")
          || dimNode(statusOf.get(g.target) ?? "existing");
        if (eDimmed) data.dimmed = true;
        return {
          id: g.id,
          source: g.source,
          target: g.target,
          sourceHandle: h?.sourceHandle,
          targetHandle: h?.targetHandle,
          type: "wrapped",
          data,
          markerEnd: { type: MarkerType.ArrowClosed, color: eColor },
          style: {
            stroke: eColor,
            strokeWidth: 1.5,
            ...(est === "deprecated" ? { strokeDasharray: "6 4" } : null),
            ...(eDimmed ? { opacity: 0.12 } : null),
          },
          // хэндл мастер-стрелки общий для всех членов — реконнект фанаутит его на все
          // (смена узла-конца по-прежнему запрещена в handleReconnect: правится только хэндл)
          reconnectable: isArchitect,
        };
      })
    );
    // Гостевой путь сборка читает из layout.levelWaypoints (реконструированный снимок D8),
    // а НЕ из сырого пропа levelEdgeWaypoints: последний входит в зависимости раскладки выше
    // → его правка даёт новый layout (со свежим levelWaypoints), и сборка идёт со СВЕЖИМ
    // снапшотом. Прямой триггер сборки по сырому пропу откатывал бы хэндл гостя при реконнекте.
  }, [layout, isArchitect, depth, isContext, containerId, schemaView, setRfNodes, setRfEdges]);

  // Перетаскивание шаблона узла из палитры: превью-рамка + создание узла на drop.
  const { dropPreview, handleDragOver, handleDragLeave, handleDrop } = useTemplateDrop({
    rfNodes, screenToFlowPosition, setGuides, clearGuides,
    isArchitect, isContext, onDropNode, dragShape,
  });

  // Одиночный клик по связи — только штатное выделение React Flow (мету больше не
  // открывает). Сохраняем обработчик, чтобы гасить клик-эхо после жеста реконнекта.
  const handleEdgeClick = useCallback(
    () => { consumeReconnectClick(); },
    [consumeReconnectClick]
  );

  // Двойной клик — единственный триггер меты (правая панель). По узлу: только локальный
  // блок (как и снятая кнопка «Подробнее»; гость/контейнер не правим, контекст read-only).
  const handleNodeDoubleClick = useCallback(
    (_e: MouseEvent, rfNode: RFNode) => {
      if (isContext || rfNode.type !== "block") return;
      const appNode = (rfNode.data as BlockData | undefined)?.appNode;
      if (appNode) cbRef.current.onEditNode(appNode);
    },
    [isContext]
  );
  // По связи: тот же путь, что у плашки (openEdgeMembers → одна связь сразу в панель,
  // несколько — выбор участника, см. TreePage). Гасим клик-эхо реконнекта и на double.
  const handleEdgeDoubleClick = useCallback(
    (_e: MouseEvent, rfEdge: RFEdge) => {
      if (isContext) return;
      if (consumeReconnectClick()) return;
      const memberIds = (rfEdge.data as WrappedEdgeData | undefined)?.memberIds ?? [];
      cbRef.current.openEdgeMembers(memberIds);
    },
    [isContext, consumeReconnectClick]
  );

  // «Показать на схеме» (locate): центрируем холст на цели и коротко её подсвечиваем.
  // Раскладка асинхронна, а при кросс-уровневом переходе холст ещё и ремаунтится —
  // поэтому эффект зависит от rfNodes/rfEdges и срабатывает ОТЛОЖЕННО: ждёт, пока цель
  // появится на холсте, после чего по token фиксирует обработку (повторно не дёргает).
  const locateHandledRef = useRef(0);
  useEffect(() => {
    if (!locate || locate.token === locateHandledRef.current) return;

    // Абсолютный прямоугольник узла по id (позиция графа + измеренный размер).
    const rectOf = (id: string): { x: number; y: number; w: number; h: number } | null => {
      const n = rfNodes.find((x) => x.id === id);
      if (!n) return null;
      const internal = getInternalNode(id);
      const pos = internal?.internals.positionAbsolute ?? n.position;
      const w = internal?.measured?.width ?? (typeof n.width === "number" ? n.width : NODE_W);
      const h = internal?.measured?.height ?? (typeof n.height === "number" ? n.height : NODE_H);
      return { x: pos.x, y: pos.y, w, h };
    };

    // Собираем прямоугольники цели. Для связи — оба её конца (через rfEdge).
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    if (locate.kind === "edge") {
      const e = rfEdges.find((x) => x.id === locate.ids[0]);
      if (!e) return; // ребро ещё не собрано — ждём следующего прогона
      for (const id of [e.source, e.target]) {
        const r = rectOf(id);
        if (r) rects.push(r);
      }
    } else {
      for (const id of locate.ids) {
        const r = rectOf(id);
        if (r) rects.push(r);
      }
    }
    if (rects.length === 0) return; // ни одной цели ещё нет на холсте — ждём раскладку

    locateHandledRef.current = locate.token;

    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    if (rects.length === 1) {
      // одиночный узел — центрируем чуть крупнее обычного fitView (привлечь внимание)
      setCenter(minX + (maxX - minX) / 2, minY + (maxY - minY) / 2, { zoom: 1.2, duration: 600 });
    } else {
      // связь/группа — вписываем bbox целей с запасом
      fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, { padding: 0.4, duration: 600 });
    }

    // Подсветка — прямо на DOM-элементах xyflow (узлы и рёбра несут data-id), чтобы не
    // ввязывать пересборку rfNodes из async-раскладки. Класс снимаем по таймеру.
    const sel = locate.kind === "edge"
      ? `.react-flow__edge[data-id="${CSS.escape(locate.ids[0])}"]`
      : locate.ids.map((id) => `.react-flow__node[data-id="${CSS.escape(id)}"]`).join(",");
    const raf = requestAnimationFrame(() => {
      const els = sel ? Array.from(document.querySelectorAll(sel)) : [];
      for (const el of els) el.classList.add("lg-locate-flash");
      window.setTimeout(() => {
        for (const el of els) el.classList.remove("lg-locate-flash");
      }, 2200);
    });
    return () => cancelAnimationFrame(raf);
  }, [locate, rfNodes, rfEdges, getInternalNode, setCenter, fitBounds]);

  // Контекст-схема без фокус-узла не бывает — защитно ничего не рисуем. Обычный
  // уровень рендерим даже пустым: тогда сразу видна канва (точки) и в неё можно
  // дропнуть первый узел, а зум остаётся «отдалённым» (defaultViewport ниже),
  // без скачка к гигантскому fitView на единственном узле.
  const hasGraphContent = nodes.length + ghostNodes.length > 0;
  if (isContext && !hasGraphContent) return null;

  return (
    <div
      // lg-canvas--editable — раскрытие хэндлов по ховеру (архитектор, не контекст);
      // lg-canvas--connecting — подсветка «зон входа» (узлов с детьми) во время
      // протягивания новой связи.
      className={
        "lg-canvas" +
        (isArchitect && !isContext ? " lg-canvas--editable" : "") +
        (connecting ? " lg-canvas--connecting" : "") +
        // реконнект над не родным узлом: запрещающий курсор + гасим подсветку хэндлов
        (reconnectBlocked ? " lg-canvas--reconnect-blocked" : "")
      }
      style={{ position: "relative", flex: 1, minHeight: 0, border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
      // ПКМ панорамирует холст — гасим браузерное контекст-меню, чтобы оно не
      // выскакивало при правом клике/перетаскивании по канвасу.
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Тулбар Undo/Redo (архитектор, не контекст). Кнопка надёжнее клавиш — не зависит
          от фокуса. Обе зовут дисптчеры из TreePage (кросс-уровневый редирект). */}
      {isArchitect && !isContext && (
        <div style={{ position: "absolute", top: 14, left: 14, zIndex: 5 }}>
          <div className="lg-seg">
            <button
              type="button"
              onClick={runUndo}
              disabled={!history.canUndo()}
              title="Отменить · Ctrl+Z"
              aria-label="Отменить"
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              onClick={runRedo}
              disabled={!history.canRedo()}
              title="Вернуть · Ctrl+Shift+Z"
              aria-label="Вернуть"
            >
              <RedoIcon />
            </button>
          </div>
        </div>
      )}
      {/* Легенда статусов и переключатель «Вид схемы» живут в правой панели схемы
          (TreePage → ObjectInspector); оверлея на холсте больше нет. */}
      {/* Тост «нельзя привязать к чужому узлу» — только архитектору (реконнект его
          прерогатива). Рендерим всегда (за экраном при !blocked), чтобы проигрывалась
          анимация уезда; position:fixed не обрезается overflow:hidden канваса. */}
      {isArchitect && !isContext && <ReconnectBlockedToast visible={reconnectBlocked} />}
      {/* Тост «нельзя привязать к дочернему объекту» — конец завис над зоной входа
          своего узла-родителя (явная попытка провалить связь вглубь). Тот же компонент,
          вариант child. Взаимоисключающ с foreign-тостом (свой узел vs чужой). */}
      {isArchitect && !isContext && <ReconnectBlockedToast visible={reconnectChildDrill} variant="child" />}
      {/* Плитка «вне уровня»: полоса у верхнего края холста, видна только при
          протягивании НОВОЙ связи на не-корневом уровне. Отпустил на неё конец
          стрелки → выбор дальнего конца из всей схемы (useEdgeConnect ловит дроп по
          data-exit-up). Не объект графа, а элемент интерфейса. */}
      {connecting && containerId && (
        <div className="lg-exit-up" data-exit-up>
          <span className="lg-exit-up-node">
            <span className="lg-exit-up-ico" aria-hidden>
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19 V5" />
                <path d="M6 11 L12 5 L18 11" />
              </svg>
            </span>
            Объект вне уровня
          </span>
        </div>
      )}
      {/* Реестр «мостиков»: рёбра внутри ReactFlow публикуют сюда геометрию и читают
          точки прыжков. Выключен в контекст-схеме (read-only звезда). */}
      <EdgeJumpProvider enabled={!isContext} paused={dragging}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeClick={handleEdgeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStopP}
        onSelectionDragStart={handleSelectionDragStart}
        onSelectionDrag={handleSelectionDrag}
        onSelectionDragStop={handleSelectionDragStopP}
        onReconnectStart={handleReconnectStart}
        onReconnect={handleReconnect}
        onReconnectEnd={handleReconnectEnd}
        // Создание новой связи протягиванием от хэндла узла. RF шлёт onConnect* И при
        // реконнекте существующего ребра, поэтому useEdgeConnect latch'ит реконнект
        // (isReconnecting) и глушит свой поток — иначе отпускание перетянутого конца
        // ВНУТРИ узла открывало бы поповер новой связи. onConnect ловит защёлку конца
        // на ХЭНДЛ (в радиусе connectionRadius) → прямая связь к узлу; onConnectEnd —
        // дроп мимо хэндлов → «зона входа» (тело контейнера) или прямая связь (тело листа).
        onConnectStart={handleConnectStart}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        // прощающий радиус защёлки конца на хэндл: попасть в периметр-хэндл узла
        // легко, при этом центр тела (≥ полширины узла от хэндлов) остаётся «зоной входа»
        connectionRadius={30}
        connectionMode={ConnectionMode.Loose}
        reconnectRadius={20}
        // Своя превью-линия с наконечником (см. ConnectionLine): дефолтная RF-линия
        // рисуется без стрелки, из-за чего при драге конца казалось, что связь
        // развёрнута не в ту сторону.
        connectionLineComponent={ConnectionLine}
        // Своё удаление через подтверждение (handleKeyDown) — встроенное отключаем,
        // иначе Backspace сносил бы узел и связи без предупреждения.
        deleteKeyCode={null}
        // На непустом уровне фитим контент, но не зумим ближе 0.85 — иначе вход на
        // разреженный уровень (1–2 узла) подлетал вплотную, мешая добавлять объекты.
        fitView={hasGraphContent}
        fitViewOptions={{ padding: 0.2, maxZoom: 0.85 }}
        // Пустой уровень (fitView выключен) открывается слегка отдалённым — комфортно
        // бросить первый узел, не отъезжая вручную.
        defaultViewport={{ x: 60, y: 60, zoom: 0.85 }}
        // Контекст-схема — read-only: раскладка предписана (фокус+звезда), drag
        // ничего не сохраняет и только «отщёлкивал» бы узел назад. На обычном
        // уровне узлы таскаем (персист координат архитектором).
        nodesDraggable={!isContext}
        // nodesConnectable=true нужен и для превью-линии reconnect, и для
        // протягивания НОВОЙ связи от хэндла (рендер connection line гейтится этим
        // флагом). Начать связь можно только с хэндла, у которого isConnectableStart
        // (его выставляем лишь архитектору вне контекст-режима — см. nodes.tsx).
        nodesConnectable
        // Навигация и выделение: холст панорамируем ПРАВОЙ кнопкой мыши (код 2),
        // ЛЕВАЯ кнопка тянет рамку прямоугольного выделения нескольких узлов
        // (selectionOnDrag). Ctrl/⌘ добавляет/убирает узлы из выделения кликом.
        // SelectionMode.Partial — в выделение попадают и узлы, задетые рамкой
        // частично. В контекст-схеме (read-only) выделять нечего — там оставляем
        // привычное панорамирование левой кнопкой и выключаем рамку.
        panOnDrag={isContext ? true : [2]}
        selectionOnDrag={!isContext}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={["Control", "Meta"]}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e5e7eb" />
        <Controls />
        {/* Границы уровней: вложенные рамки вокруг локальных узлов — по одной на
            каждого родителя из breadcrumb. Только на не-корневых уровнях. */}
        {containerId && ancestorIds.length > 0 && (
          <ViewportPortal>
            <LevelBoundary
              rfNodes={rfNodes}
              ancestorIds={ancestorIds}
              ancestorNames={ancestorNames}
              expanded={expanded}
              onCollapse={collapseContainer}
            />
          </ViewportPortal>
        )}
        {(guides.x != null || guides.y != null || guides.spacing.length > 0) && (
          <ViewportPortal>
            <AlignmentGuides x={guides.x} y={guides.y} spacing={guides.spacing} />
          </ViewportPortal>
        )}
        {/* Превью будущего узла: пустая рамка-форма с прозрачным телом. В
            ViewportPortal координаты — в системе графа, поэтому рамка масштабируется
            вместе с зумом (как реальный узел) и показывает точное место создания. */}
        {dropPreview && (
          <ViewportPortal>
            <div
              style={{
                position: "absolute",
                left: dropPreview.x,
                top: dropPreview.y,
                width: NODE_W,
                height: NODE_H,
                pointerEvents: "none",
                zIndex: 5,
                opacity: 0.85,
              }}
            >
              <NodeShapeSvg shape={dropPreview.shape} bg="transparent" stroke="#475569" outline />
            </div>
          </ViewportPortal>
        )}
        {/* Превью «быстрой связи»: автоопределённая стрелка от хэндла к соседу. Гасим во
            время ручного протягивания (connecting), чтобы превью не накладывались. */}
        {qcCandidate && !connecting && (
          <ViewportPortal>
            <QuickConnectPreview points={qcCandidate.points} />
          </ViewportPortal>
        )}
      </ReactFlow>
      </EdgeJumpProvider>
    </div>
  );
}

// useReactFlow (screenToFlowPosition для дропа шаблонов) требует контекст
// ReactFlowProvider выше самого <ReactFlow>, поэтому оборачиваем им внутренний компонент.
export default function LevelGraph(props: LevelGraphProps) {
  return (
    <ReactFlowProvider>
      <LevelGraphInner {...props} />
    </ReactFlowProvider>
  );
}
