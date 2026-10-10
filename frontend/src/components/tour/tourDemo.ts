// Демонстрация на шаге «Перевесьте связь» (испытания на людях 2026-10-10: трое из трёх
// тянули связь от сервиса к рамке, а не перевешивали конец стрелки с рамки на сервис).
// Курсор-ладонь берёт конец стрелки на рамке и переносит его на точку сервиса;
// переносимая стрелка — полупрозрачная копия той превью-линии, которую холст рисует
// при настоящем перевесе (graph/ConnectionLine: smoothstep от неподвижного конца,
// наконечник там же, где у неё). Настоящая связь не меняется.
//
// Здесь чистая часть: геометрия демонстрации и кадр цикла по времени. Рисует
// TourDemo.tsx, геометрию снимает со сцены tourHandles.ts.
import { getSmoothStepPath, Position } from "@xyflow/react";
import { clamp01, easeInOut, easeOut } from "./tourMotion";

export interface Point { x: number; y: number }
export type Side = "top" | "right" | "bottom" | "left";

/** Что показать (координаты окна). */
export interface RehangDemo {
  /** где ладонь берёт конец стрелки: ручка перевеса на рамке */
  grab: Point;
  /** куда кладёт: точка на дочернем объекте и сторона, на которой она стоит */
  drop: Point;
  dropSide: Side;
  /** неподвижный конец связи на втором объекте и сторона его точки */
  fixed: Point;
  fixedSide: Side;
  /** рамка — начало связи: тянут исходящий конец, наконечник у неподвижного */
  headAtFixed: boolean;
  /** масштаб холста: толщина линии и скругления — как у превью-линии на холсте */
  zoom: number;
}

/** Длина цикла; дальше он повторяется, пока человек не возьмётся сам. */
export const DEMO_CYCLE_MS = 5000;
/** Насколько видна переносимая копия стрелки (полупрозрачна: это показ, а не связь). */
export const GHOST_ALPHA = 0.6;
/** Ближе стольких px к точке конец защёлкивается на ней — как на холсте (connectionRadius). */
export const SNAP_PX = 24;
/** После жеста человека демонстрация возвращается через столько мс, если шаг не сделан. */
export const DEMO_RESUME_MS = 1500;

// Фазы цикла (мс от начала): ладонь подлетает к концу стрелки и проявляется, сжимается
// (взяла), везёт конец к точке, держит, разжимается (отпустила) и уходит; копия
// стрелки держится на точке и гаснет; пауза до следующего цикла.
const T_APPEAR = 450;
const T_GRAB = 700;
const T_MOVE = 2100;
const T_HOLD = 2400;
const T_RELEASE = 2650;
const T_LEAVE = 3250;
const T_GHOST_OUT = 3900;

/** Откуда подлетает и куда уходит ладонь: снизу справа от точки, как рука с мышью. */
const APPROACH = { x: 30, y: 24 };
const LEAVE = { x: 22, y: 18 };

export interface DemoFrame {
  /** ладонь: центр, сжата ли, нажатие 0..1 (чуть меньше в нажатом), видимость */
  hand: { x: number; y: number; closed: boolean; press: number; opacity: number };
  /** конец переносимой копии стрелки: у ладони или защёлкнут на точке; null — копии нет */
  ghost: { x: number; y: number; snapped: boolean; opacity: number } | null;
  /** круги «нажал» и «отпустил»: где и насколько разошлись (0..1); null — нет */
  ripple: { x: number; y: number; k: number } | null;
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const lerpPt = (a: Point, b: Point, k: number): Point => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) });
const phase = (t: number, from: number, to: number): number => clamp01((t - from) / (to - from));

