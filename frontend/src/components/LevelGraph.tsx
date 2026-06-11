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
  useNodesState,
  useEdgesState,
  useReactFlow,
  ViewportPortal,
  type Node as RFNode,
  type Edge as RFEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./LevelGraph.css";
import type { Node as AppNode, GhostNode, Edge as AppEdge, NodeShape, EdgePoint } from "../types";
import { canHaveChildren } from "../types";
import {
  NODE_W, NODE_H, shapeHeight,
  CTX_LABEL_W,
} from "./graph/constants";
import type {
  WrappedEdgeData,
  BlockData, GhostData, ContainerData,
  DisplayExternal, EdgeShelf, EdgeLoop, EdgeGroup,
} from "./graph/types";
import { edgeText } from "./graph/text";
import { getNodeColors } from "./graph/colors";
import { projectGhosts } from "./graph/layout/projectGhosts";
import { layoutLevel, layoutContext } from "./graph/layout/engine";
import { placeOutsideGhosts } from "./graph/layout/outsideGhosts";
import { computeDetours } from "./graph/layout/detours";
import { NodeShapeSvg } from "./graph/shapes";
import { nodeTypes } from "./graph/nodes";
import { edgeTypes } from "./graph/edges";
import ConnectionLine from "./graph/ConnectionLine";
import { LevelBoundary, AlignmentGuides } from "./graph/boundaries";
import ReconnectBlockedToast from "./graph/ReconnectBlockedToast";
import { useAlignmentGuides } from "./graph/interaction/useAlignmentGuides";
import { useSnapAlignment } from "./graph/interaction/useSnapAlignment";
import { useTemplateDrop } from "./graph/interaction/useTemplateDrop";
import { useReconnectHandles } from "./graph/interaction/useReconnectHandles";
import { useEdgeWaypoints } from "./graph/interaction/useEdgeWaypoints";
import { useCanvasDelete } from "./graph/interaction/useCanvasDelete";
import { useEdgeConnect, type ConnectTarget } from "./graph/interaction/useEdgeConnect";

// --- Основной компонент ---

// Стабильный пустой дефолт для levelEdgeHandles: дефолт-параметр `= {}` создавал бы
// НОВЫЙ объект на каждый рендер, а он — зависимость async-эффекта раскладки → лишний
// перезапуск ELK и мигание. Один модульный объект держит ссылку стабильной.
const EMPTY_LEVEL_HANDLES: Record<string, string[]> = {};
// Тот же приём для пер-уровневых путей гостевых стрелок: стабильная ссылка дефолта,
// чтобы не дёргать сборку рёбер лишний раз.
const EMPTY_LEVEL_WAYPOINTS: Record<string, EdgePoint[]> = {};

// Результат раскладки, который потребляет эффект сборки RF-узлов/рёбер. Считается
// в async-эффекте (Фаза 4): движок async, поэтому это стейт, а не useMemo рендера.
type LayoutResult = {
  // снимок локальных узлов, по которому посчитана раскладка. Сборка RF-узлов читает
  // позиции/данные ИЗ НЕГО, а не из пропа nodes: иначе при смене nodes эффект сборки
  // успевал отработать со СТАРЫМ layout (позиции ещё прежние) до резолва async-ELK —
  // узел на кадр прыгал на исходную позицию. Снимок держит позиции и данные согласованными.
  nodes: AppNode[];
  entities: DisplayExternal[];
  positions: Map<string, { x: number; y: number }>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
  edgeShelves?: Map<string, EdgeShelf>;
  edgeLoops?: Map<string, EdgeLoop>;
  // основная схема: рёбра с дефолтным обводом (вынесенный гость ↔ локальный узел, чей
  // прямой маршрут пересекал бы чужие узлы) → высота огибания clearY
  edgeDetours?: Map<string, { clearY: number }>;
  groupArr: EdgeGroup[];
  spacers: RFNode[];
};

