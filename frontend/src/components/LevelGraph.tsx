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
import { UndoIcon, RedoIcon, RelayoutIcon } from "../ui/icons";
import type { Node as AppNode, GhostNode, Edge as AppEdge, ViewLayout, EdgePoint } from "../types";
import { canHaveChildren } from "../types";
import { NODE_W, NODE_H } from "./graph/constants";
import type {
  WrappedEdgeData,
  BlockData, GhostData, ContainerData,
  LocateRequest,
  LevelPersistenceProps, LevelModeFlags, LevelDrillCallbacks, LevelEdgeCallbacks,
  LevelDeleteCallbacks, LevelDropProps, LevelUndoProps,
} from "./graph/types";
import type { LayoutResult } from "./graph/layout/pipeline";
import type { LabelPlacement } from "./graph/layout/labelLayout";
import { computeViewLayoutOffThread } from "./graph/layout/pipelineClient";
import { layoutSig } from "./graph/layout/layoutSig";
import { assembleRfGraph } from "./graph/assembleRf";
import { reconcileNodes, reconcileEdges } from "./graph/reconcileRf";
import { NodeShapeSvg } from "./graph/shapes";
import { nodeTypes } from "./graph/nodes";
import { edgeTypes } from "./graph/edges";
import { trunkHitAt } from "./graph/trunkHit";
import { EdgeJumpProvider } from "./graph/EdgeJumpContext";
import ConnectionLine from "./graph/ConnectionLine";
import { LevelBoundary, AlignmentGuides } from "./graph/boundaries";
import { useAlignmentGuides } from "./graph/interaction/useAlignmentGuides";
import { useSnapAlignment } from "./graph/interaction/useSnapAlignment";
import { useLevelMeasure } from "./graph/interaction/useLevelMeasure";
import { useTemplateDrop, type DropFrame } from "./graph/interaction/useTemplateDrop";
import { useHistory } from "./graph/interaction/useHistory";
import type { History } from "./graph/interaction/useHistory";
import { useCanvasDelete } from "./graph/interaction/useCanvasDelete";
import { useEdgeConnect, type ConnectTarget } from "./graph/interaction/useEdgeConnect";
import QuickConnectPreview from "./graph/QuickConnectPreview";
import { useLayoutAnimation, type LayoutGate } from "./graph/interaction/useLayoutAnimation";
import { ANIM_MOVE_MS } from "./graph/interaction/layoutAnimation";
import { useLevelLocate } from "./graph/interaction/useLevelLocate";
import { useLevelSelection } from "./graph/interaction/useLevelSelection";
import { useLevelQuickConnect } from "./graph/interaction/useLevelQuickConnect";
import { useLevelEdgeChoice } from "./graph/interaction/useLevelEdgeChoice";
import { useFrameFollowOverlay } from "./graph/interaction/useFrameFollowOverlay";
import { useLiveDragHandles, type LiveHandleInputs } from "./graph/interaction/useLiveDragHandles";
import { useLevelPersistence } from "./graph/interaction/useLevelPersistence";
import { useLevelDrill } from "./graph/interaction/useLevelDrill";

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
  /** Ключ ВИДА для персиста раскладки, если отличается от структурного containerId.
      Страница объекта: containerId = parent_id (структура/предки/глубина), а раскладка
      персистится в вид фокуса — layoutViewId = node.id. Не задан → view_id = containerId. */
  layoutViewId?: string;
  /** имена предков из breadcrumb (корень → непосредственный родитель) —
      подписи вложенных рамок уровней; пусто на корне */
  ancestorNames: string[];
  /** id тех же предков (параллельно ancestorNames) — для сопоставления гостей */
  ancestorIds: string[];
  isArchitect: boolean;
  // Что открыто в правой панели — для устойчивой подсветки связанного (узел+его стрелки /
  // стрелка+оба узла). Гость сводится к kind:"node". Считается в MapEditorPage из selectedObject.
  linkedHighlight?: { kind: "node" | "edge"; id: string } | null;
  // Обновить кэш детей раскрытого контейнера (после создания/отката ребёнка в его рамке
  // на ЭТОМ же уровне — localChildren иначе держит устаревший список). token — триггер.
  refreshChildrenOf?: { id: string; token: number } | null;
  // Запрос «показать на схеме» из индикатора незавершённости (SchemaAlerts → MapEditorPage).
  // MapEditorPage сперва приводит холст к нужному уровню (navigateToLevel), затем кладёт сюда
  // запрос. Холст центрируется на цели и коротко её подсвечивает. token меняется на
  // КАЖДЫЙ клик — повторный клик по тому же объекту снова сфокусирует. Раскладка async,
  // поэтому фокус срабатывает отложенно — как только цель появится в rfNodes/rfEdges.
  locate?: LocateRequest | null;
  // Персист раскладки вида (fence + политика 409 + зеркало родителю): onLayoutChanged,
  // onPersistError, viewMeta, gestureActiveRef, onPersistConflict, retryPatch. read-only
  // страницы бандл не передают — записи гейтятся readOnly. Состав — LevelPersistenceProps.
  persistence?: LevelPersistenceProps;
  // Флаги режима канваса: readOnly, edgesInspectable, nodesDraggable, arrangeOnly,
  // ignorePersistedExpanded, fitOnLoad, fitOnExpand, schemaView. Состав — LevelModeFlags.
  mode?: LevelModeFlags;
  // Drill-навигация и деталька (двойной клик по узлу/гостю/пустому холсту): onDrillDown,
  // onEnterNode, onEditNode, onInspectGhost, onClearSelection. Состав — LevelDrillCallbacks.
  drill: LevelDrillCallbacks;
  // Колбэки создания и инспекции связей: onEdgesChoice, onTrunkChoice, onCreateEdge,
  // onConnectInto, onExitUp. НАМЕРЕННО НЕ `edges` (так зовётся дата-проп AppEdge[]).
  edgeCallbacks: LevelEdgeCallbacks;
  // Запросы удаления узлов с канваса (клавиатура → подтверждение в родителе):
  // onRequestDeleteNode, onRequestDeleteNodes. Состав — LevelDeleteCallbacks.
  delete?: LevelDeleteCallbacks;
  // Дроп шаблона узла из боковой палитры: onDropNode, dragShape. Состав — LevelDropProps.
  drop?: LevelDropProps;
  // Undo/Redo: history, onUndo, onRedo (общая история + дисптчеры страницы-хозяина;
  // без бандла канвас заводит локальную историю). Состав — LevelUndoProps.
  undo?: LevelUndoProps;
  // «Переразложить» — canvas-кнопка в правом верхнем углу холста (архитектор).
  // Передан → кнопка видна; редактор-карта НЕ передаёт (у него своя в топбаре).
  onRelayout?: () => void;
  // Сигнал свершившейся переразкладки (токен инкрементится страницей-хозяином
  // после сброса): приход свежей раскладки режиссируется чистым переездом
  // видимых узлов/рамок (planRelayout), без сворачивания раскрытий.
  relayoutToken?: number;
  // Сигнал мутации страницы (создание/удаление узлов и связей, правка связи):
  // стрелки с изменившейся геометрией в следующем применении перерисовываются
  // анимированно (drawIn), новые — рисуются (окно мутаций, AN28а).
  mutationToken?: number;
}

