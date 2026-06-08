import { useEffect, useLayoutEffect, useCallback, useRef, useState, type ComponentType } from "react";
import type { MouseEvent, DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { nodesApi, edgesApi } from "../api/nodes";
import { NODE_DRAG_MIME } from "./NodeTreePanel";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  MarkerType,
  ConnectionMode,
  ConnectionLineType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  reconnectEdge,
  getSmoothStepPath,
  EdgeLabelRenderer,
  ViewportPortal,
  BaseEdge,
  type Node as RFNode,
  type Edge as RFEdge,
  type Connection,
  type NodeTypes,
  type EdgeTypes,
  type NodeProps,
  type EdgeProps,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./LevelGraph.css";
import type { CSSProperties } from "react";
import type { Node as AppNode, GhostNode, Edge as AppEdge, NodeShape, AncestorRef } from "../types";
import {
  NODE_W, NODE_H, shapeHeight,
  SNAP_THRESHOLD, MAX_TAG_FONT, MIN_TAG_FONT,
  SIDE_HANDLES, hid,
  BOUNDARY_PAD, BOUNDARY_STEP, BOUNDARY_LABEL_PAD, BOUNDARY_LABEL_STEP,
  CTX_LABEL_W, MIN_SHELF, SHELF_PAD,
} from "./graph/constants";
import type {
  EdgeShelf, EdgeLoop, WrappedEdgeData,
  BlockData, GhostData, ContainerData,
  BlockRFNode, GhostRFNode, ContainerRFNode,
  DisplayExternal,
} from "./graph/types";
import { wrapLabel, edgeText } from "./graph/text";
import { getNodeColors } from "./graph/colors";
import { projectGhosts } from "./graph/layout/projectGhosts";
import { computeLayout } from "./graph/layout/level";

// --- Кастомный тип ребра с HTML-лейблом (поддерживает перенос) ---

// Полка подписи (контекст-схема): к какому концу ребра прилегает горизонтальный
// SVG-путь по ортогональной ломаной со скруглением углов радиуса r. Используется для
// обхода «не родной» стрелки bidi (getSmoothStepPath не умеет произвольную «скобу»).
function roundedPolyline(pts: Array<{ x: number; y: number }>, r: number): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const aX = p1.x - ((p1.x - p0.x) / l1) * rr, aY = p1.y - ((p1.y - p0.y) / l1) * rr;
    const bX = p1.x + ((p2.x - p1.x) / l2) * rr, bY = p1.y + ((p2.y - p1.y) / l2) * rr;
    d += ` L ${aX},${aY} Q ${p1.x},${p1.y} ${bX},${bY}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x},${last.y}`;
  return d;
}

