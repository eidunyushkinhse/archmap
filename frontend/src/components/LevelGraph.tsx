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
import { nodesApi, viewsApi } from "../api/nodes";
import type { Node as AppNode, GhostNode, Edge as AppEdge, NodeShape, NodeStatus, AncestorRef, ViewLayout, ViewLayoutPayload, EdgePoint } from "../types";
import { canHaveChildren, bundleKey } from "../types";
import {
  NODE_W, NODE_H,
  CTX_LABEL_W,
  EDGE_MANUAL_LAYOUT,
} from "./graph/constants";
import type {
  WrappedEdgeData,
  BlockData, GhostData, ContainerData, FrameData,
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
import { absPositionOf } from "./graph/absPos";
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

// Стабильный пустой дефолт для viewLayout: дефолт-параметр `= {}` создавал бы
// НОВЫЙ объект на каждый рендер, а он — зависимость async-эффекта раскладки → лишний
// перезапуск ELK и мигание. Один модульный объект держит ссылку стабильной.
const EMPTY_VIEW_LAYOUT: ViewLayout = {};

// Стиль приглушения узла, скрытого фильтром «Вид схемы» (мгновенно, без transition —
// см. ТЗ: fade на opacity в наших прогонах вёл себя нестабильно).
const DIM_STYLE = { opacity: 0.12, pointerEvents: "none" as const };

interface LevelGraphProps {
  nodes: AppNode[];
  // реестр не-локальных концов рёбер уровня (R2): гости И глубокие концы внутри
  // поддерева, с цепочками предков. Проекцию на видимые сущности делает конвейер.
  // В контекст-режиме сюда передаются соседи фокуса (пре-спроецированные сервером).
  endpoints: GhostNode[];
  // раскладка вида как есть (R3, единое хранилище view_layout): item_id → payload.
  // Позиции — по id сущности (локалы/гости/контейнеры единообразно), геометрия
  // рёбер — по ключу пучка "b:<src>><tgt>". Контекст-схема раскладку не хранит — {}.
  viewLayout?: ViewLayout;
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
  // Раскладка вида изменена и сохранена (батч view_layout: позиции узлов и/или
  // геометрия пучков; null — строка удалена) — родитель зеркалит те же значения в
  // свой стейт, чтобы пересчёт раскладки без рефетча их не откатил. ЕДИНСТВЕННЫЙ
  // канал зеркалирования раскладки (R3; заменил пять прежних колбэков).
  onLayoutChanged?: (items: Record<string, ViewLayoutPayload | null>) => void;
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
  endpoints,
  viewLayout = EMPTY_VIEW_LAYOUT,
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
  onLayoutChanged,
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
  const { screenToFlowPosition, setCenter, fitBounds, getInternalNode, getNodes } = useReactFlow();
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
  // РЕАЛЬНЫЕ габариты узлов (node.measured — v12 пишет их в контролируемый стейт через
  // onNodesChange 'dimensions'). Паттерн render→measure→layout (V2.2b): при смене
  // СИГНАТУРЫ размеров (не позиций/выделения!) перезапускаем раскладку — стадии качества
  // стрелок получают настоящие тела вместо фолбэка NODE_W×NODE_H. useNodesInitialized не
  // годится: флипается до публикации замеров (xyflow#4202). Петли нет: пере-раскладка
  // размеров не меняет → сигнатура стабильна → второго перезапуска не будет.
  // РЕАЛЬНЫЕ габариты узлов для стадий качества стрелок (V2.2b). Размеры только
  // НАКАПЛИВАЮТСЯ: сборка пересоздаёт RF-узлы без measured (замер доезжает отдельным
  // 'dimensions'-событием позже) — сигнатура «полный↔неполный набор» мигала бы и
  // бесконечно перезапускала раскладку. Запись живёт, пока узел не перемеряется ИНАЧЕ;
  // исчезновение узла записи не трогает (устаревшие безвредны — конвейер смотрит по id).
  const nodeSizesRef = useRef<Record<string, { w: number; h: number }>>({});
  const [sizesVersion, setSizesVersion] = useState(0);

  // ЕДИНАЯ запись раскладки вида (R3): merge-патч поверх зеркала viewLayout →
  // батч-PUT view_layout + зеркало родителю (onLayoutChanged). Сервер заменяет
  // payload строки ЦЕЛИКОМ, поэтому частичный патч мержится здесь; null-патч —
  // удалить строку (сброс в авто); null-ПОЛЕ в патче попадает в merged, сервер
  // выкидывает его как None (exclude_none) — сброс отдельного поля.
  const commitLayout = useCallback(
    (patch: Record<string, Partial<ViewLayoutPayload> | null>) => {
      if (!isArchitect || isContext) return;
      // Нормализация payload для сравнения с зеркалом: null-поля эквивалентны
      // отсутствию (сервер выкидывает их exclude_none).
      const norm = (v: ViewLayoutPayload | null | undefined): string => {
        if (v == null) return "null";
        const entries = Object.entries(v).filter(([, x]) => x != null);
        entries.sort(([a], [b]) => (a < b ? -1 : 1));
        return JSON.stringify(entries);
      };
      const items: Record<string, ViewLayoutPayload | null> = {};
      for (const [k, p] of Object.entries(patch)) {
        const merged = p === null ? null : { ...(viewLayout[k] ?? {}), ...p };
        // ДЕДУП: значение не отличается от зеркала → не пишем и не дёргаем
        // родителя. Это рубильник петель самоподдержки: повторяющийся интент
        // (тот же сид/миграция каждый прогон) не перезапускает раскладку.
        if (norm(merged) === norm(viewLayout[k])) continue;
        items[k] = merged;
      }
      if (Object.keys(items).length === 0) return;
      guardPersist(viewsApi.saveLayout(containerId, items), onPersistError);
      onLayoutChanged?.(items);
    },
    [isArchitect, isContext, containerId, viewLayout, onPersistError, onLayoutChanged],
  );

  // Раскрытые инлайн контейнеры (гостевые и ЛОКАЛЬНЫЕ, R5). Раскрытие — часть
  // состояния ВИДА и персистится (payload.expanded в view_layout, архитектор);
  // поверх сохранённого живут ЭФЕМЕРНЫЕ правки текущей сессии (overrides): у
  // viewer'а персиста нет, а у архитектора override совпадает с зеркалом коммита.
  // Такое производное решает и гонку инициализации: viewLayout приходит async,
  // а expanded не нужно «переливать» в стейт — он вычисляется.
  const [expandOverrides, setExpandOverrides] = useState<Map<string, boolean>>(new Map());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс эфемерных правок на смену уровня — осознанный reset-on-prop-change
    setExpandOverrides(new Map());
  }, [containerId]);
  const expanded = useMemo(() => {
    const s = new Set<string>();
    for (const [id, p] of Object.entries(viewLayout)) if (p.expanded) s.add(id);
    for (const [id, v] of expandOverrides) {
      if (v) s.add(id);
      else s.delete(id);
    }
    return s;
  }, [viewLayout, expandOverrides]);

  // Догруженные дети раскрытых ЛОКАЛЬНЫХ контейнеров (R5): id → прямые дети.
  // Кэш живёт до смены уровня; сворачивание кэш не чистит (повторное раскрытие
  // мгновенно). Конвейер держит контейнер свёрнутым, пока детей нет в карте.
  const [localChildren, setLocalChildren] = useState<Record<string, AppNode[]>>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс кэша детей на смену уровня — осознанный reset-on-prop-change
    setLocalChildren({});
  }, [containerId]);
  const commitExpanded = useCallback(
    (id: string, value: boolean) => {
      setExpandOverrides((prev) => new Map(prev).set(id, value));
      // персист (архитектор, не контекст — гейтит commitLayout): true — раскрыт,
      // null-поле — сброс (exclude_none выкинет его из payload строки)
      commitLayout({ [id]: { expanded: value ? true : null } });
    },
    [commitLayout],
  );
  // Раскрытие ГОСТЕВОГО контейнера: детей даёт проекция (реестр endpoints).
  const expandContainer = useCallback(
    (id: string) => { commitExpanded(id, true); },
    [commitExpanded],
  );
  // Раскрытие ЛОКАЛЬНОГО контейнера (R5): лениво догружаем его прямых детей —
  // по Д3 показываются ВСЕ дети, а /graph уровня их не отдаёт.
  const expandLocalContainer = useCallback(
    (id: string) => {
      commitExpanded(id, true);
      setLocalChildren((prev) => {
        if (prev[id]) return prev;
        void nodesApi.list(id).then((kids) => {
          setLocalChildren((cur) => (cur[id] ? cur : { ...cur, [id]: kids }));
        });
        return prev;
      });
    },
    [commitExpanded],
  );
  const collapseContainer = useCallback(
    (id: string) => { commitExpanded(id, false); },
    [commitExpanded],
  );
  // Догрузка детей для ПЕРСИСТНЫХ раскрытий (R5): после перезахода expanded
  // приходит из view_layout, а кэш детей пуст — конвейер держал бы контейнер
  // свёрнутым вечно. Дозагружаем локалов уровня (и, по мере появления их детей
  // в кэше, — раскрытых потомков цепочкой). Гостевых в known нет — им детей
  // даёт проекция. Повторный сет во время полёта гасится guard'ом cur[id].
  useEffect(() => {
    if (isContext) return;
    const known = new Set([
      ...nodes.map((n) => n.id),
      ...Object.values(localChildren).flat().map((n) => n.id),
    ]);
    for (const id of expanded) {
      if (!known.has(id) || localChildren[id]) continue;
      void nodesApi.list(id).then((kids) => {
        setLocalChildren((cur) => (cur[id] ? cur : { ...cur, [id]: kids }));
      });
    }
  }, [expanded, nodes, localChildren, isContext]);

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
    rfNodes, onNodesChange, setGuides, isArchitect, isContext,
    ancestorIds, ancestorNames, commitLayout, push: history.push,
  });

  // Поток 'dimensions'-изменений RF (замер узлов) → накопление реальных габаритов и
  // перезапуск раскладки при реально новом размере (V2.2b, паттерн render→measure→layout;
  // setState в колбэке внешней системы — легален, в отличие от эффекта по rfNodes).
  const handleNodesChangeMeasured: typeof handleNodesChange = useCallback((changes) => {
    handleNodesChange(changes);
    // копия словаря размеров — лениво, только при dimensions-изменениях: обычный
    // position-тик драга не должен аллоцировать её на каждый кадр
    if (!changes.some((ch) => ch.type === "dimensions")) return;
    let changed = false;
    const merged = { ...nodeSizesRef.current };
    for (const ch of changes) {
      if (ch.type !== "dimensions" || !ch.dimensions) continue;
      const t = getInternalNode(ch.id)?.type;
      if (t === "frame" || t === "spacer") continue;
      const w = Math.round(ch.dimensions.width * 2) / 2, h = Math.round(ch.dimensions.height * 2) / 2;
      if (!w || !h) continue;
      const prev = merged[ch.id];
      if (!prev || prev.w !== w || prev.h !== h) { merged[ch.id] = { w, h }; changed = true; }
    }
    if (changed) {
      nodeSizesRef.current = merged;
      const dbg = window as unknown as { __archmapSizesVersion?: number };
      dbg.__archmapSizesVersion = (dbg.__archmapSizesVersion ?? 0) + 1;
      setSizesVersion((v) => v + 1);
    }
  }, [handleNodesChange, getInternalNode]);

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
  // Drill из узла, раскрытого ИНЛАЙН глубже текущего уровня (R5): в breadcrumb входят
  // промежуточные контейнеры (фактическая архитектура: Контекст > HelixMon > ObsCore >
  // Zabbix Core), а не прыжок через слои. Цепочку восстанавливаем по parent_id из
  // локалов уровня + догруженных детей раскрытий; не восстановилась — прежнее поведение.
  const drillWithPath = useCallback(
    (n: AppNode) => {
      if (!onEnterNode || !n.parent_id || n.parent_id === containerId) { onDrillDown(n); return; }
      const pool = new Map<string, AppNode>();
      for (const x of nodes) pool.set(x.id, x);
      for (const kids of Object.values(localChildren)) for (const k of kids) pool.set(k.id, k);
      const chain: AppNode[] = [];
      let pid: string | null | undefined = n.parent_id;
      while (pid && pid !== containerId) {
        const p = pool.get(pid);
        if (!p) { onDrillDown(n); return; }
        chain.unshift(p);
        pid = p.parent_id;
      }
      const ref = (x: AppNode): AncestorRef => ({ id: x.id, name: x.name, is_external: x.is_external });
      const levelRefs: AncestorRef[] = ancestorIds.map((id, i) => ({
        id, name: ancestorNames[i] ?? id, is_external: false,
      }));
      onEnterNode([...levelRefs, ...chain.map(ref), ref(n)]);
    },
    [nodes, localChildren, containerId, ancestorIds, ancestorNames, onDrillDown, onEnterNode],
  );

  // Рамки НЕ таскаются (запрет движения рамок, 2026-07-08): их rect производен от
  // детей, перемещение содержимого = перемещение самих узлов. Прежнее расширение
  // группы жеста потомками рамки (R4.2 expandFrameDescendants) умерло вместе с драгом.
  // ЖИВОЙ bbox-follow рамок (2026-07-08, переписан на оверлей 2026-07-08): при драге
  // ребёнка рамка следует за содержимым прямо во время жеста. РЕАЛИЗАЦИЯ — ОВЕРЛЕЙ,
  // а не движение RF-узла рамки: прежний вариант каждый тик двигал рамку в стейте и
  // компенсировал rel ВСЕХ её детей — (а) каскад ре-рендеров узлов ронял FPS драга,
  // (б) RF ведёт позицию таскаемого относительно ДВИЖУЩЕЙСЯ рамки — накапливался
  // дрейф и узел «телепортировался» на сотни px. Теперь на время жеста RF-рамки
  // предков скрываются (opacity 0, один setState), их живой прямоугольник рисуют
  // лёгкие div-ы в ViewportPortal, обновляемые ИМПЕРАТИВНО через ref (ноль рендеров
  // на тик), а финальная геометрия применяется одним setState на отпускании.
  // Паддинги рамки снимаются на старте жеста (рамка = bbox прямых детей + константные
  // отступы); обход рамок — глубокие первыми (изменение вложенной двигает объемлющую).
  const framePadsRef = useRef<Map<string, { l: number; t: number; r: number; b: number }>>(new Map());
  const rfSize = (n: RFNode): { w: number; h: number } => ({
    w: n.measured?.width ?? (typeof n.width === "number" ? n.width : NODE_W),
    h: n.measured?.height ?? (typeof n.height === "number" ? n.height : NODE_H),
  });
  const snapshotFramePads = useCallback(() => {
    const pads = new Map<string, { l: number; t: number; r: number; b: number }>();
    for (const f of rfNodes) {
      if (f.type !== "frame") continue;
      const kids = rfNodes.filter((k) => k.parentId === f.id && k.type !== "spacer");
      if (kids.length === 0) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const k of kids) {
        const { w, h } = rfSize(k);
        minX = Math.min(minX, k.position.x); minY = Math.min(minY, k.position.y);
        maxX = Math.max(maxX, k.position.x + w); maxY = Math.max(maxY, k.position.y + h);
      }
      const { w: fw, h: fh } = rfSize(f);
      pads.set(f.id, { l: minX, t: minY, r: fw - maxX, b: fh - maxY });
    }
    framePadsRef.current = pads;
  }, [rfNodes]);
  // Рамки, скрытые на текущий жест (их рисует оверлей) + div-ы оверлея по id.
  const affectedFramesRef = useRef<Set<string>>(new Set());
  const overlayElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [overlayFrames, setOverlayFrames] = useState<
    { id: string; name: string; x: number; y: number; w: number; h: number }[]
  >([]);
  // Старт жеста: рамки-предки таскаемых скрываются, оверлей получает их стартовые rect.
  const beginFrameOverlay = useCallback((grp: RFNode[]) => {
    const byId = new Map(rfNodes.map((n) => [n.id, n]));
    const affected = new Set<string>();
    for (const n of grp) {
      let pid = n.parentId;
      while (pid) {
        const p = byId.get(pid);
        if (!p) break;
        if (p.type === "frame") affected.add(p.id);
        pid = p.parentId;
      }
    }
    affectedFramesRef.current = affected;
    if (affected.size === 0) { setOverlayFrames([]); return; }
    setOverlayFrames([...affected].map((id) => {
      const f = byId.get(id)!;
      const abs = absPositionOf(f, byId);
      const { w, h } = rfSize(f);
      return { id, name: (f.data as { name?: string }).name ?? "", x: abs.x, y: abs.y, w, h };
    }));
    setRfNodes((prev) => prev.map((n) =>
      affected.has(n.id) ? { ...n, style: { ...n.style, opacity: 0 } } : n,
    ));
  }, [rfNodes, setRfNodes]);
  // Тик жеста: живой bbox затронутых рамок → императивно в div-ы оверлея. Ноль setState.
  // Позиции читаем из RF-стора (стейт прошлого тика), таскаемые подменяем свежими из
  // аргумента onNodeDrag; рамки в стейте на время жеста неподвижны, поэтому абсолюты
  // детей корректны по построению.
  const liveFollowFrames = useCallback((dragged: RFNode[]) => {
    const affected = affectedFramesRef.current;
    if (affected.size === 0) return;
    const pads = framePadsRef.current;
    const els = overlayElsRef.current;
    const nodes = getNodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const d of dragged) {
      const cur = byId.get(d.id);
      if (cur) byId.set(d.id, { ...cur, position: d.position });
    }
    const depthOf = (n: RFNode): number => {
      let d = 0, pid = n.parentId;
      while (pid) { d++; pid = byId.get(pid)?.parentId; }
      return d;
    };
    const kidsOf = new Map<string, RFNode[]>();
    for (const n of byId.values()) {
      if (!n.parentId || n.type === "spacer") continue;
      (kidsOf.get(n.parentId) ?? kidsOf.set(n.parentId, []).get(n.parentId)!).push(n);
    }
    // live-rect рамок в АБСОЛЮТЕ, глубокие первыми (объемлющая видит live-rect вложенной)
    const live = new Map<string, { x: number; y: number; w: number; h: number }>();
    const frames = [...byId.values()].filter((n) => n.type === "frame" && affected.has(n.id))
      .sort((a, b) => depthOf(b) - depthOf(a));
    for (const f of frames) {
      const pad = pads.get(f.id);
      const kids = kidsOf.get(f.id);
      if (!pad || !kids || kids.length === 0) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const k of kids) {
        const lr = live.get(k.id);
        const abs = lr ?? { ...absPositionOf(k, byId), ...rfSize(k) };
        const { w, h } = lr ?? rfSize(k);
        minX = Math.min(minX, abs.x); minY = Math.min(minY, abs.y);
        maxX = Math.max(maxX, abs.x + w); maxY = Math.max(maxY, abs.y + h);
      }
      const rect = {
        x: minX - pad.l, y: minY - pad.t,
        w: maxX - minX + pad.l + pad.r, h: maxY - minY + pad.t + pad.b,
      };
      live.set(f.id, rect);
      const el = els.get(f.id);
      if (el) {
        el.style.left = `${rect.x}px`; el.style.top = `${rect.y}px`;
        el.style.width = `${rect.w}px`; el.style.height = `${rect.h}px`;
      }
    }
  }, [getNodes]);
  // Отпускание: финальная геометрия рамок применяется ОДНИМ setState (copy-on-write:
  // клонируются только рамки с изменившимся bbox и их дети при сдвиге origin — rel-
  // компенсация держит абсолюты детей), скрытые рамки возвращают видимость, оверлей
  // гаснет. Дальше обычный персист — конвейер пересчитает всё начисто.
  const finalizeFrameFollow = useCallback(() => {
    const affected = affectedFramesRef.current;
    affectedFramesRef.current = new Set();
    setOverlayFrames([]);
    if (affected.size === 0) return;
    setRfNodes((prev) => {
      const pads = framePadsRef.current;
      const patched = new Map<string, RFNode>();
      const byId = new Map(prev.map((n) => [n.id, n]));
      const cur = (id: string): RFNode | undefined => patched.get(id) ?? byId.get(id);
      const unhide = (n: RFNode): RFNode => {
        if (!affected.has(n.id) || !n.style || n.style.opacity === undefined) return n;
        const rest = { ...n.style };
        delete rest.opacity;
        return { ...n, style: rest };
      };
      const depthOf = (n: RFNode): number => {
        let d = 0, pid = n.parentId;
        while (pid) { d++; pid = byId.get(pid)?.parentId; }
        return d;
      };
      const frames = prev.filter((n) => n.type === "frame").sort((a, b) => depthOf(b) - depthOf(a));
      const kidsOf = new Map<string, RFNode[]>();
      for (const n of prev) {
        if (!n.parentId || n.type === "spacer") continue;
        (kidsOf.get(n.parentId) ?? kidsOf.set(n.parentId, []).get(n.parentId)!).push(n);
      }
      for (const f of frames) {
        const pad = pads.get(f.id);
        const kids0 = kidsOf.get(f.id);
        if (!pad || !kids0 || kids0.length === 0) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const k0 of kids0) {
          const k = cur(k0.id)!;
          const { w, h } = rfSize(k);
          minX = Math.min(minX, k.position.x); minY = Math.min(minY, k.position.y);
          maxX = Math.max(maxX, k.position.x + w); maxY = Math.max(maxY, k.position.y + h);
        }
        const dx = minX - pad.l, dy = minY - pad.t;
        const nw = maxX - minX + pad.l + pad.r, nh = maxY - minY + pad.t + pad.b;
        const fc = cur(f.id)!;
        const { w: fw, h: fh } = rfSize(fc);
        const moved = Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5;
        if (!moved && Math.abs(nw - fw) < 0.5 && Math.abs(nh - fh) < 0.5) continue;
        patched.set(f.id, {
          ...fc,
          position: { x: fc.position.x + dx, y: fc.position.y + dy },
          width: nw, height: nh,
          ...(fc.measured ? { measured: { width: nw, height: nh } } : null),
        });
        // компенсация rel нужна только при сдвиге origin рамки; рост вправо/вниз
        // (dx=dy=0) детей не трогает
        if (moved) {
          for (const k0 of kids0) {
            const k = cur(k0.id)!;
            patched.set(k.id, { ...k, position: { x: k.position.x - dx, y: k.position.y - dy } });
          }
        }
      }
      return prev.map((n) => unhide(patched.get(n.id) ?? n));
    });
  }, [setRfNodes]);
  const handleNodeDragStart = useCallback(
    (_e: MouseEvent, n: RFNode, ns: RFNode[]) => {
      setDragging(true);
      const grp = ns.length > 0 ? ns : [n];
      groupEdgeDrag.begin(grp);
      liveDragHandles.begin(rfNodes); // база позиций всех узлов на старте жеста
      noteDragStart(grp); // фиксируем «старые» позиции для инверсии перемещения
      snapshotFramePads(); // паддинги рамок для живого bbox-follow
      beginFrameOverlay(grp); // скрыть рамки-предки, включить живой оверлей
    },
    [groupEdgeDrag, liveDragHandles, rfNodes, noteDragStart, snapshotFramePads, beginFrameOverlay],
  );
  const handleSelectionDragStart = useCallback(
    (_e: MouseEvent, ns: RFNode[]) => {
      setDragging(true);
      groupEdgeDrag.begin(ns);
      liveDragHandles.begin(rfNodes);
      noteDragStart(ns);
      snapshotFramePads();
      beginFrameOverlay(ns);
    },
    [groupEdgeDrag, liveDragHandles, rfNodes, noteDragStart, snapshotFramePads, beginFrameOverlay],
  );
  const handleNodeDrag = useCallback(
    (_e: MouseEvent, _n: RFNode, ns: RFNode[]) => { groupEdgeDrag.move(ns); liveDragHandles.move(ns); liveFollowFrames(ns); },
    [groupEdgeDrag, liveDragHandles, liveFollowFrames],
  );
  const handleSelectionDrag = useCallback(
    (_e: MouseEvent, ns: RFNode[]) => { groupEdgeDrag.move(ns); liveDragHandles.move(ns); liveFollowFrames(ns); },
    [groupEdgeDrag, liveDragHandles, liveFollowFrames],
  );
  // Отпускание драга: весь жест (перенос изломов в groupEdgeDrag.end + персист позиций в
  // handleNodeDragStop) сворачиваем в ОДНУ команду истории через beginGroup/commitGroup —
  // иначе мультидраг узлов с изломанными рёбрами между ними давал бы 1+N шагов Undo.
  const handleNodeDragStopP = useCallback(
    (e: MouseEvent, n: RFNode, ns: RFNode[]) => {
      setDragging(false);
      finalizeFrameFollow(); // рамки: финальный bbox одним setState + вернуть видимость
      history.beginGroup();
      try {
        liveDragHandles.end();
        groupEdgeDrag.end(ns);
        handleNodeDragStop(e, n, ns);
      } finally {
        history.commitGroup("Перемещение группы");
      }
    },
    [groupEdgeDrag, liveDragHandles, handleNodeDragStop, history, finalizeFrameFollow],
  );
  const handleSelectionDragStopP = useCallback(
    (e: MouseEvent, ns: RFNode[]) => {
      setDragging(false);
      finalizeFrameFollow();
      history.beginGroup();
      try {
        liveDragHandles.end();
        groupEdgeDrag.end(ns);
        handleSelectionDragStop(e, ns);
      } finally {
        history.commitGroup("Перемещение группы");
      }
    },
    [groupEdgeDrag, liveDragHandles, handleSelectionDragStop, history, finalizeFrameFollow],
  );

  // Удаление выбранного узла с клавиатуры через подтверждение.
  const { handleKeyDown } = useCanvasDelete({
    rfNodes, isArchitect, isContext, onRequestDeleteNode, onRequestDeleteNodes,
  });


  // Персист кастомного пути стрелки (изломы) по отпусканию драга сегмента: патч
  // payload ПУЧКА в view_layout (единый слой R3 — развилка «колонка ребра vs
  // пер-уровневый слой» умерла). Пустой массив = сброс в авто, якорь снимается.
  const { commitWaypoints } = useEdgeWaypoints({ isArchitect, commitLayout });

  // Персист позиции плашки (доля label_t) по отпусканию её драга. Доля геометрия-
  // независима; живёт в payload пучка — общая для членов мастер-стрелки по построению.
  const commitLabelT = useCallback(
    (bundleId: string, t: number | null) => {
      commitLayout({ [bundleId]: { label_t: t } });
    },
    [commitLayout],
  );

  // Реконнект концов рёбер (смена хэндла на том же узле + персист). Смену хэндла и
  // сброс изломов (старый путь считался от прежних концов — после смены хэндла он
  // кривой) хук пишет ОДНИМ патчем пучка через commitLayout; Undo — обратным патчем.
  const {
    handleReconnectStart, handleReconnect, handleReconnectEnd,
    isValidConnection: isValidReconnect, isReconnecting, reconnectBlocked, reconnectChildDrill,
    consumeReconnectClick,
  } = useReconnectHandles({
    setRfEdges, isArchitect, commitLayout, push: history.push,
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
  // Позиции — абсолютные: дети compound-рамок несут относительные координаты (R4).
  const qcCandidate = useMemo(() => {
    if (!qc) return null;
    const byId = new Map(rfNodes.map((n) => [n.id, n]));
    const src = byId.get(qc.sourceId);
    if (!src) return null;
    const cands: QcNode[] = rfNodes
      .filter((n) => n.type !== "spacer" && n.type !== "frame" && n.id !== qc.sourceId)
      .map((n) => ({ id: n.id, ...absPositionOf(n, byId) }));
    return findQuickConnectTarget(
      qc.sourceId, qc.side, qc.frac,
      { id: src.id, ...absPositionOf(src, byId) }, cands,
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

  const cbRef = useRef({ onDrillDown, drillWithPath, onEnterNode, onEditNode, expandContainer, expandLocalContainer, collapseContainer, commitWaypoints, commitLabelT, openEdgeMembers, pushHistory: history.push, commitLayout, quickConnect: quickConnectHandlers });
  // Канонический latest-ref: обновляем cbRef.current в эффекте БЕЗ зависимостей (после
  // каждого рендера). Объявлен ДО эффекта сборки ниже — порядок исполнения эффектов =
  // порядок объявления, поэтому сборка читает уже свежий cbRef.current. Поведенчески
  // ноль: и события узлов, и эффекты исполняются после рендера.
  useEffect(() => {
    cbRef.current = { onDrillDown, drillWithPath, onEnterNode, onEditNode, expandContainer, expandLocalContainer, collapseContainer, commitWaypoints, commitLabelT, openEdgeMembers, pushHistory: history.push, commitLayout, quickConnect: quickConnectHandlers };
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
  // ГИСТЕРЕЗИС МАРШРУТОВ: финальные autoRoutes/edgeHandles последнего прогона с ТЕМ ЖЕ
  // комплектом замеров (sizesVersion). Передаются следующему прогону — валидные прежние
  // маршруты удерживаются, пока не хуже свежих на порог (стрелки не перекладываются от
  // чужих микро-сдвигов). СТРОГО одинаковый sizesVersion: замеры приходят порциями, и
  // маршруты частично-замеренного прогона, удержанные в полностью-замеренном мире,
  // разъезжались с плашками/каналами (аудит ловил плашки, порезанные СВОЕЙ же линией).
  // При смене уровня — сброс (чужие маршруты всё равно невалидны, но не гоняем валидацию).
  const prevRoutesRef = useRef<{
    routes: Map<string, EdgePoint[]>;
    handles: Map<string, { sourceHandle: string; targetHandle: string }>;
    version: number;
  } | null>(null);
  useEffect(() => { prevRoutesRef.current = null; }, [containerId, isContext]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Счётчик «раскладка в полёте» — сигнал занятости для полигона (dump-levels ждёт
      // нуля перед снятием сигнатуры): раскладка двухфазная (фолбэк-габариты → замер →
      // пере-прогон), и без явного сигнала снапшот ловил межфазное состояние.
      const w = window as unknown as { __archmapLayoutInflight?: number; __archmapLayoutRuns?: number };
      w.__archmapLayoutInflight = (w.__archmapLayoutInflight ?? 0) + 1;
      w.__archmapLayoutRuns = (w.__archmapLayoutRuns ?? 0) + 1;
      try {
      // гистерезис — только между прогонами с ОДНИМ комплектом замеров (см. prevRoutesRef)
      const sameSizes = prevRoutesRef.current?.version === sizesVersion;
      const { layout: next, liveInputs, intents } = await computeViewLayout({
        nodes, endpoints, edges, containerId, viewLayout,
        ancestorIds: stableAncestorIds, expanded, localChildren, isContext,
        sizes: nodeSizesRef.current,
        prevRoutes: sameSizes ? prevRoutesRef.current?.routes : undefined,
        prevEdgeHandles: sameSizes ? prevRoutesRef.current?.handles : undefined,
      });
      if (cancelled) return; // устаревший прогон: ни снапшота, ни персиста интентов
      if (next.autoRoutes) {
        prevRoutesRef.current = { routes: next.autoRoutes, handles: next.edgeHandles, version: sizesVersion };
      }
      liveHandleInputs.current = liveInputs;
      // Побочные записи раскладки (интенты) — через единый commitLayout: засев владения
      // own-on-first-render и приобретение якоря изломом (абсолют → офсет, на экране без
      // сдвига). Зеркало onLayoutChanged кладёт их в viewLayout → следующий прогон видит
      // сохранённое и интент не повторяет. cbRef — чтобы не тащить commitLayout в deps.
      for (const intent of intents) {
        if (intent.kind === "seed-positions") {
          cbRef.current.commitLayout(
            Object.fromEntries(intent.seeds.map((s) => [s.id, { x: s.x, y: s.y }])),
          );
        } else {
          cbRef.current.commitLayout(
            Object.fromEntries(intent.migrations.map((m) => [m.itemId, { waypoints: m.waypoints, anchor: m.anchor }])),
          );
        }
      }
      setLayout(next);
      } finally {
        w.__archmapLayoutInflight = (w.__archmapLayoutInflight ?? 1) - 1;
      }
    })();
    return () => { cancelled = true; };
    // Геометрия рёбер внутри viewLayout не вся влияет на позиции, НО зависимость — весь
    // объект намеренно: изломы/хэндлы пучков читает эффект-сборщик ниже, и он должен
    // работать с ОДНИМ снапшотом (layout). Иначе при реконнекте смена хэндла (async-
    // раскладка) и сброс изломов (sync-стейт) рассинхронятся: сборщик сработал бы со
    // старым layout → ребро прыгнуло бы на исходный хэндл.
  }, [nodes, endpoints, containerId, viewLayout, edges, isContext, expanded, localChildren, stableAncestorIds, sizesVersion]);

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
    const { nodes: layoutNodes, entities, positions, edgeHandles, edgeShelves, edgeLoops, autoRoutes, labelPlacements, bundleWaypoints, guestFrames, groupArr, spacers } = layout;
    const cb = cbRef.current;
    // R4: раскрытые гостевые рамки — compound-узлы RF. Родитель сущности — САМАЯ
    // ГЛУБОКАЯ рамка, содержащая её членом; родитель рамки — самая глубокая внешняя
    // рамка, накрывающая всех её членов. Дети получают position ОТНОСИТЕЛЬНО родителя.
    const frameOfEntity = (id: string) => {
      let best: (typeof guestFrames)[number] | undefined;
      for (const f of guestFrames) {
        if (f.memberIds.has(id) && (!best || f.depth > best.depth)) best = f;
      }
      return best;
    };
    const frameOfFrame = (f: (typeof guestFrames)[number]) => {
      let best: (typeof guestFrames)[number] | undefined;
      for (const g of guestFrames) {
        if (g === f || g.depth >= f.depth) continue;
        let covers = true;
        for (const id of f.memberIds) if (!g.memberIds.has(id)) { covers = false; break; }
        if (covers && (!best || g.depth > best.depth)) best = g;
      }
      return best;
    };
    // Вложенность рамки ОТНОСИТЕЛЬНО УРОВНЯ (1 = верхняя раскрытая, 2 = раскрытая
    // внутри раскрытой, …) — длина цепочки объемлющих рамок. Именно она, а не
    // f.depth: depth рамок нумеруется вслед за breadcrumb, и на дриллнутых уровнях
    // верхняя рамка несёт depth = глубине уровня — прибавка depth+f.depth двоила бы
    // глубину и дети красились на ступень светлее положенного.
    const frameNesting = (f0: (typeof guestFrames)[number]): number => {
      let n = 0;
      for (let f: (typeof guestFrames)[number] | undefined = f0; f; f = frameOfFrame(f)) n++;
      return n;
    };
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
      // Рамки — первыми (RF требует родителя в массиве раньше детей; guestFrames
      // отсортированы по depth, поэтому и вложенные рамки идут после объемлющих).
      // Реальный rect из раскладки; тело прозрачно для мыши (см. FrameNode).
      ...guestFrames.map((f) => {
        const pf = frameOfFrame(f);
        // Рамки НЕ таскаются (запрет движения рамок, 2026-07-08): rect рамки всегда
        // производен от детей — двигаются только сами узлы.
        return {
          id: f.id,
          type: "frame" as const,
          position: pf
            ? { x: f.rect.x - pf.rect.x, y: f.rect.y - pf.rect.y }
            : { x: f.rect.x, y: f.rect.y },
          ...(pf ? { parentId: pf.id } : null),
          width: f.rect.w,
          height: f.rect.h,
          draggable: false,
          selectable: false,
          zIndex: -1, // под узлами (и под их рёбрами внутри рамки)
          data: {
            name: f.name,
            onCollapse: () => cb.collapseContainer(f.id),
          } satisfies FrameData,
        };
      }),
      ...layoutNodes.map((n) => {
        const abs = positions.get(n.id) ?? { x: 0, y: 0 };
        // блок внутри раскрытого ЛОКАЛА (R5) — ребёнок compound-рамки
        const pf = frameOfEntity(n.id);
        const compound = pf
          ? { parentId: pf.id, position: { x: abs.x - pf.rect.x, y: abs.y - pf.rect.y } }
          : { position: abs };
        return {
          id: n.id,
          type: "block" as const,
          ...compound,
          ...(dimNode(n.status) ? { style: DIM_STYLE } : null),
          data: {
            appNode: n,
            onDrillDown: cb.drillWithPath,
            isArchitect,
            // C4: дети раскрытых инлайн контейнеров светлее родительского уровня —
            // к глубине уровня прибавляется вложенность рамки относительно уровня
            colors: getNodeColors(n.is_external, depth + (pf ? frameNesting(pf) : 0), n.status),
            hideActions: isContext,
            connectable: isArchitect && !isContext,
            quickConnect: isArchitect && !isContext ? cb.quickConnect : undefined,
            // Раскрытие ЛОКАЛЬНОГО контейнера инлайн (R5): лупа у сервиса с детьми.
            // В контексте read-only схема — без раскрытий.
            onExpand: !isContext && n.has_children && canHaveChildren(n.shape)
              ? cb.expandLocalContainer
              : undefined,
          } satisfies BlockData,
        };
      }),
      ...entities.map((ent) => {
        const abs = positions.get(ent.id) ?? { x: 0, y: 0 };
        // сущность внутри раскрытой рамки — ребёнок compound-узла (координаты рамки)
        const pf = frameOfEntity(ent.id);
        const compound = pf
          ? {
              parentId: pf.id,
              position: { x: abs.x - pf.rect.x, y: abs.y - pf.rect.y },
            }
          : { position: abs };
        if (ent.kind === "leaf") {
          return {
            id: ent.id,
            type: "ghost" as const,
            ...compound,
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
          ...compound,
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
        // Кастомный путь (изломы): архитектор, не контекст. Геометрия живёт на ключе
        // ПУЧКА (R3) — одна на пару отображаемых концов: мастер-стрелка редактируется
        // как одиночная, у гостевой/сквозной проекции путь свой по построению (прежняя
        // развилка bothLocal «колонка ребра vs пер-уровневый слой» умерла).
        const bk = bundleKey(g.source, g.target);
        const editable = isArchitect && !isContext;
        if (editable) {
          // путь — из РЕКОНСТРУИРОВАННОГО снимка (владеемый якорем = anchor + офсет,
          // Ф3/D8), а не из сырого зеркала: иначе изломы не ехали бы за рамкой
          const wp = bundleWaypoints[bk];
          data.editable = true;
          data.waypoints = wp && wp.length > 0 ? wp : undefined;
          // «Старые» геометрия/доля на момент сборки = последнее закоммиченное значение
          // (драг-превью живёт в локальном стейте edges.tsx и сюда не доходит). Это и есть
          // состояние для инверсии. undefined-путь инвертируется пустым массивом (сброс в авто).
          const oldWp = data.waypoints;
          const oldT = single.label_t ?? null;
          // фиче-тогл: ручные изломы выключены → грипы сегментов не рендерятся
          // (edges.tsx гейтит их наличием этого колбэка), новые изломы не создаются
          if (EDGE_MANUAL_LAYOUT) data.onWaypointsCommit = (nwp) => {
            cb.commitWaypoints(bk, nwp);
            cb.pushHistory({
              label: "Изменение пути связи",
              undo: () => cb.commitWaypoints(bk, oldWp ?? []),
              redo: () => cb.commitWaypoints(bk, nwp),
            });
          };
          // Перетаскивание плашки доступно только архитектору (editable); доля — в
          // payload пучка (общая для членов мастер-стрелки по построению).
          data.onLabelTCommit = (t) => {
            cb.commitLabelT(bk, t);
            cb.pushHistory({
              label: "Перемещение подписи",
              undo: () => cb.commitLabelT(bk, oldT),
              redo: () => cb.commitLabelT(bk, t),
            });
          };
        }
        // Позиция плашки (доля label_t) — из payload пучка; члены обогащены конвейером
        // одинаково, читаем у первого. Ставим и viewer'у (отображение сдвига).
        // null → центр. Контекст-полки долю игнорируют (своя геометрия плашки).
        if (!isContext) {
          const lt = single.label_t;
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
          // (смена узла-конца по-прежнему запрещена в handleReconnect: правится только хэндл).
          // Фиче-тогл: реконнект = ручная фиксация хэндла → выключен вместе с ручным слоем.
          reconnectable: isArchitect && EDGE_MANUAL_LAYOUT,
        };
      })
    );
    // Путь пучка сборка читает из layout.bundleWaypoints (реконструированный снимок D8),
    // а НЕ из сырого пропа viewLayout: последний входит в зависимости раскладки выше →
    // его правка даёт новый layout (со свежим bundleWaypoints), и сборка идёт со СВЕЖИМ
    // снапшотом. Прямой триггер сборки по сырому пропу откатывал бы хэндл при реконнекте.
  }, [layout, isArchitect, depth, isContext, schemaView, setRfNodes, setRfEdges]);

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
  const hasGraphContent = nodes.length + endpoints.length > 0;
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
        onNodesChange={handleNodesChangeMeasured}
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
            />
          </ViewportPortal>
        )}
        {(guides.x != null || guides.y != null || guides.spacing.length > 0) && (
          <ViewportPortal>
            <AlignmentGuides x={guides.x} y={guides.y} spacing={guides.spacing} />
          </ViewportPortal>
        )}
        {/* Живой оверлей рамок на время драга: RF-рамки предков скрыты, их bbox рисуют
            эти div-ы (обновляются императивно из liveFollowFrames — без setState). */}
        {overlayFrames.length > 0 && (
          <ViewportPortal>
            {overlayFrames.map((f) => (
              <div
                key={f.id}
                ref={(el) => {
                  if (el) overlayElsRef.current.set(f.id, el);
                  else overlayElsRef.current.delete(f.id);
                }}
                style={{
                  position: "absolute", left: f.x, top: f.y, width: f.w, height: f.h,
                  border: "1px dashed #9ca3af", borderRadius: 12, background: "transparent",
                  boxSizing: "border-box", pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    position: "absolute", left: 10, bottom: 8, fontSize: 12, fontWeight: 600,
                    color: "#64748b", background: "#fff", padding: "2px 8px", borderRadius: 5,
                    border: "1px solid #e5e7eb", whiteSpace: "nowrap", pointerEvents: "none",
                  }}
                >
                  🔍 {f.name}
                </div>
              </div>
            ))}
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
