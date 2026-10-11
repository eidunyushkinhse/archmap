// Z-МАРШРУТЫ С УПОРЯДОЧЕНИЕМ ДОРОЖЕК (Ф2 эпика «стрелки без жёстких хэндлов»,
// docs/plan-arrows-ports.md, правило R5 «своя дорожка»).
//
// Канонический маршрут связи — «Z», как у ELK layered (и, значит, у Mermaid): стаб из
// порта вдоль нормали стороны, ДОРОЖКА в канале между узлами (горизонтальная при оси
// потока «v», вертикальная при «h»), стаб в порт цели. Когда на пути лежат тела (ребро
// «через слой», ручная позиция), маршрут — «ZZ» из двух дорожек: канал у верхнего
// конца → свободная колонна между телами → канал у нижнего конца; это аналог фиктивных
// узлов ELK на длинных рёбрах. ВЫБОР ВАРИАНТА (Z по каждому свободному интервалу
// канала, ZZ по каждой свободной колонне) — покоординатный спуск по ИСТИННОЙ цене
// сцены: для каждой связи по очереди пробуются её варианты, дорожки всех каналов
// упорядочиваются заново, считаются фактические кресты и наложения всех Z-маршрутов
// плюс крюки; вариант принимается, только если цена сцены строго падает (детерминизм и
// сходимость). Старт — Z в канале, ближнем к верхнему концу (ELK гнёт длинное ребро в
// первом же канале), иначе ZZ с минимальным крюком; два прохода, потолок проб.
//
// Дорожки одного канала упорядочиваются по зависимостям «кто над кем» с подсчётом
// пересечений — калька с OrthogonalRoutingGenerator ELK: для каждой пары
// перекрывающихся по пробегу дорожек считаются кресты в обоих порядках (спуск одной
// режет дорожку другой, подъём другой — дорожку первой), почти слитые вертикали двух
// дорожек штрафуются как «конфликт» (CONFLICT_PENALTY ELK), из зависимостей собирается
// граф, циклы рвутся жадной эвристикой (Eades–Lin–Smyth), топологический номер даёт
// номер дорожки, дорожки раздаются равным шагом вокруг середины канала.
//
// Z — ТОЛЬКО ТАМ, ГДЕ ОН ЧИСТ. Дорожки и стабы не режут тела (клиренс Z_CLEAR) и
// границы чужих раскрытых рамок; канал обязан вместить свои дорожки (шаг сжимается до
// LANE_GAP_MIN, не ниже). Связь без чистого Z/ZZ уступает A* (routeAll) — тот видит
// готовые Z как предпроложенный контекст и получает подсказками свободные дорожки
// канала рядом со стопкой.
//
// ПОРЯДОК ПОРТОВ (доводка E85): связь, чья дорожка у этого конца НЕ в соседнем канале
// (длинный Z: вертикаль идёт сквозь промежуточные каналы; ZZ: подход из колонны X),
// получает ключ порядка не «центр дальнего узла», а место своей вертикали в соседнем
// канале (X у ZZ, собственный центр узла у длинного Z) — так ELK упорядочивает порты
// по позициям фиктивных узлов в соседнем слое. Ключи возвращаются вызывающему, тот
// пересчитывает порты и зовёт zRoutes второй раз.
//
// Чистый модуль: вход — группы, их порты (ports.ts) и препятствия; выход — маршруты,
// ключи портов и грид-подсказки. Детерминизм: все обходы — в порядке id.
import type { EdgePoint } from "../../../types";
import { cleanup, pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";
import type { PortPair } from "./ports";
import { NUDGE_GAP } from "./channelNudge";

const EPS = 0.5;
// Отладочный след выбора вариантов: полигон стрелок включает его флагом (в проде молчит).
export const __zDebug: { on: boolean; lines: string[] } = { on: false, lines: [] };
const zlog = (...args: unknown[]): void => { if (__zDebug.on) __zDebug.lines.push(args.map(String).join(" ")); };

// Константы контракта маршрутов (реестр ROUTER_VERSION).
/** Клиренс дорожки и стабов Z от тел узлов и плашек, px (= DEFAULT_MARGIN роутера). */
export const Z_CLEAR = 12;
/** Дно сжатия шага дорожек в тесном канале, px (= дно лестницы канала, E29). */
export const LANE_GAP_MIN = 8;
/** «Конфликт» (ELK): вертикали двух соседних дорожек ближе этого — почти слиты, px. */
export const LANE_CONFLICT_TOL = 4;
/** Вес конфликта против одного креста при выборе порядка дорожек (ELK CONFLICT_PENALTY). */
export const LANE_CONFLICT_PENALTY = 16;

/** Ориентация дорожки: "v" — ось потока вертикальная (дорожка горизонтальна), "h" — наоборот. */
type Orient = "v" | "h";

// Координаты «поперёк» (across — вдоль оси потока, по ней лежат дорожки) и «вдоль»
// (along — вдоль дорожки). Для "v": across = y, along = x.
const acrossOf = (o: Orient, p: EdgePoint): number => (o === "v" ? p.y : p.x);
const alongOf = (o: Orient, p: EdgePoint): number => (o === "v" ? p.x : p.y);
const mk = (o: Orient, along: number, across: number): EdgePoint =>
  (o === "v" ? { x: along, y: across } : { x: across, y: along });
const rectAcross = (o: Orient, r: NodeRect): [number, number] =>
  (o === "v" ? [r.y, r.y + r.h] : [r.x, r.x + r.w]);
const rectAlong = (o: Orient, r: NodeRect): [number, number] =>
  (o === "v" ? [r.x, r.x + r.w] : [r.y, r.y + r.h]);
const half = (v: number): number => Math.round(v * 2) / 2;

// Ориентация пары сторон: противоположные стороны одной оси. Сторона, чья внешняя
// нормаль смотрит в +across (bottom / right), — «верхний» конец U: от него маршрут идёт
// в +across к дорожке. Остальные сочетания (петля, одноимённые стороны) — не Z.
function orientOf(s: EdgeSide, t: EdgeSide): { orient: Orient; sIsU: boolean } | null {
  if (s === "bottom" && t === "top") return { orient: "v", sIsU: true };
  if (s === "top" && t === "bottom") return { orient: "v", sIsU: false };
  if (s === "right" && t === "left") return { orient: "h", sIsU: true };
  if (s === "left" && t === "right") return { orient: "h", sIsU: false };
  return null;
}

// Дорожка (сегмент канала): у Z одна, у ZZ две. uAlong — along вертикали, приходящей
// сверху (из +across-стороны), dAlong — вертикали, уходящей вниз.
interface Seg {
  edge: ZEdge;
  uAlong: number;
  dAlong: number;
  lo: number;              // пробег дорожки вдоль along
  hi: number;
  bandLo: number;          // допустимый интервал across дорожки (с клиренсом)
  bandHi: number;
  slot: number;            // номер дорожки в канале (0 — ближе к U)
  lane: number;            // across дорожки
}

// Вариант маршрута связи: Z (одна дорожка в интервале band) либо ZZ (две дорожки и
// колонна x между ними).
interface Cand {
  kind: "z" | "zz";
  x: number;                       // колонна ZZ (along); NaN у Z
  bands: Array<[number, number]>;  // интервалы across дорожек (1 у Z, 2 у ZZ)
  adjU: boolean;                   // крайняя верхняя дорожка — в канале, соседнем с U
  adjD: boolean;                   // крайняя нижняя дорожка — в канале, соседнем с D
  detour: number;                  // лишняя длина против прямого Z
  order: number;                   // ранг при равенстве: Z по близости к U, ZZ после
}

interface ZEdge {
  id: string;
  orient: Orient;
  sIsU: boolean;
  kind: "z" | "zz";
  uAlong: number;
  dAlong: number;
  uAcross: number;
  dAcross: number;
  x: number;               // колонна ZZ (along), у Z не используется
  adjU: boolean;           // см. Cand
  adjD: boolean;
  segs: Seg[];
  cands: Cand[];
  exclude: NodeRect[];
  hard: ReadonlyArray<NodeRect>;
}

/** Цена креста при выборе варианта дорожки — та же, что у A* (routeAll.DEFAULT_CROSS_COST). */
const CAND_CROSS_COST = 200;

// Применить вариант к связи: вид, колонна, сегменты.
function applyCand(e: ZEdge, c: Cand): void {
  e.kind = c.kind;
  e.x = c.x;
  e.adjU = c.adjU;
  e.adjD = c.adjD;
  if (c.kind === "z") {
    e.segs = [{
      edge: e, uAlong: e.uAlong, dAlong: e.dAlong, lo: Math.min(e.uAlong, e.dAlong), hi: Math.max(e.uAlong, e.dAlong),
      bandLo: c.bands[0][0], bandHi: c.bands[0][1], slot: 0, lane: 0,
    }];
  } else {
    e.segs = [
      { edge: e, uAlong: e.uAlong, dAlong: c.x, lo: Math.min(e.uAlong, c.x), hi: Math.max(e.uAlong, c.x), bandLo: c.bands[0][0], bandHi: c.bands[0][1], slot: 0, lane: 0 },
      { edge: e, uAlong: c.x, dAlong: e.dAlong, lo: Math.min(c.x, e.dAlong), hi: Math.max(c.x, e.dAlong), bandLo: c.bands[1][0], bandHi: c.bands[1][1], slot: 0, lane: 0 },
    ];
  }
}

const sameRect = (a: NodeRect, b: NodeRect): boolean =>
  a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/**
 * Допустимые интервалы across для дорожки между вертикалями в колоннах uAlong (сверху,
 * от uAcross) и dAlong (снизу, до dAcross): от uAcross + клиренс до dAcross − клиренс,
 * минус тела в колонне U (ниже неё), в колонне D (выше неё) и тела, которые резала бы
 * сама дорожка на своём пробеге. Тела концов исключены (стыковка с ними легальна по
 * построению), остальные раздуты на клиренс; `hard` — границы чужих рамок, через них Z
 * не ходит (без раздутия — это мягкая граница, не тело).
 */
function laneIntervals(
  o: Orient, uAlong: number, dAlong: number, uAcross: number, dAcross: number,
  obstacles: ReadonlyArray<NodeRect>, exclude: ReadonlyArray<NodeRect>, hard: ReadonlyArray<NodeRect>,
): Array<[number, number]> {
  let lo = uAcross + Z_CLEAR, hi = dAcross - Z_CLEAR;
  if (lo > hi + EPS) return [];
  const spanLo = Math.min(uAlong, dAlong), spanHi = Math.max(uAlong, dAlong);
  const forbidden: Array<[number, number]> = [];
  const consider = (r: NodeRect, pad: number): void => {
    const [a0, a1] = rectAlong(o, r);
    const [c0, c1] = rectAcross(o, r);
    const aLo = a0 - pad, aHi = a1 + pad, cLo = c0 - pad, cHi = c1 + pad;
    // колонна U: тело, лежащее ниже границы U, ограничивает дорожку сверху
    if (aLo < uAlong && uAlong < aHi && cHi > uAcross + EPS) hi = Math.min(hi, cLo);
    // колонна D: тело выше границы D ограничивает дорожку снизу
    if (aLo < dAlong && dAlong < aHi && cLo < dAcross - EPS) lo = Math.max(lo, cHi);
    // пробег дорожки: тело на пути запрещает полосу своих across
    if (aLo < spanHi && aHi > spanLo) forbidden.push([cLo, cHi]);
  };
  for (const r of obstacles) {
    if (exclude.some((e) => sameRect(e, r))) continue;
    consider(r, Z_CLEAR);
  }
  for (const r of hard) consider(r, 0);
  if (lo > hi + EPS) return [];
  forbidden.sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  let cur = lo;
  for (const [f0, f1] of forbidden) {
    if (f1 <= cur) continue;
    if (f0 > hi) break;
    if (f0 > cur + EPS) out.push([cur, Math.min(f0, hi)]);
    cur = Math.max(cur, f1);
    if (cur > hi) break;
  }
  if (cur <= hi + EPS) out.push([cur, hi]);
  return out.filter(([a, b]) => b >= a - EPS);
}

// Свободные колонны между телами, лежащими в across-полосе (uAcross, dAcross): дополнение
// объединения их along-диапазонов (раздутых на клиренс). Крайние интервалы открыты.
function freeColumns(
  o: Orient, uAcross: number, dAcross: number,
  obstacles: ReadonlyArray<NodeRect>, exclude: ReadonlyArray<NodeRect>, hard: ReadonlyArray<NodeRect>,
): Array<[number, number]> {
  const busy: Array<[number, number]> = [];
  const add = (r: NodeRect, pad: number): void => {
    const [c0, c1] = rectAcross(o, r);
    if (c1 + pad <= uAcross + EPS || c0 - pad >= dAcross - EPS) return; // вне полосы
    const [a0, a1] = rectAlong(o, r);
    busy.push([a0 - pad, a1 + pad]);
  };
  for (const r of obstacles) if (!exclude.some((e) => sameRect(e, r))) add(r, Z_CLEAR);
  for (const r of hard) add(r, 0);
  busy.sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  let cur = -Infinity;
  for (const [b0, b1] of busy) {
    if (b0 > cur + EPS) out.push([cur, b0]);
    cur = Math.max(cur, b1);
  }
  out.push([cur, Infinity]);
  return out;
}

// ── упорядочение дорожек канала (калька OrthogonalRoutingGenerator ELK) ──────────

interface Dep { from: number; to: number; weight: number }

const within = (v: number, lo: number, hi: number): boolean => v >= lo - EPS && v <= hi + EPS;

// Зависимости пары перекрывающихся дорожек: сколько крестов даёт порядок «i над j»
// (спуск i к D_i режет дорожку j, подъём j от U_j режет дорожку i) и наоборот; почти
// слитые вертикали (D_i ≈ U_j при «i над j») — конфликт с весом LANE_CONFLICT_PENALTY.
function pairDeps(i: number, j: number, a: Seg, b: Seg): Dep[] {
  const cIJ = (within(a.dAlong, b.lo, b.hi) ? 1 : 0) + (within(b.uAlong, a.lo, a.hi) ? 1 : 0);
  const cJI = (within(b.dAlong, a.lo, a.hi) ? 1 : 0) + (within(a.uAlong, b.lo, b.hi) ? 1 : 0);
  const confIJ = Math.abs(a.dAlong - b.uAlong) < LANE_CONFLICT_TOL ? 1 : 0;
  const confJI = Math.abs(b.dAlong - a.uAlong) < LANE_CONFLICT_TOL ? 1 : 0;
  const dIJ = LANE_CONFLICT_PENALTY * confIJ + cIJ;
  const dJI = LANE_CONFLICT_PENALTY * confJI + cJI;
  if (dIJ < dJI) return [{ from: i, to: j, weight: dJI - dIJ }];
  if (dJI < dIJ) return [{ from: j, to: i, weight: dIJ - dJI }];
  // порядок безразличен для крестов, но дорожки обязаны быть разными: пара нулевых
  // зависимостей, одну из них снимет разрыв циклов
  return [{ from: i, to: j, weight: 0 }, { from: j, to: i, weight: 0 }];
}

// Жадный разрыв циклов (Eades–Lin–Smyth): стоки — в хвост порядка, истоки — в голову,
// при тупике — вершина с максимальным (out − in). Зависимости против порядка:
// ненулевые разворачиваются, нулевые снимаются. Детерминизм — обход по индексам
// (сегменты заранее отсортированы по id).
function breakCycles(n: number, deps: Dep[]): Dep[] {
  const inW = new Array<number>(n).fill(0), outW = new Array<number>(n).fill(0);
  for (const d of deps) { outW[d.from] += d.weight; inW[d.to] += d.weight; }
  const alive = new Array<boolean>(n).fill(true);
  const left: number[] = [], right: number[] = [];
  let remaining = n;
  const remove = (k: number): void => {
    alive[k] = false; remaining--;
    for (const d of deps) {
      if (d.from === k && alive[d.to]) inW[d.to] -= d.weight;
      if (d.to === k && alive[d.from]) outW[d.from] -= d.weight;
    }
  };
  while (remaining > 0) {
    let moved = true;
    while (moved) {
      moved = false;
      for (let k = 0; k < n; k++) {
        if (alive[k] && outW[k] === 0) { right.push(k); remove(k); moved = true; }
      }
      for (let k = 0; k < n; k++) {
        if (alive[k] && inW[k] === 0) { left.push(k); remove(k); moved = true; }
      }
    }
    if (remaining === 0) break;
    let best = -1, bestFlow = -Infinity;
    for (let k = 0; k < n; k++) {
      if (!alive[k]) continue;
      const flow = outW[k] - inW[k];
      if (flow > bestFlow) { bestFlow = flow; best = k; }
    }
    left.push(best); remove(best);
  }
  const pos = new Array<number>(n);
  [...left, ...right.reverse()].forEach((k, idx) => { pos[k] = idx; });
  const out: Dep[] = [];
  for (const d of deps) {
    if (pos[d.from] < pos[d.to]) out.push(d);
    else if (d.weight > 0) out.push({ from: d.to, to: d.from, weight: d.weight });
  }
  return out;
}

// Топологическая нумерация: номер дорожки = длина самого длинного пути зависимостей.
function slotsOf(n: number, dag: Dep[]): number[] {
  const slot = new Array<number>(n).fill(0);
  const indeg = new Array<number>(n).fill(0);
  for (const d of dag) indeg[d.to]++;
  const queue: number[] = [];
  for (let k = 0; k < n; k++) if (indeg[k] === 0) queue.push(k);
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    for (const d of dag) {
      if (d.from !== k) continue;
      slot[d.to] = Math.max(slot[d.to], slot[k] + 1);
      if (--indeg[d.to] === 0) queue.push(d.to);
    }
  }
  return slot;
}

