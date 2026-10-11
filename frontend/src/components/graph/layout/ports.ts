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
  share?: string;         // id общего плеча: концы с одним id делят одну точку стороны
  fixedAlong?: number;    // сближенная пара: порт стоит здесь, вне равного шага
  set: (p: EdgePoint) => void;
}

/**
 * ОБЩИЕ ПЛЕЧА (Ф2, заход 4, решение пользователя 2026-10-11; спека edge E95): концы
 * ОДНОГО направления на одной стороне узла, уходящие в одно крыло (все исходящие влево,
 * все входящие справа…), делят один порт, стаб и первую дорожку — ствол, расходящийся
 * там, где расходятся цели (режим mergeEdges ELK). Связь делит плечо не больше чем на
 * одном конце: ствол отправления и ствол прибытия на одной линии дали бы ложную связь
 * между их чужими концами. Выбор конца — где группа больше, при равенстве — отправление.
 * Переключатель — для полигона и тестов (сравнение со «своей дорожкой» у каждой связи).
 */
export const PORT_SHARE = { on: true };

/**
 * СБЛИЖЕННАЯ ПАРА: зазор между стыкуемыми сторонами меньше этого — Z не помещается
 * (две полосы клиренса и дорожка), и порты обеих сторон выравниваются в общую колонну
 * внутри пересечения сторон: связь — прямая. Иначе A* рисует микрозигзаг на дюжине px.
 * = 2·Z_CLEAR + NUDGE_GAP.
 */
