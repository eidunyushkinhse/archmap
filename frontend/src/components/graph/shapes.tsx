// Презентация формы узла (SVG C4-фигуры), отступы контента и node-стили.
import { Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { NODE_W, NODE_H, shapeHeight } from "./constants";
import type { NodeShape } from "../../types";

// --- Стиль конкретного хэндла из 12 ---

export function fixedHandleStyle(pos: Position, offset: number): CSSProperties {
  // САМ хэндл — это маленькая измеряемая точка-цель НА линии границы узла (видимый
  // круглый дот рисует дочерний .lg-handle-dot, см. NodeHandles). Так и центр хэндла
  // (его берёт превью reconnect, center=true), и его внешняя кромка (её берут обычные
  // рёбра, center=false) ложатся на границу с точностью до ~1px. Раньше хэндлом был
  // сам 9px-дот: центр и кромка расходились на пол-хэндла, отчего либо тонул
  // наконечник превью, либо зиял зазор у обычных стрелок.
  //
  // Поперёк границы делаем бокс тонким (THIN), чтобы кромка ≈ центр; min-width/height
  // у RF по умолчанию 5px — обнуляем, иначе бокс не ужать. opacity и видимый стиль —
  // в LevelGraph.css (дот скрыт в покое, показывается на ховере/.connectingto).
  const THIN = 2;
  const base: CSSProperties = {
    width: THIN,
    height: THIN,
    minWidth: 0,
    minHeight: 0,
    background: "transparent",
    border: "none",
    zIndex: 3, // поверх SVG-формы узла
  };
  // Вдоль стороны бокс двигает offset (top/left в %), поперёк — translate ±50%
  // (центрируем точку-цель ровно на линии границы).
  switch (pos) {
    case Position.Left:
      return { ...base, top: `${offset * 100}%`, transform: "translate(-50%, -50%)" };
    case Position.Right:
      return { ...base, top: `${offset * 100}%`, transform: "translate(50%, -50%)" };
    case Position.Top:
      return { ...base, left: `${offset * 100}%`, transform: "translate(-50%, -50%)" };
    default: // Bottom
      return { ...base, left: `${offset * 100}%`, transform: "translate(-50%, 50%)" };
  }
}

// --- SVG-формы узлов (C4): сервис / БД / брокер / пользователь ---

export interface NodeShapeProps {
  shape: NodeShape;
  bg: string;
  stroke: string;
  dashed?: boolean; // пунктир для гостевых узлов
  // режим контура (прозрачное тело, напр. превью драга): у БД не замыкаем тело
  // сверху прямой — иначе она просвечивает сквозь прозрачную крышку-эллипс
  outline?: boolean;
}

export function NodeShapeSvg({ shape, bg, stroke, dashed, outline }: NodeShapeProps) {
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
export function contentPadding(shape: NodeShape, hasActions: boolean): CSSProperties {
  const right = hasActions ? 52 : 14;
  switch (shape) {
    case "database": return { paddingTop: 28, paddingRight: right, paddingBottom: 14, paddingLeft: 16 };
    case "broker": return { paddingTop: 14, paddingRight: right, paddingBottom: 14, paddingLeft: 30 };
    case "person": return { paddingTop: 54, paddingRight: right, paddingBottom: 8, paddingLeft: 14 };
    default: return { paddingTop: 12, paddingRight: right, paddingBottom: 12, paddingLeft: 14 };
  }
}

export const nodeContainer: CSSProperties = {
  position: "relative",
  width: NODE_W,
  height: NODE_H,
  boxSizing: "border-box",
  fontSize: 13,
};
// Свечение выбранного узла (см. BlockNode). Два drop-shadow: тонкий контурный +
// мягкий ореол синим — повторяют силуэт SVG-формы.
export const SELECTED_GLOW =
  "drop-shadow(0 0 2px #2563eb) drop-shadow(0 0 7px rgba(37,99,235,0.65))";

// --- Стили узла (чипы/кнопки/панели действий) ---

export const tagChip: CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 10,
  fontSize: 11,
  marginRight: 3,
};
export const nodeActions: CSSProperties = {
  position: "absolute",
  top: 6,
  right: 8,
  display: "flex",
  gap: 3,
  zIndex: 2, // выше контент-блока (zIndex 1), иначе он перехватывает клики по кнопкам
};
// Действия для узла-пользователя: опущены внутрь прямоугольника-тела (тело начинается
// с y≈50, см. NodeShapeSvg/person), чтобы кнопка не висела сбоку от головы.
export const personActions: CSSProperties = {
  ...nodeActions,
  top: 56,
};
export const nodeBtn: CSSProperties = {
  padding: "2px 6px",
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #e5e7eb",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1.4,
};