export interface ZRoutesResult {
  /** groupId → Z/ZZ-маршрут (source → target, со стабами) либо прямая. */
  routes: Map<string, EdgePoint[]>;
  /**
   * Ключи порядка портов (доводка E85): along-координата, по которой конец связи
   * сортируется на своей стороне вместо центра дальнего узла. Есть только у концов,
   * чья дорожка не в соседнем канале (ZZ: колонна X; длинный Z: собственный центр).
   */
  portKeys: Map<string, { s?: number; t?: number }>;
  /** Свободные дорожки у стопок каналов — грид-подсказки A* для связей без Z. */
  gridHints: { xs: number[]; ys: number[] };
}

/**
 * Z-маршруты для связей с портами на противоположных сторонах одной оси.
 * obstacles — тела узлов и плашки рамок (жёсткие препятствия с клиренсом);
 * rectOf — тело стыковки конца (исключается из препятствий своей связи);
 * hardOf — границы ЧУЖИХ рамок связи (сквозь них Z не ходит).
 */
export function zRoutes(params: {
  groups: ReadonlyArray<{ id: string; source: string; target: string }>;
  ports: ReadonlyMap<string, PortPair>;
  obstacles: ReadonlyArray<NodeRect>;
  rectOf: (id: string) => NodeRect | undefined;
  hardOf?: (groupId: string) => ReadonlyArray<NodeRect>;
}): ZRoutesResult {
  const { groups, ports, obstacles, rectOf, hardOf } = params;
  const routes = new Map<string, EdgePoint[]>();
  const portKeys = new Map<string, { s?: number; t?: number }>();
  const hintXs = new Set<number>(), hintYs = new Set<number>();
  const edges: ZEdge[] = [];

  const sorted = [...groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const g of sorted) {
    const pp = ports.get(g.id);
    if (!pp || g.source === g.target) continue;
    const ori = orientOf(pp.s.side, pp.t.side);
    if (!ori) continue;
    const { orient: o, sIsU } = ori;
    const U = sIsU ? pp.s.point : pp.t.point;
    const D = sIsU ? pp.t.point : pp.s.point;
    const uAlong = alongOf(o, U), dAlong = alongOf(o, D);
    const uAcross = acrossOf(o, U), dAcross = acrossOf(o, D);
    if (dAcross - uAcross < 2 * Z_CLEAR - EPS) continue; // узлы вплотную/перекрыты — не Z
    const exclude = [rectOf(g.source), rectOf(g.target)].filter((r): r is NodeRect => !!r);
    const hard = hardOf?.(g.id) ?? [];
    const bodies = obstacles.filter((r) => !exclude.some((e) => sameRect(e, r)));
    const edge: ZEdge = {
      id: g.id, orient: o, sIsU, kind: "z", uAlong, dAlong, uAcross, dAcross,
      x: NaN, adjU: true, adjD: true, segs: [], cands: [], exclude, hard,
    };
    // ПРЯМАЯ: порты в одной колонне — дорожка не нужна, достаточно чистого отрезка
    if (Math.abs(uAlong - dAlong) <= EPS) {
      const straight = [{ ...pp.s.point }, { ...pp.t.point }];
      if (!pathCrossesRects(straight, [...bodies, ...hard])) routes.set(g.id, straight);
      continue;
    }
    const cands: Cand[] = [];
    // СОСЕДСТВО дорожки с концом: между границей конца и дорожкой на её пробеге нет тел
    // (иначе дорожка лежит за рядом узлов — «длинная» вертикаль сквозь соседний канал)
    const adjacent = (fromAcross: number, toAcross: number, spanLo: number, spanHi: number): boolean => {
      const c0 = Math.min(fromAcross, toAcross), c1 = Math.max(fromAcross, toAcross);
      const blocks = (r: NodeRect): boolean => {
        const [a0, a1] = rectAlong(o, r);
        const [b0, b1] = rectAcross(o, r);
        return a0 < spanHi && a1 > spanLo && b0 < c1 && b1 > c0;
      };
      if (obstacles.some((r) => !exclude.some((e) => sameRect(e, r)) && blocks(r))) return false;
      return !hard.some(blocks);
    };
    const spanLo = Math.min(uAlong, dAlong), spanHi = Math.max(uAlong, dAlong);
    const intervals = laneIntervals(o, uAlong, dAlong, uAcross, dAcross, obstacles, exclude, hard);
    intervals.forEach((iv, k) => cands.push({
      kind: "z", x: NaN, bands: [iv],
      adjU: adjacent(uAcross, iv[0], spanLo, spanHi), adjD: adjacent(iv[1], dAcross, spanLo, spanHi),
      detour: 0, order: k,
    }));
    // ZZ по каждой свободной колонне между телами полосы (аналог фиктивного узла ELK)
    const mid = (uAlong + dAlong) / 2;
    // колонна не ближе клиренса к колоннам портов (иначе это Z с паразитной ступенькой)
    const cols = freeColumns(o, uAcross, dAcross, obstacles, exclude, hard)
      .map(([a, b]) => Math.min(Math.max(mid, a + Z_CLEAR), b - Z_CLEAR))
      .filter((x) => Number.isFinite(x) && Math.abs(x - uAlong) >= Z_CLEAR && Math.abs(x - dAlong) >= Z_CLEAR);
    cols.forEach((xRaw, k) => {
      const x = half(xRaw);
      const i1 = laneIntervals(o, uAlong, x, uAcross, dAcross, obstacles, exclude, hard);
      const i2 = laneIntervals(o, x, dAlong, uAcross, dAcross, obstacles, exclude, hard);
      if (i1.length === 0 || i2.length === 0) return;
      const [b1Lo, b1Hi] = i1[0];               // ближний к U
      const [b2Lo, b2Hi] = i2[i2.length - 1];   // ближний к D
      // дорожки ZZ лежат в РАЗНЫХ каналах (между ними ряд тел); общий канал — дело Z
      if (b1Hi > b2Lo - LANE_GAP_MIN) return;
      cands.push({
        kind: "zz", x, bands: [[b1Lo, b1Hi], [b2Lo, b2Hi]],
        adjU: adjacent(uAcross, b1Lo, Math.min(uAlong, x), Math.max(uAlong, x)),
        adjD: adjacent(b2Hi, dAcross, Math.min(x, dAlong), Math.max(x, dAlong)),
        detour: Math.abs(x - uAlong) + Math.abs(x - dAlong) - Math.abs(uAlong - dAlong),
        order: intervals.length + k,
      });
    });
    if (cands.length === 0) continue;
    edge.cands = cands;
    edges.push(edge);
  }

  // ── упорядочение дорожек каналов (по текущему выбору вариантов) ─────────────────
  // Компоненты — по перекрытию пробега (с зазором) и интервалов across; внутри —
  // зависимости, разрыв циклов, топологические номера, раздача дорожек равным шагом
  // вокруг середины канала. hints — собирать ли свободные дорожки (финальный вызов).
  const assignLanes = (hints: boolean): void => {
    const all: Seg[] = [];
    for (const e of edges) all.push(...e.segs);
    for (const o of ["v", "h"] as const) {
      const S = all.filter((s) => s.edge.orient === o);
      const n = S.length;
      if (n === 0) continue;
      const parent = S.map((_, k) => k);
      const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
      const interacts = (a: Seg, b: Seg): boolean =>
        a.edge !== b.edge &&
        Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > -NUDGE_GAP &&
        Math.min(a.bandHi, b.bandHi) - Math.max(a.bandLo, b.bandLo) >= -EPS;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) if (interacts(S[i], S[j])) parent[find(i)] = find(j);
      }
      const comps = new Map<number, number[]>();
      for (let k = 0; k < n; k++) {
        const r = find(k);
        const arr = comps.get(r);
        if (arr) arr.push(k); else comps.set(r, [k]);
      }
      for (const members of comps.values()) {
        const M = members.map((k) => S[k]);
        const m = M.length;
        const deps: Dep[] = [];
        for (let i = 0; i < m; i++) {
          for (let j = i + 1; j < m; j++) if (interacts(M[i], M[j])) deps.push(...pairDeps(i, j, M[i], M[j]));
        }
        const slots = slotsOf(m, breakCycles(m, deps));
        const K = Math.max(...slots) + 1;
        // полоса канала — пересечение интервалов членов; пустое пересечение (цепочка
        // перекрытий с уходящими интервалами) — середина между крайними, дорожки зажмёт
        // собственный интервал, а наложения отсеет проверка ниже
        const cLo = Math.max(...M.map((s) => s.bandLo));
        const cHi = Math.min(...M.map((s) => s.bandHi));
        const center = (cLo + cHi) / 2;
        let gap = NUDGE_GAP;
        if (K > 1 && (K - 1) * gap > cHi - cLo) gap = Math.max(LANE_GAP_MIN, (cHi - cLo) / (K - 1));
        M.forEach((s, i) => {
          s.slot = slots[i];
          const raw = center + (slots[i] - (K - 1) / 2) * gap;
          s.lane = half(Math.min(Math.max(raw, s.bandLo), s.bandHi));
        });
        if (!hints) continue;
        // свободные дорожки по обе стороны стопки — подсказки A* связям без Z
        for (const side of [-1, 1]) {
          const free = center + side * ((K - 1) / 2 + 1) * gap;
          if (free >= cLo - EPS && free <= cHi + EPS) (o === "v" ? hintYs : hintXs).add(half(free));
        }
      }
    }
  };

  // Ломаная связи по текущим дорожкам (source → target); null — ZZ сложился (нижняя
  // дорожка не ниже верхней) либо маршрут режет тело / чужую рамку.
  const buildRoute = (e: ZEdge): EdgePoint[] | null => {
    const o = e.orient;
    if (e.kind === "zz" && e.segs[1].lane <= e.segs[0].lane + EPS) return null;
    const ud: EdgePoint[] = e.kind === "z"
      ? [mk(o, e.uAlong, e.uAcross), mk(o, e.uAlong, e.segs[0].lane), mk(o, e.dAlong, e.segs[0].lane), mk(o, e.dAlong, e.dAcross)]
      : [
        mk(o, e.uAlong, e.uAcross), mk(o, e.uAlong, e.segs[0].lane), mk(o, e.x, e.segs[0].lane),
        mk(o, e.x, e.segs[1].lane), mk(o, e.dAlong, e.segs[1].lane), mk(o, e.dAlong, e.dAcross),
      ];
    const pts = cleanup(e.sIsU ? ud : [...ud].reverse());
    const bodies = obstacles.filter((r) => !e.exclude.some((x) => sameRect(x, r)));
    if (pathCrossesRects(pts, [...bodies, ...e.hard])) return null;
    return pts;
  };

  // Истинная цена сцены по текущему выбору: кресты и наложения между всеми Z-маршрутами,
  // невозможные маршруты (как несколько крестов — они уйдут в A*), крюки ZZ.
  const INVALID_COST = 3 * CAND_CROSS_COST;
  const OVERLAP_COST_Z = 2 * CAND_CROSS_COST;
  const sceneCost = (): number => {
    assignLanes(false);
    const built: EdgePoint[][] = [];
    let cost = 0;
    for (const e of edges) {
      const pts = buildRoute(e);
      if (pts) built.push(pts); else cost += INVALID_COST;
      if (e.kind === "zz") cost += Math.abs(e.x - e.uAlong) + Math.abs(e.x - e.dAlong) - Math.abs(e.uAlong - e.dAlong);
    }
    for (let i = 0; i < built.length; i++) {
      for (let j = i + 1; j < built.length; j++) {
        cost += crossings(built[i], built[j]) * CAND_CROSS_COST;
        if (overlapping(built[i], built[j])) cost += OVERLAP_COST_Z;
      }
    }
    return cost;
  };

  // ── выбор варианта: старт без соседей, затем покоординатный спуск по цене сцены ──
  for (const e of edges) {
    const start = [...e.cands].sort((a, b) => a.detour - b.detour || a.order - b.order)[0];
    applyCand(e, start);
  }
  const movable = edges.filter((e) => e.cands.length > 1);
  if (movable.length > 0) {
    let best = sceneCost();
    let evals = 0;
    const MAX_EVALS = 400;
    for (let pass = 0; pass < 2 && evals < MAX_EVALS; pass++) {
      let improved = false;
      for (const e of movable) {
        const current = e.cands.find((c) => c.kind === e.kind && c.bands[0][0] === e.segs[0].bandLo && (c.kind === "z" || c.x === e.x));
        for (const c of e.cands) {
          if (c === current || evals >= MAX_EVALS) continue;
          applyCand(e, c);
          evals++;
          const cost = sceneCost();
          zlog(e.id.slice(0, 8), "try", c.kind, c.bands.map((b) => `${b[0].toFixed(0)}..${b[1].toFixed(0)}`).join("/"), Number.isFinite(c.x) ? `x=${c.x}` : "", `cost=${cost.toFixed(0)}`, `best=${best.toFixed(0)}`);
          if (cost < best - EPS) { best = cost; improved = true; break; }
          if (current) applyCand(e, current);
        }
      }
      if (!improved) break;
    }
  }
  assignLanes(true);
  for (const e of edges) zlog(e.id.slice(0, 8), "→", e.kind, e.segs.map((s) => `${s.bandLo.toFixed(0)}..${s.bandHi.toFixed(0)}@${s.lane}`).join("/"), Number.isFinite(e.x) ? `x=${e.x}` : "");

  // ── сборка и проверка: тела, чужие рамки, взаимные наложения ───────────────────
  const built = new Map<string, { edge: ZEdge; pts: EdgePoint[] }>();
  for (const e of edges) {
    const pts = buildRoute(e);
    if (!pts) { zlog(e.id.slice(0, 8), "DROP body/hard/collapsed"); continue; }
    built.set(e.id, { edge: e, pts });
  }
  // наложение двух маршрутов: дорожки ближе LANE_GAP_MIN с общим пробегом либо слитые
  // стабы в одной колонне — проигрывает дорожка с большим номером (потом id), она уходит
  // в A*
  const ids = [...built.keys()].sort();
  const dropped = new Set<string>();
  const slotOf = (e: ZEdge): number => Math.max(...e.segs.map((s) => s.slot));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = built.get(ids[i]), B = built.get(ids[j]);
      if (!A || !B || dropped.has(ids[i]) || dropped.has(ids[j])) continue;
      if (!overlapping(A.pts, B.pts)) continue;
      const sa = slotOf(A.edge), sb = slotOf(B.edge);
      const loser = sa > sb || (sa === sb && ids[i] > ids[j]) ? ids[i] : ids[j];
      zlog(loser.slice(0, 8), "DROP overlap with", (loser === ids[i] ? ids[j] : ids[i]).slice(0, 8));
      dropped.add(loser);
    }
  }
  for (const id of ids) {
    if (dropped.has(id)) continue;
    const b = built.get(id);
    if (!b) continue;
    routes.set(id, b.pts);
    // ключи порядка портов (доводка E85): у ZZ конец, чья дорожка в соседнем канале,
    // сортируется по колонне X (туда уходит дорожка); конец без соседней дорожки
    // (длинная вертикаль сквозь соседний канал) — по центру своего узла
    const e = b.edge;
    const key: { s?: number; t?: number } = {};
    const uKey = e.sIsU ? "s" : "t", dKey = e.sIsU ? "t" : "s";
    const g = groups.find((x) => x.id === id);
    const centerOf = (nodeId: string | undefined): number | undefined => {
      const r = nodeId ? rectOf(nodeId) : undefined;
      if (!r) return undefined;
      const [a0, a1] = rectAlong(e.orient, r);
      return (a0 + a1) / 2;
    };
    const uNode = g ? (e.sIsU ? g.source : g.target) : undefined;
    const dNode = g ? (e.sIsU ? g.target : g.source) : undefined;
    if (e.kind === "zz") {
      key[uKey] = e.adjU ? e.x : centerOf(uNode);
      key[dKey] = e.adjD ? e.x : centerOf(dNode);
    } else {
      if (!e.adjU) key[uKey] = centerOf(uNode);
      if (!e.adjD) key[dKey] = centerOf(dNode);
    }
    if (key.s === undefined) delete key.s;
    if (key.t === undefined) delete key.t;
    if (key.s !== undefined || key.t !== undefined) portKeys.set(id, key);
  }
  // ВСТРЕЧНЫЕ ПАРЫ (две связи между теми же узлами): ключ одного конца распространяется
  // на близнеца у того же узла — иначе порядок пары на двух сторонах разъедется и даст
  // неустранимый крест (нулевой он только при одинаковом порядке на обоих концах).
  const byPair = new Map<string, Array<{ id: string; source: string; target: string }>>();
  for (const g of groups) {
    const k = g.source < g.target ? `${g.source}|${g.target}` : `${g.target}|${g.source}`;
    const arr = byPair.get(k);
    if (arr) arr.push(g); else byPair.set(k, [g]);
  }
  for (const twins of byPair.values()) {
    if (twins.length < 2) continue;
    const keyAt = new Map<string, number>();
    for (const g of [...twins].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const k = portKeys.get(g.id);
      if (!k) continue;
      if (k.s !== undefined && !keyAt.has(g.source)) keyAt.set(g.source, k.s);
      if (k.t !== undefined && !keyAt.has(g.target)) keyAt.set(g.target, k.t);
    }
    if (keyAt.size === 0) continue;
    for (const g of twins) {
      const k = { ...(portKeys.get(g.id) ?? {}) };
      const ks = keyAt.get(g.source), kt = keyAt.get(g.target);
      if (ks !== undefined) k.s = ks;
      if (kt !== undefined) k.t = kt;
      portKeys.set(g.id, k);
    }
  }
  const asc = (p: number, q: number): number => p - q;
  return { routes, portKeys, gridHints: { xs: [...hintXs].sort(asc), ys: [...hintYs].sort(asc) } };
}