/** Кадр цикла в момент t (мс от начала цикла, любые t сводятся к одному циклу). */
export function demoFrame(tRaw: number, demo: Pick<RehangDemo, "grab" | "drop">): DemoFrame {
  const t = ((tRaw % DEMO_CYCLE_MS) + DEMO_CYCLE_MS) % DEMO_CYCLE_MS;
  const { grab, drop } = demo;
  const from = { x: grab.x + APPROACH.x, y: grab.y + APPROACH.y };
  const away = { x: drop.x + LEAVE.x, y: drop.y + LEAVE.y };

  // ладонь
  let pos: Point;
  let opacity = 1;
  if (t < T_APPEAR) {
    const k = easeOut(phase(t, 0, T_APPEAR));
    pos = lerpPt(from, grab, k);
    opacity = k;
  } else if (t < T_GRAB) {
    pos = grab;
  } else if (t < T_MOVE) {
    pos = lerpPt(grab, drop, easeInOut(phase(t, T_GRAB, T_MOVE)));
  } else if (t < T_RELEASE) {
    pos = drop;
  } else if (t < T_LEAVE) {
    const k = easeOut(phase(t, T_RELEASE, T_LEAVE));
    pos = lerpPt(drop, away, k);
    opacity = 1 - k;
  } else {
    pos = away;
    opacity = 0;
  }
  const closed = t >= T_APPEAR + 100 && t < T_HOLD + 100;
  // нажатие: сжимается за 150 мс после «взяла», разжимается за 150 мс на «отпустила»
  const press = t < T_APPEAR + 100 ? 0
    : t < T_HOLD + 100 ? phase(t, T_APPEAR + 100, T_APPEAR + 250)
      : 1 - phase(t, T_HOLD + 100, T_HOLD + 250);

  // копия стрелки: появляется, когда ладонь взяла конец, едет с ней, у точки защёлкивается
  let ghost: DemoFrame["ghost"] = null;
  if (t >= T_APPEAR + 100 && t < T_GHOST_OUT) {
    const near = Math.hypot(pos.x - drop.x, pos.y - drop.y) <= SNAP_PX;
    const snapped = t >= T_MOVE || (t >= T_GRAB && near);
    const end = snapped ? drop : pos;
    const alpha = t < T_GRAB ? GHOST_ALPHA * phase(t, T_APPEAR + 100, T_GRAB)
      : t < T_LEAVE ? GHOST_ALPHA
        : GHOST_ALPHA * (1 - phase(t, T_LEAVE, T_GHOST_OUT));
    ghost = { x: end.x, y: end.y, snapped, opacity: alpha };
  }

  // круги: «нажал» на рамке, «отпустил» на точке
  let ripple: DemoFrame["ripple"] = null;
  if (t >= T_APPEAR + 100 && t < T_APPEAR + 600) ripple = { ...grab, k: phase(t, T_APPEAR + 100, T_APPEAR + 600) };
  else if (t >= T_HOLD + 100 && t < T_HOLD + 600) ripple = { ...drop, k: phase(t, T_HOLD + 100, T_HOLD + 600) };

  return { hand: { ...pos, closed, press, opacity }, ghost, ripple };
}

const POS: Record<Side, Position> = {
  top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left,
};
const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/**
 * Путь переносимой копии стрелки — как превью-линия холста при перевесе: smoothstep от
 * неподвижного конца к концу у ладони. Пока конец не защёлкнут, он входит со стороны,
 * противоположной неподвижному концу (так делает React Flow без хэндла под курсором),
 * защёлкнутый — со стороны точки. Масштаб холста — в скруглениях и отступах.
 */
export function ghostPath(demo: RehangDemo, end: Point, snapped: boolean): string {
  const [path] = getSmoothStepPath({
    sourceX: demo.fixed.x, sourceY: demo.fixed.y, sourcePosition: POS[demo.fixedSide],
    targetX: end.x, targetY: end.y,
    targetPosition: POS[snapped ? demo.dropSide : OPPOSITE[demo.fixedSide]],
    borderRadius: 12 * demo.zoom,
    offset: 20 * demo.zoom,
  });
  return path;
}
