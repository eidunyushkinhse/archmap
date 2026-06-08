import { useEffect, useCallback, useRef, useState } from "react";
import type { MouseEvent, DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { nodesApi, edgesApi } from "../api/nodes";
import { NODE_DRAG_MIME } from "./NodeTreePanel";
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
  reconnectEdge,
  ViewportPortal,
  type Node as RFNode,
  type Edge as RFEdge,
  type Connection,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./LevelGraph.css";
import type { Node as AppNode, GhostNode, Edge as AppEdge, NodeShape } from "../types";
import {
  NODE_W, NODE_H, shapeHeight,
  SNAP_THRESHOLD,
  CTX_LABEL_W,
} from "./graph/constants";
import type {
  WrappedEdgeData,
  BlockData, GhostData, ContainerData,
} from "./graph/types";
import { edgeText } from "./graph/text";
import { getNodeColors } from "./graph/colors";
import { projectGhosts } from "./graph/layout/projectGhosts";
import { computeLayout } from "./graph/layout/level";
import { computeContextLayout } from "./graph/layout/context";
import { NodeShapeSvg } from "./graph/shapes";
import { nodeTypes } from "./graph/nodes";
import { edgeTypes } from "./graph/edges";
import { LevelBoundary, AlignmentGuides } from "./graph/boundaries";

// Фактический размер узла: берём измеренный React Flow, иначе заданный явно,
// иначе дефолт. Нужен для выравнивания по центру при узлах разного размера.
function nodeSize(n: RFNode | undefined): { w: number; h: number } {
  return {
    w: n?.measured?.width ?? n?.width ?? NODE_W,
    h: n?.measured?.height ?? n?.height ?? NODE_H,
  };
}

// Магнитное выравнивание по ЦЕНТРУ: для центра (cx, cy) ищем ближайшего по X и по Y
// соседа из rfNodes и, если он ближе SNAP_THRESHOLD, «прилипаем» центром к нему.
// Оси независимы. Возвращаем притянутый центр и флаги попадания (для направляющих).
// Используется и при перетаскивании существующего узла (excludeId — он сам), и при
// перетаскивании превью нового узла из палитры (excludeId не задан).
function snapCenter(
  cx: number, cy: number, rfNodes: RFNode[], excludeId?: string,
): { snapCx: number; snapCy: number; hitX: boolean; hitY: boolean } {
  let snapCx = cx, snapCy = cy;
  let bestDx = SNAP_THRESHOLD, bestDy = SNAP_THRESHOLD;
  let hitX = false, hitY = false;
  for (const other of rfNodes) {
    if (excludeId && other.id === excludeId) continue;
    const { w: ow, h: oh } = nodeSize(other);
    const ocx = other.position.x + ow / 2;
    const ocy = other.position.y + oh / 2;
    const dx = Math.abs(ocx - cx);
    if (dx <= bestDx) { bestDx = dx; snapCx = ocx; hitX = true; }
    const dy = Math.abs(ocy - cy);
    if (dy <= bestDy) { bestDy = dy; snapCy = ocy; hitY = true; }
  }
  return { snapCx, snapCy, hitX, hitY };
}

// --- Основной компонент ---

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
  // отпускание перетянутого из боковой палитры шаблона на схему: shape — выбранная
  // форма, pos — координаты в системе графа (левый-верхний угол узла)
  onDropNode?: (shape: NodeShape, pos: { x: number; y: number }) => void;
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
  levelEdgeHandles = {},
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
  onDropNode,
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

  // Reconnect: отслеживаем активное ребро и успех операции
  const reconnectingEdge = useRef<RFEdge | null>(null);
  const reconnectSucceeded = useRef(true);

  // Координаты (в системе графа) центральных направляющих, пока узел «магнитится».
  // null по оси — направляющей нет. Сбрасываются по окончании драга.
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });

  // Превью будущего узла при перетаскивании шаблона из палитры: форма + координаты
  // (левый-верхний угол) в системе графа. Рендерится в ViewportPortal, поэтому
  // автоматически масштабируется под текущий зум — рамка совпадает с реальным
  // размером узлов на схеме. null — превью не показываем.
  const [dropPreview, setDropPreview] = useState<{ shape: NodeShape; x: number; y: number } | null>(null);

  // Скрываем направляющие (обе оси) — общий помощник для разных мест.
  const clearGuides = useCallback(() => {
    setGuides((g) => (g.x === null && g.y === null ? g : { x: null, y: null }));
  }, []);

  // Драг шаблона завершился (drop или отмена) — TreePage обнулил dragShape.
  // Убираем превью и направляющие.
  useEffect(() => {
    if (!dragShape) {
      setDropPreview((p) => (p === null ? p : null));
      clearGuides();
    }
  }, [dragShape, clearGuides]);

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, rfNode: RFNode) => {
      setGuides({ x: null, y: null }); // прячем направляющие
      // В контекст-режиме раскладка эфемерная — перетаскивания не сохраняем
      if (isContext) return;
      if (!isArchitect) return;
      const pos = { pos_x: rfNode.position.x, pos_y: rfNode.position.y };
      if (rfNode.type === "block") {
        // Локальный узел — координаты в самом узле
        nodesApi.update(rfNode.id, pos);
      } else if ((rfNode.type === "ghost" || rfNode.type === "container") && containerId) {
        // Гость (лист) или свёрнутый предок-контейнер — координаты привязаны к
        // уровню (containerId + id отображаемой сущности = rfNode.id)
        nodesApi.saveGhostPosition(containerId, rfNode.id, pos);
      }
    },
    [isArchitect, containerId, isContext],
  );

  // Магнитное выравнивание по центру при драге: перехватываем position-изменения
  // и, если центр перетаскиваемого узла оказался ближе SNAP_THRESHOLD к центру
  // соседа по X или Y, сдвигаем координату так, чтобы центры совпали. По осям
  // независимо — X может «прилипнуть» к одному соседу, Y к другому. Снапим и
  // финальное изменение (отпускание), чтобы узел остался ровно на магнитной
  // координате. Пока идёт драг — публикуем координаты центральных направляющих.
  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode>[]) => {
      let guideX: number | null = null;
      let guideY: number | null = null;
      const snapped = changes.map((change) => {
        if (change.type !== "position" || !change.position) return change;
        const dragged = rfNodes.find((n) => n.id === change.id);
        const { w: dw, h: dh } = nodeSize(dragged);
        // Центр узла в текущей (перетаскиваемой) позиции
        const cx = change.position.x + dw / 2;
        const cy = change.position.y + dh / 2;
        const { snapCx, snapCy, hitX, hitY } = snapCenter(cx, cy, rfNodes, change.id);
        // Направляющие показываем только во время активного драга
        if (change.dragging) {
          if (hitX) guideX = snapCx;
          if (hitY) guideY = snapCy;
        }
        // Обратно из центра в координату угла (позиция узла = левый-верхний угол)
        return { ...change, position: { x: snapCx - dw / 2, y: snapCy - dh / 2 } };
      });
      setGuides((prev) =>
        prev.x === guideX && prev.y === guideY ? prev : { x: guideX, y: guideY },
      );
      onNodesChange(snapped);
    },
    [rfNodes, onNodesChange],
  );

  // Удаление узла с клавиатуры. Встроенное удаление React Flow отключено
  // (deleteKeyCode=null), иначе Backspace сносил бы узел и его связи прямо с
  // канваса — без предупреждения и в обход модалки. Здесь по Backspace/Delete
  // находим единственный выбранный локальный узел и просим открыть то же
  // подтверждение со списком связей, что и кнопка «Удалить».
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      if (isContext || !isArchitect || !onRequestDeleteNode) return;
      // не перехватываем удаление, когда правят текст в поле
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      // действуем только при ровно одном выбранном узле; мульти/ноль — игнор,
      // чтобы случайно не снести пачку
      const selected = rfNodes.filter((n) => n.type === "block" && n.selected);
      if (selected.length !== 1) return;
      e.preventDefault();
      onRequestDeleteNode((selected[0].data as BlockData).appNode);
    },
    [rfNodes, isArchitect, isContext, onRequestDeleteNode],
  );

  const handleReconnectStart = useCallback((_: MouseEvent, edge: RFEdge) => {
    reconnectingEdge.current = edge;
    reconnectSucceeded.current = false;
  }, []);

  const handleReconnect = useCallback(
    (oldEdge: RFEdge, newConn: Connection) => {
      // Разрешаем только смену хэндла на том же узле
      if (newConn.source !== oldEdge.source || newConn.target !== oldEdge.target) return;
      reconnectSucceeded.current = true;
      // shouldReplaceId:false — сохраняем исходный id ребра (по нему идёт PATCH
      // и клик-обработчик); по умолчанию reconnectEdge сгенерил бы новый id
      setRfEdges((els) => reconnectEdge(oldEdge, newConn, els, { shouldReplaceId: false }));
      if (isArchitect && newConn.sourceHandle && newConn.targetHandle) {
        // Концы ребра делятся на локальные (узел этого уровня) и спроецированные на
        // гостя. На уровне максимум один конец гостевой (второй всегда локальный).
        // Хэндл локального конца — глобальный «домашний», в колонку самого ребра.
        // Хэндл гостевого конца привязан к уровню И к показанной сущности (свёрнутый
        // контейнер ИЛИ развёрнутый лист — это РАЗНЫЕ проекции одного конца), поэтому
        // хранится per-level по node_id отдельно — иначе проекции затирали бы друг
        // друга, а колонка затёрла бы «домашний» хэндл узла на его родном уровне.
        const localIds = new Set(nodes.map((n) => n.id));
        const sourceLocal = localIds.has(newConn.source!);
        const targetLocal = localIds.has(newConn.target!);

        const column: { source_handle?: string; target_handle?: string } = {};
        if (sourceLocal) column.source_handle = newConn.sourceHandle;
        if (targetLocal) column.target_handle = newConn.targetHandle;
        const hasColumn = Boolean(column.source_handle || column.target_handle);
        if (hasColumn) edgesApi.update(oldEdge.id, column);

        let ghost: { node_id: string; handle: string } | undefined;
        if (containerId) {
          if (!sourceLocal) ghost = { node_id: newConn.source!, handle: newConn.sourceHandle };
          else if (!targetLocal) ghost = { node_id: newConn.target!, handle: newConn.targetHandle };
          if (ghost) nodesApi.saveGhostEdgeHandle(containerId, oldEdge.id, ghost);
        }

        // Синхронизируем стейт уровня теми же значениями, что вернул бы рефетч —
        // иначе пересчёт раскладки (сворачивание/разворачивание без рефетча)
        // откатил бы привязку к autoHandles из устаревших данных.
        onEdgeHandlesChanged?.(oldEdge.id, {
          column: hasColumn ? column : undefined,
          ghost,
        });
      }
    },
    [isArchitect, nodes, containerId, onEdgeHandlesChanged],
  );

  const handleReconnectEnd = useCallback(() => {
    // Если не успешно — ничего не делаем, ребро остаётся на месте
    reconnectingEdge.current = null;
    reconnectSucceeded.current = true;
  }, []);

  // Разрешаем реконнект только к хэндлам того же узла
  const isValidConnection = useCallback((conn: Connection | RFEdge) => {
    const orig = reconnectingEdge.current;
    if (!orig) return false;
    return conn.source === orig.source && conn.target === orig.target;
  }, []);

  useEffect(() => {
    // Сворачиваем гостей к их верхним (неразвёрнутым) контейнерам
    const { entities, ghostToEffective, emergedFrom } = projectGhosts(ghostNodes, ancestorIds, expanded);
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
        ? computeContextLayout(
            nodes[0].id,
            shapeHeight(nodes[0].shape),
            entities,
            layoutEdges,
            ancestorIds,
            expanded,
          )
        : null;
    const { positions, edgeHandles } = ctxLayout ?? computeLayout(allNodeInfos, layoutEdges);
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

    setRfNodes([
      ...nodes.map((n) => ({
        id: n.id,
        type: "block" as const,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          appNode: n,
          onDrillDown,
          onEdit: onEditNode,
          isArchitect,
          colors: getNodeColors(n.is_external, depth),
          hideActions: isContext,
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
            onExpand: expandContainer,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, ghostNodes, levelPositions, levelEdgeHandles, edges, isArchitect, depth, expanded, ancestorIds.join("|")]);

  // Перетаскивание шаблона узла из боковой палитры на схему. dragOver с
  // preventDefault разрешает дроп; на drop читаем форму из dataTransfer, переводим
  // экранные координаты курсора в координаты графа и центрируем узел под курсором.
  const handleDragOver = useCallback((e: DragEvent) => {
    if (!isArchitect || isContext || !onDropNode) return;
    if (!e.dataTransfer.types.includes(NODE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // Курсор = центр будущего узла. Притягиваем центр к соседям, рамку-превью
    // ставим на притянутую позицию, направляющие показываем как при обычном драге.
    if (!dragShape) return;
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const dh = shapeHeight(dragShape);
    const { snapCx, snapCy, hitX, hitY } = snapCenter(flow.x, flow.y, rfNodes);
    setDropPreview({ shape: dragShape, x: snapCx - NODE_W / 2, y: snapCy - dh / 2 });
    const gx = hitX ? snapCx : null;
    const gy = hitY ? snapCy : null;
    setGuides((prev) => (prev.x === gx && prev.y === gy ? prev : { x: gx, y: gy }));
  }, [isArchitect, isContext, onDropNode, dragShape, rfNodes, screenToFlowPosition]);

  // Курсор ушёл с канваса (а не на его дочерний элемент) — убираем превью/направляющие,
  // чтобы рамка не «зависала» на краю.
  const handleDragLeave = useCallback((e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropPreview((p) => (p === null ? p : null));
    clearGuides();
  }, [clearGuides]);

  const handleDrop = useCallback((e: DragEvent) => {
    if (!isArchitect || isContext || !onDropNode) return;
    const shape = e.dataTransfer.getData(NODE_DRAG_MIME);
    if (!shape) return;
    e.preventDefault();
    const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const s = shape as NodeShape;
    // Узел создаётся ровно там, где показывало превью (с тем же примагничиванием).
    const { snapCx, snapCy } = snapCenter(flow.x, flow.y, rfNodes);
    onDropNode(s, { x: snapCx - NODE_W / 2, y: snapCy - shapeHeight(s) / 2 });
    setDropPreview(null);
    clearGuides();
  }, [isArchitect, isContext, onDropNode, rfNodes, screenToFlowPosition, clearGuides]);

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
      className="lg-canvas"
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
        isValidConnection={isValidConnection}
        connectionMode={ConnectionMode.Loose}
        reconnectRadius={20}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionLineStyle={{ stroke: "#6b7280", strokeWidth: 1.5 }}
        // Своё удаление через подтверждение (handleKeyDown) — встроенное отключаем,
        // иначе Backspace сносил бы узел и связи без предупреждения.
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        // nodesConnectable=true нужен, чтобы React Flow рисовал превью-линию
        // при reconnect (рендер connection line гейтится этим флагом). Создание
        // новых связей всё равно невозможно: onConnect не задан, а isValidConnection
        // вне reconnect возвращает false.
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