// Кресты двух ортогональных ломаных: перпендикулярные сегменты, пересечение строго
// внутри обоих (та же семантика, что у метрик качества E23).
function crossings(a: EdgePoint[], b: EdgePoint[]): number {
  let n = 0;
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], a1 = a[i];
    const ah = Math.abs(a1.y - a0.y) <= EPS;
    for (let j = 1; j < b.length; j++) {
      const b0 = b[j - 1], b1 = b[j];
      const bh = Math.abs(b1.y - b0.y) <= EPS;
      if (ah === bh) continue;
      const h0 = ah ? a0 : b0, h1 = ah ? a1 : b1, v0 = ah ? b0 : a0, v1 = ah ? b1 : a1;
      const hx0 = Math.min(h0.x, h1.x), hx1 = Math.max(h0.x, h1.x);
      const vy0 = Math.min(v0.y, v1.y), vy1 = Math.max(v0.y, v1.y);
      if (hx0 + EPS < v0.x && v0.x < hx1 - EPS && vy0 + EPS < h0.y && h0.y < vy1 - EPS) n++;
    }
  }
  return n;
}

// Коллинеарное наложение двух ломаных: сегменты одной ориентации ближе LANE_GAP_MIN
// с совместным пробегом больше EPS (касание концами — не наложение). Пара СТАБОВ
// (крайние сегменты) меряется строгим EPS: соседние порты одной стороны легально
// стоят теснее зазора дорожек, а совпасть точно они не могут (порты уникальны).
function overlapping(a: EdgePoint[], b: EdgePoint[]): boolean {
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], a1 = a[i];
    const ah = Math.abs(a1.y - a0.y) <= EPS;
    const aStub = i === 1 || i === a.length - 1;
    for (let j = 1; j < b.length; j++) {
      const b0 = b[j - 1], b1 = b[j];
      const bh = Math.abs(b1.y - b0.y) <= EPS;
      if (ah !== bh) continue;
      const bStub = j === 1 || j === b.length - 1;
      const ca = ah ? a0.y : a0.x, cb = ah ? b0.y : b0.x;
      if (Math.abs(ca - cb) >= (aStub && bStub ? EPS : LANE_GAP_MIN)) continue;
      const lo = Math.max(Math.min(ah ? a0.x : a0.y, ah ? a1.x : a1.y), Math.min(ah ? b0.x : b0.y, ah ? b1.x : b1.y));
      const hi = Math.min(Math.max(ah ? a0.x : a0.y, ah ? a1.x : a1.y), Math.max(ah ? b0.x : b0.y, ah ? b1.x : b1.y));
      if (hi - lo > EPS) return true;
    }
  }
  return false;
}