function WrappedLabelEdge({
  id,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const d = data as WrappedEdgeData | undefined;
  const shelf = d?.shelf;
  const loop = d?.loop;

  let edgePath: string;
  let labelX: number;
  let labelY: number;
  if (loop) {
    // Контекст-схема: «не родная» стрелка bidi огибает колонку. Путь от дальней стороны
    // соседа: полка наружу до loopX → вертикаль до clearY (над/под колонкой) → к центру
    // фокуса по X → в верх/низ-центр фокуса. Точки строим сосед→фокус, затем при нужде
    // разворачиваем, чтобы порядок совпал с source→target (иначе стрелка-маркер не на месте).
    const nIsSrc = loop.neighborEnd === "source";
    const nX = nIsSrc ? sourceX : targetX;
    const nY = nIsSrc ? sourceY : targetY;
    const fX = nIsSrc ? targetX : sourceX;
    const fY = nIsSrc ? targetY : sourceY;
    const seq = [
      { x: nX, y: nY },
      { x: loop.loopX, y: nY },
      { x: loop.loopX, y: loop.clearY },
      { x: fX, y: loop.clearY },
      { x: fX, y: fY },
    ];
    edgePath = roundedPolyline(nIsSrc ? seq : [...seq].reverse(), 12);
    labelX = (nX + loop.loopX) / 2;                  // середина полки у соседа
    labelY = nY;
  } else if (shelf) {
    // Контекст-схема: подпись на горизонтальной «полке» у соседа. Сосед — конец полки
    // (shelf.end), фокус — противоположный конец. Вертикальный сгиб ставим на расстоянии
    // len от соседа, тогда отрезок сосед→сгиб строго горизонтален и равен len (это и есть
    // полка). Длина len единая по колонке → полки соседей выстраиваются ровной лентой.
    const nX = shelf.end === "target" ? targetX : sourceX;
    const nY = shelf.end === "target" ? targetY : sourceY;
    const fX = shelf.end === "target" ? sourceX : targetX;
    const dir = fX >= nX ? 1 : -1;                  // направление от соседа к фокусу
    const MIN_GAP = 24;                             // сгиб не ближе MIN_GAP к фокусу (страховка)
    const cx = dir === 1
      ? Math.min(nX + dir * shelf.len, fX - MIN_GAP)
      : Math.max(nX + dir * shelf.len, fX + MIN_GAP);
    [edgePath] = getSmoothStepPath({
      sourceX, sourceY, sourcePosition,
      targetX, targetY, targetPosition,
      borderRadius: 12, centerX: cx,
    });
    labelX = (nX + cx) / 2;                          // середина фактической полки
    labelY = nY;
  } else {
    [edgePath, labelX, labelY] = getSmoothStepPath({
      sourceX, sourceY, sourcePosition,
      targetX, targetY, targetPosition,
      borderRadius: 12,
    });
  }
  const labelText = d?.label;
  const items = d?.items;
  const capW = d?.maxWidth;
  const lines = labelText ? wrapLabel(labelText) : [];

  const boxBase: CSSProperties = {
    position: "absolute",
    transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
    background: "rgba(255,255,255,0.95)",
    border: "1px solid #e5e7eb",
    borderRadius: 4,
    fontSize: 11,
    color: "#374151",
    lineHeight: 1.4,
  };

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {items && items.length > 0 ? (
        // Мастер-стрелка: буллет-список текстов слитых связей
        <EdgeLabelRenderer>
          <div style={{ ...boxBase, padding: "4px 8px", textAlign: "left", maxWidth: capW ?? 240, whiteSpace: "normal" }}>
            {items.map((it, i) => (
              <div key={i} style={{ display: "flex", gap: 4 }}>
                <span>•</span><span>{it}</span>
              </div>
            ))}
          </div>
        </EdgeLabelRenderer>
      ) : lines.length > 0 ? (
        <EdgeLabelRenderer>
          {/* при заданном capW (контекст) подпись переносится по словам и ограничена по
              ширине, чтобы влезть в зазор между фокусом и колонкой и не лезть на узлы */}
          <div style={{ ...boxBase, padding: "2px 7px", textAlign: "center", whiteSpace: capW ? "normal" : "nowrap", maxWidth: capW }}>
            {capW ? labelText : lines.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const edgeTypes = {
  wrapped: WrappedLabelEdge,
} as EdgeTypes;

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

// --- Стиль конкретного хэндла из 12 ---

function fixedHandleStyle(pos: Position, offset: number, borderColor: string): CSSProperties {
  // opacity задаётся в LevelGraph.css: хэндлы скрыты в покое и показываются
  // только при наведении конца стрелки (класс .connectingto). Инлайновый opacity
  // здесь не ставим — он бы перебил CSS по специфичности.
  const base: CSSProperties = {
    background: borderColor,
    width: 9,
    height: 9,
    borderRadius: "50%",
    border: "2px solid rgba(255,255,255,0.7)",
    zIndex: 3, // поверх SVG-формы узла
  };
  if (pos === Position.Left || pos === Position.Right) {
    return { ...base, top: `${offset * 100}%`, transform: "translateY(-50%)" };
  }
  return { ...base, left: `${offset * 100}%`, transform: "translateX(-50%)" };
}

// --- SVG-формы узлов (C4): сервис / БД / брокер / пользователь ---

interface NodeShapeProps {
  shape: NodeShape;
  bg: string;
  stroke: string;
  dashed?: boolean; // пунктир для гостевых узлов
  // режим контура (прозрачное тело, напр. превью драга): у БД не замыкаем тело
  // сверху прямой — иначе она просвечивает сквозь прозрачную крышку-эллипс
  outline?: boolean;
}

function NodeShapeSvg({ shape, bg, stroke, dashed, outline }: NodeShapeProps) {
  const W = NODE_W, H = shapeHeight(shape), sw = 1.5;
  const dash = dashed ? "5 3" : undefined;
  const fill = { fill: bg, stroke, strokeWidth: sw, strokeDasharray: dash };
  const lineStroke = { fill: "none", stroke, strokeWidth: sw, strokeDasharray: dash };
  const svgStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    overflow: "visible",
    filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.12))",
  };

  if (shape === "database") {
    // Вертикальный цилиндр: тело (боковые стенки + нижняя передняя дуга) и
    // верхний эллипс-крышка с ПОЛНЫМ контуром — именно он даёт объём.
    const ry = 11, rx = (W - 2) / 2, cx = W / 2;
    return (
      <svg width={W} height={H} style={svgStyle}>
        {/* Тело: вниз по левой стенке, передняя дуга низа, вверх по правой.
            Верх замыкаем прямой — она скрыта под эллипсом-крышкой. */}
        <path d={`M1,${ry} L1,${H - ry} A${rx},${ry} 0 0 0 ${W - 1},${H - ry} L${W - 1},${ry}${outline ? "" : " Z"}`} {...fill} />
        {/* Крышка целиком — виден весь контур эллипса (и задний обод, и передняя «губа») */}
        <ellipse cx={cx} cy={ry} rx={rx} ry={ry} {...fill} />
      </svg>
    );
  }
  if (shape === "broker") {
    // Горизонтальный цилиндр (труба): тело + передняя дуга левого торца
    const rxc = 12, ryc = (H - 2) / 2;
    return (
      <svg width={W} height={H} style={svgStyle}>
        <path d={`M${rxc},1 L${W - rxc},1 A${rxc},${ryc} 0 0 1 ${W - rxc},${H - 1} L${rxc},${H - 1} A${rxc},${ryc} 0 0 1 ${rxc},1 Z`} {...fill} />
        <path d={`M${rxc},1 A${rxc},${ryc} 0 0 1 ${rxc},${H - 1}`} {...lineStroke} />
      </svg>
    );
  }
  if (shape === "person") {
    // Пользователь (C4): крупная голова-круг + тело-прямоугольник со скруглением.
    // Голова Ø44 вместо прежней Ø26 — узел выше (PERSON_H), смотрится аккуратнее.
    return (
      <svg width={W} height={H} style={svgStyle}>
        <circle cx={W / 2} cy={26} r={22} {...fill} />
        <rect x={1} y={50} width={W - 2} height={H - 51} rx={14} {...fill} />
      </svg>
    );
  }
  // service — прямоугольник со скруглёнными углами
  return (
    <svg width={W} height={H} style={svgStyle}>
      <rect x={1} y={1} width={W - 2} height={H - 2} rx={8} {...fill} />
    </svg>
  );
}

/** Отступы контента под форму (чтобы текст не заходил на эллипсы/голову) */
function contentPadding(shape: NodeShape, hasActions: boolean): CSSProperties {
  const right = hasActions ? 52 : 14;
  switch (shape) {
    case "database": return { paddingTop: 28, paddingRight: right, paddingBottom: 14, paddingLeft: 16 };
    case "broker": return { paddingTop: 14, paddingRight: right, paddingBottom: 14, paddingLeft: 30 };
    case "person": return { paddingTop: 54, paddingRight: right, paddingBottom: 8, paddingLeft: 14 };
    default: return { paddingTop: 12, paddingRight: right, paddingBottom: 12, paddingLeft: 14 };
  }
}

const nodeContainer: CSSProperties = {
  position: "relative",
  width: NODE_W,
  height: NODE_H,
  boxSizing: "border-box",
  fontSize: 13,
};
// Свечение выбранного узла (см. BlockNode). Два drop-shadow: тонкий контурный +
// мягкий ореол синим — повторяют силуэт SVG-формы.
const SELECTED_GLOW =
  "drop-shadow(0 0 2px #2563eb) drop-shadow(0 0 7px rgba(37,99,235,0.65))";

// --- Кастомные компоненты узлов ---

function NodeHandles({ nodeId, color }: { nodeId: string; color: string }) {
  return (
    <>
      {SIDE_HANDLES.flatMap(({ side, pos, offsets }) =>
        offsets.map((offset, idx) => (
          <Handle
            key={hid(nodeId, side, idx)}
            id={hid(nodeId, side, idx)}
            type="source"
            position={pos}
            // нельзя НАЧАТЬ связь с пустого хэндла (в покое хэндл инертен,
            // курсор не меняется); остаётся приёмником конца стрелки при reconnect
            isConnectableStart={false}
            style={fixedHandleStyle(pos, offset, color)}
          />
        ))
      )}
    </>
  );
}

// Единое «облако» с ролью и технологией: «{роль}: {технология}» (если есть оба,
// иначе — то, что задано). Выравнивание задаёт родитель. Шрифт авто-уменьшается,
// чтобы строка влезла в доступную ширину узла (важно для узлов разного размера).
function RoleTechChip({
  role, technology, color,
}: { role?: string | null; technology?: string | null; color: string }) {
  const label = role && technology ? `${role}: ${technology}` : role || technology || "";
  const ref = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(MAX_TAG_FONT);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    // Уменьшаем шрифт от MAX до MIN, пока чип не впишется в ширину родителя
    const fit = () => {
      let size = MAX_TAG_FONT;
      el.style.fontSize = `${size}px`;
      while (size > MIN_TAG_FONT && el.scrollWidth > parent.clientWidth) {
        size -= 0.5;
        el.style.fontSize = `${size}px`;
      }
      setFontSize(size);
    };
    fit();
    // Пересчёт при изменении ширины узла (узлы разного размера / ресайз)
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [label]);

  if (!label) return null;
  return (
    <span
      ref={ref}
      style={{
        ...tagChip,
        marginRight: 0,
        maxWidth: "100%",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        background: "rgba(255,255,255,0.22)",
        color,
        fontSize,
      }}
    >
      {label}
    </span>
  );
}

function BlockNode({ data, selected }: NodeProps<BlockRFNode>) {
  const c = data.colors;
  const shape = data.appNode.shape;
  // У пользователя «провалиться внутрь» нечего → кнопку «Войти» не показываем.
  // Голова человечка — узкий круг по центру вверху, поэтому стандартное место
  // кнопок (правый верхний угол) висит в пустоте сбоку от головы: для персоны
  // опускаем действия внутрь прямоугольника-тела (personActions).
  const isPerson = shape === "person";
  const btnStyle: CSSProperties = {
    ...nodeBtn,
    background: "rgba(255,255,255,0.18)",
    color: c.text,
    borderColor: "rgba(255,255,255,0.3)",
  };
  return (
    <div
      style={{
        ...nodeContainer,
        height: shapeHeight(shape),
        color: c.text,
        // Подсветка выбранного узла: синее свечение по силуэту (drop-shadow
        // тянется по альфе SVG-формы, поэтому ореол повторяет контур любой
        // формы — цилиндра БД, человечка и т.д.). Сигнал «этот узел активен и
        // исчезнет по Backspace».
        filter: selected ? SELECTED_GLOW : undefined,
      }}
    >
      <NodeShapeSvg shape={shape} bg={c.bg} stroke={c.border} />
      <NodeHandles nodeId={data.appNode.id} color={c.border} />

      {/* Кнопки в правом верхнем углу — абсолютно, не зависят от контента.
          В контекст-режиме (hideActions) их нет — схема только для просмотра. */}
      {!data.hideActions && (
        <div style={isPerson ? personActions : nodeActions}>
          {!isPerson && (
            <button
              className="nodrag"
              onClick={(e) => { e.stopPropagation(); data.onDrillDown(data.appNode); }}
              style={btnStyle}
              title="Войти"
            >→</button>
          )}
          <button
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); data.onEdit(data.appNode); }}
            style={btnStyle}
            title={data.isArchitect ? "Изменить" : "Просмотр"}
          >{data.isArchitect ? "✎" : "◉"}</button>
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(shape, !data.hideActions) }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
          {data.appNode.name}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <RoleTechChip role={data.appNode.role} technology={data.appNode.technology} color={c.text} />
        </div>
      </div>
    </div>
  );
}

