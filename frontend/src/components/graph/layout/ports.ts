// ПОРТ НА СВЯЗЬ (эпик «стрелки без жёстких хэндлов», docs/plan-arrows-ports.md, Ф1).
//
// Точки стыковки больше не фиксированные слоты узла, а свои у каждой нарисованной
// линии: сторона — по правилу оси потока (R2), порядок на стороне — по дальнему концу
// (R3), шаг — равный с полями у узла и проекция дальнего конца с минимальным зазором у
// рамки (R4). Так крепятся стрелки в Mermaid (ELK layered): у каждой связи свой порт,
// входы и выходы вперемешку на одной стороне, общих точек нет по построению.
//
// Чистый модуль: геометрия входит прямоугольниками, выходит картой портов. Роутер
// (autoRoutes) получает по ОДНОМУ порту на конец и прокладывает маршрут между ними —
// сторону он больше не выбирает.
import type { EdgePoint } from "../../../types";
import type { EdgeSide, NodeRect } from "../edgePath";
import { spread1D } from "./pav";

/** Ось потока уровня: "v" — сверху вниз (стороны top/bottom), "h" — слева направо. */
export type FlowAxis = "v" | "h";

export interface PortEnd { side: EdgeSide; point: EdgePoint }
export interface PortPair { s: PortEnd; t: PortEnd }

// Константы контракта маршрутов (входят в реестр ROUTER_VERSION).
/** Поле от угла стороны узла до крайнего порта, px (ELK: portsSurrounding ≈ 10). */
export const PORT_MARGIN = 10;
/** Минимальный зазор между портами на стороне РАМКИ (проекция дальнего конца), px. */
export const FRAME_PORT_GAP = 24;
/** Гистерезис смены режима стороны (разнесены вдоль оси ↔ стоят рядом), px. */
export const SIDE_HYSTERESIS = 16;
/** Доля голосов, при которой ось потока меняется против прежней (гистерезис оси). */
export const AXIS_FLIP_SHARE = 0.6;

const center = (r: NodeRect): EdgePoint => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
// зазор между прямоугольниками вдоль оси: >0 — разнесены, ≤0 — пересекаются по ней
const gapV = (a: NodeRect, b: NodeRect): number => Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
const gapH = (a: NodeRect, b: NodeRect): number => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
const isVerticalSide = (s: EdgeSide): boolean => s === "top" || s === "bottom";

/** Зазор меньше половины меньшего узла считается перекрытием: узлы «друг под другом». */
export const AXIS_OVERLAP_SHARE = 0.5;
/** Пара, разнесённая по обеим осям, голосует, только если зазоры различаются вдвое. */
export const AXIS_DECISIVE_RATIO = 0.5;

/**
 * Ось потока уровня по геометрии связей. Голосует каждая пара узлов: разнесены только
 * по вертикали (по горизонтали перекрываются или почти — зазор меньше половины узла) —
 * голос за "v"; только по горизонтали — за "h"; по обеим осям — за ось МЕНЬШЕГО зазора,
 * если он меньше другого хотя бы вдвое (у слоистой раскладки зазор между слоями мал и
 * постоянен, разброс внутри слоя велик), иначе пара воздерживается. Прежняя ось (из
 * прежних сторон) удерживается, пока против неё не наберётся AXIS_FLIP_SHARE голосов:
 * ось не дёргается при драге одного узла. Без голосов — "v" (автораскладка DOWN).
 */