interface LevelGraphProps {
  nodes: AppNode[];
  ghostNodes: GhostNode[];
  // сохранённые координаты гостей на уровне, ключ — id отображаемой сущности
  // (лист-гость ИЛИ предок-контейнер, в который гость свёрнут)
  levelPositions: Record<string, { pos_x: number; pos_y: number }>;
  // сохранённые хэндлы гостевых концов рёбер: edge_id → список значений хэндлов
  // (по одному на проекцию). Применяются к концу, чей текущий показанный узел
  // совпадает с префиксом хэндла; остальные — из колонок ребра / autoHandles.
  // Необязателен: контекст-схема (mode="context") хэндлы не сохраняет — там {}.
  levelEdgeHandles?: Record<string, string[]>;
  // сохранённые пути гостевых стрелок на уровне: edge_id → точки-сгибы
  levelEdgeWaypoints?: Record<string, EdgePoint[]>;
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
  onLevelEdgeWaypointsChanged?: (edgeId: string, waypoints: EdgePoint[]) => void;
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
  // форма шаблона, который СЕЙЧАС перетаскивают из палитры (null — драга нет).
  // Нужна, чтобы во время dragover показать на схеме превью-рамку будущего узла:
  // dataTransfer.getData в dragover недоступен (только на drop), поэтому форму
  // прокидываем через состояние из TreePage.
  dragShape?: NodeShape | null;
  // "level" (по умолчанию) — обычный уровень; "context" — контекстная схема узла
  // из дерева: фокус-блок без кнопок, координаты не сохраняются.
  mode?: "level" | "context";
}

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
  onEditNode,
  onEdgesChoice,
  onEdgeHandlesChanged,
  onEdgeWaypointsChanged,
  onLevelEdgeWaypointsChanged,
  onNodeMoved,
  onDropNode,
  onCreateEdge,
  onConnectInto,
  onExitUp,
  onRequestDeleteNode,
  dragShape,
  mode = "level",
}: LevelGraphProps) {
  const isContext = mode === "context";
  const { screenToFlowPosition } = useReactFlow();
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RFEdge>([]);

  // Развёрнутые соседние контейнеры (свёрнуты по умолчанию). Эфемерно: сбрасываем
  // при переходе на другой уровень.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Центр (в координатах графа) контейнера на момент его раскрытия. По нему
  // центрируем дефолтную раскладку детей: раскрытая рамка встаёт туда же, где
  // стоял свёрнутый узел (детям без ручных координат). Эфемерно, как expanded.
  const expandOrigins = useRef<Map<string, { x: number; y: number }>>(new Map());
  // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс expand-состояния на смену уровня — осознанный reset-on-prop-change; паттерн prev-в-рендере здесь запрещён сестринским правилом react-hooks/refs (expandOrigins.current.clear() в рендере)
  useEffect(() => { setExpanded(new Set()); expandOrigins.current.clear(); }, [containerId]);

  const expandContainer = useCallback((id: string) => {
    // запоминаем центр сворачиваемого контейнера до раскрытия — дефолтная
    // раскладка его детей будет отцентрирована по этой точке
    const c = rfNodes.find((n) => n.id === id);
    if (c) expandOrigins.current.set(id, { x: c.position.x + NODE_W / 2, y: c.position.y + NODE_H / 2 });
    setExpanded((prev) => new Set(prev).add(id));
  }, [rfNodes]);
  const collapseContainer = useCallback((id: string) => {
    setExpanded((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  // Состояние центральных направляющих магнитного выравнивания (общее для snap-драга
  // и drop-шаблона).
  const { guides, setGuides, clearGuides } = useAlignmentGuides();

  // Магнитное выравнивание узлов при драге + персист позиции по отпусканию.
  const { handleNodesChange, handleNodeDragStop } = useSnapAlignment({
    rfNodes, onNodesChange, setGuides, isArchitect, isContext, containerId, onNodeMoved,
  });

  // Удаление выбранного узла с клавиатуры через подтверждение.
  const { handleKeyDown } = useCanvasDelete({
    rfNodes, isArchitect, isContext, onRequestDeleteNode,
  });

  // Персист кастомного пути стрелки (изломы) по отпусканию драга сегмента: локальная —
  // в колонку ребра, гостевая — в пер-уровневый слой. Объявлен до реконнекта: тот при
  // смене хэндла сбрасывает waypoints (пустой массив) — старый путь считался относительно
  // прежних концов и после смены хэндла кривой; дефолтный авто-маршрут корректнее.
  const { commitWaypoints } = useEdgeWaypoints({
    isArchitect, containerId, onEdgeWaypointsChanged, onLevelEdgeWaypointsChanged,
  });

  // Реконнект концов рёбер (смена хэндла на том же узле + персист). resetWaypoints —
  // на смену хэндла дропаем изломы в дефолт (см. выше).
  const {
    handleReconnectStart, handleReconnect, handleReconnectEnd,
    isValidConnection: isValidReconnect, isReconnecting, reconnectBlocked,
    consumeReconnectClick,
  } = useReconnectHandles({
    setRfEdges, nodes, isArchitect, containerId, onEdgeHandlesChanged,
    resetWaypoints: (edgeIds, ghost) => commitWaypoints(edgeIds, [], ghost),
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

  const cbRef = useRef({ onDrillDown, onEditNode, expandContainer, commitWaypoints, openEdgeMembers });
  // Канонический latest-ref: обновляем cbRef.current в эффекте БЕЗ зависимостей (после
  // каждого рендера). Объявлен ДО эффекта сборки ниже — порядок исполнения эффектов =
  // порядок объявления, поэтому сборка читает уже свежий cbRef.current. Поведенчески
  // ноль: и события узлов, и эффекты исполняются после рендера.
  useEffect(() => {
    cbRef.current = { onDrillDown, onEditNode, expandContainer, commitWaypoints, openEdgeMembers };
  });

  // Чистая раскладка (производное в рендере, не в эффекте — это и закрывает класс
  // багов «правка одного ломала соседа»). Зависит ТОЛЬКО от данных. Этапы: проекция
  // гостей → ремап рёбер → слияние мастер-стрелок → позиции/хэндлы (dagre или
  // контекст-раскладка) → центрирование детей раскрытого контейнера → распорки.
  // Раскладку считаем в ASYNC-эффекте (Фаза 4): движок ELK асинхронный, поэтому
  // результат не может жить в useMemo рендера. Эффект перезапускается только при
  // смене ДАННЫХ раскладки (не при драге/выделении — те идут в контролируемый стейт
  // RF), поэтому интерактив сохраняется. Предыдущий layout держим до резолва нового
  // (не сбрасываем в null) — нет мигания между сменой входа и ответом движка.
  // Шаг 4.1: внутри пока СТАРЫЙ движок через async-адаптер (layoutLevel/layoutContext);
  // подмена на ELK — шаги 4.2/4.3. cancelled отбрасывает устаревший результат.
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
    // Сворачиваем гостей к их верхним (неразвёрнутым) контейнерам
    const { entities, ghostToEffective, emergedFrom } = projectGhosts(ghostNodes, stableAncestorIds, expanded);
    const remap = (id: string) => ghostToEffective.get(id) ?? id;
    // Рёбра с концами, переадресованными на отображаемые сущности. Хэндл гостевого
    // конца подменяем сохранённым per-level значением для ТЕКУЩЕЙ проекции (узла,
    // который сейчас показан): из списка берём тот, чей префикс совпал с показанным
    // концом. Хэндл локального конца остаётся из колонки ребра.
    const remappedEdges = edges.map((e) => {
      const source_id = remap(e.source_id);
      const target_id = remap(e.target_id);
      let source_handle = e.source_handle;
      let target_handle = e.target_handle;
      for (const h of levelEdgeHandles[e.id] ?? []) {
        if (h.startsWith(source_id + "--")) source_handle = h;
        else if (h.startsWith(target_id + "--")) target_handle = h;
      }
      return { ...e, source_id, target_id, source_handle, target_handle };
    });

    // В контекст-режиме раскладка эфемерная и единая — сохранённые координаты
    // (фокус двигали на своём уровне) тут из ДРУГОЙ системы координат и дали бы
    // наложение на соседей. Поэтому игнорируем savedPos: чистый dagre.
    const allNodeInfos = [
      ...nodes.map((n) => ({
        id: n.id,
        savedPos:
          !isContext && n.pos_x != null && n.pos_y != null
            ? { x: n.pos_x, y: n.pos_y }
            : null,
      })),
      // Позиция гостя берётся по id ОТОБРАЖАЕМОЙ сущности (лист-гость ИЛИ
      // предок-контейнер, в который гость свёрнут) — иначе свёрнутый контейнер
      // (напр. User Management) каждый раз падал на дефолтную dagre-позицию.
      ...entities.map((ent) => {
        const saved = !isContext ? levelPositions[ent.id] : undefined;
        return {
          id: ent.id,
          savedPos: saved ? { x: saved.pos_x, y: saved.pos_y } : null,
        };
      }),
    ];

    const displayedIds = new Set<string>([...nodes.map((n) => n.id), ...entities.map((e) => e.id)]);

    // Слияние связей одного направления между парой отображаемых узлов в мастер-стрелку
    const groupArr: EdgeGroup[] = [];
    const groupMap = new Map<string, EdgeGroup>();
    for (const e of remappedEdges) {
      if (!displayedIds.has(e.source_id) || !displayedIds.has(e.target_id)) continue;
      let g = groupMap.get(`${e.source_id}>${e.target_id}`);
      if (!g) { g = { id: "", source: e.source_id, target: e.target_id, members: [] }; groupMap.set(`${e.source_id}>${e.target_id}`, g); groupArr.push(g); }
      g.members.push(e);
    }
    for (const g of groupArr) {
      g.id = g.members.length === 1 ? g.members[0].id : `merge:${g.source}->${g.target}`;
    }

    // Раскладку/хэндлы считаем на мастер-рёбрах (по одному на направление между парой).
    // Хэндлы у мастера общие для всех членов (одна линия) — берём у первого члена, у
    // которого они заданы (в remappedEdges хэндлы уже разрешены: колонка для локального
    // конца, гостевой по префиксу). Так пересчёт не сбрасывает хэндл мастера на авто.
    const layoutEdges: AppEdge[] = groupArr.map((g) => {
      if (g.members.length === 1) return g.members[0];
      const longest = g.members.reduce((a, b) => (edgeText(b).length > edgeText(a).length ? b : a));
      return {
        id: g.id, source_id: g.source, target_id: g.target,
        label: longest.label, technology: longest.technology,
        source_handle: g.members.find((m) => m.source_handle)?.source_handle ?? null,
        target_handle: g.members.find((m) => m.target_handle)?.target_handle ?? null,
        created_at: "",
      };
    });

    // Контекст — звезда: своя детерминированная frame-aware раскладка (фокус в центре,
    // соседи в две колонки, колонки за вылетом рамок фокуса). Обычный уровень — dagre.
    const ctxLayout =
      isContext && nodes[0]
        ? await layoutContext(
            nodes[0].id,
            shapeHeight(nodes[0].shape),
            entities,
            layoutEdges,
            stableAncestorIds,
            expanded,
          )
        : null;
    const baseLayout = ctxLayout ?? (await layoutLevel(allNodeInfos, layoutEdges));
    const positions = baseLayout.positions;
    let edgeHandles = baseLayout.edgeHandles;
    // полки подписей и обходы не родных стрелок считаются только в контекст-раскладке
    const edgeShelves = ctxLayout?.edgeShelves;
    const edgeLoops = ctxLayout?.edgeLoops;
    // дефолтные обводы гостевых стрелок (см. блок выноса гостей ниже) — основная схема
    const edgeDetours = new Map<string, { clearY: number }>();

    // Дефолтная раскладка детей раскрытого контейнера: сдвигаем их так, чтобы центр
    // их bbox совпал с центром, где стоял свёрнутый узел (запомнен при раскрытии).
    // Только обычный уровень, только сущности БЕЗ ручных координат (levelPositions),
    // сгруппированные по контейнеру, из которого они вышли. Сущность с ручной
    // позицией остаётся на месте и в центрирование не входит.
    if (!isContext) {
      const groups = new Map<string, string[]>();
      for (const ent of entities) {
        const from = emergedFrom.get(ent.id);
        if (from && expandOrigins.current.has(from) && !levelPositions[ent.id]) {
          (groups.get(from) ?? groups.set(from, []).get(from)!).push(ent.id);
        }
      }
      for (const [from, ids] of groups) {
        const origin = expandOrigins.current.get(from)!;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const id of ids) {
          const p = positions.get(id);
          if (!p) continue;
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
        }
        if (!isFinite(minX)) continue;
        const dx = origin.x - (minX + maxX) / 2;
        const dy = origin.y - (minY + maxY) / 2;
        for (const id of ids) {
          const p = positions.get(id);
          if (p) positions.set(id, { x: p.x + dx, y: p.y + dy });
        }
      }
    }

    // Дефолтная раскладка внешних гостей в колонки за рамку + дефолтные обводы их
    // стрелок: оба шага вынесены в graph/layout/* под юнит-тесты. Блоки исторически
    // вложены (обводы читают placedOutside и bbox рамки из выноса гостей), поэтому
    // outsideGhosts отдаёт результат явно, а computeDetours получает его на вход.
    // outsideGhosts МУТИРУЕТ positions (расставляет колонки); computeDetours чист.
    if (!isContext) {
      const og = placeOutsideGhosts({
        nodes, entities, stableAncestorIds, levelPositions, layoutEdges, positions,
      });
      if (og) {
        edgeHandles = og.edgeHandles;
        const localIds = new Set(nodes.map((n) => n.id));
        const displayIds = [...nodes.map((n) => n.id), ...entities.map((e) => e.id)];
        const { handles, detours } = computeDetours({
          groupArr, placedOutside: og.placedOutside, frame: og.frame,
          localIds, displayIds, positions, levelEdgeWaypoints, levelEdgeHandles,
        });
        for (const [id, h] of handles) edgeHandles.set(id, h);
        for (const [id, d] of detours) edgeDetours.set(id, d);
      }
    }

    // Распорки: обходы не родных стрелок выходят за bbox узлов → крайними точками
    // контента (loopX/clearY обходов + запас под полку с подписью) расширяем область,
    // которую увидит fitView. Только контекст и только если есть обходы.
    const spacers: RFNode[] = [];
    if (isContext && edgeLoops && edgeLoops.size > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of positions.values()) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
      }
      const PAD = 130; // запас под дальнюю полку/подпись не родной стрелки
      for (const lp of edgeLoops.values()) {
        minX = Math.min(minX, lp.loopX - PAD); maxX = Math.max(maxX, lp.loopX + PAD);
        minY = Math.min(minY, lp.clearY - 20); maxY = Math.max(maxY, lp.clearY + 20);
      }
      spacers.push(
        { id: "__spacer_min", type: "spacer", position: { x: minX, y: minY }, data: {}, draggable: false, selectable: false },
        { id: "__spacer_max", type: "spacer", position: { x: maxX, y: maxY }, data: {}, draggable: false, selectable: false },
      );
    }
    // То же для дефолтных обводов гостевых стрелок (основная схема): clearY уходит за
    // bbox узлов сверху/снизу — распорками включаем его в область fitView.
    if (!isContext && edgeDetours.size > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of positions.values()) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
      }
      for (const d of edgeDetours.values()) {
        minY = Math.min(minY, d.clearY - 20); maxY = Math.max(maxY, d.clearY + 20);
      }
      if (isFinite(minX)) {
        spacers.push(
          { id: "__detour_min", type: "spacer", position: { x: minX, y: minY }, data: {}, draggable: false, selectable: false },
          { id: "__detour_max", type: "spacer", position: { x: maxX, y: maxY }, data: {}, draggable: false, selectable: false },
        );
      }
    }

      if (!cancelled) setLayout({ nodes, entities, positions, edgeHandles, edgeShelves, edgeLoops, edgeDetours, groupArr, spacers });
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
    const { nodes: layoutNodes, entities, positions, edgeHandles, edgeShelves, edgeLoops, edgeDetours, groupArr, spacers } = layout;
    const cb = cbRef.current;
    // локальные узлы уровня — у редактируемой жестом стрелки оба конца должны быть
    // локальны (waypoints в координатах этого уровня; гость/контейнер — чужая система)
    const localIds = new Set(layoutNodes.map((n) => n.id));
    setRfNodes([
      ...layoutNodes.map((n) => ({
        id: n.id,
        type: "block" as const,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          appNode: n,
          onDrillDown: cb.onDrillDown,
          onEdit: cb.onEditNode,
          isArchitect,
          colors: getNodeColors(n.is_external, depth),
          hideActions: isContext,
          connectable: isArchitect && !isContext,
        } satisfies BlockData,
      })),
      ...entities.map((ent) => {
        const position = positions.get(ent.id) ?? { x: 0, y: 0 };
        if (ent.kind === "leaf") {
          return {
            id: ent.id,
            type: "ghost" as const,
            position,
            data: {
              appNode: ent.ghost,
              colors: getNodeColors(ent.ghost.is_external, ent.ghost.node_depth),
              connectable: isArchitect && !isContext,
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
            colors: getNodeColors(false, ent.depth),
            onExpand: cb.expandContainer,
            connectable: isArchitect && !isContext,
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
          const wpOf = (m: AppEdge) => (bothLocal ? m.waypoints : levelEdgeWaypoints[m.id]);
          const rep = g.members.find((m) => { const w = wpOf(m); return w != null && w.length > 0; });
          data.editable = true;
          data.waypoints = (rep ? wpOf(rep) : undefined) ?? undefined;
          data.onWaypointsCommit = (wp) => cb.commitWaypoints(memberIds, wp, !bothLocal);
        }
        // Триггер детализации связи на плашке с описанием (клик по линии на основной схеме
        // перехватывают грипы изломов). В контексте схема только для просмотра — не вешаем.
        if (!isContext) data.onOpenDetails = () => cb.openEdgeMembers(data.memberIds);
        // Дефолтный обвод гостевой стрелки (если её прямой маршрут пересекал бы узлы).
        // Применяется только при отсутствии своих waypoints — это разводит edges.tsx.
        if (!isContext) {
          const det = edgeDetours?.get(g.id);
          if (det) data.detour = det;
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
        return {
          id: g.id,
          source: g.source,
          target: g.target,
          sourceHandle: h?.sourceHandle,
          targetHandle: h?.targetHandle,
          type: "wrapped",
          data,
          markerEnd: { type: MarkerType.ArrowClosed, color: "#6b7280" },
          style: { stroke: "#6b7280", strokeWidth: 1.5 },
          // хэндл мастер-стрелки общий для всех членов — реконнект фанаутит его на все
          // (смена узла-конца по-прежнему запрещена в handleReconnect: правится только хэндл)
          reconnectable: isArchitect,
        };
      })
    );
    // levelEdgeWaypoints читается в сборке (wpOf для гостей), но В ЗАВИСИМОСТЯХ ЕГО НЕТ
    // НАМЕРЕННО: триггерить сборку напрямую по нему нельзя — она бы запускалась со старым
    // (async-устаревшим) layout и при реконнекте гостя откатывала хэндл на исходный. Вместо
    // этого levelEdgeWaypoints входит в зависимости раскладки выше → меняется он → новый
    // layout → сборка тут же со СВЕЖИМ снапшотом и свежим значением из замыкания. Инвариант:
    // layout пересобирается при любом изменении levelEdgeWaypoints, поэтому замыкание свежее.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, isArchitect, depth, isContext, containerId, setRfNodes, setRfEdges]);

  // Перетаскивание шаблона узла из палитры: превью-рамка + создание узла на drop.
  const { dropPreview, handleDragOver, handleDragLeave, handleDrop } = useTemplateDrop({
    rfNodes, screenToFlowPosition, setGuides, clearGuides,
    isArchitect, isContext, onDropNode, dragShape,
  });

  const handleEdgeClick = useCallback(
    (_event: MouseEvent, rfEdge: RFEdge) => {
      // клик-эхо сразу после жеста реконнекта — не открываем поповер информации о связи
      if (consumeReconnectClick()) return;
      const memberIds = (rfEdge.data as WrappedEdgeData | undefined)?.memberIds ?? [];
      openEdgeMembers(memberIds);
    },
    [openEdgeMembers, consumeReconnectClick]
  );

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
    >
      {/* Тост «нельзя привязать к чужому узлу» — только архитектору (реконнект его
          прерогатива). Рендерим всегда (за экраном при !blocked), чтобы проигрывалась
          анимация уезда; position:fixed не обрезается overflow:hidden канваса. */}
      {isArchitect && !isContext && <ReconnectBlockedToast visible={reconnectBlocked} />}
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
            Узел вне уровня
          </span>
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeClick={handleEdgeClick}
        onNodeDragStop={handleNodeDragStop}
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
        {(guides.x != null || guides.y != null) && (
          <ViewportPortal>
            <AlignmentGuides x={guides.x} y={guides.y} />
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
                height: shapeHeight(dropPreview.shape),
                pointerEvents: "none",
                zIndex: 5,
                opacity: 0.85,
              }}
            >
              <NodeShapeSvg shape={dropPreview.shape} bg="transparent" stroke="#475569" outline />
            </div>
          </ViewportPortal>
        )}
      </ReactFlow>
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