function GhostBlockNode({ data }: NodeProps<GhostRFNode>) {
  const c = data.colors;
  const shape = data.appNode.shape;
  // Форма та же, но пунктиром — «призрачность» внешнего узла видна по пунктирному контуру.
  return (
    <div style={{ ...nodeContainer, height: shapeHeight(shape), color: c.text }}>
      <NodeShapeSvg shape={shape} bg={c.bg} stroke={c.border} dashed />
      <NodeHandles nodeId={data.appNode.id} color={c.border} />
      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(shape, false) }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{data.appNode.name}</div>
        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <RoleTechChip role={data.appNode.role} technology={data.appNode.technology} color={c.text} />
        </div>
      </div>
    </div>
  );
}

function ContainerNode({ data }: NodeProps<ContainerRFNode>) {
  const c = data.colors;
  const btnStyle: CSSProperties = {
    ...nodeBtn,
    background: "rgba(255,255,255,0.18)",
    color: c.text,
    borderColor: "rgba(255,255,255,0.3)",
  };
  return (
    <div style={{ ...nodeContainer, color: c.text }}>
      <svg width={NODE_W} height={NODE_H} style={{ position: "absolute", inset: 0, pointerEvents: "none", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.12))" }}>
        <rect x={1} y={1} width={NODE_W - 2} height={NODE_H - 2} rx={8} fill={c.bg} stroke={c.border} strokeWidth={1.5} strokeDasharray="5 3" />
      </svg>
      <NodeHandles nodeId={data.id} color={c.border} />
      <div style={nodeActions}>
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); data.onExpand(data.id); }}
          style={btnStyle}
          title="Раскрыть содержимое"
        >🔍</button>
      </div>
      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", padding: "12px 14px", paddingRight: 40 }}>
        <div style={{ fontSize: 10, opacity: 0.8, fontWeight: 500, marginBottom: 2 }}>контейнер</div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{data.name}</div>
      </div>
    </div>
  );
}