export function flowAxisOf(
  pairs: ReadonlyArray<{ a: NodeRect; b: NodeRect }>,
  prevAxis?: FlowAxis,
): FlowAxis {
  let v = 0, h = 0;
  for (const { a, b } of pairs) {
    const gv = gapV(a, b), gh = gapH(a, b);
    const sepV = gv > AXIS_OVERLAP_SHARE * Math.min(a.h, b.h);
    const sepH = gh > AXIS_OVERLAP_SHARE * Math.min(a.w, b.w);
    if (sepV && sepH) {
      const ratio = Math.min(gv, gh) / Math.max(gv, gh);
      if (ratio > AXIS_DECISIVE_RATIO) continue;   // диагональ без явного слоя — воздержалась
      if (gv < gh) v++; else h++;
    } else if (sepV) v++;
    else if (sepH) h++;
  }
  const total = v + h;
  if (total === 0) return prevAxis ?? "v";
  if (prevAxis) {
    const against = prevAxis === "v" ? h : v;
    return against / total >= AXIS_FLIP_SHARE ? (prevAxis === "v" ? "h" : "v") : prevAxis;
  }
  return h > v ? "h" : "v";
}

/**
 * Стороны стыковки пары узлов (R2). Разнесены вдоль оси потока — стороны оси потока,
 * обращённые друг к другу; стоят рядом (пересекаются по оси потока) — поперечные стороны.
 * prev — прежние стороны пары: режим удерживается в полосе ±SIDE_HYSTERESIS.
 */
export function sidesFor(
  a: NodeRect, b: NodeRect, axis: FlowAxis,
  prev?: { s: EdgeSide; t: EdgeSide },
): { s: EdgeSide; t: EdgeSide } {
  const gAxis = axis === "v" ? gapV(a, b) : gapH(a, b);
  const prevFlow = prev ? isVerticalSide(prev.s) === (axis === "v") : null;
  // режим: по оси потока, если разнесены вдоль неё; гистерезис держит прежний режим
  const flowMode = prevFlow === true ? gAxis > -SIDE_HYSTERESIS
    : prevFlow === false ? gAxis > SIDE_HYSTERESIS
      : gAxis > 0;
  const ca = center(a), cb = center(b);
  const vertical = flowMode ? axis === "v" : axis === "h";
  if (vertical) {
    return cb.y >= ca.y ? { s: "bottom", t: "top" } : { s: "top", t: "bottom" };
  }
  return cb.x >= ca.x ? { s: "right", t: "left" } : { s: "left", t: "right" };
}

interface SideEntry {
  key: string;            // id группы + конец
  far: number;            // координата дальнего конца вдоль стороны (порядок R3)
  tie: string;            // тай-брейк
  set: (p: EdgePoint) => void;
}

// координата вдоль стороны и её диапазон
function sideSpan(r: NodeRect, side: EdgeSide): { start: number; len: number } {
  return isVerticalSide(side) ? { start: r.x, len: r.w } : { start: r.y, len: r.h };
}
function pointOnSide(r: NodeRect, side: EdgeSide, along: number): EdgePoint {
  switch (side) {
    case "top": return { x: along, y: r.y };
    case "bottom": return { x: along, y: r.y + r.h };
    case "left": return { x: r.x, y: along };
    default: return { x: r.x + r.w, y: along };
  }
}
const half = (v: number): number => Math.round(v * 2) / 2;

/**
 * Порты всех связей уровня: сторона по R2, порядок по R3, позиции по R4.
 * rects — тела стыковки (узлы и рамки-концы); frameIds — какие из них рамки;
 * prevSides — прежние стороны пар (гистерезис R2 и прежняя ось); keys — ключи порядка
 * концов вместо центра дальнего узла (доводка E85: роутер отдаёт место вертикали
 * связи в соседнем канале — колонну ZZ или центр своего узла у длинного Z).
 * Группы с концом без прямоугольника пропускаются.
 */
