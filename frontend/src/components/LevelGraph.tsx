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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./LevelGraph.css";
import { ExitUpTile, HistoryToolbar, ViewToolbar } from "./graph/CanvasToolbars";
import DropOverlays from "./graph/DropOverlays";
import { useConnectTargets } from "./graph/interaction/useConnectTargets";
import type { Node as AppNode, GhostNode, Edge as AppEdge, ViewLayout, EdgePoint } from "../types";
import { distToPolyline } from "./graph/edgePath";

/** Допуск попадания двойного клика в линию соседней связи (общее плечо, E95), px холста. */
const SHARED_HIT_TOL = 4;
import { OVERLOAD_NODES, OVERLOAD_EDGES } from "./graph/constants";
import { readEdgeLabelsHidden, writeEdgeLabelsHidden } from "./graph/labelsPref";
import type { BlockData, GhostData, LevelDeleteCallbacks, LevelDrillCallbacks, LevelDropProps, LevelEdgeCallbacks, LevelModeFlags, LevelPersistenceProps, LevelProjectionProps, LevelUndoProps, LinkedHighlight, LocateRequest, WrappedEdgeData } from "./graph/types";
import type { LayoutResult } from "./graph/layout/pipeline";
import type { PrevScene } from "./graph/layout/incrementalScope";
import type { LabelPlacement } from "./graph/layout/labelLayout";
import { computeViewLayoutOffThread } from "./graph/layout/pipelineClient";
import {
  routeCache, viewCacheKey, toCacheEntry, fromCacheEntry, type RouteCacheView,
} from "./graph/layout/routeCacheStore";
import { getCurrentProjectId } from "../api/projectScope";
import { layoutSig } from "./graph/layout/layoutSig";
import { assembleRfGraph } from "./graph/assembleRf";
import { reconcileNodes, reconcileEdges } from "./graph/reconcileRf";
import { nodeTypes } from "./graph/nodes";
import { edgeTypes } from "./graph/edges";
import { EdgeJumpProvider } from "./graph/EdgeJumpContext";
import { ReconnectProvider } from "./graph/ReconnectContext";
import ConnectionLine from "./graph/ConnectionLine";
import { LevelBoundary, AlignmentGuides } from "./graph/boundaries";
import { useAlignmentGuides } from "./graph/interaction/useAlignmentGuides";
import { useSnapAlignment } from "./graph/interaction/useSnapAlignment";
import { useLevelMeasure } from "./graph/interaction/useLevelMeasure";
import { useTemplateDrop, type DropFrame } from "./graph/interaction/useTemplateDrop";
import { useLevelHistory } from "./graph/interaction/useLevelHistory";
import { useLevelDragLifecycle } from "./graph/interaction/useLevelDragLifecycle";
import { useLevelRehang } from "./graph/interaction/useLevelRehang";
import { SCHEMA_FIT_OPTIONS, useLevelAutoFit } from "./graph/interaction/useLevelAutoFit";
import { useFarZoom } from "./graph/interaction/useFarZoom";
import { useCanvasDelete } from "./graph/interaction/useCanvasDelete";
import { useEdgeConnect } from "./graph/interaction/useEdgeConnect";
import QuickConnectPreview from "./graph/QuickConnectPreview";
import { useLayoutAnimation, type LayoutGate } from "./graph/interaction/useLayoutAnimation";
import { ANIM_MOVE_MS } from "./graph/interaction/layoutAnimation";
import { useLevelLocate } from "./graph/interaction/useLevelLocate";
import { useLevelSelection, selectCarrierEdge } from "./graph/interaction/useLevelSelection";
import { useProjectionTwins } from "./graph/interaction/useProjectionTwins";
import { useLevelQuickConnect } from "./graph/interaction/useLevelQuickConnect";
import { useLevelEdgeChoice } from "./graph/interaction/useLevelEdgeChoice";
import { useFrameFollowOverlay } from "./graph/interaction/useFrameFollowOverlay";
import { useLiveDragHandles, type LiveHandleInputs } from "./graph/interaction/useLiveDragHandles";
import { useLevelPersistence } from "./graph/interaction/useLevelPersistence";
import { useLevelDrill } from "./graph/interaction/useLevelDrill";
import { useIdleCleanup } from "./graph/interaction/useIdleCleanup";
import { useOncePerViewToast } from "./graph/interaction/useOncePerViewToast";
import CanvasNotice from "./graph/CanvasNotice";
import { emitTourEvent } from "./tour/tourBus";
import { diag } from "./graph/layout/diag";

// --- Основной компонент ---

// Стабильный пустой дефолт для viewLayout: дефолт-параметр `= {}` создавал бы
// НОВЫЙ объект на каждый рендер, а он — зависимость async-эффекта раскладки → лишний
// перезапуск ELK и мигание. Один модульный объект держит ссылку стабильной.
const EMPTY_VIEW_LAYOUT: ViewLayout = {};

