import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
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
  type Viewport,
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
import type { LayoutResult } from "./graph/layout/pipeline";
import { computeViewLayoutOffThread } from "./graph/layout/pipelineClient";
import { layoutSig } from "./graph/layout/layoutSig";
import { assembleRfGraph } from "./graph/assembleRf";
import { relevantChildren, relevantChildCounts } from "./graph/relevantChildren";
import { reconcileNodes, reconcileEdges } from "./graph/reconcileRf";
import { NodeShapeSvg } from "./graph/shapes";
import { nodeTypes } from "./graph/nodes";
import { edgeTypes } from "./graph/edges";
import { trunkHitAt } from "./graph/trunkHit";
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
import { useLayoutAnimation, type LayoutGate } from "./graph/interaction/useLayoutAnimation";
import { ANIM_MOVE_MS } from "./graph/interaction/layoutAnimation";
import { useFrameFollowOverlay } from "./graph/interaction/useFrameFollowOverlay";
import { useLiveDragHandles, type LiveHandleInputs } from "./graph/interaction/useLiveDragHandles";
import { planPersistFailure, type CommitOrigin } from "./graph/interaction/persistGuard";
import { isConflict } from "../api/client";

// --- Основной компонент ---

// Стабильный пустой дефолт для viewLayout: дефолт-параметр `= {}` создавал бы
// НОВЫЙ объект на каждый рендер, а он — зависимость async-эффекта раскладки → лишний
// перезапуск ELK и мигание. Один модульный объект держит ссылку стабильной.
const EMPTY_VIEW_LAYOUT: ViewLayout = {};

// Опции центрирования страничных схем (fitOnLoad/fitOnExpand и кнопка «Центрировать»
// встроенных блоков): единый источник, чтобы авто-фит и ручное центрирование давали
// идентичный вид. maxZoom 1.0 — не раздувать разреженные схемы (1–2 узла) крупнее
// натурального размера, но и не мельчить (прежние 0.85 оставляли схемы «мелко»).
const SCHEMA_FIT_OPTIONS = { padding: 0.1, maxZoom: 1.0 };