// Невидимый узел-распорка (контекст-схема): ставится в крайние точки контента, включая
// обходы не родных стрелок, чтобы fitView (фитит только узлы) вмещал весь рисунок.
function SpacerNode() {
  return <div style={{ width: 1, height: 1, pointerEvents: "none" }} />;
}

const nodeTypes: NodeTypes = {
  block: BlockNode as ComponentType<NodeProps>,
  ghost: GhostBlockNode as ComponentType<NodeProps>,
  container: ContainerNode as ComponentType<NodeProps>,
  spacer: SpacerNode as ComponentType<NodeProps>,
};

// --- Границы уровней (C4-подобные вложенные boundary) ---

// Приблизительная ширина плашки подписи (контекст) под шрифт 11px: моноширинная оценка,
// капится по CTX_LABEL_W (длинная подпись переносится по словам). Точную ширину знает
// только DOM в WrappedLabelEdge — здесь нужна лишь оценка для длины полки колонки.
function ctxLabelWidth(text: string): number {
  return Math.min(CTX_LABEL_W, Math.round(text.length * 6.3) + 16);
}

// Раскладка контекстной схемы. Контекстный граф — ЗВЕЗДА: фокус + его прямые соседи,
// каждое ребро (после проекции) идёт фокус↔сосед. Общий dagre гонял звезду как
// сложный граф → длинные гнутые пути, наложения узлов и рамок, подписи под узлами.
// Тут раскладываем детерминированно и frame-aware:
//  • фокус в центре, входящие соседи — колонкой слева, исходящие/двунаправленные — справа;
//  • каждое ребро — один прыжок к ближней стороне соседа, хэндлы назначаются напрямую;
//  • колонку соседа отодвигаем за вылет «приватных» рамок фокуса (рамок предков,
//    членом которых сосед НЕ является), чтобы сосед/его рамка их не пересекали. Рамки,
//    которые сосед делит с фокусом, остаются его членами — bbox сам обнимет обоих;
//  • раскрытый контейнер-сосед = своя рамка вокруг детей: его дети группируются
//    вплотную, а между группами кладём зазор ≥ паддинга рамки (нет вертикальных наложений).
export function computeContextLayout(
  focusId: string,
  focusHeight: number,
  entities: DisplayExternal[],
  edges: AppEdge[],
  ancestorIds: string[],
  expanded: Set<string>,
): {
  positions: Map<string, { x: number; y: number }>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
  edgeShelves: Map<string, EdgeShelf>;
  edgeLoops: Map<string, EdgeLoop>;
} {
  const lastDepth = ancestorIds.length - 1;
  const bcIndex = new Map(ancestorIds.map((id, i) => [id, i]));

  // 1. Метаданные соседа: глубина общего предка-рамки (lcaIdx), ключ группы (рамка
  //    раскрытого контейнера, если сосед раскрыт), флаг «обёрнут собственной рамкой».
  //    Заодно считаем maxDepth — как в LevelBoundary (нужен для величины паддинга).
  interface NMeta { lcaIdx: number; groupKey: string; framed: boolean }
  const meta = new Map<string, NMeta>();
  let maxDepth = Math.max(0, lastDepth);
  for (const ent of entities) {
    const anc = ent.kind === "leaf" ? (ent.ghost.ancestors ?? []) : ent.ancestors;
    let lcaIdx = -1, lcaPos = -1;
    anc.forEach((a, pos) => {
      const idx = bcIndex.get(a.id);
      if (idx !== undefined && idx > lcaIdx) { lcaIdx = idx; lcaPos = pos; }
    });
    let groupKey = ent.id;
    let framed = false;
    if (ent.kind === "leaf" && lcaIdx !== -1) {
      // раскрытые контейнеры-рамки ниже общего предка (первый — внешняя рамка группы)
      for (let pos = lcaPos + 1; pos < anc.length; pos++) {
        if (expanded.has(anc[pos].id)) {
          if (!framed) { groupKey = anc[pos].id; framed = true; }
          maxDepth = Math.max(maxDepth, lcaIdx + (pos - lcaPos));
        }
      }
    }
    meta.set(ent.id, { lcaIdx, groupKey, framed });
  }

  // Горизонтальный вылет приватных рамок фокуса для соседа с данным lcaIdx: сосед —
  // не член рамок глубже его lcaIdx, поэтому должен оказаться за самой внешней из них.
  const reachFor = (lcaIdx: number): number => {
    if (lcaIdx >= lastDepth) return 0;             // делит даже прямого родителя — приватных рамок нет
    const outerPrivateDepth = lcaIdx < 0 ? 0 : lcaIdx + 1; // самая внешняя приватная рамка
    return BOUNDARY_PAD + (maxDepth - outerPrivateDepth) * BOUNDARY_STEP;
  };
  const MARGIN = 48;
  const clearanceOf = (id: string): number => {
    const m = meta.get(id)!;
    return reachFor(m.lcaIdx) + (m.framed ? BOUNDARY_PAD : 0) + MARGIN;
  };

  // 2. Классификация соседей. Чистые: in-only → левая колонка, out-only → правая.
  //    Двунаправленные кладём в колонку, где МЕНЬШЕ чистых соседей (равенство или только
  //    bidi → справа). Тогда «родная» стрелка bidi идёт в естественном направлении колонки
  //    (право=исходящая, лево=входящая), а «не родная» уходит в обход (см. секцию 3).
  const hasOut = new Set<string>(); // есть ребро фокус → сосед
  const hasIn = new Set<string>();  // есть ребро сосед → фокус
  for (const e of edges) {
    if (e.source_id === focusId && e.target_id !== focusId) hasOut.add(e.target_id);
    else if (e.target_id === focusId && e.source_id !== focusId) hasIn.add(e.source_id);
  }
  const isBidi = (id: string): boolean => hasOut.has(id) && hasIn.has(id);
  const pureRight: string[] = [], pureLeft: string[] = [], bidi: string[] = [];
  for (const ent of entities) {
    if (isBidi(ent.id)) bidi.push(ent.id);
    else if (hasOut.has(ent.id)) pureRight.push(ent.id);
    else if (hasIn.has(ent.id)) pureLeft.push(ent.id);
    else pureRight.push(ent.id); // сосед без ребра к фокусу (теоретически) — пусть справа
  }
  const bidiSide: "left" | "right" = pureRight.length <= pureLeft.length ? "right" : "left";
  const right = [...pureRight, ...(bidiSide === "right" ? bidi : [])]; // исходящие (+bidi сюда?)
  const left = [...pureLeft, ...(bidiSide === "left" ? bidi : [])];    // входящие (+bidi сюда?)
  const onRightSet = new Set(right);

  const ROW = NODE_H + 60;
  const positions = new Map<string, { x: number; y: number }>();

  // Группа = соседи под одной рамкой раскрытого контейнера (groupKey), иначе одиночка.
  interface Grp { members: string[]; lcaIdx: number; framed: boolean }
  const buildGroups = (ids: string[]): Grp[] => {
    const map = new Map<string, Grp>();
    const order: string[] = [];
    for (const id of ids) {
      const m = meta.get(id)!;
      if (!map.has(m.groupKey)) {
        map.set(m.groupKey, { members: [], lcaIdx: m.lcaIdx, framed: m.framed });
        order.push(m.groupKey);
      }
      map.get(m.groupKey)!.members.push(id);
    }
    // Ключевой инвариант против наложения рамок: группы, делящие с фокусом более ГЛУБОКУЮ
    // рамку (больший lcaIdx), ставим БЛИЖЕ к центру. Тогда каждая общая рамка — компактная
    // полоса у фокуса, а сосед, который ей не член, гарантированно снаружи (дальше по y).
    return order.map((k) => map.get(k)!).sort((a, b) => b.lcaIdx - a.lcaIdx);
  };

  // Раскладка одной стороны: фокус по центру (y=0), группы расходятся вверх/вниз —
  // каждая на менее заполненную сторону, по lcaIdx (глубже-делящие рамку — ближе к фокусу).
  // Тогда каждая общая рамка — вложенная полоса вокруг центра, а сосед, который ей не член,
  // всегда снаружи. Зазор у границы рамки добавляем, когда lcaIdx падает относительно
  // предыдущего на этой стороне; «предыдущий» для первой группы — сам ФОКУС (он член всех
  // рамок предков, эффективный lca = lastDepth), поэтому приватная рамка фокуса корректно
  // отодвигает первого не-члена.
  const layoutSide = (sideIds: string[], dir: 1 | -1): void => {
    if (sideIds.length === 0) return;
    // базовый зазор учитывает место под подпись ребра (CTX_LABEL_W) + поля, чтобы плашка
    // влезала между фокусом и колонкой и не наезжала на узлы
    const sideGap = Math.max(CTX_LABEL_W + 60, ...sideIds.map(clearanceOf));
    const x = dir === 1 ? NODE_W + sideGap : -(sideGap + NODE_W);
    const groups = buildGroups(sideIds);

    const placed: Array<{ id: string; cy: number }> = [];
    const baseGap = ROW - NODE_H;        // базовый зазор между соседними узлами
    let downBot = focusHeight / 2;       // нижняя занятая граница (центр фокуса = 0)
    let upTop = -focusHeight / 2;        // верхняя занятая граница
    let prevDownLca = lastDepth;         // фокус — член всех рамок предков
    let prevUpLca = lastDepth;

    // При НЕЧЁТНОМ числе соседей на стороне один обязан лежать на горизонтали фокуса
    // (cy=0) — иначе колонка «провисает» в одну сторону и стрелки зря изгибаются.
    // Центрируем самую глубоко-делящую рамку группу (groups[0] — ближайшую к центру по
    // lcaIdx): её средний член встаёт в 0, остальные расходятся как обычно. Безопасно по
    // рамкам: глубочайший на стороне сосед делит с фокусом самую внутреннюю рамку, а
    // приватные рамки фокуса при этом колоночно-локальны (разводятся горизонтально через
    // sideGap), вертикального наложения не дают. Многочленную группу центрируем, только
    // если в ней нечётное число членов (иначе ни один член не попадёт ровно в 0) —
    // редкий случай раскрытого контейнера с чётным числом детей оставляем как было.
    let startIdx = 0;
    if (sideIds.length % 2 === 1 && groups[0].members.length % 2 === 1) {
      const g = groups[0];
      const mid = (g.members.length - 1) / 2;
      g.members.forEach((id, i) => placed.push({ id, cy: (i - mid) * ROW }));
      upTop = -(mid * ROW + NODE_H / 2);
      downBot = (g.members.length - 1 - mid) * ROW + NODE_H / 2;
      prevDownLca = prevUpLca = g.lcaIdx;
      startIdx = 1;
    }

    for (let gi = startIdx; gi < groups.length; gi++) {
      const g = groups[gi];
      // паддинг рамки на глубине g.lcaIdx+1 (её члены — внутренние соседи/фокус, но не эта
      // группа) + собственный паддинг группы, если она обёрнута своей рамкой (раскрытый контейнер)
      const boundaryPad =
        BOUNDARY_PAD + Math.max(0, maxDepth - (g.lcaIdx + 1)) * BOUNDARY_STEP +
        (g.framed ? BOUNDARY_PAD : 0);
      if (downBot <= -upTop) {
        const gap = baseGap + (g.lcaIdx < prevDownLca ? boundaryPad : 0);
        const c = downBot + gap + NODE_H / 2; // центр первого (ближнего к фокусу) члена
        g.members.forEach((id, i) => placed.push({ id, cy: c + i * ROW }));
        downBot = c + (g.members.length - 1) * ROW + NODE_H / 2;
        prevDownLca = g.lcaIdx;
      } else {
        const gap = baseGap + (g.lcaIdx < prevUpLca ? boundaryPad : 0);
        const c = upTop - gap - NODE_H / 2;
        g.members.forEach((id, i) => placed.push({ id, cy: c - i * ROW }));
        upTop = c - (g.members.length - 1) * ROW - NODE_H / 2;
        prevUpLca = g.lcaIdx;
      }
    }

    for (const p of placed) positions.set(p.id, { x, y: p.cy - NODE_H / 2 });
  };
  layoutSide(left, -1);
  layoutSide(right, 1);
  positions.set(focusId, { x: 0, y: -focusHeight / 2 });

  // 3. Хэндлы и маршруты. У ребра bidi-соседа есть «родная» стрелка (в естественном
  //    направлении колонки) и «не родная» (обратная). Родные и все обычные одно-направленные
  //    идут через единый центральный хэндл стороны фокуса (left/right, slot 1) к ближней
  //    стороне соседа. Не родная цепляется за ДАЛЬНЮЮ сторону соседа, огибает колонку сверху
  //    или снизу и входит в верхний/нижний центральный хэндл фокуса.
  const ids = new Set([focusId, ...entities.map((e) => e.id)]);
  // родная стрелка: право-колоночная — исходящая (центр→сосед), лево-колоночная — входящая
  const isNativeEdge = (e: AppEdge): boolean => {
    const outgoing = e.source_id === focusId;
    const neighborId = outgoing ? e.target_id : e.source_id;
    return onRightSet.has(neighborId) ? outgoing : !outgoing;
  };

  // Полки подписей: ближняя лента (near, у стороны соседа к фокусу — родные/обычные стрелки)
  // и дальняя лента (far, с противоположной стороны соседа — не родные стрелки). Длина ленты
  // = макс. оценочная ширина подписи в ней (минимум MIN_SHELF) → полки выстраиваются ровно.
  const nearW = { left: [MIN_SHELF], right: [MIN_SHELF] };
  const farW = { left: [MIN_SHELF], right: [MIN_SHELF] };
  for (const e of edges) {
    if (!ids.has(e.source_id) || !ids.has(e.target_id)) continue;
    const neighborId = e.source_id === focusId ? e.target_id : e.source_id;
    const side = onRightSet.has(neighborId) ? "right" : "left";
    const text = [e.label, e.technology].filter(Boolean).join(" · ") || "связь";
    (isNativeEdge(e) ? nearW : farW)[side].push(ctxLabelWidth(text));
  }
  const nearLen = { left: Math.max(...nearW.left) + SHELF_PAD, right: Math.max(...nearW.right) + SHELF_PAD };
  const farLen = { left: Math.max(...farW.left) + SHELF_PAD, right: Math.max(...farW.right) + SHELF_PAD };

  // bbox колонки (по её узлам) — чтобы обход не родной стрелки гарантированно охватил все узлы
  const colBox = (colIds: string[]) => {
    let top = Infinity, bot = -Infinity, l = Infinity, r = -Infinity;
    for (const id of colIds) {
      const p = positions.get(id); if (!p) continue;
      top = Math.min(top, p.y); bot = Math.max(bot, p.y + NODE_H);
      l = Math.min(l, p.x); r = Math.max(r, p.x + NODE_W);
    }
    return { top, bot, l, r };
  };
  const focusTop = -focusHeight / 2, focusBot = focusHeight / 2;
  const LOOP_MARGIN = 40; // зазор обхода над/под колонкой
  const RING_STEP = 26;   // разнос вложенных обходов, если на стороне несколько bidi

  // Параметры обхода (loopX — дальняя вертикаль, clearY — уровень обхода над/под) на каждого
  // bidi-соседа. Несколько bidi на стороне нанизываем вложенными кольцами, чтобы не пересекались.
  const loopParam = new Map<string, { loopX: number; clearY: number }>();
  const assignLoops = (side: "left" | "right") => {
    const members = (side === "right" ? right : left).filter(isBidi);
    if (members.length === 0) return;
    const box = colBox(side === "right" ? right : left);
    const cy = (id: string) => positions.get(id)!.y + NODE_H / 2;
    const farBaseX = side === "right" ? box.r + farLen.right : box.l - farLen.left;
    const dirX = side === "right" ? 1 : -1;
    const topBase = Math.min(box.top, focusTop) - LOOP_MARGIN; // обход сверху
    const botBase = Math.max(box.bot, focusBot) + LOOP_MARGIN;  // обход снизу
    // верх: сосед выше центра фокуса; ближе к верху → внутреннее (меньшее) кольцо
    const over = members.filter((id) => cy(id) < 0).sort((a, b) => cy(a) - cy(b));
    const under = members.filter((id) => cy(id) >= 0).sort((a, b) => cy(b) - cy(a));
    over.forEach((id, k) => loopParam.set(id, { loopX: farBaseX + dirX * k * RING_STEP, clearY: topBase - k * RING_STEP }));
    under.forEach((id, k) => loopParam.set(id, { loopX: farBaseX + dirX * k * RING_STEP, clearY: botBase + k * RING_STEP }));
  };
  assignLoops("right"); assignLoops("left");

  const edgeHandles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  const edgeShelves = new Map<string, EdgeShelf>();
  const edgeLoops = new Map<string, EdgeLoop>();
  for (const e of edges) {
    if (!ids.has(e.source_id) || !ids.has(e.target_id)) continue;
    const outgoing = e.source_id === focusId;
    const neighborId = outgoing ? e.target_id : e.source_id;
    const onRight = onRightSet.has(neighborId);
    const focusSide = onRight ? "right" : "left";

    if (isNativeEdge(e) || !isBidi(neighborId)) {
      // родная / обычная стрелка: центр стороны фокуса ↔ ближняя сторона соседа, полка у соседа
      const neighborSide = onRight ? "left" : "right";
      const focusHandle = hid(focusId, focusSide, 1);
      const neighborHandle = hid(neighborId, neighborSide, 1);
      edgeHandles.set(e.id, outgoing
        ? { sourceHandle: focusHandle, targetHandle: neighborHandle }
        : { sourceHandle: neighborHandle, targetHandle: focusHandle });
      edgeShelves.set(e.id, {
        end: outgoing ? "target" : "source",
        len: onRight ? nearLen.right : nearLen.left,
      });
    } else {
      // НЕ родная стрелка bidi: дальняя сторона соседа → обход сверху/снизу → верх/низ-центр фокуса
      const p = loopParam.get(neighborId)!;
      const over = p.clearY < 0;
      const farSide = onRight ? "right" : "left";          // дальняя от фокуса сторона соседа
      const neighborHandle = hid(neighborId, farSide, 1);
      const focusHandle = hid(focusId, over ? "top" : "bottom", 1);
      edgeHandles.set(e.id, outgoing
        ? { sourceHandle: focusHandle, targetHandle: neighborHandle }
        : { sourceHandle: neighborHandle, targetHandle: focusHandle });
      edgeLoops.set(e.id, { neighborEnd: outgoing ? "target" : "source", loopX: p.loopX, clearY: p.clearY });
    }
  }

  return { positions, edgeHandles, edgeShelves, edgeLoops };
}

