import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
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
import type { Node as AppNode, GhostNode, Edge as AppEdge, NodeShape, AncestorRef, ViewLayout, ViewLayoutPayload, EdgePoint } from "../types";
import { canHaveChildren } from "../types";
import { NODE_W, NODE_H } from "./graph/constants";
import type {
  WrappedEdgeData,
  BlockData, GhostData, ContainerData,
  QuickConnectHandlers,
} from "./graph/types";
import type { EdgeSide } from "./graph/edgePath";
import type { SchemaView } from "./schemaView";
import { computeViewLayout, type LayoutResult } from "./graph/layout/pipeline";
import { assembleRfGraph } from "./graph/assembleRf";
import { NodeShapeSvg } from "./graph/shapes";
import { nodeTypes } from "./graph/nodes";
import { edgeTypes } from "./graph/edges";
import { EdgeJumpProvider } from "./graph/EdgeJumpContext";
import ConnectionLine from "./graph/ConnectionLine";
import { LevelBoundary, AlignmentGuides } from "./graph/boundaries";
import { absPositionOf } from "./graph/absPos";
import { useAlignmentGuides } from "./graph/interaction/useAlignmentGuides";
import { useSnapAlignment } from "./graph/interaction/useSnapAlignment";
import { useTemplateDrop, type DropFrame } from "./graph/interaction/useTemplateDrop";
import { useHistory } from "./graph/interaction/useHistory";
import type { History } from "./graph/interaction/useHistory";
import { useCanvasDelete } from "./graph/interaction/useCanvasDelete";
import { useEdgeConnect, type ConnectTarget } from "./graph/interaction/useEdgeConnect";
import { findQuickConnectTarget, type QcNode } from "./graph/interaction/quickConnect";
import QuickConnectPreview from "./graph/QuickConnectPreview";
import { useLayoutAnimation } from "./graph/interaction/useLayoutAnimation";
import { useFrameFollowOverlay } from "./graph/interaction/useFrameFollowOverlay";
import { useLiveDragHandles, type LiveHandleInputs } from "./graph/interaction/useLiveDragHandles";
import { guardPersist } from "./graph/interaction/persistGuard";

// --- Основной компонент ---