interface LevelGraphProps {
  nodes: AppNode[];
  // реестр не-локальных концов рёбер уровня (R2): гости И глубокие концы внутри
  // поддерева, с цепочками предков. Проекцию на видимые сущности делает конвейер.
  // В контекст-режиме сюда передаются соседи фокуса (пре-спроецированные сервером).
  endpoints: GhostNode[];
  // раскладка вида как есть (R3, единое хранилище view_layout): item_id → payload.
  // Позиции — по id сущности (локалы/гости/контейнеры единообразно); геометрия
  // рёбер не хранится (авто-слой, легаси-ключи пучков "b:" отфильтрованы бэком).
  // Контекст-схема раскладку не хранит — {}.
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
  // Двойной клик по пустому холсту — сбросить выделение (подсветку связанного) и очистить
  // правую панель. Вызывается только для клика по пустому pane, не по узлу/ребру.
  onClearSelection?: () => void;
  // клик по описанию связи (одиночной или «мастер-стрелке») — список для выбора.
  // Даже одиночная связь открывает «Выберите связь»: оттуда можно дозаписать новую
  // связь в том же направлении, а не городить отдельную стрелку.
  onEdgesChoice: (edges: AppEdge[]) => void;
  // ОБЩЕЕ ПЛЕЧО (E80): двойной клик в точке легального ствола ≥2 отрисованных
  // связей — модалка выбора с направлением ствола (вместо обычной детализации)
  onTrunkChoice?: (kind: "out" | "in", edges: AppEdge[]) => void;
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
  // Общая история Undo/Redo, поднятая в TreePage: команды перемещений кладёт
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
  // Возвращаемый промис (ресинк) нужен политике 409: переигровка user-патча ждёт
  // завершения перезагрузки уровня.
  onPersistError?: (e: unknown) => void | Promise<void>;
  // Версия вида (fence записей раскладки) + курсор проекта (поллинг) — живой
  // снимок, шарится с TreePage мутируемым ref'ом: TreePage наполняет его из
  // GraphResponse при load(), LevelGraph читает версию при каждой записи и
  // обновляет из ответов PUT. Не передан (read-only блок) — записи всё равно не
  // идут (гейт readOnly); на уровне ОБЯЗАТЕЛЕН для fence.
  viewMeta?: { current: ViewMetaState };
  // Флаг «идёт жест драга» для поллинга этапа 1: TreePage пропускает рефетч,
  // пока пользователь тащит узлы (перезагрузка уровня посреди жеста снесла бы
  // RF-стейт под рукой). Реф, не колбэк — ноль ре-рендеров на жест.
  gestureActiveRef?: { current: boolean };
  // Канал переигровки 409 user-батча (этап 0): persistFenced отдаёт исходный
  // патч НАВЕРХ (onPersistConflict), TreePage делает ресинк и возвращает патч
  // пропом retryPatch. Канал живёт в TreePage сознательно: ресинк показывает
  // «Загрузка…» и РАЗМОНТИРУЕТ холст — локальный стейт канала умер бы вместе с
  // ним (ретрай терялся, найдено e2e-зондом).
  onPersistConflict?: (patch: Record<string, Partial<ViewLayoutPayload> | null>) => void;
  retryPatch?: { patch: Record<string, Partial<ViewLayoutPayload> | null>; token: number } | null;
  // Read-only: все жесты правки отключены (драг, связи, удаление, дроп, персист
  // раскладки), но рендер уровня и навигация (двойной клик, выделение) сохраняются.
  // Для встроенных блоков схемы на страницах (pages_pivot).
  readOnly?: boolean;
  // Инспекция связей (двойной клик по стрелке/общему плечу → подсветка полного
  // пути, модалка выбора) доступна и в read-only: это просмотр, не правка.
  // По умолчанию гейтится readOnly (?? !readOnly) — редактор не передаёт и ведёт
  // себя как прежде; встроенные блоки просмотра передают true.
  edgesInspectable?: boolean;
  // Переопределение draggable-узлов: true — узлы можно таскать даже в readOnly
  // (персист раскладки при этом НЕ идёт — только визуальный драг в рамках сессии).
  // По умолчанию: !readOnly.
  nodesDraggable?: boolean;
  // Режим «только расстановка» (встроенные блоки на страницах): драг узлов,
  // персист раскладки и undo/redo перемещений ВКЛЮЧЕНЫ, но создание/удаление
  // связей и узлов, дроп шаблонов — ВЫКЛЮЧЕНЫ (это зона редактора-карты).
  arrangeOnly?: boolean;
  // Стартовать свёрнутым: персистные раскрытия вида (payload.expanded) НЕ
  // применяются — раскрытия только эфемерными кликами лупы этой сессии.
  // Страничные схемы (проекта и объекта) стартуют свёрнутыми единообразно
  // (решение 2026-07-30); редактор-карта флаг не передаёт и восстанавливает
  // персистные раскрытия как прежде (container.md C7).
  ignorePersistedExpanded?: boolean;
  // Авто-центрирование вида (встроенные блоки на страницах). fitOnLoad — вписать
  // контент ПОСЛЕ оседания раскладки (двухфазная: фолбэк-габариты → замер →
  // пере-прогон; декларативный fitView снимает лишь первый проход и «сползает»).
  // fitOnExpand — анимированно центрировать при каждом раскрытии узла лупой
  // (контент может уехать за край окна). Оба используют SCHEMA_FIT_OPTIONS — те же
  // опции, что кнопка «Центрировать» (Controls), чтобы вид совпадал с ручным.
  // Редактор-карта флаги не передаёт — его центрирование не меняется.
  fitOnLoad?: boolean;
  fitOnExpand?: boolean;
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

// Живой снимок версий конкурентности (этап 0/1, docs/archive/plan-concurrency.md):
// version — fence вида, graphRev — курсор изменений проекта.
export type ViewMetaState = { version: number; graphRev: number; metaRev?: number };

// Запрос фокуса на объекте/связи/группе. ids: для node — [nodeId]; для edge — [edgeId];
// для group — id всех узлов кластера. token — монотонный счётчик из TreePage.
export type LocateRequest = {
  kind: "node" | "edge" | "group";
  ids: string[];
  // Для kind="edge": сырые концы связи из алерта. Фолбэк, когда самой связи нет
  // среди отрисованных (конец = раскрытый контейнер — проекция её скрывает,
  // E6/C19): фокусируем ПРЕДСТАВИТЕЛЕЙ концов (узел или рамку — id совпадает).
  endIds?: string[];
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
  onClearSelection,
  onEdgesChoice,
  onTrunkChoice,
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
  onPersistConflict,
  retryPatch,
  viewMeta,
  gestureActiveRef,
  readOnly = false,
  edgesInspectable,
  nodesDraggable: nodesDraggableProp,
  arrangeOnly = false,
  ignorePersistedExpanded = false,
  fitOnLoad = false,
  fitOnExpand = false,
  schemaView = "all",
  locate,
}: LevelGraphProps) {
  // readOnly гейтит все жесты правки, но не влияет на рендер уровня
  const isReadOnly = readOnly;
  // Драг узлов: по умолчанию !isReadOnly, но можно включить отдельно (embedded-блоки)
  const dragNodes = nodesDraggableProp ?? (arrangeOnly || !isReadOnly);
  // «Только расстановка»: драг/персист/undo доступны, структурная правка — нет.
  // canArrange — персист раскладки, снапы, undo/redo перемещений.
  // canStructure — создание/удаление связей и узлов, дроп шаблонов.
  const canArrange = arrangeOnly || !isReadOnly;
  const canStructure = !isReadOnly;
  // Инспекция связей — просмотр, не правка: доступна и в read-only, если явно
  // включена (встроенные блоки). Дефолт — прежнее поведение (гейт readOnly).
  const canInspectEdges = edgesInspectable ?? !isReadOnly;
  // drill-навигация (кнопки «Войти» на узлах): редактор передаёт onEnterNode,
  // страница объекта — нет (навигация двойным кликом + лупа).
  const drillNav = !!onEnterNode;
  const { screenToFlowPosition, setCenter, fitBounds, fitView, getInternalNode, getNodes, getEdges } = useReactFlow();
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

  // --- «Тихое окно» (Ф1 эпика плавности): на окно анимации раскрытия/сворачивания
  // прогоны конвейера раскладки ОТКЛАДЫВАЮТСЯ (holdRef), копятся флагом dirtyRef и
  // досчитываются в «мёртвой зоне» конца move (gate.flush, зовёт оркестратор
  // анимации) — тяжёлый счёт и тотальный apply не дёргают кадры разъезда узлов.
  // Владение здесь (не в хуке): счёт — computeNow этого компонента; хук только
  // дёргает фазы. Сигналы — СИНХРОННЫЕ ref'ы (state лагал бы на рендер).
  const holdRef = useRef(false); // окно открыто — счёт откладывать
  const dirtyRef = useRef(false); // в окне менялись входы раскладки
  const runIdRef = useRef(0); // «последний выигрывает» для async-прогонов
  const lastSigRef = useRef<string | null>(null); // сигнатура последнего применённого
  const appliedResolveRef = useRef<(() => void) | null>(null); // ждун применения (flush)
  const computeNowRef = useRef<() => Promise<"applied" | "skipped" | "stale">>(
    async () => "stale",
  );
  const gate = useMemo<LayoutGate>(() => ({
    hold: () => { holdRef.current = true; },
    // Флаш «мёртвой зоны»: досчитать отложенное и ДОЖДАТЬСЯ применения (резолв —
    // в эффекте-сборщике после applyLayout, либо сразу — если прогон скипнут по
    // сигнатуре или перегнан более свежим: тогда применение придёт от победителя.
    flush: async () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const applied = new Promise<void>((res) => { appliedResolveRef.current = res; });
      const r = await computeNowRef.current();
      if (r === "applied") await applied;
      else appliedResolveRef.current = null;
    },
    // Окно закрыто (endDraw/cancel): hold снять; накопившееся досчитать в фоне.
    release: () => {
      holdRef.current = false;
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void computeNowRef.current();
      }
    },
    // Смена уровня: накопленное протухло — новый уровень пересчитает свой эффект.
    reset: () => {
      holdRef.current = false;
      dirtyRef.current = false;
    },
  }), []);

  // Анимация раскрытия/сворачивания контейнеров: единственная точка применения
  // раскладки к RF-стейту (applyLayout вместо прямых setRfNodes/setRfEdges в
  // сборщике). Интенты ставят обработчики лупы/сворачивания; окно анимации
  // включает класс lg-canvas--anim (CSS-transition в LevelGraph.css).
  const {
    apply: applyLayout, noteExpand, noteCollapse, noteGesture,
    cancel: cancelAnim, reset: resetAnim, active: animActive, jumpsPaused,
  } = useLayoutAnimation({ getNodes, getEdges, setRfNodes, setRfEdges, gate });
  // Смена уровня/режима: отложенная анимация протухла — жёсткий сброс без доигровки
  // (свежую раскладку нового уровня применит сборщик).
  useEffect(() => { resetAnim(); }, [containerId, resetAnim]);

  // Авто-центрирование (fitOnLoad/fitOnExpand): expandFitRef взводится при раскрытии
  // (commitExpanded), didLoadFitRef — одноразовый фит загрузки (на маунт; холст
  // ремаунтится по key=node.id, поэтому «один раз» == «один раз на страницу»).
  // Таймер — дебаунс оседания раскладки (двухфазная: замер может прийти вторым
  // прогоном, фитим по последнему в окне).
  const expandFitRef = useRef(false);
  const didLoadFitRef = useRef(false);

  // ЕДИНАЯ запись раскладки вида (R3): merge-патч поверх зеркала viewLayout →
  // батч-PUT view_layout + зеркало родителю (onLayoutChanged). Сервер заменяет
  // payload строки ЦЕЛИКОМ, поэтому частичный патч мержится здесь; null-патч —
  // удалить строку (сброс в авто); null-ПОЛЕ в патче попадает в merged, сервер
  // выкидывает его как None (exclude_none) — сброс отдельного поля.
  // Возвращает, была ли запись: false — весь батч погашен дедупом/гардами, смены
  // viewLayout (и пересчёта раскладки) НЕ будет — по этому сигналу dragStop
  // откатывает живое превью рёбер (liveDragHandles.restore).
  //
  // Фенсированный персист (этап 0 конкурентности): запись несёт base_version
  // вида; устаревшая (вид изменён другой сессией) → 409 → политика
  // planPersistFailure: user-интент после ресинка переигрывается ОДИН раз
  // исходным патчем (merge заново, уже от свежего зеркала), derived-интент
  // выбрасывается — пересчёт конвейера от свежих данных сам родит актуальное.
  // Переигровку исполняет канал TreePage (onPersistConflict → проп retryPatch,
  // см. комментарий к пропу); без канала (не передан) — деградация до ресинка.
  // ОЧЕРЕДЬ фенсированных записей: батчи одной сессии идут СТРОГО по одному —
  // base_version читается в момент СТАРТА задачи (после ответа предыдущей), а не
  // постановки. Без очереди параллельные свои же батчи делили одну версию и
  // ловили самоконфликт 409 → ресинк («вспышка» исходной картинки посреди
  // анимации раскрытия; репро: spawn-probe --relayout-first --slow-layout —
  // после «Переразложить» массовый derived-засев уровня висит в полёте, а клик
  // раскрытия уезжает с той же версией). Fence остаётся против ЧУЖИХ сессий.
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const persistFenced = useCallback(
    (
      items: Record<string, ViewLayoutPayload | null>,
      patch: Record<string, Partial<ViewLayoutPayload> | null>,
      origin: CommitOrigin,
      isRetry: boolean,
    ): void => {
      persistChainRef.current = persistChainRef.current.then(() =>
        viewsApi
          .saveLayout(containerId, items, viewMeta?.current.version)
          .then((res) => {
            if (viewMeta) viewMeta.current = { version: res.version, graphRev: res.graph_rev };
          })
          .catch((e: unknown) => {
            console.error("Запись раскладки не прошла — ресинхронизирую уровень из БД", e);
            if (
              planPersistFailure(isConflict(e), origin, isRetry) === "retry-after-resync" &&
              onPersistConflict
            ) {
              onPersistConflict(patch); // ресинк + возврат патча пропом — наверху
              return;
            }
            void onPersistError?.(e);
          }),
      );
    },
    [containerId, onPersistError, onPersistConflict, viewMeta],
  );
  const commitLayout = useCallback(
    (
      patch: Record<string, Partial<ViewLayoutPayload> | null>,
      origin: CommitOrigin = "user",
      isRetry = false,
    ): boolean => {
      if (!isArchitect || !canArrange) return false;
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
      if (Object.keys(items).length === 0) return false;
      persistFenced(items, patch, origin, isRetry);
      onLayoutChanged?.(items);
      return true;
    },
    [isArchitect, canArrange, viewLayout, persistFenced, onLayoutChanged],
  );
  // Исполнитель переигровки 409 (проп retryPatch из TreePage): одноразово (token)
  // коммитит исходный патч заново — commitLayout здесь из deps, т.е. замкнут на
  // СВЕЖЕЕ зеркало после ресинка (типично это уже НОВЫЙ маунт холста — ресинк
  // показывает «Загрузка…»); isRetry=true — второй 409 уже не переигрывается.
  const retryDoneRef = useRef(0);
  useEffect(() => {
    if (!retryPatch || retryPatch.token === retryDoneRef.current) return;
    retryDoneRef.current = retryPatch.token;
    commitLayout(retryPatch.patch, "user", true);
  }, [retryPatch, commitLayout]);
  // СТАБИЛЬНАЯ обёртка коммита для долгоживущих замыканий (команды undo/redo в
  // истории живут произвольно долго): всегда зовёт СВЕЖИЙ commitLayout. Иначе
  // дедуп выше сравнивал бы патч со СНИМКОМ viewLayout из момента создания
  // команды и гасил бы законную запись: Ctrl+Z перемещения молча не работал
  // (undo-патч «вернуть старую позицию» совпадает со старым зеркалом; сломано
  // дедупом cb2faad 2026-07-07, вскрыто смоуком Ф2 эпика плавности).
  const commitLayoutRef = useRef(commitLayout);
  useEffect(() => { commitLayoutRef.current = commitLayout; });
  const commitLayoutStable = useCallback(
    (patch: Record<string, Partial<ViewLayoutPayload> | null>) => commitLayoutRef.current(patch),
    [],
  );

  // Последний применённый результат конвейера (заполняется эффектом у стейта
  // layout ниже): own-on-expand берёт отсюда абсолютную позицию контейнера.
  const layoutLatestRef = useRef<LayoutResult | null>(null);

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
    // Страничные схемы стартуют свёрнутыми: сохранённые раскрытия вида не
    // применяются (ignorePersistedExpanded), живут только клики этой сессии.
    if (!ignorePersistedExpanded) {
      for (const [id, p] of Object.entries(viewLayout)) if (p.expanded) s.add(id);
    }
    for (const [id, v] of expandOverrides) {
      if (v) s.add(id);
      else s.delete(id);
    }
    return s;
  }, [viewLayout, expandOverrides, ignorePersistedExpanded]);

  // read-only (страница): дети, релевантные схеме, — «отображаемое = связанное
  // рёбрами» (тот же принцип, что у гостей, X16 v2). counts гейтит лупу и бейдж
  // без фетча списков детей; фильтр собирает состав кэша при раскрытии.
  const relevantCounts = useMemo(
    () => (isReadOnly ? relevantChildCounts(edges, endpoints, expanded) : undefined),
    [isReadOnly, edges, endpoints, expanded],
  );

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
      // Раскрытие (value=true) в режиме fitOnExpand — запрос на анимированное
      // центрирование после оседания раскладки (см. эффект авто-центрирования).
      // Сворачивание (value=false) центрирование не запрашивает.
      if (value && fitOnExpand) expandFitRef.current = true;
      setExpandOverrides((prev) => new Map(prev).set(id, value));
      // персист (архитектор, не контекст — гейтит commitLayout): true — раскрыт,
      // null-поле — сброс (exclude_none выкинет его из payload строки).
      // OWN-ON-EXPAND: контейнер, не владевший позицией (чисто-ELK уровень —
      // типично сразу после импорта), при раскрытии закрепляет текущую. Иначе
      // сетке первого показа детей не от чего стартовать, и ребёнка без видимых
      // рёбер (все его связи ведут в сам раскрытый контейнер и дропнуты
      // проекцией) ELK уносил изолированной компонентой в угол канвы — рамка
      // «раскрывалась» вдали от места клика, под левой панелью.
      const p = viewLayout[id];
      const owned = p?.x != null && p?.y != null;
      const cur = value && !owned ? layoutLatestRef.current?.positions.get(id) : undefined;
      commitLayout({ [id]: { expanded: value ? true : null, ...(cur ? { x: cur.x, y: cur.y } : null) } });
    },
    [commitLayout, viewLayout, fitOnExpand],
  );
  // Раскрытие ГОСТЕВОГО контейнера: детей даёт проекция (реестр endpoints).
  const expandContainer = useCallback(
    (id: string) => { noteExpand(id); commitExpanded(id, true); },
    [commitExpanded, noteExpand],
  );
  // Раскрытие ЛОКАЛЬНОГО контейнера (R5): лениво догружаем его прямых детей —
  // по Д3 показываются ВСЕ дети, а /graph уровня их не отдаёт.
  // Ф2 плавности: expanded включается ПО ПРИХОДУ детей (одним батчем с
  // localChildren) — иначе между кликом и фетчем успевал стартовать прогон
  // «expanded есть, детей нет» (контейнер в нём всё равно свёрнут), который
  // только скипался по сигнатуре, съедая ~60мс латентности старта анимации.
  // С тёплым кэшем раскрываем сразу (повторное раскрытие мгновенно, как раньше).
  const expandLocalContainer = useCallback(
    (id: string) => {
      if (localChildren[id]) {
        noteExpand(id);
        commitExpanded(id, true);
        return;
      }
      void nodesApi.list(id).then((kids) => {
        // read-only (страница): только дети, релевантные текущей схеме, —
        // «отображаемое = связанное рёбрами» (как у гостей, X16 v2). Раскрываемый
        // контейнер — в наборе раскрытых: рёбра «в его рамку» границу не образуют.
        const fit = isReadOnly
          ? relevantChildren(kids, edges, endpoints, new Set([...expanded, id]))
          : kids;
        // Пустое раскрытие (все дети нерелевантны): не раскрываем; лупа у узла
        // уже погашена счётчиком relevantCounts.
        if (fit.length === 0) return;
        noteExpand(id);
        commitExpanded(id, true);
        setLocalChildren((cur) => (cur[id] ? cur : { ...cur, [id]: fit }));
      });
    },
    [localChildren, commitExpanded, noteExpand, isReadOnly, edges, endpoints, expanded],
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
    if (isReadOnly) return;
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
  }, [expanded, nodes, localChildren, isReadOnly]);

  // Таргетный рефреш кэша детей одного контейнера (дроп нового узла в его раскрытую рамку /
  // откат такого дропа): перечитываем список и ПЕРЕЗАПИСЫВАЕМ (в отличие от ленивой догрузки
  // выше — та не трогает уже заполненный ключ). token гарантирует срабатывание на повтор.
  const refreshTokenRef = useRef(0);
  useEffect(() => {
    if (isReadOnly || !refreshChildrenOf) return;
    if (refreshChildrenOf.token === refreshTokenRef.current) return;
    refreshTokenRef.current = refreshChildrenOf.token;
    const { id } = refreshChildrenOf;
    void nodesApi.list(id).then((kids) => {
      setLocalChildren((cur) => ({ ...cur, [id]: kids }));
    });
  }, [refreshChildrenOf, isReadOnly]);

  // Состояние центральных направляющих магнитного выравнивания (общее для snap-драга
  // и drop-шаблона).
  const { guides, setGuides, clearGuides } = useAlignmentGuides();

  // История Undo/Redo (Ctrl+Z / Ctrl+Shift+Z). На основном канвасе её поднимают в
  // TreePage (туда же кладутся структурные команды и дисптчеры с кросс-уровневым
  // редиректом); ownHistory — фолбэк для контекст-модалки, где истории не нужно.
  const ownHistory = useHistory();
  const baseHistory = historyProp ?? ownHistory;
  // Команды этого канваса (перемещения) ШТАМПУЕМ текущим containerId,
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
    if (!isArchitect || !canArrange) return;
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
  }, [isArchitect, canArrange, runUndo, runRedo]);

  // Магнитное выравнивание узлов при драге + персист позиции по отпусканию.
  // commitLayout — стабильной обёрткой: команды undo/redo, которые useSnapAlignment
  // кладёт в историю, обязаны коммитить через СВЕЖЕЕ зеркало (см. commitLayoutStable).
  const { handleNodesChange, handleNodeDragStop, handleSelectionDragStop, noteDragStart } = useSnapAlignment({
    rfNodes, onNodesChange, setGuides, isArchitect, disabled: !canArrange,
    ancestorIds, ancestorNames, commitLayout: commitLayoutStable, push: history.push,
    noteGesture, // флаш клавиатурной серии открывает окно жеста, как отпускание драга
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
      if (gestureActiveRef) gestureActiveRef.current = true; // поллинг этапа 1: рефетч не врывается в жест
      cancelAnim(); // transition раскрытия не должен цеплять жест — мгновенно доиграть
      const grp = ns.length > 0 ? ns : [n];
      liveDragHandles.begin(rfNodes, rfEdges); // база позиций узлов + снимок маршрутов на старте
      noteDragStart(grp); // фиксируем «старые» позиции для инверсии перемещения
      frameFollow.snapshotPads(); // паддинги рамок для живого bbox-follow
      frameFollow.begin(grp); // скрыть рамки-предки, включить живой оверлей
    },
    [liveDragHandles, rfNodes, rfEdges, noteDragStart, frameFollow, cancelAnim, gestureActiveRef],
  );
  const handleSelectionDragStart = useCallback(
    (_e: MouseEvent, ns: RFNode[]) => {
      setDragging(true);
      if (gestureActiveRef) gestureActiveRef.current = true;
      cancelAnim();
      liveDragHandles.begin(rfNodes, rfEdges);
      noteDragStart(ns);
      frameFollow.snapshotPads();
      frameFollow.begin(ns);
    },
    [liveDragHandles, rfNodes, rfEdges, noteDragStart, frameFollow, cancelAnim, gestureActiveRef],
  );
  const handleNodeDrag = useCallback(
    (_e: MouseEvent, _n: RFNode, ns: RFNode[]) => { liveDragHandles.move(ns); frameFollow.follow(ns); },
    [liveDragHandles, frameFollow],
  );
  const handleSelectionDrag = useCallback(
    (_e: MouseEvent, ns: RFNode[]) => { liveDragHandles.move(ns); frameFollow.follow(ns); },
    [liveDragHandles, frameFollow],
  );
  // Отпускание драга: persistGroup сам кладёт ОДНУ команду на весь жест;
  // beginGroup/commitGroup вокруг — страховка, чтобы сопутствующие push-и
  // (если появятся) не разбили жест на несколько шагов Undo.
  const handleNodeDragStopP = useCallback(
    (e: MouseEvent, n: RFNode, ns: RFNode[]) => {
      setDragging(false);
      frameFollow.finalize(); // рамки: финальный bbox одним setState + вернуть видимость
      noteGesture(); // изменённые пересчётом стрелки перерисовать анимированно
      history.beginGroup();
      try {
        // персист первым: нужен факт записи — жест без неё (нетто-сдвига нет)
        // не сменит viewLayout и не запустит пересчёт, поэтому живое превью
        // рёбер откатывается к состоянию старта (иначе висело бы насовсем)
        const committed = handleNodeDragStop(e, n, ns);
        if (!committed) liveDragHandles.restore();
        else dragScopeRef.current = [n.id]; // пересчёт заскоуплен на перетащенный узел
      } finally {
        liveDragHandles.end();
        history.commitGroup("Перемещение группы");
        if (gestureActiveRef) gestureActiveRef.current = false;
      }
    },
    [liveDragHandles, handleNodeDragStop, history, frameFollow, noteGesture, gestureActiveRef],
  );
  const handleSelectionDragStopP = useCallback(
    (e: MouseEvent, ns: RFNode[]) => {
      setDragging(false);
      frameFollow.finalize();
      noteGesture();
      history.beginGroup();
      try {
        const committed = handleSelectionDragStop(e, ns);
        if (!committed) liveDragHandles.restore();
        else dragScopeRef.current = ns.map((x) => x.id); // скоуп на всю перетащенную группу
      } finally {
        liveDragHandles.end();
        history.commitGroup("Перемещение группы");
        if (gestureActiveRef) gestureActiveRef.current = false;
      }
    },
    [liveDragHandles, handleSelectionDragStop, history, frameFollow, noteGesture, gestureActiveRef],
  );

  // Удаление выбранного узла с клавиатуры через подтверждение.
  const { handleKeyDown } = useCanvasDelete({
    rfNodes, isArchitect, disabled: !canStructure, onRequestDeleteNode, onRequestDeleteNodes,
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
      isArchitect, disabled: !canStructure, resolveTarget,
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
  const onConnectIntoRef = useRef(onConnectInto);
  const resolveTargetRef = useRef(resolveTarget);
  const displayNameOfRef = useRef(displayNameOf);
  useEffect(() => {
    qcRef.current = qc;
    qcCandidateRef.current = qcCandidate;
    onCreateEdgeRef.current = onCreateEdge;
    onConnectIntoRef.current = onConnectInto;
    resolveTargetRef.current = resolveTarget;
    displayNameOfRef.current = displayNameOf;
  });
  const quickConnectHandlers = useMemo<QuickConnectHandlers>(() => ({
    enter: (sourceId, sourceHandle, side, frac) => setQc({ sourceId, sourceHandle, side, frac }),
    leave: () => setQc(null),
    activate: () => {
      const q = qcRef.current, c = qcCandidateRef.current;
      setQc(null);
      if (!q || !c) return;
      const nameOf = displayNameOfRef.current;
      // Цель-«зона входа» (контейнер или сервис с детьми) и у быстрой связи уводит
      // в выбор потомка — как дроп протягивания в тело (E73). Прямая связь в
      // промежуточный объект рождала бы алерт intermediate_edges (баг 2026-07-16).
      const target = resolveTargetRef.current(c.targetId);
      if (target && target.kind === "into") {
        onConnectIntoRef.current?.(
          q.sourceId, c.targetId, target.name, q.sourceHandle, nameOf(q.sourceId),
        );
        return;
      }
      onCreateEdgeRef.current?.(
        q.sourceId, c.targetId, q.sourceHandle, c.targetHandle,
        nameOf(q.sourceId), nameOf(c.targetId),
      );
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
  // связи того же направления). Общая точка для двойного клика по линии и по
  // плашке с описанием.
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
  // Выбор связи ОБЩЕГО ПЛЕЧА (E80): члены отрисованных участников ствола флаттенятся
  // до связей БД. Меньше двух связей (вырожденный ствол) — false, вызывающий уходит
  // в обычную детализацию.
  const openTrunkMembers = useCallback(
    (kind: "out" | "in", memberIds: string[]): boolean => {
      const members = memberIds
        .map((mid) => edges.find((e) => e.id === mid))
        .filter((e): e is AppEdge => e != null);
      if (members.length < 2 || !onTrunkChoice) return false;
      onTrunkChoice(kind, members);
      return true;
    },
    [edges, onTrunkChoice],
  );

  const cbRef = useRef({ onDrillDown, drillWithPath, onEnterNode, onEditNode, onInspectGhost, onClearSelection, expandContainer, expandLocalContainer, collapseContainer, openEdgeMembers, openTrunkMembers, commitLayout, quickConnect: quickConnectHandlers });
  // Канонический latest-ref: обновляем cbRef.current в эффекте БЕЗ зависимостей (после
  // каждого рендера). Объявлен ДО эффекта сборки ниже — порядок исполнения эффектов =
  // порядок объявления, поэтому сборка читает уже свежий cbRef.current. Поведенчески
  // ноль: и события узлов, и эффекты исполняются после рендера.
  useEffect(() => {
    cbRef.current = { onDrillDown, drillWithPath, onEnterNode, onEditNode, onInspectGhost, onClearSelection, expandContainer, expandLocalContainer, collapseContainer, openEdgeMembers, openTrunkMembers, commitLayout, quickConnect: quickConnectHandlers };
  });
  // Ленивая читалка колбэков для сборки: обработчики в data собранных объектов зовут
  // getCb() в момент клика (не при сборке) — объект может пережить несколько прогонов
  // (скип Ф1, реконсиляция Ф2), а действия обязаны идти через СВЕЖИЙ commitLayout.
  const getCb = useCallback(() => cbRef.current, []);

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
  // Последний применённый layout — latest-ref для обработчиков, объявленных выше
  // по файлу (own-on-expand в commitExpanded читает позицию контейнера в момент
  // клика). Зеркалим только эффектом (react-hooks/refs).
  useEffect(() => { layoutLatestRef.current = layout; });
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
  // Скоуп пересчёта после драга (фикс дрейфа): id узлов последнего жеста. computeNow
  // передаёт их конвейеру (роутятся только их рёбра, остальные — из prevRoutes) и сразу
  // обнуляет — следующий прогон (не дроп) считает всё целиком.
  const dragScopeRef = useRef<string[] | null>(null);
  useEffect(() => { prevRoutesRef.current = null; lastSigRef.current = null; }, [containerId]);

  // Сборка RF-узлов/рёбер из раскладки и синхронизация в контролируемый стейт RF.
  // Стейт нужен мутабельным: onNodesChange/onEdgesChange пишут туда драг и выделение
  // МЕЖДУ пересчётами. Сама сборка — чистая функция assembleRfGraph (вынесена при
  // распиле Ф2); nodes берутся ИЗ layout (снимок, по которому он посчитан), а не из
  // пропа — позиции и данные согласованы, эффект не срабатывает со старым layout.
  // Колбэки — из latest-ref (cbRef), поэтому в зависимостях только данные.
  // ПОРЯДОК ОБЪЯВЛЕНИЯ ВАЖЕН (Ф1): сборщик стоит ПЕРЕД эффектом раскладки. Прогон,
  // открывающий окно анимации, приносит setLayout и зеркало интентов (viewLayout)
  // ОДНИМ батчем; сборщик успевает применить план (applyLayout → gate.hold())
  // до того, как эффект раскладки среагирует на viewLayout, — зеркальный прогон
  // не стартует в окно, а откладывается (dirty) до флаша.
  useEffect(() => {
    if (!layout) return; // первый рендер до резолва async-раскладки
    const { nextNodes, nextEdges } = assembleRfGraph({
      layout, isArchitect, isReadOnly, drillNav, relevantCounts, depth, schemaView, getCb,
    });
    // Реконсиляция (Ф2): содержательно неизменённые объекты заменяются ПРОШЛЫМИ
    // из стейта RF — React.memo узлов/рёбер снова работает, apply перестаёт
    // ре-рендерить всю сцену (заодно неизменённые узлы переживают пересчёт с
    // сохранённым выделением/замерами).
    const recNodes = reconcileNodes(getNodes(), nextNodes);
    const recEdges = reconcileEdges(getEdges(), nextEdges);
    // Применение — через оркестратор анимации: без интента раскрытия/сворачивания
    // это те же setRfNodes/setRfEdges, с интентом — режиссированный переход.
    applyLayout(recNodes, recEdges);
    // Применение состоялось — разбудить ждущий флаш тихого окна: unmask ждёт
    // именно ПРИМЕНЕНИЯ (не конца счёта), чтобы drawIn рисовал свежие маршруты.
    appliedResolveRef.current?.();
    appliedResolveRef.current = null;
  }, [layout, isArchitect, depth, isReadOnly, drillNav, relevantCounts, schemaView, applyLayout, getCb, getNodes, getEdges]);

  // Один прогон конвейера раскладки (бывшее тело async-эффекта; Ф1 вынесла его в
  // колбэк, чтобы флаш тихого окна мог досчитать отложенное со СВЕЖИМИ пропсами).
  // «Последний выигрывает»: прогон, перегнанный более новым (runIdRef), не пишет
  // ничего — ни снапшота гистерезиса, ни персиста интентов, ни setLayout.
  const computeNow = useCallback(async (): Promise<"applied" | "skipped" | "stale"> => {
    const runId = ++runIdRef.current;
    // Счётчик «раскладка в полёте» — сигнал занятости для полигона (dump-levels ждёт
    // нуля перед снятием сигнатуры): раскладка двухфазная (фолбэк-габариты → замер →
    // пере-прогон), и без явного сигнала снапшот ловил межфазное состояние.
    const w = window as unknown as { __archmapLayoutInflight?: number; __archmapLayoutRuns?: number };
    w.__archmapLayoutInflight = (w.__archmapLayoutInflight ?? 0) + 1;
    w.__archmapLayoutRuns = (w.__archmapLayoutRuns ?? 0) + 1;
    try {
      // гистерезис — только между прогонами с ОДНИМ комплектом замеров (см. prevRoutesRef)
      const sameSizes = prevRoutesRef.current?.version === sizesVersion;
      // скоуп после драга: роутим только рёбра перетащенных узлов (обрывает каскад rip-up
      // и дрейф). Обнуляем СРАЗУ: прогон берёт скоуп ровно один раз, следующий — полный.
      const scopeNodeIds = dragScopeRef.current ?? undefined;
      dragScopeRef.current = null;
      // Ф3: счёт в Web Worker — главный поток на время прогона свободен (фолбэк
      // на прямой вызов модуля внутри клиента; «последний выигрывает» — runId ниже).
      const { layout: next, liveInputs, intents } = await computeViewLayoutOffThread({
        nodes, endpoints, edges, containerId, viewLayout,
        ancestorIds: stableAncestorIds, expanded, localChildren,
        sizes: nodeSizesRef.current,
        prevRoutes: sameSizes ? prevRoutesRef.current?.routes : undefined,
        prevEdgeHandles: sameSizes ? prevRoutesRef.current?.handles : undefined,
        scopeNodeIds: sameSizes ? scopeNodeIds : undefined,
      });
      if (runId !== runIdRef.current) return "stale"; // устаревший прогон: ничего не пишет
      if (next.autoRoutes) {
        prevRoutesRef.current = { routes: next.autoRoutes, handles: next.edgeHandles, version: sizesVersion };
      }
      liveHandleInputs.current = liveInputs;
      // Побочные записи раскладки (интенты) — через единый commitLayout: засев владения
      // own-on-first-render. Зеркало onLayoutChanged кладёт их в viewLayout → следующий
      // прогон видит сохранённое и интент не повторяет. cbRef — чтобы не тащить
      // commitLayout в deps.
      for (const intent of intents) {
        // origin "derived": при 409 такой батч НЕ переигрывается — после ресинка
        // конвейер пересчитает сиды от свежего мира (устаревший интент — мусор).
        cbRef.current.commitLayout(
          Object.fromEntries(intent.seeds.map((s) => [s.id, { x: s.x, y: s.y }])),
          "derived",
        );
      }
      // Скип идентичных применений (Ф1): зеркальные прогоны (зеркало засева,
      // зеркало expanded) дают результат, идентичный применённому ПО ПОСТРОЕНИЮ, —
      // не дёргаем setLayout (и тотальную пересборку RF). Гистерезис, снимок
      // живого драга и интенты выше обновлены ОБЯЗАТЕЛЬНО и при скипе.
      const sig = layoutSig(next);
      if (sig === lastSigRef.current) return "skipped";
      lastSigRef.current = sig;
      setLayout(next);
      return "applied";
    } finally {
      w.__archmapLayoutInflight = (w.__archmapLayoutInflight ?? 1) - 1;
    }
    // Геометрия рёбер внутри viewLayout не вся влияет на позиции, НО зависимость — весь
    // объект намеренно: изломы/хэндлы пучков читает эффект-сборщик выше, и он должен
    // работать с ОДНИМ снапшотом (layout). Иначе при реконнекте смена хэндла (async-
    // раскладка) и сброс изломов (sync-стейт) рассинхронятся: сборщик сработал бы со
    // старым layout → ребро прыгнуло бы на исходный хэндл.
  }, [nodes, endpoints, containerId, viewLayout, edges, expanded, localChildren, stableAncestorIds, sizesVersion]);
  useEffect(() => { computeNowRef.current = computeNow; });
  // Инвалидация на размонтирование: полёт не должен персистить интенты после ухода
  // со страницы (прежняя cancelled-семантика закрывала это cleanup'ом эффекта).
  useEffect(() => () => { runIdRef.current++; }, []);

  // Эффект раскладки: данные изменились → пересчитать. В тихом окне (hold) — только
  // пометить dirty: счёт и применение случатся на флаше «мёртвой зоны» конца move
  // (или в release при отмене окна). Пересоздание computeNow == смена данных.
  useEffect(() => {
    if (holdRef.current) { dirtyRef.current = true; return; }
    void computeNow();
  }, [computeNow]);

  // Раскрытые рамки уровня (гостевые + локальные) как цели дропа шаблона: id контейнера
  // (будущий parent_id) + абсолютный rect + depth (глубочайшая побеждает при вложенности).
  const expandedFrames = useMemo<DropFrame[]>(
    () => (layout?.guestFrames ?? []).map((f) => ({ id: f.id, depth: f.depth, rect: f.rect })),
    [layout],
  );

  // Перетаскивание шаблона узла из палитры: превью-рамка + создание узла на drop.
  const { dropPreview, dropTargetFrame, handleDragOver, handleDragLeave, handleDrop } = useTemplateDrop({
    rfNodes, screenToFlowPosition, setGuides, clearGuides,
    isArchitect, disabled: !canStructure, onDropNode, dragShape, expandedFrames,
  });

  // Двойной клик — единственный триггер меты (правая панель); одиночный — только
  // штатное выделение RF. По узлу: только локальный блок (гость/контейнер не правим).
  // readOnly: двойной клик вызывает onEditNode/onInspectGhost для навигации на страницу.
  const handleNodeDoubleClick = useCallback(
    (_e: MouseEvent, rfNode: RFNode) => {
      if (rfNode.type === "block") {
        const appNode = (rfNode.data as BlockData | undefined)?.appNode;
        if (appNode) cbRef.current.onEditNode(appNode);
      } else if (rfNode.type === "ghost") {
        // Гость/сосед — навигация на страницу (в том числе в readOnly).
        const ghost = (rfNode.data as GhostData | undefined)?.appNode;
        if (ghost) cbRef.current.onInspectGhost?.(ghost);
      }
    },
    []
  );
  // По связи: сперва хит-тест ОБЩЕГО ПЛЕЧА (E80) — клик в точке легального ствола
  // ≥2 отрисованных связей открывает модалку ствола с направлением; иначе прежний
  // путь плашки (openEdgeMembers → одна связь сразу в панель, несколько — выбор
  // участника, см. TreePage). Клик по плашке сюда не попадает — она адресует свою
  // связь однозначно (E57).
  const handleEdgeDoubleClick = useCallback(
    (e: MouseEvent, rfEdge: RFEdge) => {
      if (!canInspectEdges) return;
      const dataOf = (re: RFEdge): WrappedEdgeData | undefined => re.data as WrappedEdgeData | undefined;
      const pt = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const ortho = rfEdges
        .map((re) => ({ id: re.id, pts: dataOf(re)?.autoRoute ?? [] }))
        .filter((re) => re.pts.length >= 2);
      const hit = trunkHitAt(ortho, rfEdge.id, pt);
      if (hit) {
        const flat = hit.memberIds.flatMap((gid) => {
          const re = rfEdges.find((x) => x.id === gid);
          return re ? dataOf(re)?.memberIds ?? [] : [];
        });
        if (cbRef.current.openTrunkMembers(hit.kind, flat)) return;
      }
      const memberIds = dataOf(rfEdge)?.memberIds ?? [];
      cbRef.current.openEdgeMembers(memberIds);
    },
    [canInspectEdges, rfEdges, screenToFlowPosition]
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

    // Собираем прямоугольники цели и селекторы подсветки. Связь ищем по id И по
    // членству в пучке (мастер-стрелка merge:* несёт сырые id в memberIds); связь,
    // скрытую проекцией (конец = раскрытый контейнер, E6/C19), фокусируем по
    // КОНЦАМ — их представители на холсте: узел либо рамка (id рамки = id узла, C3).
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    let flashSelectors: string[];
    if (locate.kind === "edge") {
      const rawId = locate.ids[0];
      const e = rfEdges.find(
        (x) =>
          x.id === rawId ||
          ((x.data as { memberIds?: string[] } | undefined)?.memberIds ?? []).includes(rawId),
      );
      if (e) {
        for (const id of [e.source, e.target]) {
          const r = rectOf(id);
          if (r) rects.push(r);
        }
        flashSelectors = [`.react-flow__edge[data-id="${CSS.escape(e.id)}"]`];
      } else {
        const foundEnds = (locate.endIds ?? []).filter((id) => rfNodes.some((n) => n.id === id));
        for (const id of foundEnds) {
          const r = rectOf(id);
          if (r) rects.push(r);
        }
        // ни ребра, ни представителей концов — ещё не собрано, ждём следующего прогона
        if (rects.length === 0) return;
        flashSelectors = foundEnds.map((id) => `.react-flow__node[data-id="${CSS.escape(id)}"]`);
      }
    } else {
      for (const id of locate.ids) {
        const r = rectOf(id);
        if (r) rects.push(r);
      }
      flashSelectors = locate.ids.map((id) => `.react-flow__node[data-id="${CSS.escape(id)}"]`);
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
    const sel = flashSelectors.join(",");
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
    if (!linkedHighlight) return;
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
    // Подсвеченные рёбра поднимаем НАД прочими рёбрами перестановкой их <svg> в конец
    // контейнера .react-flow__edges: RF рисует каждое ребро отдельным <svg>, стекинг между
    // ними — по DOM-порядку (z-index бесполезен и опасен: рёбра делят stacking-контекст с
    // узлами и положительный z накрыл бы узлы). Так дуги-мостики подсвеченного ребра идут
    // ПОВЕРХ пересекаемых серых стрелок, но ребро остаётся под узлами (узлы — в своём div
    // после контейнера рёбер). Возврат на место — по восстановлению исходного соседа.
    let restore: Array<{ svg: Element; parent: Node; before: Node | null }> = [];
    const raf = requestAnimationFrame(() => {
      for (const id of nodeIds) {
        const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
        if (el) { el.classList.add("lg-linked-node"); applied.push(el); }
      }
      for (const id of edgeIds) {
        // Плашка подписи живёт в другом контейнере (edgelabel-renderer) — поднимаем её
        // над соседними плашками классом (z внутри stacking context renderer'а; жалоба
        // «плашки друг на друге — выбранную не прочитать»). Адрес — data-lg-edge (edges.tsx).
        const lb = document.querySelector(`.react-flow__edgelabel-renderer [data-lg-edge="${CSS.escape(id)}"]`);
        if (lb) { lb.classList.add("lg-linked-label"); applied.push(lb); }
        const el = document.querySelector(`.react-flow__edge[data-id="${CSS.escape(id)}"]`);
        if (!el) continue;
        el.classList.add("lg-linked-edge");
        applied.push(el);
        const svg = el.closest("svg");
        const parent = svg?.parentElement;
        if (svg && parent && parent.classList.contains("react-flow__edges") && svg !== parent.lastElementChild) {
          restore.push({ svg, parent, before: svg.nextSibling });
          parent.appendChild(svg); // в конец → рисуется поверх прочих рёбер
        }
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      for (const el of applied) el.classList.remove("lg-linked-node", "lg-linked-edge", "lg-linked-label");
      // Возврат <svg> ребра на исходную позицию (best-effort: только если узлы ещё в DOM
      // на прежних местах — иначе RF уже перерисовал список и сам восстановил порядок).
      for (const r of restore) {
        if (r.svg.parentElement !== r.parent) continue;
        if (r.before && r.before.parentNode === r.parent) r.parent.insertBefore(r.svg, r.before);
        else if (!r.before) r.parent.appendChild(r.svg);
      }
      applied = [];
      restore = [];
    };
  }, [linkedHighlight, rfNodes, rfEdges]);

  // АДАПТИВНАЯ ТОЛЩИНА РАМОК ПОД ЗУМ: рамки (нативные C4-boundary и compound-рамки
  // раскрытий) рисуются 1px-пунктиром в координатах графа — на сильном отдалении
  // физический 1px тает до долей экранного пикселя и рамка исчезает. Держим на холсте
  // CSS-переменную --lg-frame-bw = max(1, 1/zoom)px: при приближении рамка остаётся
  // прежним аккуратным 1px, при отдалении растёт физически ровно настолько, чтобы на
  // экране оставаться ~1px. Пишем императивно (не через стейт) — зум не должен
  // ре-рендерить граф; квант 0.25px гасит дёрганье стилей на каждом тике колеса.
  const canvasRef = useRef<HTMLDivElement>(null);
  const frameBwRef = useRef(0);
  const handleViewportChange = useCallback((vp: Viewport) => {
    const bw = Math.round(Math.max(1, 1 / vp.zoom) * 4) / 4;
    if (bw === frameBwRef.current) return;
    frameBwRef.current = bw;
    canvasRef.current?.style.setProperty("--lg-frame-bw", `${bw}px`);
  }, []);

  // Уровень рендерим даже пустым: тогда сразу видна канва (точки) и в неё можно
  // дропнуть первый узел, а зум остаётся «отдалённым» (defaultViewport ниже),
  // без скачка к гигантскому fitView на единственном узле.
  const hasGraphContent = nodes.length + endpoints.length > 0;

  // Авто-центрирование страничных схем (fitOnLoad/fitOnExpand). Раскладка двухфазная
  // (фолбэк-габариты → замер → пере-прогон), поэтому фитим НЕ на первом проходе, а по
  // оседании: дебаунс на смене layout/sizesVersion ловит последний прогон в окне.
  //  - Загрузка (fitOnLoad): одноразово (didLoadFitRef), после первого замера
  //    (sizesVersion ≥ 1), БЕЗ анимации — правит «спозание» декларативного fitView,
  //    который сгорает на первом проходе и оставляет схему «вверху и мелко».
  //  - Раскрытие (fitOnExpand): по флагу expandFitRef (взведён в commitExpanded),
  //    С анимацией (duration = ANIM_MOVE_MS) — идёт параллельно разъезду узлов.
  // Оба — через SCHEMA_FIT_OPTIONS (== кнопка «Центрировать»). Не fitOnLoad/Expand
  // (редактор-карта) — эффект no-op, центрирование редактора не меняется.
  useEffect(() => {
    if ((!fitOnLoad && !fitOnExpand) || !hasGraphContent) return;
    const t = window.setTimeout(() => {
      if (!didLoadFitRef.current && fitOnLoad && sizesVersion >= 1) {
        didLoadFitRef.current = true;
        fitView(SCHEMA_FIT_OPTIONS);
        return;
      }
      if (expandFitRef.current && fitOnExpand) {
        expandFitRef.current = false;
        fitView({ ...SCHEMA_FIT_OPTIONS, duration: ANIM_MOVE_MS });
      }
    }, 140);
    return () => window.clearTimeout(t);
  }, [layout, sizesVersion, hasGraphContent, fitOnLoad, fitOnExpand, fitView]);

  return (
    <div
      // lg-canvas--editable — раскрытие хэндлов по ховеру (архитектор, не контекст);
      // lg-canvas--connecting — подсветка «зон входа» (узлов с детьми) во время
      // протягивания новой связи.
      className={
        "lg-canvas" +
        (isArchitect && !isReadOnly ? " lg-canvas--editable" : "") +
        (connecting ? " lg-canvas--connecting" : "") +
        // окно анимации раскрытия/сворачивания: CSS-transition на узлах и рамках
        (animActive ? " lg-canvas--anim" : "")
      }
      ref={canvasRef}
      // --lg-frame-bw: стартовое значение под defaultViewport (zoom 0.85 → ~1.18px);
      // дальше живёт императивно в handleViewportChange (включая fitView при маунте)
      style={{ position: "relative", flex: 1, minHeight: 0, border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", "--lg-frame-bw": "1.25px" } as CSSProperties}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
      // Двойной клик по ПУСТОМУ холсту — сброс выделения (подсветки) и правой панели.
      // Клик по узлу/ребру/плашке исключаем closest'ом (у них свои даблклик-триггеры).
      onDoubleClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest?.(".react-flow__node, .react-flow__edge, .react-flow__edgelabel-renderer")) return;
        cbRef.current.onClearSelection?.();
      }}
      // ПКМ панорамирует холст — гасим браузерное контекст-меню, чтобы оно не
      // выскакивало при правом клике/перетаскивании по канвасу.
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Индиго-наконечник для ПОДСВЕЧЕННЫХ рёбер (П5/П6): наконечник — общий для цвета
          SVG-маркер, покрасить его CSS'ом на пути нельзя, поэтому на подсвеченное ребро
          через CSS marker-end указываем ЭТОТ маркер. Геометрия 1:1 со штатным RF
          ArrowClosed (viewBox/points/markerUnits), поэтому размер/форма те же. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs>
          <marker
            id="lg-linked-arrow" className="react-flow__arrowhead"
            markerWidth="12.5" markerHeight="12.5" viewBox="-10 -10 20 20"
            markerUnits="strokeWidth" orient="auto-start-reverse" refX="0" refY="0"
          >
            <polyline
              className="arrowclosed" strokeLinecap="round" strokeLinejoin="round"
              style={{ stroke: "#6366f1", fill: "#6366f1", strokeWidth: 1 }}
              points="-5,-4 0,0 -5,4 -5,-4"
            />
          </marker>
        </defs>
      </svg>
      {/* Тулбар Undo/Redo (архитектор, не контекст). Кнопка надёжнее клавиш — не зависит
          от фокуса. Обе зовут дисптчеры из TreePage (кросс-уровневый редирект). */}
      {isArchitect && !isReadOnly && (
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
          точки прыжков. Пауза — на драг И на фазу move анимации (иначе пересчёт реестра
          даёт второй проход рендера всех рёбер посреди окна); снятие — на unmask/свопе,
          батчем с проявлением. */}
      <EdgeJumpProvider enabled paused={dragging || jumpsPaused}>
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
        // На непустом уровне фитим контент. Редактор-карта: не зумим ближе 0.85 —
        // иначе вход на разреженный уровень (1–2 узла) подлетал вплотную, мешая
        // добавлять объекты. Страничные схемы (fitOnLoad): SCHEMA_FIT_OPTIONS — тот
        // же вид, что даст авто-фит по оседании и кнопка «Центрировать» (без скачка).
        fitView={hasGraphContent}
        fitViewOptions={fitOnLoad ? SCHEMA_FIT_OPTIONS : { padding: 0.2, maxZoom: 0.85 }}
        // Пустой уровень (fitView выключен) открывается слегка отдалённым — комфортно
        // бросить первый узел, не отъезжая вручную.
        defaultViewport={{ x: 60, y: 60, zoom: 0.85 }}
        // Контекст-схема и readOnly — без правки: раскладка предписана, drag
        // ничего не сохраняет и только «отщёлкивал» бы узел назад. На обычном
        // уровне узлы таскаем (персист координат архитектором).
        // dragNodes позволяет включить драг узлов в readOnly (embedded-блоки).
        nodesDraggable={dragNodes}
        // nodesConnectable=true нужен для протягивания связи от хэндла (рендер
        // connection line гейтится этим флагом). Начать связь можно только с
        // хэндла, у которого isConnectableStart (его выставляем лишь архитектору
        // вне контекст-режима — см. nodes.tsx).
        nodesConnectable
        // Навигация и выделение: холст панорамируем ПРАВОЙ кнопкой мыши (код 2),
        // ЛЕВАЯ кнопка тянет рамку прямоугольного выделения нескольких узлов
        // (selectionOnDrag). Ctrl/⌘ добавляет/убирает узлы из выделения кликом.
        // SelectionMode.Partial — в выделение попадают и узлы, задетые рамкой
        // частично. В read-only без драга узлов — панорамирование левой кнопкой.
        panOnDrag={dragNodes ? [2] : (isReadOnly ? true : [2])}
        selectionOnDrag={dragNodes && !isReadOnly}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={["Control", "Meta"]}
        // двойной клик по пустому холсту сбрасывает выделение (наш onDoubleClick на обёртке) —
        // штатный зум-по-даблклику отключаем, чтобы холст не подлетал на этом жесте
        zoomOnDoubleClick={false}
        // толщина рамок компенсирует отдаление (см. handleViewportChange выше);
        // колбэк ловит и колесо/пан, и программные fitView/setViewport
        onViewportChange={handleViewportChange}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e5e7eb" />
        {/* Кнопка «Центрировать» (fit-view). Страничные схемы: SCHEMA_FIT_OPTIONS —
            идентично авто-фиту (fitOnLoad/fitOnExpand), «как будто кнопка нажата».
            Редактор-карта: undefined → прежнее поведение (дефолт RF, без cap). */}
        <Controls fitViewOptions={(fitOnLoad || fitOnExpand) ? SCHEMA_FIT_OPTIONS : undefined} />
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
                // border-box + тот же радиус (12), что у .lg-frame — контур подсветки
                // ложится ровно на контур рамки (иначе бордер уезжал наружу на 2px).
                boxSizing: "border-box",
                pointerEvents: "none",
                zIndex: 4,
                borderRadius: 12,
                border: "2px solid #6366f1",
                background: "rgba(99, 102, 241, 0.06)",
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