interface FrameDef {
  id: string;
  name: string;
  depth: number;          // 0 — самый внешний предок; глубже → меньше отступ
  memberIds: Set<string>; // id отображаемых узлов-потомков этого контейнера
}

/**
 * Рамки уровней (C4-boundary). Для каждого контейнера рисуется пунктирный
 * прямоугольник вокруг bbox всех его отображаемых узлов-потомков. Контейнеры:
 *  - предки из breadcrumb (ancestorIds/Names, корень → непосредственный родитель);
 *  - промежуточные контейнеры гостей между общим предком и гостем — «условно-
 *    гостевые» рамки (показывают иерархию: гость лежит в своём контейнере).
 * Так гость (напр. Zabbix Web) попадает внутрь рамки общего предка (HelixMon),
 * внутри подрамки своего родителя (ProdMon). Гость без общего предка-рамки
 * (общий предок только корень) остаётся снаружи.
 * Рендерится через ViewportPortal — в координатах графа, пан/зум вместе с узлами.
 */
function LevelBoundary({
  rfNodes, ancestorIds, ancestorNames, expanded, onCollapse,
}: {
  rfNodes: RFNode[]; ancestorIds: string[]; ancestorNames: string[];
  expanded: Set<string>; onCollapse: (id: string) => void;
}) {
  if (ancestorIds.length === 0) return null;
  const blocks = rfNodes.filter((n) => n.type === "block");
  // внешние отображаемые узлы: гости (leaf) и свёрнутые контейнеры
  const externals = rfNodes.filter((n) => n.type === "ghost" || n.type === "container");
  if (blocks.length === 0) return null;

  const extAncestors = (n: RFNode): AncestorRef[] =>
    n.type === "ghost"
      ? (n.data as GhostData).appNode.ancestors ?? []
      : ((n.data as ContainerData).ancestors ?? []);

  const localIds = blocks.map((b) => b.id);
  const bcIndex = new Map(ancestorIds.map((id, i) => [id, i]));

  const frames = new Map<string, FrameDef>();
  // breadcrumb-рамки: локальные узлы — потомки каждого предка
  ancestorIds.forEach((id, i) => {
    frames.set(id, { id, name: ancestorNames[i], depth: i, memberIds: new Set(localIds) });
  });

  for (const g of externals) {
    const anc = extAncestors(g);
    // общий предок = самый глубокий breadcrumb-предок среди предков
    let lcaIdx = -1, lcaPos = -1;
    anc.forEach((a, pos) => {
      const idx = bcIndex.get(a.id);
      if (idx !== undefined && idx > lcaIdx) { lcaIdx = idx; lcaPos = pos; }
    });
    if (lcaIdx === -1) continue; // нет общего предка-рамки → снаружи
    // узел — член breadcrumb-рамок до общего предка включительно
    for (let i = 0; i <= lcaIdx; i++) frames.get(ancestorIds[i])!.memberIds.add(g.id);
    // промежуточные контейнеры (ниже общего предка) — рамки развёрнутых контейнеров
    for (let pos = lcaPos + 1; pos < anc.length; pos++) {
      const a = anc[pos];
      const depth = lcaIdx + (pos - lcaPos);
      if (!frames.has(a.id)) frames.set(a.id, { id: a.id, name: a.name, depth, memberIds: new Set() });
      frames.get(a.id)!.memberIds.add(g.id);
    }
  }

  const posById = new Map(rfNodes.map((n) => [n.id, n.position]));
  const maxDepth = Math.max(...[...frames.values()].map((f) => f.depth));

  const rects = [...frames.values()].map((f) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of f.memberIds) {
      const p = posById.get(id);
      if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    }
    if (!isFinite(minX)) return null;
    const pad = BOUNDARY_PAD + (maxDepth - f.depth) * BOUNDARY_STEP;
    // рамку растягиваем вниз сильнее, чем по остальным сторонам, чтобы подпись получила
    // свою полосу под содержимым. Внешним рамкам (меньший depth) добавка больше — так их
    // подпись уходит ниже нижнего края вложенных рамок и не царапает их.
    const labelPad = BOUNDARY_LABEL_PAD + (maxDepth - f.depth) * BOUNDARY_LABEL_STEP;
    return {
      id: f.id, name: f.name, depth: f.depth,
      x: minX - pad, y: minY - pad,
      w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad + labelPad,
    };
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  // внешние рамки (меньший depth) рисуем первыми — под внутренними
  rects.sort((a, b) => a.depth - b.depth);

  return (
    <>
      {rects.map((r) => {
        const collapsible = expanded.has(r.id); // развёрнутый контейнер — можно свернуть
        return (
          <div
            key={r.id}
            style={{
              position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h,
              border: "1px dashed #9ca3af", borderRadius: 12, background: "transparent",
              boxSizing: "border-box", pointerEvents: "none",
            }}
          >
            <div
              className={collapsible ? "nodrag nopan" : undefined}
              onClick={collapsible ? () => onCollapse(r.id) : undefined}
              title={collapsible ? "Свернуть" : undefined}
              style={{
                position: "absolute", left: 10, bottom: 8, fontSize: 12, fontWeight: 600,
                color: "#64748b", background: "#fff", padding: "2px 8px", borderRadius: 5,
                border: "1px solid #e5e7eb", whiteSpace: "nowrap",
                pointerEvents: collapsible ? "auto" : "none",
                cursor: collapsible ? "pointer" : "default",
              }}
            >
              {collapsible ? `🔍 ${r.name} ✕` : r.name}
            </div>
          </div>
        );
      })}
    </>
  );
}

