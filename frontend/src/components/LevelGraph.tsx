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
  ConnectionLineType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ViewportPortal,
  type Node as RFNode,
  type Edge as RFEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./LevelGraph.css";
import type { Node as AppNode, GhostNode, Edge as AppEdge, NodeShape } from "../types";
import { canHaveChildren } from "../types";
import {
  NODE_W, NODE_H, shapeHeight,
  CTX_LABEL_W,
} from "./graph/constants";
import type {
  WrappedEdgeData,
  BlockData, GhostData, ContainerData,
  DisplayExternal, EdgeShelf, EdgeLoop,
} from "./graph/types";
import { edgeText } from "./graph/text";
import { getNodeColors } from "./graph/colors";
import { projectGhosts } from "./graph/layout/projectGhosts";
import { layoutLevel, layoutContext } from "./graph/layout/engine";
import { NodeShapeSvg } from "./graph/shapes";
import { nodeTypes } from "./graph/nodes";
import { edgeTypes } from "./graph/edges";
import { LevelBoundary, AlignmentGuides } from "./graph/boundaries";
import { useAlignmentGuides } from "./graph/interaction/useAlignmentGuides";
import { useSnapAlignment } from "./graph/interaction/useSnapAlignment";
import { useTemplateDrop } from "./graph/interaction/useTemplateDrop";
import { useReconnectHandles } from "./graph/interaction/useReconnectHandles";
import { useCanvasDelete } from "./graph/interaction/useCanvasDelete";
import { useEdgeConnect, type ConnectTarget } from "./graph/interaction/useEdgeConnect";

// --- Основной компонент ---

// Стабильный пустой дефолт для levelEdgeHandles: дефолт-параметр `= {}` создавал бы
// НОВЫЙ объект на каждый рендер, а он — зависимость async-эффекта раскладки → лишний
// перезапуск ELK и мигание. Один модульный объект держит ссылку стабильной.
const EMPTY_LEVEL_HANDLES: Record<string, string[]> = {};

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
  groupArr: { id: string; source: string; target: string; members: AppEdge[] }[];
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
  onEdgeClick: (edge: AppEdge) => void;
  // клик по «мастер-стрелке» (несколько слитых связей) — выбор нужной
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
  edges,
  depth,
  containerId,
  ancestorNames,
  ancestorIds,
  isArchitect,
  onDrillDown,
  onEditNode,
  onEdgeClick,
  onEdgesChoice,
  onEdgeHandlesChanged,
  onNodeMoved,
  onDropNode,
  onCreateEdge,
  onConnectInto,
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

  // Реконнект концов рёбер (смена хэндла на том же узле + персист).
  const {
    handleReconnectStart, handleReconnect, handleReconnectEnd,
    isValidConnection: isValidReconnect, isReconnecting,
  } = useReconnectHandles({ setRfEdges, nodes, isArchitect, containerId, onEdgeHandlesChanged });

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
      onCreate: onCreateEdge, onInto: onConnectInto,
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
  const cbRef = useRef({ onDrillDown, onEditNode, expandContainer });
  cbRef.current = { onDrillDown, onEditNode, expandContainer };

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
    const groupArr: { id: string; source: string; target: string; members: AppEdge[] }[] = [];
    const groupMap = new Map<string, { id: string; source: string; target: string; members: AppEdge[] }>();
    for (const e of remappedEdges) {
      if (!displayedIds.has(e.source_id) || !displayedIds.has(e.target_id)) continue;
      let g = groupMap.get(`${e.source_id}>${e.target_id}`);
      if (!g) { g = { id: "", source: e.source_id, target: e.target_id, members: [] }; groupMap.set(`${e.source_id}>${e.target_id}`, g); groupArr.push(g); }
      g.members.push(e);
    }
    for (const g of groupArr) {
      g.id = g.members.length === 1 ? g.members[0].id : `merge:${g.source}->${g.target}`;
    }

    // Раскладку/хэндлы считаем на мастер-рёбрах (по одному на направление между парой)
    const layoutEdges: AppEdge[] = groupArr.map((g) => {
      if (g.members.length === 1) return g.members[0];
      const longest = g.members.reduce((a, b) => (edgeText(b).length > edgeText(a).length ? b : a));
      return {
        id: g.id, source_id: g.source, target_id: g.target,
        label: longest.label, technology: longest.technology,
        source_handle: null, target_handle: null, created_at: "",
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
    const { positions, edgeHandles } = ctxLayout ?? (await layoutLevel(allNodeInfos, layoutEdges));
    // полки подписей и обходы не родных стрелок считаются только в контекст-раскладке
    const edgeShelves = ctxLayout?.edgeShelves;
    const edgeLoops = ctxLayout?.edgeLoops;

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

      if (!cancelled) setLayout({ nodes, entities, positions, edgeHandles, edgeShelves, edgeLoops, groupArr, spacers });
    })();
    return () => { cancelled = true; };
  }, [nodes, ghostNodes, levelPositions, levelEdgeHandles, edges, isContext, expanded, stableAncestorIds]);

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
    const { nodes: layoutNodes, entities, positions, edgeHandles, edgeShelves, edgeLoops, groupArr, spacers } = layout;
    const cb = cbRef.current;
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
          // мастер-стрелку реконнектить нельзя (неоднозначно, какую из связей)
          reconnectable: isArchitect && !isMaster,
        };
      })
    );
  }, [layout, isArchitect, depth, isContext, setRfNodes, setRfEdges]);

  // Перетаскивание шаблона узла из палитры: превью-рамка + создание узла на drop.
  const { dropPreview, handleDragOver, handleDragLeave, handleDrop } = useTemplateDrop({
    rfNodes, screenToFlowPosition, setGuides, clearGuides,
    isArchitect, isContext, onDropNode, dragShape,
  });

  const handleEdgeClick = useCallback(
    (_event: MouseEvent, rfEdge: RFEdge) => {
      const memberIds = (rfEdge.data as WrappedEdgeData | undefined)?.memberIds ?? [];
      const members = memberIds
        .map((mid) => edges.find((e) => e.id === mid))
        .filter((e): e is AppEdge => e != null);
      if (members.length === 0) return;
      if (members.length === 1) onEdgeClick(members[0]);
      else onEdgesChoice(members);
    },
    [edges, onEdgeClick, onEdgesChoice]
  );

  if (nodes.length + ghostNodes.length === 0) return null;

  return (
    <div
      // lg-canvas--editable — раскрытие хэндлов по ховеру (архитектор, не контекст);
      // lg-canvas--connecting — подсветка «зон входа» (узлов с детьми) во время
      // протягивания новой связи.
      className={
        "lg-canvas" +
        (isArchitect && !isContext ? " lg-canvas--editable" : "") +
        (connecting ? " lg-canvas--connecting" : "")
      }
      style={{ flex: 1, minHeight: 0, border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
    >
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
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{ stroke: "#6b7280", strokeWidth: 1.5 }}
        // Своё удаление через подтверждение (handleKeyDown) — встроенное отключаем,
        // иначе Backspace сносил бы узел и связи без предупреждения.
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2 }}
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