export const CLOSE_PAIR_GAP = 38;
/** Минимальное пересечение сторон вдоль, при котором есть куда поставить общую колонну. */
const CLOSE_PAIR_OVERLAP = 2 * PORT_MARGIN;

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
}): { ports: Map<string, PortPair>; axis: FlowAxis; shares: Map<string, { s?: string; t?: string }> } {
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
  // стороны всех пар — заранее: общие плеча считаются по сторонам
  const items: Array<{ g: { id: string; source: string; target: string }; a: NodeRect; b: NodeRect; sides: { s: EdgeSide; t: EdgeSide } }> = [];
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
    items.push({ g, a, b, sides });
  }
  // ОБЩИЕ ПЛЕЧА: корзины «узел|сторона|направление|куда» (куда — дальний конец левее или
  // правее середины узла вдоль стороны: ствол в одну сторону; общая шина через весь борт
  // режется любой связью, выходящей из того же борта между её ветвями), связь — в
  // бо́льшую корзину (не меньше двух), при равенстве — отправление; корзины, где после
  // выбора остался один, распускаются.
  // СБЛИЖЕННЫЕ ПАРЫ: общая колонна портов — середина пересечения сторон (в пределах полей)
  const closeAlong = new Map<string, number>();
  for (const it of items) {
    if (it.g.source === it.g.target) continue;
    const vertical = isVerticalSide(it.sides.s);
    if (vertical !== isVerticalSide(it.sides.t)) continue;
    const gap = vertical ? gapV(it.a, it.b) : gapH(it.a, it.b);
    if (gap < 0 || gap >= CLOSE_PAIR_GAP) continue;
    const sa = sideSpan(it.a, it.sides.s), sb = sideSpan(it.b, it.sides.t);
    const lo = Math.max(sa.start + PORT_MARGIN, sb.start + PORT_MARGIN);
    const hi = Math.min(sa.start + sa.len - PORT_MARGIN, sb.start + sb.len - PORT_MARGIN);
    if (hi - lo < CLOSE_PAIR_OVERLAP - 2 * PORT_MARGIN) continue;
    closeAlong.set(it.g.id, half((lo + hi) / 2));
  }
  const shares = new Map<string, { s?: string; t?: string }>();
  if (PORT_SHARE.on) {
    const bucket = new Map<string, number>();
    const wing = (side: EdgeSide, self: NodeRect, other: NodeRect): string => {
      const c = center(self), o = center(other);
      return (isVerticalSide(side) ? o.x < c.x : o.y < c.y) ? "lo" : "hi";
    };
    const keyS = (it: typeof items[number]): string => `${it.g.source}|${it.sides.s}|out|${wing(it.sides.s, it.a, it.b)}`;
    const keyT = (it: typeof items[number]): string => `${it.g.target}|${it.sides.t}|in|${wing(it.sides.t, it.b, it.a)}`;
    const eligible = (it: typeof items[number]): boolean =>
      it.g.source !== it.g.target && !closeAlong.has(it.g.id) &&
      !(frameIds?.has(it.g.source) ?? false) && !(frameIds?.has(it.g.target) ?? false);
    for (const it of items) {
      if (!eligible(it)) continue;
      bucket.set(keyS(it), (bucket.get(keyS(it)) ?? 0) + 1);
      bucket.set(keyT(it), (bucket.get(keyT(it)) ?? 0) + 1);
    }
    const chosen = new Map<string, number>();
    const pick = new Map<string, "s" | "t">();
    for (const it of items) {
      if (!eligible(it)) continue;
      const ns = bucket.get(keyS(it)) ?? 0, nt = bucket.get(keyT(it)) ?? 0;
      const end: "s" | "t" | null = ns >= 2 && ns >= nt ? "s" : nt >= 2 ? "t" : null;
      if (!end) continue;
      const k = end === "s" ? keyS(it) : keyT(it);
      pick.set(it.g.id, end);
      chosen.set(k, (chosen.get(k) ?? 0) + 1);
    }
    for (const it of items) {
      const end = pick.get(it.g.id);
      if (!end) continue;
      const k = end === "s" ? keyS(it) : keyT(it);
      if ((chosen.get(k) ?? 0) >= 2) shares.set(it.g.id, end === "s" ? { s: k } : { t: k });
    }
  }
  for (const { g, a, b, sides } of items) {
    const pair: PortPair = {
      s: { side: sides.s, point: center(a) },
      t: { side: sides.t, point: center(b) },
    };
    ports.set(g.id, pair);
    const ca = center(a), cb = center(b);
    const alongOf = (side: EdgeSide, p: EdgePoint): number => (isVerticalSide(side) ? p.x : p.y);
    const k = keys?.get(g.id);
    const sh = shares.get(g.id);
    const fixedAlong = closeAlong.get(g.id);
    push(g.source, a, sides.s, { key: `${g.id}:s`, far: k?.s ?? alongOf(sides.s, cb), tie: `${g.id}:s`, share: sh?.s, fixedAlong, set: (p) => { pair.s.point = p; } });
    push(g.target, b, sides.t, { key: `${g.id}:t`, far: k?.t ?? alongOf(sides.t, ca), tie: `${g.id}:t`, share: sh?.t, fixedAlong, set: (p) => { pair.t.point = p; } });
  }

  // Слоты сторон: концы одного общего плеча — один слот (ключ — среднее ключей членов).
  interface Slot { far: number; tie: string; setters: Array<(p: EdgePoint) => void>; keys: Set<string> }
  const slotsBySide = new Map<string, Slot[]>();
  for (const [sideKey, rec] of bySide) {
    const slots: Slot[] = [];
    const slotByShare = new Map<string, Slot>();
    for (const e of rec.entries) {
      if (e.fixedAlong !== undefined) { e.set(pointOnSide(rec.rect, rec.side, e.fixedAlong)); continue; }
      if (e.share) {
        const sl = slotByShare.get(e.share);
        if (sl) { sl.far += e.far; sl.setters.push(e.set); sl.keys.add(e.key); if (e.tie < sl.tie) sl.tie = e.tie; continue; }
        const fresh: Slot = { far: e.far, tie: e.tie, setters: [e.set], keys: new Set([e.key]) };
        slotByShare.set(e.share, fresh); slots.push(fresh);
        continue;
      }
      slots.push({ far: e.far, tie: e.tie, setters: [e.set], keys: new Set([e.key]) });
    }
    for (const sl of slots) sl.far /= sl.setters.length;
    slotsBySide.set(sideKey, slots);
  }
  const cmpSlot = (p: Slot, q: Slot): number => p.far - q.far || (p.tie < q.tie ? -1 : p.tie > q.tie ? 1 : 0);
  // ВСТРЕЧНЫЕ ПАРЫ И СЛОТЫ: порядок концов пары вдоль стороны обязан совпадать на обоих
  // узлах (иначе крест неустраним). У одиночных портов это даёт равный ключ (zRoutes) и
  // тай-брейк по id; слот общего плеча несёт средний ключ группы и может развернуть
  // порядок — тогда менее весомая сторона (меньше концов в двух слотах) подстраивается:
  // слот второй связи встаёт вплотную к слоту первой с нужной стороны.
  if (PORT_SHARE.on) {
    const byPair = new Map<string, Array<typeof items[number]>>();
    for (const it of items) {
      if (it.g.source === it.g.target) continue;
      const k = it.g.source < it.g.target ? `${it.g.source}|${it.g.target}` : `${it.g.target}|${it.g.source}`;
      const arr = byPair.get(k);
      if (arr) arr.push(it); else byPair.set(k, [it]);
    }
    const slotOf = (sideKey: string, entryKey: string): Slot | undefined =>
      slotsBySide.get(sideKey)?.find((sl) => sl.keys.has(entryKey));
    for (const arr of byPair.values()) {
      if (arr.length !== 2 || arr[0].g.source !== arr[1].g.target) continue;
      const [e1, e2] = arr; // e1: A → B, e2: B → A
      if (e1.sides.s !== e2.sides.t || e1.sides.t !== e2.sides.s) continue;
      const A = e1.g.source, B = e1.g.target;
      const sA1 = slotOf(`${A}|${e1.sides.s}`, `${e1.g.id}:s`), sA2 = slotOf(`${A}|${e1.sides.s}`, `${e2.g.id}:t`);
      const sB1 = slotOf(`${B}|${e1.sides.t}`, `${e1.g.id}:t`), sB2 = slotOf(`${B}|${e1.sides.t}`, `${e2.g.id}:s`);
      if (!sA1 || !sA2 || !sB1 || !sB2 || sA1 === sA2 || sB1 === sB2) continue;
      const oA = Math.sign(cmpSlot(sA1, sA2)), oB = Math.sign(cmpSlot(sB1, sB2));
      if (oA === oB) continue;
      const EPS_FAR = 1e-3;
      const wA = sA1.setters.length + sA2.setters.length, wB = sB1.setters.length + sB2.setters.length;
      if (wA <= wB) sA2.far = sA1.far + (oB > 0 ? -EPS_FAR : EPS_FAR);
      else sB2.far = sB1.far + (oA > 0 ? -EPS_FAR : EPS_FAR);
    }
  }

  for (const [sideKey, rec] of bySide) {
    const { rect, side, frame } = rec;
    const slots = slotsBySide.get(sideKey) ?? [];
    slots.sort(cmpSlot);
    const { start, len } = sideSpan(rect, side);
    const margin = Math.min(PORT_MARGIN, len / 4);
    const lo = start + margin, hi = start + len - margin;
    const k = slots.length;
    let along: number[];
    if (frame) {
      // рамка: проекция дальнего конца на сторону, зажатая полями, затем разведение с
      // минимальным зазором; не влезло — равный шаг
      const desired = slots.map((e) => Math.min(hi, Math.max(lo, e.far)));
      along = spread1D(desired, FRAME_PORT_GAP);
      if (along.some((v) => v < lo - 0.5 || v > hi + 0.5)) {
        const step = (hi - lo) / (k + 1);
        along = slots.map((_, i) => lo + step * (i + 1));
      }
    } else {
      const step = (hi - lo) / (k + 1);
      along = slots.map((_, i) => lo + step * (i + 1));
    }
    slots.forEach((sl, i) => { const pt = pointOnSide(rect, side, half(along[i])); for (const set of sl.setters) set({ ...pt }); });
  }
  return { ports, axis, shares };
}