// Центральные направляющие при магнитном выравнивании. Рендерятся внутри
// ViewportPortal, поэтому координаты — в системе графа. Линии тонкие, длинные
// (перекрывают видимую область при любом зуме/панораме).
function AlignmentGuides({ x, y }: { x: number | null; y: number | null }) {
  const SPAN = 1_000_000; // заведомо больше любого практического холста
  return (
    <>
      {x != null && (
        <div
          style={{
            position: "absolute", left: x, top: -SPAN / 2, width: 0, height: SPAN,
            borderLeft: "1px solid #22c55e", pointerEvents: "none", zIndex: 4,
          }}
        />
      )}
      {y != null && (
        <div
          style={{
            position: "absolute", top: y, left: -SPAN / 2, height: 0, width: SPAN,
            borderTop: "1px solid #22c55e", pointerEvents: "none", zIndex: 4,
          }}
        />
      )}
    </>
  );
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

// --- Стили ---

const tagChip: CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 10,
  fontSize: 11,
  marginRight: 3,
};
const nodeActions: CSSProperties = {
  position: "absolute",
  top: 6,
  right: 8,
  display: "flex",
  gap: 3,
  zIndex: 2, // выше контент-блока (zIndex 1), иначе он перехватывает клики по кнопкам
};
// Действия для узла-пользователя: опущены внутрь прямоугольника-тела (тело начинается
// с y≈50, см. NodeShapeSvg/person), чтобы кнопка не висела сбоку от головы.
const personActions: CSSProperties = {
  ...nodeActions,
  top: 56,
};
const nodeBtn: CSSProperties = {
  padding: "2px 6px",
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #e5e7eb",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1.4,
};