export function assignPorts(params: {
  groups: ReadonlyArray<{ id: string; source: string; target: string }>;
  rects: ReadonlyMap<string, NodeRect>;
  frameIds?: ReadonlySet<string>;
  prevSides?: ReadonlyMap<string, { s: EdgeSide; t: EdgeSide }>;
  axis?: FlowAxis;
  keys?: ReadonlyMap<string, { s?: number; t?: number }>;
}): { ports: Map<string, PortPair>; axis: FlowAxis } {
  const { groups, rects, frameIds, prevSides, keys } = params;
  const pairs: Array<{ a: NodeRect; b: NodeRect }> = [];
  for (const g of groups) {
    const a = rects.get(g.source), b = rects.get(g.target);
    if (a && b && g.source !== g.target) pairs.push({ a, b });
  }
  // прежняя ось — большинство прежних сторон
  let prevAxis: FlowAxis | undefined;
  if (prevSides && prevSides.size > 0) {
    let vv = 0, hh = 0;
    for (const p of prevSides.values()) { if (isVerticalSide(p.s)) vv++; else hh++; }
    prevAxis = hh > vv ? "h" : "v";
  }
  const axis = params.axis ?? flowAxisOf(pairs, prevAxis);

  const ports = new Map<string, PortPair>();
  const bySide = new Map<string, { rect: NodeRect; side: EdgeSide; frame: boolean; entries: SideEntry[] }>();
  const push = (nodeId: string, rect: NodeRect, side: EdgeSide, entry: SideEntry) => {
    const k = `${nodeId}|${side}`;
    let rec = bySide.get(k);
    if (!rec) { rec = { rect, side, frame: frameIds?.has(nodeId) ?? false, entries: [] }; bySide.set(k, rec); }
    rec.entries.push(entry);
  };
  for (const g of groups) {
    const a = rects.get(g.source), b = rects.get(g.target);
    if (!a || !b) continue;
    let sides: { s: EdgeSide; t: EdgeSide };
    if (g.source === g.target) {
      // петля: два разных борта одного узла, чтобы маршрут обогнул угол
      sides = axis === "v" ? { s: "right", t: "top" } : { s: "bottom", t: "left" };
    } else {
      sides = sidesFor(a, b, axis, prevSides?.get(g.id));
    }
    const pair: PortPair = {
      s: { side: sides.s, point: center(a) },
      t: { side: sides.t, point: center(b) },
    };
    ports.set(g.id, pair);
    const ca = center(a), cb = center(b);
    const alongOf = (side: EdgeSide, p: EdgePoint): number => (isVerticalSide(side) ? p.x : p.y);
    const k = keys?.get(g.id);
    push(g.source, a, sides.s, { key: `${g.id}:s`, far: k?.s ?? alongOf(sides.s, cb), tie: `${g.id}:s`, set: (p) => { pair.s.point = p; } });
    push(g.target, b, sides.t, { key: `${g.id}:t`, far: k?.t ?? alongOf(sides.t, ca), tie: `${g.id}:t`, set: (p) => { pair.t.point = p; } });
  }

  for (const rec of bySide.values()) {
    const { rect, side, frame, entries } = rec;
    entries.sort((p, q) => p.far - q.far || (p.tie < q.tie ? -1 : p.tie > q.tie ? 1 : 0));
    const { start, len } = sideSpan(rect, side);
    const margin = Math.min(PORT_MARGIN, len / 4);
    const lo = start + margin, hi = start + len - margin;
    const k = entries.length;
    let along: number[];
    if (frame) {
      // рамка: проекция дальнего конца на сторону, зажатая полями, затем разведение с
      // минимальным зазором; не влезло — равный шаг
      const desired = entries.map((e) => Math.min(hi, Math.max(lo, e.far)));
      along = spread1D(desired, FRAME_PORT_GAP);
      if (along.some((v) => v < lo - 0.5 || v > hi + 0.5)) {
        const step = (hi - lo) / (k + 1);
        along = entries.map((_, i) => lo + step * (i + 1));
      }
    } else {
      const step = (hi - lo) / (k + 1);
      along = entries.map((_, i) => lo + step * (i + 1));
    }
    entries.forEach((e, i) => e.set(pointOnSide(rect, side, half(along[i]))));
  }
  return { ports, axis };
}