// ПРЕДЕЛ ОТДАЛЕНИЯ (CV2 v2, решение пользователя 2026-10-12): дефолтные 0.5 React Flow
// упирались на больших уровнях — ни колесом, ни «Центрировать» (fitView тоже не
// опускается ниже minZoom) всю схему было не увидеть. 0.05 — узел 190 px становится
// ~10 px: даже уровень на 6000 px умещается в окно с запасом. Ниже FAR_ZOOM холст в
// дальнем режиме (см. useFarZoom).
const MIN_ZOOM = 0.05;
// Пропсы <ReactFlow> — модульными константами (аудит F-57): литерал в JSX — новый объект
// на каждый рендер, а массивы клавиш и кнопок панорамы React Flow сверяет по ссылке и
// перевешивает на них слушатели.
// Редактор-карта не зумит ближе 0.85 при фите — вход на разреженный уровень не подлетает.
const EDITOR_FIT_OPTIONS = { padding: 0.2, maxZoom: 0.85 };
// «Центрировать» страничных схем — тот же вид, что авто-фит, и с той же плавностью.
const SCHEMA_FIT_ANIMATED = { ...SCHEMA_FIT_OPTIONS, duration: ANIM_MOVE_MS };
const DEFAULT_VIEWPORT = { x: 60, y: 60, zoom: 0.85 };
// Панорамирование ПРАВОЙ кнопкой мыши (код 2).
const PAN_RIGHT_BUTTON = [2];
const MULTI_SELECT_KEYS = ["Control", "Meta"];
const PRO_OPTIONS = { hideAttribution: true };

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
  linkedHighlight?: LinkedHighlight | null;
  // Счётчик чтений уровня с сервера (растёт на каждую мутацию): сигнал «кэш детей
  // раскрытых рамок протух». Ответ /graph детей рамок не несёт, поэтому без него
  // удалённый/созданный внутри рамки объект остаётся на холсте до ухода с уровня.
  childrenRev?: number;
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
  // onEnterNode, onEditNode, onInspectGhost, onInspectNodeId, onClearSelection. Состав — LevelDrillCallbacks.
  drill: LevelDrillCallbacks;
  // Колбэки создания и инспекции связей: onEdgesChoice, onCreateEdge,
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
  // ПРОЕКЦИЯ ХОЗЯИНА (холст развёртывания, docs/specs/deployment.md): полный состав
  // раскрытых контейнеров, предел вложенности, декор рамок, пометки и группы карточек,
  // снятие выделения токеном. Не передан — прежнее поведение байт-в-байт. Состав —
  // LevelProjectionProps.
  projection?: LevelProjectionProps;
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
  childrenRev = 0,
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
  projection,
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
    fitOnExpand = false, schemaView = "all", edgeLabelsHidden: edgeLabelsHiddenMode,
  } = mode ?? {};
  const { onDrillDown, onEnterNode, onEditNode, onInspectGhost, onInspectNodeId, onClearSelection, onSelectionChange } = drill;
  const {
    children: projectedChildren, inlineDepth, frameDecor, marks, groupOf, clearSelectionToken,
  } = projection ?? {};
  // Признак проекции для ключа кэша маршрутов вида: у холста развёртывания своя сцена
  // на том же уровне и том же view_id, что у холста объектов.
  const projected = projection !== undefined;
  // Раскрываемые контейнеры проекции — ключи карты состава (площадки): лупа только у
  // них; карточка проекции с детьми вне карты (цельный контейнер) не раскрывается.
  const expandableIds = useMemo(
    () => (projectedChildren ? new Set(Object.keys(projectedChildren)) : undefined),
    [projectedChildren],
  );
  const { onCreateEdge, onConnectInto, onExitUp, onEdgesChoice, onReconnectFrameEnd } = edgeCallbacks;
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
  const [rfNodes, setRfNodesRaw, onNodesChange] = useNodesState<RFNode>([]);
  const [rfEdges, setRfEdgesRaw, onEdgesChange] = useEdgesState<RFEdge>([]);
  // Маркер «RF-стейт только что менялся» (apply, drawIn-маски, frame-follow):
  // авто-центрирование ждёт ТИХОЕ ОКНО после последнего коммита, чтобы анимация
  // фитовки не стартовала внутри тяжёлого коммита и не билась о последующие
  // (трейс 2026-08-06: коммиты 100–180ms морозили кадры центрирования).
  const lastRfCommitRef = useRef(0);
  const setRfNodes = useCallback<typeof setRfNodesRaw>((...a) => {
    lastRfCommitRef.current = performance.now();
    return setRfNodesRaw(...a);
  }, [setRfNodesRaw]);
  const setRfEdges = useCallback<typeof setRfEdgesRaw>((...a) => {
    lastRfCommitRef.current = performance.now();
    return setRfEdgesRaw(...a);
  }, [setRfEdgesRaw]);

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
  const computeNowRef = useRef<(opts?: { cleanup?: boolean }) => Promise<"applied" | "skipped" | "stale">>(
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

  // ПЕРЕГРУЖЕННАЯ СЦЕНА (перф-эпик Ф2, P1/P8): классификация по применяемой
  // раскладке (отображаемые узлы = локалы + гости; мастер-рёбра = groupArr).
  // Реф читает оркестратор анимации (честное отключение), стейт — разовый тост.
  const overloadedRef = useRef(false);
  const overloadToast = useOncePerViewToast();
  // ТОСТ СТУПЕНЕЙ БЮДЖЕТА РАБОТ (Ф5 эпика router-opt, спека perf.md P13) — по образцу
  // разового тоста перегрузки P8. Ступень бюджета означает, что часть стадий качества
  // стрелок принесена в жертву потолку работ; молчаливая деградация запрещена ровно так
  // же, как молчаливое отключение анимаций.
  const budgetToast = useOncePerViewToast();
  // Разовый совет о грязи стрелок на перегруженной сцене (P15) — только тем, кто
  // может двигать узлы: совет «подёргайте узлы» наблюдателю невыполним.
  const dirtyToast = useOncePerViewToast();
  const { show: showOverloadToast } = overloadToast;
  const { show: showBudgetToast } = budgetToast;
  const { show: showDirtyToast } = dirtyToast;
  // Занятость конвейера (P4): счётчик прогонов в полёте; бейдж «Считаю
  // раскладку…» проявляется CSS-задержкой INDICATE_AFTER_MS=300мс (LevelGraph.css).
  const [computing, setComputing] = useState(0);
  // «Скрыть подписи связей» (CV32): чисто визуальный режим — скрытие CSS-классом на
  // корне, раскладка/маршруты не пересчитываются. Собственное состояние живёт, когда
  // тумблером владеет канвас (mode.edgeLabelsHidden не передан); управляемый режим
  // (редактор-карта) приносит состояние пропом, свой тумблер не рисуется.
  const [edgeLabelsHiddenOwn, setEdgeLabelsHiddenOwn] = useState(readEdgeLabelsHidden);
  const labelsHidden = edgeLabelsHiddenMode ?? edgeLabelsHiddenOwn;
  const toggleEdgeLabels = useCallback(() => {
    const next = !edgeLabelsHiddenOwn;
    writeEdgeLabelsHidden(next);
    setEdgeLabelsHiddenOwn(next);
  }, [edgeLabelsHiddenOwn]);
  // Защита от прокликивания (P5): id контейнеров с интентом раскрытия/сворачивания,
  // ждущим применения. Повторный клик по тому же id (в т.ч. «отменяющий») до
  // применения игнорируется — иначе каждый клик перезапускал бы конвейер
  // («последний выигрывает» убивает прогон в полёте), а клик, попавший в момент
  // смены кнопки, «отменял» ещё не показанное раскрытие. Чистится применением
  // раскладки; TTL — страховка на случай умершего прогона.
  const pendingToggleRef = useRef(new Map<string, number>());

  // Анимация раскрытия/сворачивания контейнеров: единственная точка применения
  // раскладки к RF-стейту (applyLayout вместо прямых setRfNodes/setRfEdges в
  // сборщике). Интенты ставят обработчики лупы/сворачивания; окно анимации
  // включает класс lg-canvas--anim (CSS-transition в LevelGraph.css).
  const {
    apply: applyLayout, noteExpand, noteCollapse, noteRelayout, noteGesture, noteMutation,
    cancel: cancelAnim, reset: resetAnim, active: animActive, jumpsPaused,
  } = useLayoutAnimation({ getNodes, getEdges, setRfNodes, setRfEdges, gate, overloadedRef });
  // Авто-центрирование (fitOnLoad/fitOnExpand): didLoadFitRef — одноразовый фит
  // загрузки (на маунт; холст ремаунтится по key=node.id, поэтому «один раз» ==
  // «один раз на страницу»). autoFitRef — запрос на АНИМИРОВАННОЕ центрирование
  // (метка времени взведения; null — запроса нет): взводят раскрытие/сворачивание
  // (useLevelDrill) и «Переразложить» (эффект ниже), гасит эффект авто-центрирования.
  // Таймер там — дебаунс оседания раскладки (двухфазная: замер может прийти вторым
  // прогоном, фитим по последнему в окне).
  const didLoadFitRef = useRef(false);
  const autoFitRef = useRef<number | null>(null);

  // Смена уровня/режима: отложенная анимация протухла — жёсткий сброс без доигровки
  // (свежую раскладку нового уровня применит сборщик).
  useEffect(() => { resetAnim(); }, [containerId, resetAnim]);
  // «Переразложить»: страница-хозяин свершила сброс (токен) — интент держится в
  // хуке до прихода свежего прогона и режиссирует его чистым переездом. На
  // страничных схемах (fitOnExpand) сброс раскладки — ещё и запрос на анимированное
  // центрирование: состав прежний, но геометрия новая, и результат хочется видеть
  // целиком по центру — как после раскрытия/сворачивания. Фит идёт ПОСЛЕ оседания
  // переезда (гейт !animActive в эффекте центрирования), не поверх него.
  useEffect(() => {
    if (!relayoutToken) return;
    noteRelayout();
    if (fitOnExpand) autoFitRef.current = performance.now();
  }, [relayoutToken, noteRelayout, fitOnExpand]);
  // Мутация страницы (создание/удаление узлов и связей): окно мутаций — стрелки
  // с изменившейся геометрией перерисуются анимированно, новые нарисуются (AN28а).
  useEffect(() => { if (mutationToken) noteMutation(); }, [mutationToken, noteMutation]);

  // ЕДИНЫЙ канал записи раскладки вида (R3): дедуп+merge поверх зеркала → батч-PUT
  // view_layout (fence + политика 409) + зеркало родителю. Тела commitLayout/
  // persistFenced, очередь фенсированных записей, исполнитель переигровки retryPatch
  // и стабильная обёртка — в useLevelPersistence (Фаза 3в-А). commitLayout нужен
  // драгу/снапам (commitLayoutStable), раскрытиям (commitExpanded) и конвейеру
  // (intent-засев через cbRef).
  // view_id записи раскладки: ключ ВИДА (layoutViewId), а не структурный containerId.
  // На странице объекта раскладка персистится в вид фокуса (node.id), тогда как
  // containerId (= parent_id) продолжает ключить структуру/предков/глубину ниже.
  const { commitLayout, commitLayoutStable, persistFailed, dismissPersistFailed } = useLevelPersistence({
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
  // конвейеру раскладки и сборщику RF; autoFitRef хук взводит при раскрытии и
  // сворачивании (владелец запроса — эффект авто-центрирования ниже).
  const {
    drillWithPath, expandContainer: rawExpandContainer,
    expandLocalContainer: rawExpandLocalContainer, collapseContainer: rawCollapseContainer,
    expanded, relevantCounts, localChildren,
  } = useLevelDrill({
    containerId, nodes, edges, endpoints, ancestorIds, ancestorNames,
    onDrillDown, onEnterNode, viewLayout, ignorePersistedExpanded, isReadOnly,
    fitOnExpand, autoFitRef, childrenRev, commitLayout, noteExpand, noteCollapse,
    layoutLatestRef, projectedChildren,
  });

  // Защита от прокликивания (P5): любой повторный toggle по id с висящим интентом
  // игнорируется до применения раскладки (или до TTL — страховка).
  const TOGGLE_GUARD_TTL_MS = 15_000;
  const guardedToggle = useCallback((id: string, fn: (id: string) => void) => {
    const ts = pendingToggleRef.current.get(id);
    if (ts !== undefined && performance.now() - ts < TOGGLE_GUARD_TTL_MS) return;
    pendingToggleRef.current.set(id, performance.now());
    fn(id);
  }, []);
  // Раскрытие лупой ждёт обучающий тур демо-стенда (шина tourBus, docs/tasks/demo-tour.md).
  const expandContainer = useCallback(
    (id: string) => guardedToggle(id, (x) => { rawExpandContainer(x); emitTourEvent({ type: "node-expanded", id: x }); }),
    [guardedToggle, rawExpandContainer]);
  const expandLocalContainer = useCallback(
    (id: string) => guardedToggle(id, (x) => { rawExpandLocalContainer(x); emitTourEvent({ type: "node-expanded", id: x }); }),
    [guardedToggle, rawExpandLocalContainer]);
  const collapseContainer = useCallback(
    (id: string) => guardedToggle(id, rawCollapseContainer), [guardedToggle, rawCollapseContainer]);

  // Состояние центральных направляющих магнитного выравнивания (общее для snap-драга
  // и drop-шаблона).
  const { guides, setGuides, clearGuides } = useAlignmentGuides();

  // История Undo/Redo: адаптер со штампом уровня, запуск отмены/повтора и глобальные
  // клавиши (только архитектор и не контекст — read-only).
  const { history, runUndo, runRedo } = useLevelHistory({
    historyProp, onUndo, onRedo, containerId, noteGesture, keysEnabled: isArchitect && canArrange,
  });

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

  // Рамки НЕ таскаются (запрет движения рамок, 2026-07-08): их rect производен от
  // детей, перемещение содержимого = перемещение самих узлов. ЖИВОЙ bbox-follow
  // рамок при драге ребёнка — оверлей в useFrameFollowOverlay (вынесен при распиле Ф2).
  const frameFollow = useFrameFollowOverlay({ rfNodes, setRfNodes, getNodes });
  // Скоуп пересчёта после драга (фикс дрейфа): id узлов последнего жеста. computeNow
  // передаёт их конвейеру (роутятся только их рёбра, остальные — из prevRoutes) и сразу
  // обнуляет — следующий прогон (не дроп) считает всё целиком.
  const dragScopeRef = useRef<string[] | null>(null);
  // Старт, ход и отпускание драга узлов и рамки выделения; dragging замораживает
  // реестр «мостиков» на время жеста, draggingRef читает таймер фоновой уборки (P14).
  const {
    dragging, draggingRef,
    handleNodeDragStart, handleSelectionDragStart, handleNodeDrag, handleSelectionDrag,
    handleNodeDragStopP, handleSelectionDragStopP,
  } = useLevelDragLifecycle({
    rfNodes, rfEdges, history, liveDragHandles, frameFollow, noteDragStart,
    handleNodeDragStop, handleSelectionDragStop, cancelAnim, noteGesture,
    gestureActiveRef, dragScopeRef,
  });

  // Удаление выбранного узла с клавиатуры через подтверждение.
  const { handleKeyDown } = useCanvasDelete({
    rfNodes, isArchitect, disabled: !canStructure, onRequestDeleteNode, onRequestDeleteNodes,
  });


  // Узлы холста как концы новой связи: цель протяжки («зона входа» / напрямую) и имя
  // отображаемого узла для заголовков окон создания связи.
  const { resolveTarget, displayNameOf } = useConnectTargets(rfNodes);

  // Создание новой связи протягиванием стрелки (хэндл → напрямую, тело контейнера →
  // выбор потомка).
  const {
    connecting, handleConnectStart, handleConnect, handleConnectEnd, isValidNewConnection,
    handleReconnectStart, handleReconnectEnd,
  } = useEdgeConnect({
    isArchitect, disabled: !canStructure, resolveTarget,
    onCreate: (s, t) => onCreateEdge?.(s, t, displayNameOf(s), displayNameOf(t)),
    onInto: (s, cid, cname) => onConnectInto?.(s, cid, cname, displayNameOf(s)),
    onExitUp: (s) => onExitUp?.(s, displayNameOf(s)),
  });

  // Перепривязка конца-в-рамку (edge.md E1a): правила попадания, перевес и признак
  // «идёт перевес» для класса холста; ручку рисует ребро (RehangAnchor).
  const { rehanging, rehangHandlers } = useLevelRehang({
    layoutLatestRef, canStructure, onReconnectFrameEnd, handleReconnectStart, handleReconnectEnd,
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
  // Инспекция связей (openEdgeMembers) вынесена в useLevelEdgeChoice (Фаза 3б) —
  // колбэк кормит cbRef ниже.
  const { openEdgeMembers } = useLevelEdgeChoice({ edges, onEdgesChoice });

  const cbRef = useRef({ onDrillDown, drillWithPath, onEnterNode, onEditNode, onInspectGhost, onInspectNodeId, onClearSelection, onSelectionChange, expandContainer, expandLocalContainer, collapseContainer, openEdgeMembers, commitLayout, quickConnect: quickConnectHandlers });
  // Канонический latest-ref: обновляем cbRef.current в эффекте БЕЗ зависимостей (после
  // каждого рендера). Объявлен ДО эффекта сборки ниже — порядок исполнения эффектов =
  // порядок объявления, поэтому сборка читает уже свежий cbRef.current. Поведенчески
  // ноль: и события узлов, и эффекты исполняются после рендера.
  useEffect(() => {
    cbRef.current = { onDrillDown, drillWithPath, onEnterNode, onEditNode, onInspectGhost, onInspectNodeId, onClearSelection, onSelectionChange, expandContainer, expandLocalContainer, collapseContainer, openEdgeMembers, commitLayout, quickConnect: quickConnectHandlers };
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
    // СНИМОК ФИНАЛЬНОЙ СЦЕНЫ прогона (Ф3, E84): позиции и габариты, по которым
    // посчитаны routes. Конвейер диффует его со своими финальными позициями и сам
    // считает скоуп пересчёта (раскрытие/сворачивание больше не платит всей сценой).
    // Копии ГЛУБОКИЕ: positions конвейера и словарь замеров живут своей жизнью, а
    // снимок обязан описывать именно тот прогон, чьи маршруты лежат рядом.
    scene: PrevScene;
    version: number;
  } | null>(null);
  // ПЕРСИСТНЫЙ КЭШ МАРШРУТОВ ВИДА (Ф2 эпика router-opt, спека perf.md P11): маршруты
  // последнего АВТОРИТЕТНОГО прогона этого вида, пережившие уход с вида и перезагрузку.
  // Открытие уровня — единственный сценарий без prev (гистерезис и скоуп бессильны):
  // кэш возвращает конвейеру prev, и при совпадении routeSig стадии качества стрелок
  // не считаются вовсе. Ключ вида и сама запись — в рефах: чтение кэша не имеет права
  // порождать рендер или лишний прогон конвейера.
  const cachedEntryRef = useRef<RouteCacheView | null>(null);
  const viewCacheKeyRef = useRef<string>("");
  // Смена ВИДА: гистерезис прошлого вида невалиден (сброс), кэш нового — читается.
  // layoutViewId в зависимостях, потому что вид — это пара (структурный containerId,
  // ключ раскладки): на странице объекта соседние узлы делят parent_id и различаются
  // только layoutViewId. Эффект объявлен ВЫШЕ эффекта раскладки — на смене вида он
  // успевает подставить свежий кэш до первого прогона.
  useEffect(() => {
    prevRoutesRef.current = null;
    lastSigRef.current = null;
    const key = viewCacheKey(getCurrentProjectId(), containerId, layoutViewId, projected ? "deploy" : undefined);
    viewCacheKeyRef.current = key;
    const entry = routeCache.load(key);
    cachedEntryRef.current = entry ? fromCacheEntry(entry) : null;
  }, [containerId, layoutViewId, projected]);

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
      // проекция хозяина (холст развёртывания): предел гейта лупы, декор рамок, пометки,
      // раскрываемые контейнеры; без проекции все undefined — сборка прежняя
      maxInlineDepth: inlineDepth, frameDecor, marks, expandableIds,
    });
    // Реконсиляция (Ф2): содержательно неизменённые объекты заменяются ПРОШЛЫМИ
    // из стейта RF — React.memo узлов/рёбер снова работает, apply перестаёт
    // ре-рендерить всю сцену (заодно неизменённые узлы переживают пересчёт с
    // сохранённым выделением/замерами).
    const recNodes = reconcileNodes(getNodes(), nextNodes);
    const recEdges = reconcileEdges(getEdges(), nextEdges);
    // Классификация сцены (P1) ДО применения: оркестратор внутри applyLayout
    // уже должен видеть свежий вердикт (честное отключение анимаций P8).
    const displayedCount = layout.nodes.length + layout.entities.length;
    const overloaded = displayedCount > OVERLOAD_NODES || layout.groupArr.length > OVERLOAD_EDGES;
    overloadedRef.current = overloaded;
    if (overloaded) {
      const viewKey = containerId ?? "__root__";
      showOverloadToast(viewKey); // разовый тост на вид (P8)
      // Разовый совет о грязи стрелок (P15, пожелание пользователя 2026-09-01):
      // на перегруженной сцене холодная раскладка грубее, а выправляет её именно
      // серия правок (скоуп E84 → невидимая уборка P14 → чистый гистерезис под
      // следующим действием). Совет выполним только тому, кто может двигать узлы.
      // Уборка сюда не доходит (setLayout не зовёт — apply не срабатывает), так
      // что «сам всплывший» тост невозможен (аксиома P14).
      if (isArchitect && canArrange) showDirtyToast(viewKey);
    }
    // Применение состоялось — интенты раскрытий отражены на холсте, гвард
    // прокликивания (P5) отпускает накопленные id.
    pendingToggleRef.current.clear();
    // Применение — через оркестратор анимации: без интента раскрытия/сворачивания
    // это те же setRfNodes/setRfEdges, с интентом — режиссированный переход.
    applyLayout(recNodes, recEdges);
    // Применение состоялось — разбудить ждущий флаш тихого окна: unmask ждёт
    // именно ПРИМЕНЕНИЯ (не конца счёта), чтобы drawIn рисовал свежие маршруты.
    appliedResolveRef.current?.();
    appliedResolveRef.current = null;
  }, [layout, isArchitect, canArrange, depth, isReadOnly, drillNav, relevantCounts, schemaView, applyLayout, getCb, getNodes, getEdges, containerId, showOverloadToast, showDirtyToast, inlineDepth, frameDecor, marks, expandableIds]);

  // НЕВИДИМАЯ УБОРКА СКОУПНОЙ ГРЯЗИ (спека perf.md P14): скоупный прогон (E82/E84)
  // кладёт часть рёбер хуже полного и не обновляет кэш вида — по паузе бездействия
  // холст досчитывает полный прогон С ГИСТЕРЕЗИСОМ и НЕ ПОКАЗЫВАЕТ его: экран
  // меняется только от действия пользователя. Уборка пишет ровно две вещи — кэш вида
  // (P11) и снимок гистерезиса; чистая геометрия приезжает СЛЕДУЮЩИМ действием.
  // Таймер живёт в хуке (чистая логика под тест), прогон — здесь: уборка идёт той же
  // оркестрацией («последний выигрывает» по runId).
  // «Занято» читаем СИНХРОННО: драг в полёте (draggingRef) или открытое тихое окно
  // анимации (holdRef — в нём прогоны вообще откладываются) — уборка ждёт тишины.
  const idleCleanup = useIdleCleanup({
    run: () => { void computeNowRef.current({ cleanup: true }); },
    isBusy: () => draggingRef.current || holdRef.current,
  });

  // Один прогон конвейера раскладки (бывшее тело async-эффекта; Ф1 вынесла его в
  // колбэк, чтобы флаш тихого окна мог досчитать отложенное со СВЕЖИМИ пропсами).
  // «Последний выигрывает»: прогон, перегнанный более новым (runIdRef), не пишет
  // ничего — ни снапшота гистерезиса, ни персиста интентов, ни setLayout.
  const computeNow = useCallback(async (
    // УБОРОЧНЫЙ ПРОГОН (P14): тот же путь и тот же билдер входа, но (1) без sig,
    // снимка сцены и скоупа, (2) результат НЕ ПРИМЕНЯЕТСЯ на экран — только кэш вида
    // и снимок гистерезиса. Экран меняется исключительно от действия пользователя.
    opts?: { cleanup?: boolean },
  ): Promise<"applied" | "skipped" | "stale"> => {
    const cleanup = opts?.cleanup === true;
    const runId = ++runIdRef.current;
    idleCleanup.noteRunStarted(); // любой новый прогон снимает взведённую уборку
    // Счётчик «раскладка в полёте» — сигнал занятости для полигона (dump-levels ждёт
    // нуля перед снятием сигнатуры): раскладка двухфазная (фолбэк-габариты → замер →
    // пере-прогон), и без явного сигнала снапшот ловил межфазное состояние.
    const w = diag;
    w.__archmapLayoutInflight = (w.__archmapLayoutInflight ?? 0) + 1;
    w.__archmapLayoutRuns = (w.__archmapLayoutRuns ?? 0) + 1;
    // ИНДИКАЦИЯ ЗАНЯТОСТИ (P4) — но НЕ для уборки: бейдж «Считаю раскладку…» и
    // курсор progress без действия пользователя это снова «само что-то происходит»
    // (исключение зафиксировано в P4). Полигонные счётчики выше НЕ трогаем — их
    // ждут зонды, и уборка для них такой же прогон, как всякий другой.
    if (!cleanup) setComputing((c) => c + 1);
    try {
      // гистерезис — только между прогонами с ОДНИМ комплектом замеров (см. prevRoutesRef)
      const sameSizes = prevRoutesRef.current?.version === sizesVersion;
      const cached = sameSizes ? null : cachedEntryRef.current;
      // Ключ вида ФИКСИРУЕМ до await: если вид сменится, пока прогон в полёте, его
      // результат не имеет права лечь под ключ нового вида (sig всё равно не совпал бы,
      // но занятый впустую слот — тоже потеря).
      const cacheKey = viewCacheKeyRef.current;
      // скоуп после драга: роутим только рёбра перетащенных узлов (обрывает каскад rip-up
      // и дрейф). Обнуляем СРАЗУ: прогон берёт скоуп ровно один раз, следующий — полный.
      // Уборка скоуп НЕ ЧИТАЕТ И НЕ СЪЕДАЕТ: она полна по построению, а взведённый
      // жестом скоуп обязан достаться прогону этого жеста.
      const scopeNodeIds = cleanup ? undefined : (dragScopeRef.current ?? undefined);
      if (!cleanup) dragScopeRef.current = null;
      // Словарь замеров ФИКСИРУЕМ до await: useLevelMeasure подменяет его целиком на
      // новом замере, а снимок сцены обязан описывать ровно то, что видел этот прогон.
      const sizesAtRun = nodeSizesRef.current;
      // PREV-ПОЛЯ ВХОДА — ОДИН БИЛДЕР НА ВСЕ ПРОГОНЫ (P14): уборочный отличается ровно
      // тремя вычеркнутыми полями (sig, scene, scope) — второго билдера входа не
      // заводим, иначе они разъедутся. Почему уборка идёт С ГИСТЕРЕЗИСОМ: холодный
      // прогон не стабилен к сдвигу позиций и дал бы телепорт почти всех рёбер при
      // следующем действии; гистерезис же чинит ровно грязные линии, оставляя
      // остальные на месте (полевая находка приёмки №1, раунд 3).
      // ПОЧЕМУ БЕЗ SIG — ОТДЕЛЬНЫЙ ИНВАРИАНТ: входы уборки совпадают со входами
      // последнего прогона, совпавший prevRouteSig увёл бы конвейер в кэш-хит-ветку
      // «вернуть prev целиком» (сверка стоит ДО стадий) — уборка вернула бы ту самую
      // грязь и записала бы её в кэш вида с authoritative = true (отравление P11).
      // Без sig стадии качества отрабатывают по-настоящему — уборка и авторитетна,
      // и чиста. СНИМОК СЦЕНЫ — тоже нет: он включил бы авто-скоуп (E84), а уборка
      // обязана перепроложить ВСЁ. СКОУП драга уборке не достаётся по построению.
      // prev — свой снимок (тот же комплект замеров) ИЛИ персистный кэш вида, когда
      // своего снимка нет/он от других замеров. Кэш даёт одно из двух: совпал
      // routeSig — мгновенный результат без стадий качества; не совпал — обычная
      // гистерезис-валидация (buildAutoRoutes сам отбрасывает невалидный prev).
      // На SKIP-прогонах (P10) кэш тоже передаём: стадии там не идут, но кэш-хит по
      // sig сильнее пропуска — сцена открывается сразу со стрелками, а не кадром
      // smoothstep. Когда sig не совпал, prev в пропущенных стадиях просто не читается.
      // СНИМОК ПРОШЛОЙ СЦЕНЫ — только вместе со СВОИМ prev (ветка sameSizes): конвейер
      // диффует его с финальными позициями и роутит лишь окрестность изменений (E84).
      // Персистный кэш вида снимка не несёт (в ветке !sameSizes prev приходит из него),
      // поэтому там авто-скоуп не работает: либо кэш-хит по routeSig, либо честный
      // полный прогон — оба варианта корректны, инкремента просто нет.
      const prev = {
        routes: sameSizes ? prevRoutesRef.current?.routes : cached?.routes,
        handles: sameSizes ? prevRoutesRef.current?.handles : cached?.handles,
        labels: sameSizes ? prevRoutesRef.current?.labels : cached?.labels,
        // три поля, вычеркнутые у уборки (см. блок выше)
        sig: cleanup ? undefined : (sameSizes ? prevRoutesRef.current?.sig : cached?.sig),
        scene: cleanup ? undefined : (sameSizes ? prevRoutesRef.current?.scene : undefined),
        scope: cleanup ? undefined : (sameSizes ? scopeNodeIds : undefined),
      };
      // Ф3: счёт в Web Worker — главный поток на время прогона свободен (фолбэк
      // на прямой вызов модуля внутри клиента; «последний выигрывает» — runId ниже).
      const {
        layout: next, liveInputs, intents, routeSig, authoritative, scoped, budgetDegraded,
      } = await computeViewLayoutOffThread({
        nodes, endpoints, edges, containerId, viewLayout,
        ancestorIds: stableAncestorIds, expanded, localChildren,
        // ленивая догрузка детей раскрытий живёт только в редактируемом режиме
        // (useLevelDrill не фетчит в read-only): конвейеру это нужно, чтобы отличить
        // «дети ещё едут» (состав неполон, прогон повторится) от «детей не будет»
        // (страничные схемы — там раскрытый контейнер рисуется свёрнутым навсегда).
        // Проекция хозяина приносит состав целиком — догрузки нет и там.
        childrenLazyLoad: !isReadOnly && !projectedChildren,
        // предел инлайн-вложенности от проекции (развёртывание — без предела); не
        // задан — поле не передаётся, конвейер берёт MAX_INLINE_DEPTH
        ...(inlineDepth !== undefined ? { maxInlineDepth: inlineDepth } : null),
        sizes: sizesAtRun,
        // edgeQuality НЕ задаём — авто-режим конвейера (P10): прогоны с крупной
        // пачкой незамеренных узлов (первый показ, раскрытие с новыми детьми)
        // идут без стадий качества стрелок — их пересчитает прогон по замерам.
        prevRoutes: prev.routes,
        prevEdgeHandles: prev.handles,
        prevRouteSig: prev.sig,
        prevLabelPlacements: prev.labels,
        scopeNodeIds: prev.scope,
        prevScene: prev.scene,
      });
      if (runId !== runIdRef.current) return "stale"; // устаревший прогон: ничего не пишет
      // УЧЁТ СКОУПНОЙ ГРЯЗИ (P14): скоупный прогон её создал, авторитетный — смыл.
      // Отсюда взводится (и снимается) таймер фоновой уборки; уборочный прогон,
      // не ставший авторитетным, повторной попытки не получает.
      idleCleanup.noteRunFinished({ scoped, authoritative, cleanup });
      // СТУПЕНИ БЮДЖЕТА (P13): объявляем пользователю разовым тостом на вид — один на
      // вход в тяжёлый вид, а не на каждый пересчёт (механика P8). Гейт authoritative
      // уже не даст такому прогону попасть в кэш вида (P11), так что «тихая» ступень,
      // законсервированная в кэше, невозможна.
      // Уборка тостов НЕ показывает: её геометрию пользователь не видит (на экран она
      // не идёт), а всплывшее без действия предупреждение — то же «само происходит».
      if (budgetDegraded && !cleanup) showBudgetToast(containerId ?? "__root__");
      // СНИМОК ГИСТЕРЕЗИСА — И ДЛЯ УБОРКИ (P14): её маршруты чистые, а позиции она не
      // меняла, поэтому снимок сцены (из ЕЁ результата, как у всех прогонов) совпадает
      // с экранной сценой — дифф следующего драга остаётся честным. Именно эта запись
      // и обрывает НАКОПЛЕНИЕ грязи: следующий прогон стартует с чистого prev.
      if (next.autoRoutes) {
        prevRoutesRef.current = {
          routes: next.autoRoutes, handles: next.edgeHandles,
          labels: next.labelPlacements, sig: routeSig, version: sizesVersion,
          scene: {
            positions: new Map([...next.positions].map(([id, p]) => [id, { x: p.x, y: p.y }])),
            sizes: new Map(Object.entries(sizesAtRun).map(([id, s]) => [id, { w: s.w, h: s.h }])),
          },
        };
        // ЗАПИСЬ ПЕРСИСТНОГО КЭША — только АВТОРИТЕТНЫЙ прогон (P11): стадии качества
        // отработали или пришёл кэш-хит, все узлы замерены, скоупа нет. Прочие прогоны
        // (пропуск P10, частичные замеры, пересчёт после драга) временны по построению
        // и отравили бы кэш геометрией фолбэк-габаритов или замороженного prev-контекста.
        if (authoritative && next.labelPlacements) {
          const view: RouteCacheView = {
            sig: routeSig, routes: next.autoRoutes,
            handles: next.edgeHandles, labels: next.labelPlacements,
          };
          routeCache.save(
            cacheKey,
            toCacheEntry(view.sig, view.routes, view.handles, view.labels, Date.now()),
          );
          // горячая копия — только если вид с начала прогона не сменился
          if (cacheKey === viewCacheKeyRef.current) cachedEntryRef.current = view;
        }
      }
      // ГРАНИЦА «ЗАПИСАТЬ» / «ПРИМЕНИТЬ» (P14). Выше — то, что уборке МОЖНО: кэш вида
      // и снимок гистерезиса (оба невидимы). Ниже — применение на экран: снимок входов
      // живого драга, персист интентов раскладки, setLayout. Уборке ничего из этого
      // нельзя: экран меняется только от действия пользователя, а её чистая геометрия
      // приедет СЛЕДУЮЩИМ прогоном — тот возьмёт чистый prev, записанный выше.
      // Возврат "skipped" честен по смыслу: прогон посчитан и не применён.
      if (cleanup) return "skipped";
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
      if (!cleanup) setComputing((c) => c - 1); // симметрично инкременту выше
    }
    // Геометрия рёбер внутри viewLayout не вся влияет на позиции, НО зависимость — весь
    // объект намеренно: изломы/хэндлы пучков читает эффект-сборщик выше, и он должен
    // работать с ОДНИМ снапшотом (layout). Иначе при реконнекте смена хэндла (async-
    // раскладка) и сброс изломов (sync-стейт) рассинхронятся: сборщик сработал бы со
    // старым layout → ребро прыгнуло бы на исходный хэндл.
    // idleCleanup ссылочно стабилен (useMemo в хуке) — identity computeNow от него не
    // дрожит, эффект раскладки не перезапускается.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeSizesRef — стабильный ref из useLevelMeasure (читается по .current), в deps не нужен
  }, [nodes, endpoints, containerId, viewLayout, edges, expanded, localChildren, stableAncestorIds, sizesVersion, isReadOnly, idleCleanup, showBudgetToast, projectedChildren, inlineDepth]);
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

  // Рамка уровня, когда слой пуст: приглашение «первый узел кладут сюда» (CV20a).
  const emptyLevelFrame = layout && layout.nodes.length === 0 ? layout.levelFrame : undefined;

  // Двойной клик — единственный триггер меты (правая панель); одиночный — только
  // штатное выделение RF. Отзывается ЛЮБОЙ узел — сплошная фигура на схеме: локальный
  // блок, гость, свёрнутый контейнер гостя; рамка раскрытого узла — нет (это не узел,
  // а его раскрытие). readOnly-страница те же колбэки замыкает на переход на страницу.
  const handleNodeDoubleClick = useCallback(
    (_e: MouseEvent, rfNode: RFNode) => {
      if (rfNode.type === "block") {
        const appNode = (rfNode.data as BlockData | undefined)?.appNode;
        if (appNode) cbRef.current.onEditNode(appNode);
      } else if (rfNode.type === "ghost") {
        const ghost = (rfNode.data as GhostData | undefined)?.appNode;
        if (ghost) cbRef.current.onInspectGhost?.(ghost);
      } else if (rfNode.type === "container") {
        // у свёрнутого контейнера объекта узла нет — только id (он же id узла)
        cbRef.current.onInspectNodeId?.(rfNode.id);
      }
    },
    []
  );
  // По связи: тот же путь, что у плашки (openEdgeMembers → одна связь сразу в панель,
  // несколько членов — выбор участника, см. MapEditorPage). ОБЩЕЕ ПЛЕЧО (E95): клик по
  // стволу неоднозначен — адресуются ВСЕ связи, чьи линии проходят через точку клика (не
  // только верхняя в DOM); на личном участке линии это ровно один пучок. Клик по плашке
  // сюда не попадает — она адресует свою связь однозначно (E57).
  const handleEdgeDoubleClick = useCallback(
    (e: MouseEvent, rfEdge: RFEdge) => {
      if (!canInspectEdges) return;
      const members = new Set<string>((rfEdge.data as WrappedEdgeData | undefined)?.memberIds ?? []);
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      for (const other of getEdges()) {
        if (other.id === rfEdge.id) continue;
        const d = other.data as WrappedEdgeData | undefined;
        const route = d?.autoRoute;
        if (!route || route.length < 2 || distToPolyline(p, route) > SHARED_HIT_TOL) continue;
        for (const id of d?.memberIds ?? []) members.add(id);
      }
      cbRef.current.openEdgeMembers([...members]);
    },
    [canInspectEdges, screenToFlowPosition, getEdges]
  );

  // «Показать на схеме» (locate): центрирование холста на цели + короткая подсветка.
  // Эффект самодостаточен (ждёт появления цели, дедуп по token) — вынесен в
  // useLevelLocate (Фаза 3б); RF-API передаётся из useReactFlow этого компонента.
  useLevelLocate({ locate, rfNodes, rfEdges, getInternalNode, setCenter, fitBounds, fitView });

  // УСТОЙЧИВАЯ подсветка связанного по двойному клику (П5/П6): узел/связь, открытая в
  // правой панели, подсвечена, пока открыта. Эффект самодостаточен — вынесен в
  // useLevelSelection (Фаза 3б). onClearSelection (сброс по клику на пустом холсте)
  // остаётся в cbRef — это триггер выделения, а не его подсветка.
  useLevelSelection({ linkedHighlight, rfNodes, rfEdges });

  // Проекция хозяина: «близнецы» выделенного блока (карточки того же объекта в других
  // рамках) подсвечены тем же классом, RF-выделение — только на самой карточке.
  useProjectionTwins({ groupOf, rfNodes });

  // Выделение наружу (drill.onSelectionChange): id выделенных БЛОКОВ на каждое
  // изменение RF-выделения. Стабильный обработчик, колбэк — из latest-ref.
  const handleSelectionChange = useCallback(({ nodes: sel }: { nodes: RFNode[] }) => {
    cbRef.current.onSelectionChange?.(sel.filter((n) => n.type === "block").map((n) => n.id));
  }, []);
  // «Снять выделение» хозяина (projection.clearSelectionToken): рост токена снимает
  // RF-выделение со всех узлов. Ремаунт холста не годится — потерял бы камеру.
  useEffect(() => {
    if (!clearSelectionToken) return;
    setRfNodes((cur) => (cur.some((n) => n.selected)
      ? cur.map((n) => (n.selected ? { ...n, selected: false } : n))
      : cur));
  }, [clearSelectionToken, setRfNodes]);

  // Выбор связи в панели/модалке (linkedHighlight kind:"edge") переносит и
  // RF-ВЫДЕЛЕНИЕ на несущее ребро: при скрытых подписях (CV32) исключение
  // «плашка выделенной стрелки» следует за выбором — видна та и только та
  // плашка, чью стрелку выбрали (находка приёмки 2026-09-02: модалка ствола
  // ставила подсветку, а выделенной оставалась стрелка одиночного клика).
  // Зависимость — ТОЛЬКО смена цели: последующие ручные клики по стрелкам
  // двигают выделение свободно, эффект с ними не воюет.
  useEffect(() => {
    if (!linkedHighlight || linkedHighlight.kind !== "edge") return;
    const next = selectCarrierEdge(getEdges(), linkedHighlight.id);
    if (next) setRfEdges(next);
  }, [linkedHighlight, getEdges, setRfEdges]);

  // Отклик на зум без ре-рендера графа: толщина рамок держит ~1px на экране, ниже
  // FAR_ZOOM — дальний режим (data-far). Корень холста — canvasRef.
  const canvasRef = useRef<HTMLDivElement>(null);
  const handleViewportChange = useFarZoom(canvasRef);

  // Уровень рендерим даже пустым: тогда сразу видна канва (точки) и в неё можно
  // дропнуть первый узел, а зум остаётся «отдалённым» (defaultViewport ниже),
  // без скачка к гигантскому fitView на единственном узле.
  const hasGraphContent = nodes.length + endpoints.length > 0;

  // Авто-центрирование страничных схем (fitOnLoad/fitOnExpand): по оседании двухфазной
  // раскладки, в тихом окне после RF-коммитов; редактору-карте — no-op.
  useLevelAutoFit({
    layout, sizesVersion, hasGraphContent, fitOnLoad, fitOnExpand, fitView, animActive,
    lastRfCommitRef, didLoadFitRef, autoFitRef,
  });

  return (
    <div
      // lg-canvas--editable — раскрытие хэндлов по ховеру (архитектор, не контекст);
      // lg-canvas--connecting — подсветка «зон входа» (узлов с детьми) во время
      // протягивания новой связи.
      className={
        "lg-canvas" +
        (isArchitect && !isReadOnly ? " lg-canvas--editable" : "") +
        (connecting ? " lg-canvas--connecting" : "") +
        // перевес конца связи: глифы протяжки спрятаны, цель под курсором подсвечена
        (rehanging ? " lg-canvas--rehanging" : "") +
        // окно анимации раскрытия/сворачивания: CSS-transition на узлах и рамках
        (animActive ? " lg-canvas--anim" : "") +
        (labelsHidden ? " lg-canvas--nolabels" : "") +
        // конвейер в полёте: курсор занятости на контролах узлов (P4)
        (computing > 0 ? " lg-canvas--computing" : "")
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
        <HistoryToolbar onUndo={runUndo} onRedo={runRedo} canUndo={history.canUndo()} canRedo={history.canRedo()} />
      )}
      {/* ПРАВЫЙ верхний угол: «Переразложить» (архитектор, передан onRelayout) +
          тумблер «Скрыть подписи связей» (CV32, все роли — просмотровый режим, не
          правка). Стилистика едина с тулбаром Undo/Redo (тот же класс lg-seg).
          Редактор-карта не передаёт onRelayout И владеет тумблером сама (управляемый
          mode.edgeLabelsHidden): её угол холста занят рейлом алертов (AL10), поэтому
          там обе кнопки живут в топбаре, а здесь угол остаётся пустым. */}
      <ViewToolbar
        onRelayout={isArchitect ? onRelayout : undefined}
        labels={edgeLabelsHiddenMode === undefined ? { hidden: labelsHidden, onToggle: toggleEdgeLabels } : undefined}
      />
      {/* Легенда статусов и переключатель «Вид схемы» живут в правой панели схемы
          (MapEditorPage → ObjectInspector); оверлея на холсте больше нет. */}
      {/* Плитка «вне уровня»: полоса у верхнего края холста, видна только при
          протягивании НОВОЙ связи на не-корневом уровне. Отпустил на неё конец
          стрелки → выбор дальнего конца из всей схемы (useEdgeConnect ловит дроп по
          data-exit-up). Не объект графа, а элемент интерфейса. */}
      {connecting && containerId && <ExitUpTile />}
      {/* Индикация занятости конвейера (перф-эпик Ф2, P4): бейдж проявляется
          CSS-задержкой 300мс (INDICATE_AFTER_MS) — короткие пересчёты не мигают.
          Работает и на пустом холсте первого показа (layout ещё null). */}
      {computing > 0 && (
        <div className="lg-busy" role="status">
          <span className="lg-busy-spin" aria-hidden />
          Считаю раскладку…
        </div>
      )}
      {/* Разовый тост перегруженной сцены (P8): честное предупреждение об
          отключении анимаций — один на вход в перегруженный вид. */}
      {overloadToast.open && (
        <CanvasNotice tone="overload" closeLabel="Закрыть предупреждение" onClose={overloadToast.close}>
          Схема перегружена: плавность не гарантируется, анимации могут отключаться.
        </CanvasNotice>
      )}
      {/* Запись расположения не прошла (аудит R-11): схема вернулась к сохранённой. */}
      {persistFailed && (
        <CanvasNotice tone="overload" role="alert" closeLabel="Закрыть сообщение" onClose={dismissPersistFailed}>
          Не удалось сохранить расположение — схема вернулась к последней сохранённой версии.
        </CanvasNotice>
      )}
      {/* Разовый тост ступеней бюджета работ (P13): честное объявление о том, что
          раскладка стрелок упрощена ради потолка счёта. */}
      {budgetToast.open && (
        <CanvasNotice tone="budget" closeLabel="Закрыть предупреждение" onClose={budgetToast.close}>
          Сцена очень плотная: раскладка упрощена.
        </CanvasNotice>
      )}
      {/* Разовый совет о грязи стрелок на перегруженной сцене (P15): холодная
          раскладка грубее, выправит её серия правок (невидимая уборка +
          гистерезис, P14). Текст — пожелание пользователя 2026-09-01 дословно. */}
      {dirtyToast.open && (
        <CanvasNotice tone="dirty" closeLabel="Закрыть подсказку" onClose={dirtyToast.close}>
          На вашей схеме очень много объектов, поэтому стрелки могут быть
          расставлены неаккуратно. Подёргайте несколько узлов, и стрелки
          выправятся сами.
        </CanvasNotice>
      )}
      {/* Реестр «мостиков»: рёбра внутри ReactFlow публикуют сюда геометрию и читают
          точки прыжков. Пауза — на драг И на фазу move анимации (иначе пересчёт реестра
          даёт второй проход рендера всех рёбер посреди окна); снятие — на unmask/свопе,
          батчем с проявлением. */}
      <EdgeJumpProvider enabled paused={dragging || jumpsPaused}>
      {/* Правила перевеса конца-в-рамку для ручек на рёбрах (RehangAnchor, E1a). */}
      <ReconnectProvider handlers={rehangHandlers}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChangeMeasured}
        onEdgesChange={onEdgesChange}
        onNodeDoubleClick={handleNodeDoubleClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        // выделение наружу — только когда хозяин его слушает (холст развёртывания)
        onSelectionChange={onSelectionChange ? handleSelectionChange : undefined}
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
        // Перевес конца-в-рамку (единственный ручной жест над геометрией связи) RF не
        // ведёт: его ручки стояли у служебного хэндла центра стороны. Ручку на точке
        // роутера рисует ребро (RehangAnchor), правила — ReconnectProvider ниже.
        isValidConnection={isValidNewConnection}
        // прощающий радиус защёлки конца на хэндл центра стороны листа (дроп чуть за
        // краем узла всё равно связывает); к зонам входа конец не защёлкивается
        connectionRadius={30}
        connectionMode={ConnectionMode.Loose}
        // Жест протяжки стартует со стрелки-глифа у стороны (Ф5): клик по глифу — быстрая
        // связь, протяжка начинается только после сдвига на порог — иначе дрожание
        // курсора при клике превращало бы его в пустую протяжку. Click-connect RF
        // (клик по хэндлу — начало связи, второй клик — конец) выключен: клик занят.
        connectOnClick={false}
        connectionDragThreshold={4}
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
        fitViewOptions={fitOnLoad ? SCHEMA_FIT_OPTIONS : EDITOR_FIT_OPTIONS}
        // Пустой уровень (fitView выключен) открывается слегка отдалённым — комфортно
        // бросить первый узел, не отъезжая вручную.
        defaultViewport={DEFAULT_VIEWPORT}
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
        panOnDrag={dragNodes ? PAN_RIGHT_BUTTON : (isReadOnly ? true : PAN_RIGHT_BUTTON)}
        selectionOnDrag={dragNodes && canArrange}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
        // двойной клик по пустому холсту сбрасывает выделение (наш onDoubleClick на обёртке) —
        // штатный зум-по-даблклику отключаем, чтобы холст не подлетал на этом жесте
        zoomOnDoubleClick={false}
        // толщина рамок компенсирует отдаление (см. handleViewportChange выше);
        // колбэк ловит и колесо/пан, и программные fitView/setViewport
        onViewportChange={handleViewportChange}
        // предел отдаления снят до MIN_ZOOM (CV2 v2); приближение — дефолт RF (2)
        minZoom={MIN_ZOOM}
        proOptions={PRO_OPTIONS}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e5e7eb" />
        {/* Кнопка «Центрировать» (fit-view). Страничные схемы: SCHEMA_FIT_OPTIONS +
            плавность (duration = ANIM_MOVE_MS) — как авто-фит при раскрытии/сворачивании.
            Редактор-карта: undefined → прежнее поведение (дефолт RF, без cap). */}
        <Controls fitViewOptions={(fitOnLoad || fitOnExpand) ? SCHEMA_FIT_ANIMATED : undefined} />
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
        {/* Подсказки дропа шаблона: превью узла, приглашение пустого слоя, рамка-цель. */}
        <DropOverlays preview={dropPreview} targetFrame={dropTargetFrame} emptyFrame={emptyLevelFrame?.rect} />
        {/* Превью «быстрой связи»: автоопределённая стрелка от хэндла к соседу. Гасим во
            время ручного протягивания (connecting), чтобы превью не накладывались. */}
        {qcCandidate && !connecting && (
          <ViewportPortal>
            <QuickConnectPreview points={qcCandidate.points} />
          </ViewportPortal>
        )}
      </ReactFlow>
      </ReconnectProvider>
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