// Стабильный пустой дефолт для viewLayout: дефолт-параметр `= {}` создавал бы
// НОВЫЙ объект на каждый рендер, а он — зависимость async-эффекта раскладки → лишний
// перезапуск ELK и мигание. Один модульный объект держит ссылку стабильной.
const EMPTY_VIEW_LAYOUT: ViewLayout = {};

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
  // Двойной клик по ГОСТЮ (проекция чужого узла) — детализация read-only в правой панели.
  onInspectGhost?: (ghost: GhostNode) => void;
  // Что открыто в правой панели — для устойчивой подсветки связанного (узел+его стрелки /
  // стрелка+оба узла). Гость сводится к kind:"node". Считается в TreePage из selectedObject.
  linkedHighlight?: { kind: "node" | "edge"; id: string } | null;
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
  // форма, pos — координаты в системе графа (левый-верхний угол узла), parentId —
  // контейнер раскрытой рамки под курсором (узел станет его ребёнком) либо null (уровень).
  onDropNode?: (shape: NodeShape, pos: { x: number; y: number }, parentId: string | null) => void;
  // Обновить кэш детей раскрытого контейнера (после создания/отката ребёнка в его рамке
  // на ЭТОМ же уровне — localChildren иначе держит устаревший список). token — триггер.
  refreshChildrenOf?: { id: string; token: number } | null;
  // протянули стрелку от узла sourceId на ЛИСТОВОЙ узел/хэндл targetId — создать связь.
  // Хэндлы из жеста: при дропе на хэндл известны оба, на тело листа — только исходный.
  // Имена концов едут С ЖЕСТОМ: дети раскрытых ЛОКАЛЬНЫХ контейнеров известны только
  // холсту (кэш localChildren) — TreePage разрешить их id в имя не может.
  onCreateEdge?: (
    sourceId: string, targetId: string,
    sourceHandle: string | null, targetHandle: string | null,
    sourceName?: string, targetName?: string,
  ) => void;
  // протянули стрелку на узел С ДЕТЬМИ (containerId) — открыть выбор его потомка
  // как дальнего конца межуровневой связи (источник — sourceId, его хэндл — sourceHandle)
  onConnectInto?: (
    sourceId: string, containerId: string, containerName: string,
    sourceHandle: string | null, sourceName?: string,
  ) => void;
  // конец стрелки отпустили на плитку «вне уровня» — открыть выбор дальнего конца
  // из всей схемы (узла, которого нет на текущем холсте)
  onExitUp?: (sourceId: string, sourceHandle: string | null, sourceName?: string) => void;
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
  onInspectGhost,
  linkedHighlight,
  onEdgesChoice,
  onLayoutChanged,
  onDropNode,
  refreshChildrenOf,
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
  const { screenToFlowPosition, setCenter, fitBounds, getInternalNode, getNodes, getEdges } = useReactFlow();
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

  // Анимация раскрытия/сворачивания контейнеров: единственная точка применения
  // раскладки к RF-стейту (applyLayout вместо прямых setRfNodes/setRfEdges в
  // сборщике). Интенты ставят обработчики лупы/сворачивания; окно анимации
  // включает класс lg-canvas--anim (CSS-transition в LevelGraph.css).
  const {
    apply: applyLayout, noteExpand, noteCollapse, noteGesture,
    cancel: cancelAnim, reset: resetAnim, active: animActive,
  } = useLayoutAnimation({ getNodes, getEdges, setRfNodes, setRfEdges });
  // Смена уровня/режима: отложенная анимация протухла — жёсткий сброс без доигровки
  // (свежую раскладку нового уровня применит сборщик).
  useEffect(() => { resetAnim(); }, [containerId, isContext, resetAnim]);

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
    (id: string) => { noteExpand(id); commitExpanded(id, true); },
    [commitExpanded, noteExpand],
  );
  // Раскрытие ЛОКАЛЬНОГО контейнера (R5): лениво догружаем его прямых детей —
  // по Д3 показываются ВСЕ дети, а /graph уровня их не отдаёт.
  const expandLocalContainer = useCallback(
    (id: string) => {
      noteExpand(id);
      commitExpanded(id, true);
      setLocalChildren((prev) => {
        if (prev[id]) return prev;
        void nodesApi.list(id).then((kids) => {
          setLocalChildren((cur) => (cur[id] ? cur : { ...cur, [id]: kids }));
        });
        return prev;
      });
    },
    [commitExpanded, noteExpand],
  );
  const collapseContainer = useCallback(
    (id: string) => { noteCollapse(id); commitExpanded(id, false); },
    [commitExpanded, noteCollapse],
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

  // Таргетный рефреш кэша детей одного контейнера (дроп нового узла в его раскрытую рамку /
  // откат такого дропа): перечитываем список и ПЕРЕЗАПИСЫВАЕМ (в отличие от ленивой догрузки
  // выше — та не трогает уже заполненный ключ). token гарантирует срабатывание на повтор.
  const refreshTokenRef = useRef(0);
  useEffect(() => {
    if (isContext || !refreshChildrenOf) return;
    if (refreshChildrenOf.token === refreshTokenRef.current) return;
    refreshTokenRef.current = refreshChildrenOf.token;
    const { id } = refreshChildrenOf;
    void nodesApi.list(id).then((kids) => {
      setLocalChildren((cur) => ({ ...cur, [id]: kids }));
    });
  }, [refreshChildrenOf, isContext]);

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
  // пересоздавать слушатель клавиш на каждый рендер. Undo/Redo — ручной жест: изменённые
  // пересчётом стрелки перерисовываются анимированно (noteGesture).
  const runUndo = useMemo(
    () => () => { noteGesture(); (onUndo ?? history.undo)(); },
    [onUndo, history, noteGesture],
  );
  const runRedo = useMemo(
    () => () => { noteGesture(); (onRedo ?? history.redo)(); },
    [onRedo, history, noteGesture],
  );

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

  // Живой пересчёт авто-хэндлов локальных стрелок во время драга (WYSIWYG: превью =
  // итог по отпускании). Снимок входов раскладки кладём в ref в конце async-раскладки.
  const liveHandleInputs = useRef<LiveHandleInputs | null>(null);
  const liveDragHandles = useLiveDragHandles({ inputsRef: liveHandleInputs, setRfEdges });

  // Идёт ли драг узлов/рамки выделения. На время драга замораживаем реестр «мостиков»
  // (paused у EdgeJumpProvider): иначе его пересчёт каждый кадр перерисовывал бы ВСЕ
  // рёбра по два прохода — лаги и краш на хаотичном мультидраге многих узлов. Старт —
  // на onNodeDragStart/onSelectionDragStart, сброс — в обёртках над стоп-обработчиками.
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
  // детей, перемещение содержимого = перемещение самих узлов. ЖИВОЙ bbox-follow
  // рамок при драге ребёнка — оверлей в useFrameFollowOverlay (вынесен при распиле Ф2).
  const frameFollow = useFrameFollowOverlay({ rfNodes, setRfNodes, getNodes });
  const handleNodeDragStart = useCallback(
    (_e: MouseEvent, n: RFNode, ns: RFNode[]) => {
      setDragging(true);
      cancelAnim(); // transition раскрытия не должен цеплять жест — мгновенно доиграть
      const grp = ns.length > 0 ? ns : [n];
      liveDragHandles.begin(rfNodes); // база позиций всех узлов на старте жеста
      noteDragStart(grp); // фиксируем «старые» позиции для инверсии перемещения
      frameFollow.snapshotPads(); // паддинги рамок для живого bbox-follow
      frameFollow.begin(grp); // скрыть рамки-предки, включить живой оверлей
    },
    [liveDragHandles, rfNodes, noteDragStart, frameFollow, cancelAnim],
  );
  const handleSelectionDragStart = useCallback(
    (_e: MouseEvent, ns: RFNode[]) => {
      setDragging(true);
      cancelAnim();
      liveDragHandles.begin(rfNodes);
      noteDragStart(ns);
      frameFollow.snapshotPads();
      frameFollow.begin(ns);
    },
    [liveDragHandles, rfNodes, noteDragStart, frameFollow, cancelAnim],
  );
  const handleNodeDrag = useCallback(
    (_e: MouseEvent, _n: RFNode, ns: RFNode[]) => { liveDragHandles.move(ns); frameFollow.follow(ns); },
    [liveDragHandles, frameFollow],
  );
  const handleSelectionDrag = useCallback(
    (_e: MouseEvent, ns: RFNode[]) => { liveDragHandles.move(ns); frameFollow.follow(ns); },
    [liveDragHandles, frameFollow],
  );
  // Отпускание драга: жест сворачиваем в ОДНУ команду истории через beginGroup/
  // commitGroup — мультидраг остаётся одним шагом Undo.
  const handleNodeDragStopP = useCallback(
    (e: MouseEvent, n: RFNode, ns: RFNode[]) => {
      setDragging(false);
      frameFollow.finalize(); // рамки: финальный bbox одним setState + вернуть видимость
      noteGesture(); // изменённые пересчётом стрелки перерисовать анимированно
      history.beginGroup();
      try {
        liveDragHandles.end();
        handleNodeDragStop(e, n, ns);
      } finally {
        history.commitGroup("Перемещение группы");
      }
    },
    [liveDragHandles, handleNodeDragStop, history, frameFollow, noteGesture],
  );
  const handleSelectionDragStopP = useCallback(
    (e: MouseEvent, ns: RFNode[]) => {
      setDragging(false);
      frameFollow.finalize();
      noteGesture();
      history.beginGroup();
      try {
        liveDragHandles.end();
        handleSelectionDragStop(e, ns);
      } finally {
        history.commitGroup("Перемещение группы");
      }
    },
    [liveDragHandles, handleSelectionDragStop, history, frameFollow, noteGesture],
  );

  // Удаление выбранного узла с клавиатуры через подтверждение.
  const { handleKeyDown } = useCanvasDelete({
    rfNodes, isArchitect, isContext, onRequestDeleteNode, onRequestDeleteNodes,
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

  // Имя ОТОБРАЖАЕМОГО узла по id — для заголовков модалок создания связи. Дети
  // раскрытых локальных контейнеров известны только холсту (кэш localChildren),
  // поэтому имена концов уезжают вместе с жестом, а не разрешаются в TreePage.
  const displayNameOf = useCallback(
    (id: string): string | undefined => {
      const n = rfNodes.find((x) => x.id === id);
      if (!n) return undefined;
      if (n.type === "block") return (n.data as BlockData).appNode.name;
      if (n.type === "ghost") return (n.data as GhostData).appNode.name;
      if (n.type === "container") return (n.data as ContainerData).name;
      return undefined;
    },
    [rfNodes],
  );

  // Создание новой связи протягиванием стрелки (хэндл → напрямую, тело контейнера →
  // выбор потомка). Реконнект концов существующих рёбер умер вместе с ручным слоем
  // стрелок (2026-07-09) — поток создания единственный.
  const { connecting, handleConnectStart, handleConnect, handleConnectEnd, isValidNewConnection } =
    useEdgeConnect({
      isArchitect, isContext, resolveTarget,
      onCreate: (s, t, sh, th) => onCreateEdge?.(s, t, sh, th, displayNameOf(s), displayNameOf(t)),
      onInto: (s, cid, cname, sh) => onConnectInto?.(s, cid, cname, sh, displayNameOf(s)),
      onExitUp: (s, sh) => onExitUp?.(s, sh, displayNameOf(s)),
    });

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
  const displayNameOfRef = useRef(displayNameOf);
  useEffect(() => {
    qcRef.current = qc;
    qcCandidateRef.current = qcCandidate;
    onCreateEdgeRef.current = onCreateEdge;
    displayNameOfRef.current = displayNameOf;
  });
  const quickConnectHandlers = useMemo<QuickConnectHandlers>(() => ({
    enter: (sourceId, sourceHandle, side, frac) => setQc({ sourceId, sourceHandle, side, frac }),
    leave: () => setQc(null),
    activate: () => {
      const q = qcRef.current, c = qcCandidateRef.current;
      setQc(null);
      if (q && c) {
        const nameOf = displayNameOfRef.current;
        onCreateEdgeRef.current?.(
          q.sourceId, c.targetId, q.sourceHandle, c.targetHandle,
          nameOf(q.sourceId), nameOf(c.targetId),
        );
      }
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

  const cbRef = useRef({ onDrillDown, drillWithPath, onEnterNode, onEditNode, onInspectGhost, expandContainer, expandLocalContainer, collapseContainer, openEdgeMembers, pushHistory: history.push, commitLayout, quickConnect: quickConnectHandlers });
  // Канонический latest-ref: обновляем cbRef.current в эффекте БЕЗ зависимостей (после
  // каждого рендера). Объявлен ДО эффекта сборки ниже — порядок исполнения эффектов =
  // порядок объявления, поэтому сборка читает уже свежий cbRef.current. Поведенчески
  // ноль: и события узлов, и эффекты исполняются после рендера.
  useEffect(() => {
    cbRef.current = { onDrillDown, drillWithPath, onEnterNode, onEditNode, onInspectGhost, expandContainer, expandLocalContainer, collapseContainer, openEdgeMembers, pushHistory: history.push, commitLayout, quickConnect: quickConnectHandlers };
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
      // own-on-first-render. Зеркало onLayoutChanged кладёт их в viewLayout → следующий
      // прогон видит сохранённое и интент не повторяет. cbRef — чтобы не тащить
      // commitLayout в deps.
      for (const intent of intents) {
        cbRef.current.commitLayout(
          Object.fromEntries(intent.seeds.map((s) => [s.id, { x: s.x, y: s.y }])),
        );
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
  // МЕЖДУ пересчётами. Сама сборка — чистая функция assembleRfGraph (вынесена при
  // распиле Ф2); nodes берутся ИЗ layout (снимок, по которому он посчитан), а не из
  // пропа — позиции и данные согласованы, эффект не срабатывает со старым layout.
  // Колбэки — из latest-ref (cbRef), поэтому в зависимостях только данные.
  useEffect(() => {
    if (!layout) return; // первый рендер до резолва async-раскладки
    const { nextNodes, nextEdges } = assembleRfGraph({
      layout, isArchitect, isContext, depth, schemaView, cb: cbRef.current,
    });
    // Применение — через оркестратор анимации: без интента раскрытия/сворачивания
    // это те же setRfNodes/setRfEdges, с интентом — режиссированный переход.
    applyLayout(nextNodes, nextEdges);
  }, [layout, isArchitect, depth, isContext, schemaView, applyLayout]);

  // Раскрытые рамки уровня (гостевые + локальные) как цели дропа шаблона: id контейнера
  // (будущий parent_id) + абсолютный rect + depth (глубочайшая побеждает при вложенности).
  const expandedFrames = useMemo<DropFrame[]>(
    () => (layout?.guestFrames ?? []).map((f) => ({ id: f.id, depth: f.depth, rect: f.rect })),
    [layout],
  );

  // Перетаскивание шаблона узла из палитры: превью-рамка + создание узла на drop.
  const { dropPreview, dropTargetFrame, handleDragOver, handleDragLeave, handleDrop } = useTemplateDrop({
    rfNodes, screenToFlowPosition, setGuides, clearGuides,
    isArchitect, isContext, onDropNode, dragShape, expandedFrames,
  });

  // Двойной клик — единственный триггер меты (правая панель); одиночный — только
  // штатное выделение RF. По узлу: только локальный блок (гость/контейнер не правим,
  // контекст read-only).
  const handleNodeDoubleClick = useCallback(
    (_e: MouseEvent, rfNode: RFNode) => {
      if (isContext) return;
      if (rfNode.type === "block") {
        const appNode = (rfNode.data as BlockData | undefined)?.appNode;
        if (appNode) cbRef.current.onEditNode(appNode);
      } else if (rfNode.type === "ghost") {
        // Гость — проекция чужого узла: детализация read-only (GhostInspector), без правок.
        const ghost = (rfNode.data as GhostData | undefined)?.appNode;
        if (ghost) cbRef.current.onInspectGhost?.(ghost);
      }
    },
    [isContext]
  );
  // По связи: тот же путь, что у плашки (openEdgeMembers → одна связь сразу в панель,
  // несколько — выбор участника, см. TreePage).
  const handleEdgeDoubleClick = useCallback(
    (_e: MouseEvent, rfEdge: RFEdge) => {
      if (isContext) return;
      const memberIds = (rfEdge.data as WrappedEdgeData | undefined)?.memberIds ?? [];
      cbRef.current.openEdgeMembers(memberIds);
    },
    [isContext]
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

  // УСТОЙЧИВАЯ подсветка связанного по двойному клику (П5/П6): что открыто в правой панели,
  // то и подсвечено, пока открыто. Узел → он сам + инцидентные отрисованные стрелки; связь
  // → её отрисованное ребро (панель держит ЧЛЕНА пучка — ищем несущее ребро) + оба его узла.
  // Как и locate — императивно по data-id (не ввязываем пересборку rfNodes из async-раскладки);
  // отличие: держим до смены выделения (класс снимаем в cleanup, а не по таймеру). Зависимость
  // от rfNodes/rfEdges — переналожение после пере-раскладки/ремаунта холста.
  useEffect(() => {
    if (!linkedHighlight || isContext) return;
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    if (linkedHighlight.kind === "node") {
      nodeIds.add(linkedHighlight.id);
      for (const e of rfEdges) {
        if (e.source === linkedHighlight.id || e.target === linkedHighlight.id) edgeIds.add(e.id);
      }
    } else {
      const re = rfEdges.find((e) => {
        const mids = (e.data as WrappedEdgeData | undefined)?.memberIds;
        return mids ? mids.includes(linkedHighlight.id) : e.id === linkedHighlight.id;
      });
      if (re) {
        edgeIds.add(re.id);
        if (re.source) nodeIds.add(re.source);
        if (re.target) nodeIds.add(re.target);
      }
    }
    if (nodeIds.size === 0 && edgeIds.size === 0) return;
    let applied: Element[] = [];
    const raf = requestAnimationFrame(() => {
      for (const id of nodeIds) {
        const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
        if (el) { el.classList.add("lg-linked-node"); applied.push(el); }
      }
      for (const id of edgeIds) {
        const el = document.querySelector(`.react-flow__edge[data-id="${CSS.escape(id)}"]`);
        if (el) { el.classList.add("lg-linked-edge"); applied.push(el); }
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      for (const el of applied) el.classList.remove("lg-linked-node", "lg-linked-edge");
      applied = [];
    };
  }, [linkedHighlight, rfNodes, rfEdges, isContext]);

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
        // окно анимации раскрытия/сворачивания: CSS-transition на узлах и рамках
        (animActive ? " lg-canvas--anim" : "")
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
        onNodeDoubleClick={handleNodeDoubleClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStopP}
        onSelectionDragStart={handleSelectionDragStart}
        onSelectionDrag={handleSelectionDrag}
        onSelectionDragStop={handleSelectionDragStopP}
        // Создание новой связи протягиванием от хэндла узла. onConnect ловит защёлку
        // конца на ХЭНДЛ (в радиусе connectionRadius) → прямая связь к узлу;
        // onConnectEnd — дроп мимо хэндлов → «зона входа» (тело контейнера) или
        // прямая связь (тело листа).
        onConnectStart={handleConnectStart}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidNewConnection}
        // прощающий радиус защёлки конца на хэндл: попасть в периметр-хэндл узла
        // легко, при этом центр тела (≥ полширины узла от хэндлов) остаётся «зоной входа»
        connectionRadius={30}
        connectionMode={ConnectionMode.Loose}
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
            div-ы хука useFrameFollowOverlay (императивно, без setState на тик). */}
        {frameFollow.overlay && <ViewportPortal>{frameFollow.overlay}</ViewportPortal>}
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
        {/* Индикация цели дропа в раскрытую рамку: подсвечиваем её контур («рамка
            раскрывается шире под новый узел» — узел станет ребёнком её контейнера). */}
        {dropTargetFrame && (
          <ViewportPortal>
            <div
              style={{
                position: "absolute",
                left: dropTargetFrame.rect.x,
                top: dropTargetFrame.rect.y,
                width: dropTargetFrame.rect.w,
                height: dropTargetFrame.rect.h,
                pointerEvents: "none",
                zIndex: 4,
                borderRadius: 14,
                border: "2px solid #6366f1",
                background: "rgba(99, 102, 241, 0.06)",
                boxShadow: "0 0 0 3px rgba(99, 102, 241, 0.15)",
              }}
            />
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