function LevelGraphInner({
  nodes,
  endpoints,
  viewLayout = EMPTY_VIEW_LAYOUT,
  edges,
  depth,
  containerId,
  layoutViewId,
  ancestorNames,
  ancestorIds,
  isArchitect,
  linkedHighlight,
  refreshChildrenOf,
  locate,
  persistence,
  mode,
  drill,
  edgeCallbacks,
  delete: deleteCallbacks,
  drop,
  undo,
  onRelayout,
  relayoutToken,
  mutationToken,
}: LevelGraphProps) {
  // Деструктуризация бандлов в плоские имена (Фаза 3д): тело компонента и вынесенные
  // хуки работают с теми же именами, что и до группировки пропсов, — поведение не
  // меняется. Сами бандлы НЕ становятся зависимостями эффектов/хуков (только их члены),
  // поэтому ссылочная стабильность бандла не влияет на внутренние пересчёты канваса.
  const {
    onLayoutChanged, onPersistError, viewMeta, gestureActiveRef, onPersistConflict, retryPatch,
  } = persistence ?? {};
  const {
    readOnly = false, edgesInspectable, nodesDraggable: nodesDraggableProp,
    arrangeOnly = false, ignorePersistedExpanded = false, fitOnLoad = false,
    fitOnExpand = false, schemaView = "all",
  } = mode ?? {};
  const { onDrillDown, onEnterNode, onEditNode, onInspectGhost, onClearSelection } = drill;
  const { onCreateEdge, onConnectInto, onExitUp, onEdgesChoice, onTrunkChoice } = edgeCallbacks;
  const { onRequestDeleteNode, onRequestDeleteNodes } = deleteCallbacks ?? {};
  const { onDropNode, dragShape } = drop ?? {};
  const { history: historyProp, onUndo, onRedo } = undo ?? {};
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
    apply: applyLayout, noteExpand, noteCollapse, noteRelayout, noteGesture, noteMutation,
    cancel: cancelAnim, reset: resetAnim, active: animActive, jumpsPaused,
  } = useLayoutAnimation({ getNodes, getEdges, setRfNodes, setRfEdges, gate });
  // Смена уровня/режима: отложенная анимация протухла — жёсткий сброс без доигровки
  // (свежую раскладку нового уровня применит сборщик).
  useEffect(() => { resetAnim(); }, [containerId, resetAnim]);
  // «Переразложить»: страница-хозяин свершила сброс (токен) — интент держится в
  // хуке до прихода свежего прогона и режиссирует его чистым переездом.
  useEffect(() => { if (relayoutToken) noteRelayout(); }, [relayoutToken, noteRelayout]);
  // Мутация страницы (создание/удаление узлов и связей): окно мутаций — стрелки
  // с изменившейся геометрией перерисуются анимированно, новые нарисуются (AN28а).
  useEffect(() => { if (mutationToken) noteMutation(); }, [mutationToken, noteMutation]);

  // Авто-центрирование (fitOnLoad/fitOnExpand): didLoadFitRef — одноразовый фит
  // загрузки (на маунт; холст ремаунтится по key=node.id, поэтому «один раз» ==
  // «один раз на страницу»). expandFitRef (взводится при раскрытии) приходит из
  // useLevelDrill. Таймер — дебаунс оседания раскладки (двухфазная: замер может
  // прийти вторым прогоном, фитим по последнему в окне).
  const didLoadFitRef = useRef(false);

  // ЕДИНЫЙ канал записи раскладки вида (R3): дедуп+merge поверх зеркала → батч-PUT
  // view_layout (fence + политика 409) + зеркало родителю. Тела commitLayout/
  // persistFenced, очередь фенсированных записей, исполнитель переигровки retryPatch
  // и стабильная обёртка — в useLevelPersistence (Фаза 3в-А). commitLayout нужен
  // драгу/снапам (commitLayoutStable), раскрытиям (commitExpanded) и конвейеру
  // (intent-засев через cbRef).
  // view_id записи раскладки: ключ ВИДА (layoutViewId), а не структурный containerId.
  // На странице объекта раскладка персистится в вид фокуса (node.id), тогда как
  // containerId (= parent_id) продолжает ключить структуру/предков/глубину ниже.
  const { commitLayout, commitLayoutStable } = useLevelPersistence({
    containerId: layoutViewId ?? containerId, isArchitect, canArrange, viewLayout,
    onPersistError, onPersistConflict, onLayoutChanged, viewMeta, retryPatch,
  });

  // Последний применённый результат конвейера (заполняется эффектом у стейта
  // layout ниже): own-on-expand берёт отсюда абсолютную позицию контейнера.
  const layoutLatestRef = useRef<LayoutResult | null>(null);

  // Drill-навигация и инлайн-раскрытие контейнеров (гостевые и ЛОКАЛЬНЫЕ, R5):
  // drillWithPath, expand/collapse, производные expanded/localChildren/
  // relevantCounts, ленивая догрузка детей и таргетный рефреш кэша — в
  // useLevelDrill (Фаза 3в-А). expanded/localChildren/relevantCounts нужны
  // конвейеру раскладки и сборщику RF; expandFitRef — эффекту авто-центрирования.
  const {
    drillWithPath, expandContainer, expandLocalContainer, collapseContainer,
    expanded, relevantCounts, localChildren, expandFitRef,
  } = useLevelDrill({
    containerId, nodes, edges, endpoints, ancestorIds, ancestorNames,
    onDrillDown, onEnterNode, viewLayout, ignorePersistedExpanded, isReadOnly,
    fitOnExpand, refreshChildrenOf, commitLayout, noteExpand, noteCollapse,
    layoutLatestRef,
  });

  // Состояние центральных направляющих магнитного выравнивания (общее для snap-драга
  // и drop-шаблона).
  const { guides, setGuides, clearGuides } = useAlignmentGuides();

  // История Undo/Redo (Ctrl+Z / Ctrl+Shift+Z). На основном канвасе её поднимают в
  // страницу-хозяин (туда же кладутся структурные команды и дисптчеры с кросс-уровневым
  // редиректом); ownHistory — фолбэк для страниц (EmbeddedSchemaBlock), где истории не нужно.
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
  // Клавиши/кнопки зовут дисптчеры из MapEditorPage (кросс-уровневый редирект). В контекст-
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

  // Замер реальных габаритов узлов (V2.2b, render→measure→layout): ref-мост размеров,
  // счётчик новых замеров и обработчик 'dimensions'-событий RF — в useLevelMeasure
  // (Фаза 3г). sizesVersion — зависимость раскладки и гейт авто-фита (fitOnLoad),
  // nodeSizesRef читает конвейер, handleNodesChangeMeasured стоит на onNodesChange RF.
  const { nodeSizesRef, sizesVersion, handleNodesChangeMeasured } = useLevelMeasure({
    handleNodesChange, getInternalNode,
  });

  // Живой пересчёт авто-хэндлов локальных стрелок во время драга (WYSIWYG: превью =
  // итог по отпускании). Снимок входов раскладки кладём в ref в конце async-раскладки.
  const liveHandleInputs = useRef<LiveHandleInputs | null>(null);
  const liveDragHandles = useLiveDragHandles({ inputsRef: liveHandleInputs, setRfEdges });

  // Идёт ли драг узлов/рамки выделения. На время драга замораживаем реестр «мостиков»
  // (paused у EdgeJumpProvider): иначе его пересчёт каждый кадр перерисовывал бы ВСЕ
  // рёбра по два прохода — лаги и краш на хаотичном мультидраге многих узлов. Старт —
  // на onNodeDragStart/onSelectionDragStart, сброс — в обёртках над стоп-обработчиками.
  const [dragging, setDragging] = useState(false);

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
  // поэтому имена концов уезжают вместе с жестом, а не разрешаются в MapEditorPage.
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

  // «Быстрая связь»: стрелка-кнопка у хэндла предлагает связать с подходящим соседом.
  // Стейт наведения, подбор цели (qcCandidate → QuickConnectPreview в JSX) и стабильные
  // handlers (→ cbRef) вынесены в useLevelQuickConnect (Фаза 3б). resolveTarget/
  // displayNameOf общие с useEdgeConnect — передаём туда и сюда, не дублируем.
  const { qcCandidate, quickConnectHandlers } = useLevelQuickConnect({
    rfNodes, resolveTarget, displayNameOf, onCreateEdge, onConnectInto,
  });

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
  // Инспекция связей (openEdgeMembers/openTrunkMembers) вынесена в useLevelEdgeChoice
  // (Фаза 3б) — оба колбэка кормят cbRef ниже.
  const { openEdgeMembers, openTrunkMembers } = useLevelEdgeChoice({ edges, onEdgesChoice, onTrunkChoice });

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
    // плашки и сигнатура входов роутинга прошлого прогона — гашение осцилляций
    // (конвейер удерживает результат целиком из prev при неизменных входах)
    labels?: Map<string, LabelPlacement>;
    sig?: string;
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
      const { layout: next, liveInputs, intents, routeSig } = await computeViewLayoutOffThread({
        nodes, endpoints, edges, containerId, viewLayout,
        ancestorIds: stableAncestorIds, expanded, localChildren,
        sizes: nodeSizesRef.current,
        prevRoutes: sameSizes ? prevRoutesRef.current?.routes : undefined,
        prevEdgeHandles: sameSizes ? prevRoutesRef.current?.handles : undefined,
        prevRouteSig: sameSizes ? prevRoutesRef.current?.sig : undefined,
        prevLabelPlacements: sameSizes ? prevRoutesRef.current?.labels : undefined,
        scopeNodeIds: sameSizes ? scopeNodeIds : undefined,
      });
      if (runId !== runIdRef.current) return "stale"; // устаревший прогон: ничего не пишет
      if (next.autoRoutes) {
        prevRoutesRef.current = {
          routes: next.autoRoutes, handles: next.edgeHandles,
          labels: next.labelPlacements, sig: routeSig, version: sizesVersion,
        };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeSizesRef — стабильный ref из useLevelMeasure (читается по .current), в deps не нужен
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
  // участника, см. MapEditorPage). Клик по плашке сюда не попадает — она адресует свою
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

  // «Показать на схеме» (locate): центрирование холста на цели + короткая подсветка.
  // Эффект самодостаточен (ждёт появления цели, дедуп по token) — вынесен в
  // useLevelLocate (Фаза 3б); RF-API передаётся из useReactFlow этого компонента.
  useLevelLocate({ locate, rfNodes, rfEdges, getInternalNode, setCenter, fitBounds });

  // УСТОЙЧИВАЯ подсветка связанного по двойному клику (П5/П6): узел/связь, открытая в
  // правой панели, подсвечена, пока открыта. Эффект самодостаточен — вынесен в
  // useLevelSelection (Фаза 3б). onClearSelection (сброс по клику на пустом холсте)
  // остаётся в cbRef — это триггер выделения, а не его подсветка.
  useLevelSelection({ linkedHighlight, rfNodes, rfEdges });

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
      // Фит после раскрытия/сворачивания — только когда анимация ОСЕЛА (!animActive).
      // Иначе при сворачивании fitView ловит промежуточную фазу схлопывания (потомки
      // ещё стягиваются в точку) и считает viewport по ним, а не по итоговому
      // свёрнутому составу — схема «уезжает в угол». По оседании (animActive=false)
      // эффект перезапускается и фит считается по финальным узлам — одинаково для
      // раскрытия и сворачивания.
      if (expandFitRef.current && fitOnExpand && !animActive) {
        expandFitRef.current = false;
        fitView({ ...SCHEMA_FIT_OPTIONS, duration: ANIM_MOVE_MS });
      }
    }, 140);
    return () => window.clearTimeout(t);
    // expandFitRef — стабильный ref-объект из useLevelDrill (идентичность не
    // меняется), в deps для полноты exhaustive-deps без изменения поведения.
    // animActive — флаг анимации раскрытия/сворачивания: фит ждёт её оседания.
  }, [layout, sizesVersion, hasGraphContent, fitOnLoad, fitOnExpand, fitView, expandFitRef, animActive]);

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
      {/* Тулбар Undo/Redo (архитектор, расстановка доступна). Кнопка надёжнее клавиш —
          не зависит от фокуса. Гейт canArrange (= arrangeOnly || !readOnly): тулбар
          виден и в редакторе, и на страничных схемах с персистом (arrangeOnly), но
          скрыт у наблюдателя. Обе зовут дисптчеры из MapEditorPage (кросс-уровневый
          редирект); на страницах (undo-бандл не передан) — локальная ownHistory. */}
      {isArchitect && canArrange && (
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
      {/* «Переразложить» — canvas-кнопка в ПРАВОМ верхнем углу (архитектор, передан
          onRelayout). Стилистика едина с тулбаром Undo/Redo (тот же класс lg-seg).
          Редактор-карта onRelayout не передаёт — там своя кнопка в топбаре. */}
      {isArchitect && onRelayout && (
        <div style={{ position: "absolute", top: 14, right: 14, zIndex: 5 }}>
          <div className="lg-seg">
            <button
              type="button"
              onClick={onRelayout}
              title="Переразложить уровень"
              aria-label="Переразложить"
            >
              <RelayoutIcon />
            </button>
          </div>
        </div>
      )}
      {/* Легенда статусов и переключатель «Вид схемы» живут в правой панели схемы
          (MapEditorPage → ObjectInspector); оверлея на холсте больше нет. */}
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
        selectionOnDrag={dragNodes && canArrange}
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
        {/* Кнопка «Центрировать» (fit-view). Страничные схемы: SCHEMA_FIT_OPTIONS +
            плавность (duration = ANIM_MOVE_MS) — как авто-фит при раскрытии/сворачивании.
            Редактор-карта: undefined → прежнее поведение (дефолт RF, без cap). */}
        <Controls fitViewOptions={(fitOnLoad || fitOnExpand) ? { ...SCHEMA_FIT_OPTIONS, duration: ANIM_MOVE_MS } : undefined} />
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
