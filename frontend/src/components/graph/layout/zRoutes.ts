// Z-МАРШРУТЫ С УПОРЯДОЧЕНИЕМ ДОРОЖЕК (Ф2 эпика «стрелки без жёстких хэндлов»,
// docs/plan-arrows-ports.md, правило R5 «своя дорожка»).
//
// Канонический маршрут связи — «Z», как у ELK layered (и, значит, у Mermaid): стаб из
// порта вдоль нормали стороны, ДОРОЖКА в канале между узлами (горизонтальная при оси
// потока «v», вертикальная при «h»), стаб в порт цели. Когда на пути лежат тела (ребро
// «через слой», ручная позиция), маршрут — «ZZ» из двух дорожек: канал у верхнего
// конца → свободная КОЛОННА между телами → канал у нижнего конца; это аналог фиктивных
// узлов ELK на длинных рёбрах. ВЫБОР ВАРИАНТА (Z по каждому свободному интервалу
// канала, ZZ по каждой свободной колонне) — покоординатный спуск по ИСТИННОЙ цене
// сцены: для каждой связи по очереди пробуются её варианты, дорожки всех каналов
// раздаются заново, считаются фактические кресты и наложения всех Z-маршрутов плюс
// крюки; вариант принимается, только если цена сцены строго падает (детерминизм и
// сходимость). Старт — Z в канале, ближнем к НИЖНЕМУ концу D: длинная вертикаль идёт
// прямо из порта U, излом у цели (так ложится эталон ELK; старт у U давал на корне
// RIGHT 2 креста против 0), иначе ZZ с минимальным крюком; три прохода, потолок проб;
// встречные пары ходят и парой (см. ниже). Прямые пар одной колонны входят в цену как
// маршруты: колонна ZZ сквозь прямую стоит креста.
//
// ДВЕ ОРИЕНТАЦИИ ДОРОЖЕК (заход 3). Колонна ZZ — такая же дорожка, только ПОПЕРЕЧНОГО
// канала: она лежит в свободном просвете между телами и раздаётся вместе с дорожками
// связей поперечной ориентации теми же правилами. Поэтому две ZZ через один просвет
// получают разные колонны в правильном порядке (вложенная встречная пара), а не одну и
// ту же середину просвета. Дорожки вдоль оси и колонны зависят друг от друга (пробег
// дорожки кончается на колонне, пробег колонны — на дорожках): раздача идёт двумя
// кругами по обеим ориентациям.
//
// ПОРЯДОК В КАНАЛЕ — калька с OrthogonalRoutingGenerator ELK: у каждой дорожки —
// примыкающие вертикали с направлением (вверх — к меньшим across, вниз — к большим);
// для пары перекрывающихся по пробегу дорожек считаются кресты в обоих порядках
// («i над j»: нисходящие вертикали i режут дорожку j, восходящие вертикали j режут
// дорожку i), почти слитые вертикали штрафуются как «конфликт» (CONFLICT_PENALTY ELK),
// из зависимостей собирается граф, циклы рвутся жадной эвристикой (Eades–Lin–Smyth),
// топологический номер даёт номер дорожки.
//
// РАЗДАЧА ПОЗИЦИЙ — проекционные прогоны по порядку номеров: желаемая позиция — равный
// шаг вокруг середины канала; ограничения — зазор между соседними по номеру дорожками с
// общим пробегом и собственная полоса каждой дорожки, суженная НЕПОДВИЖНЫМИ
// ПАРАЛЛЕЛЬНЫМИ ОТРЕЗКАМИ чужих связей (стабы и прямые поперечной ориентации): дорожка
// не ложится вплотную к стабу соседа. Прежний зажим стопки к границе полосы давал слитые
// дорожки и сброс связи в A*.
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
// по позициям фиктивных узлов в соседнем слое. Ключ получает и связь, уступившая A* по
// наложению: её порт всё равно должен стоять там, где прошла бы её дорожка. Ключи
// возвращаются вызывающему, тот пересчитывает порты и зовёт zRoutes второй раз.
//
// Чистый модуль: вход — группы, их порты (ports.ts) и препятствия; выход — маршруты,
// ключи портов и грид-подсказки. Детерминизм: все обходы — в порядке id.
import type { EdgePoint } from "../../../types";
import { cleanup, pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";
import type { PortPair } from "./ports";
import { NUDGE_GAP } from "./channelNudge";

const EPS = 0.5;
// Отладочный след выбора вариантов: полигон стрелок включает его флагом (в проде молчит).
export const __zDebug: { on: boolean; lines: string[]; trace: string } = { on: false, lines: [], trace: "" };
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
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

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

/** Направление вертикали, примыкающей к дорожке: "up" — уходит к меньшим across. */
type Dir = "up" | "down";
interface Vert { along: number; dir: Dir }

// Сегмент раздачи: дорожка связи (idx 0/1) либо колонна ZZ (idx 2) — та же дорожка, но
// поперечной ориентации. lane — across сегмента в его ориентации, lo..hi — пробег along.
interface Seg {
  edge: ZEdge;             // владелец (у ствола — первый член)
  members: ZEdge[];        // связи, делящие сегмент (ствол общего плеча — несколько)
  share?: string;          // id общего плеча, по которому сегменты сливаются в ствол
  orient: Orient;
  idx: number;
  verts: Vert[];
  lo: number;
  hi: number;
  bandLo: number;          // допустимая полоса across (с клиренсом); у колонн может быть ±∞
  bandHi: number;
  slot: number;            // номер дорожки в канале (0 — ближе к U)
  lane: number;
}

// Вариант маршрута связи: Z (одна дорожка в интервале band) либо ZZ (две дорожки и
// колонна между ними; x — стартовая колонна, colLo..colHi — её полоса).
interface Cand {
  kind: "z" | "zz";
  x: number;
  colLo: number;
  colHi: number;
  bands: Array<[number, number]>;  // интервалы across дорожек (1 у Z, 2 у ZZ)
  adjU: boolean;                   // крайняя верхняя дорожка — в канале, соседнем с U
  adjD: boolean;                   // крайняя нижняя дорожка — в канале, соседнем с D
  detour: number;                  // лишняя длина против прямого Z
  order: number;                   // ранг при равенстве: Z по близости к D, ZZ после
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
  x: number;               // колонна ZZ (along) — переменная раздачи; NaN у Z
  colLo: number;
  colHi: number;
  lanes: number[];         // across дорожек (1 у Z, 2 у ZZ) — переменные раздачи
  slots: number[];         // номера дорожек (разрешение наложений)
  adjU: boolean;           // см. Cand
  adjD: boolean;
  cand: Cand | null;
  cands: Cand[];
  exclude: NodeRect[];
  hard: ReadonlyArray<NodeRect>;
  uNode: string;           // узел конца U / D (ключи портов)
  dNode: string;
  shareU?: string;         // общее плечо на конце U / D (прототип, заход 4)
  shareD?: string;
  // РАЗРЕШАЮЩИЙ КЛЮЧ: у связи без единого Z (стаб в ряду порта упирается в тело) —
  // along конца, где другой порт той же стороны открыл бы Z; null — такого нет
  enable: { u?: number; d?: number } | null;
}

/** Прямая пары одной колонны: неподвижный отрезок для раздачи поперечных дорожек. */
interface Straight { orient: Orient; along: number; lo: number; hi: number }
/** Неподвижный отрезок, параллельный дорожкам канала (стаб или прямая чужой связи). */
interface Fixed { edge: ZEdge | null; pos: number; lo: number; hi: number }

/** Цена креста при выборе варианта дорожки — та же, что у A* (routeAll.DEFAULT_CROSS_COST). */
const CAND_CROSS_COST = 200;

// Применить вариант к связи: вид, колонна, стартовые дорожки (середины полос).
function applyCand(e: ZEdge, c: Cand): void {
  e.kind = c.kind;
  e.x = c.x;
  e.colLo = c.colLo;
  e.colHi = c.colHi;
  e.adjU = c.adjU;
  e.adjD = c.adjD;
  e.cand = c;
  e.lanes = c.bands.map(([a, b]) => half((a + b) / 2));
  e.slots = c.bands.map(() => 0);
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

// Интервал минус дыры (полоса колонны ZZ без зон собственных портовых рядов).
function subtractHoles(iv: [number, number], holes: Array<[number, number]>): Array<[number, number]> {
  let pieces: Array<[number, number]> = [iv];
  for (const [h0, h1] of holes) {
    const next: Array<[number, number]> = [];
    for (const [p0, p1] of pieces) {
      if (h1 <= p0 || h0 >= p1) { next.push([p0, p1]); continue; }
      if (h0 > p0) next.push([p0, h0]);
      if (h1 < p1) next.push([h1, p1]);
    }
    pieces = next;
  }
  return pieces.filter(([p0, p1]) => p1 >= p0 - EPS);
}

// ── упорядочение дорожек канала (калька OrthogonalRoutingGenerator ELK) ──────────

interface Dep { from: number; to: number; weight: number }

const within = (v: number, lo: number, hi: number): boolean => v >= lo - EPS && v <= hi + EPS;

// Кресты порядка «top над bot» (top ближе к U): нисходящие вертикали top режут дорожку
// bot на её пробеге, восходящие вертикали bot режут дорожку top.
function orderCrossings(top: Seg, bot: Seg): number {
  let n = 0;
  for (const v of top.verts) if (v.dir === "down" && within(v.along, bot.lo, bot.hi)) n++;
  for (const w of bot.verts) if (w.dir === "up" && within(w.along, top.lo, top.hi)) n++;
  return n;
}

// Конфликты порядка «top над bot»: нисходящая вертикаль top почти слита с восходящей bot.
function orderConflicts(top: Seg, bot: Seg): number {
  let n = 0;
  for (const v of top.verts) {
    if (v.dir !== "down") continue;
    for (const w of bot.verts) if (w.dir === "up" && Math.abs(v.along - w.along) < LANE_CONFLICT_TOL) n++;
  }
  return n;
}

/** Вес зависимости тай-брейка: меньше одного креста, но ненулевой — разрыв циклов её уважает. */
const TIE_WEIGHT = 0.5;

// ТАЙ-БРЕЙК ПО ПОРЯДКУ ПОРТОВ. Равенство крестов в обоих порядках — почти всегда
// развёрнутое вложение двух ZZ (встречная пара, веер): дорожки одной ещё стоят на
// серединах полос, и любой порядок колонн даёт один крест, любой порядок дорожек —
// другой. Правильное вложение повторяет порядок портов: наружная связь (чьи порты
// дальше по along) идёт наружной колонной и наружными дорожками. Для колонн это
// значит «меньшая середина портов — меньший across»; для дорожек — зависит от
// поворота: к +along наружная связь выше (меньший across), к −along — ниже.
// Прежде порядка портов — ЕСТЕСТВЕННОЕ ПОЛОЖЕНИЕ ПОЛОС: дорожки с разными (хоть и
// пересекающимися) полосами при равенстве крестов идут в порядке середин полос — иначе
// произвольный порядок требует от дорожки позиции вне её полосы, система ограничений
// несовместна, и зажим даёт кресты. Порядок портов — только для дорожек одного канала.
// >0 — a над b, <0 — b над a, 0 — предпочтения нет.
function tieBreak(a: Seg, b: Seg): number {
  const midOf = (s: Seg): number => (Number.isFinite(s.bandLo) && Number.isFinite(s.bandHi) ? (s.bandLo + s.bandHi) / 2 : s.lane);
  const da = midOf(a), db = midOf(b);
  if (Math.abs(da - db) > NUDGE_GAP) return da < db ? 1 : -1;
  const ma = (a.edge.uAlong + a.edge.dAlong) / 2, mb = (b.edge.uAlong + b.edge.dAlong) / 2;
  if (ma === mb) return 0;
  if (a.idx === 2 && b.idx === 2) return ma < mb ? 1 : -1;
  if (a.idx === 2 || b.idx === 2) return 0;
  const ta = Math.sign(a.verts[1].along - a.verts[0].along), tb = Math.sign(b.verts[1].along - b.verts[0].along);
  if (ta === 0 || ta !== tb) return 0;
  return (ta > 0) === (ma > mb) ? 1 : -1;
}

// Зависимости пары перекрывающихся дорожек: сколько крестов (и конфликтов с весом
// LANE_CONFLICT_PENALTY) даёт порядок «i над j» и наоборот.
function pairDeps(i: number, j: number, a: Seg, b: Seg): Dep[] {
  const dIJ = LANE_CONFLICT_PENALTY * orderConflicts(a, b) + orderCrossings(a, b);
  const dJI = LANE_CONFLICT_PENALTY * orderConflicts(b, a) + orderCrossings(b, a);
  if (dIJ < dJI) return [{ from: i, to: j, weight: dJI - dIJ }];
  if (dJI < dIJ) return [{ from: j, to: i, weight: dIJ - dJI }];
  const t = tieBreak(a, b);
  if (t > 0) return [{ from: i, to: j, weight: TIE_WEIGHT }];
  if (t < 0) return [{ from: j, to: i, weight: TIE_WEIGHT }];
  // порядок безразличен и для крестов, и для вложения, но дорожки обязаны быть разными:
  // пара нулевых зависимостей, одну из них снимет разрыв циклов
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

// Пересечение пробегов двух сегментов (отрицательное — зазор между ними).
const runOverlap = (a: { lo: number; hi: number }, b: { lo: number; hi: number }): number =>
  Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);

/**
 * Раздача позиций дорожек одного компонента: желаемые позиции — равный шаг вокруг
 * середины канала по номерам; ограничения — зазор между взаимодействующими дорожками в
 * порядке номеров и собственная полоса каждой. Неподвижные параллельные отрезки чужих
 * связей с общим пробегом СУЖАЮТ полосу дорожки с той стороны, где ей не хватает места
 * (при двух вариантах — где она не стоит по желаемой позиции). Решение — проекционные
 * прогоны: вперёд по номерам нижняя дорожка отодвигается от верхней, назад — верхняя от
 * нижней, пока всё не уляжется; при несовместной системе (канал не вмещает стопку даже с
 * шагом LANE_GAP_MIN) полоса остаётся твёрдой границей, а слившиеся дорожки отсеет
 * проверка наложений (уступят A*).
 */
function distribute(
  M: Seg[], slots: number[], interacts: (a: Seg, b: Seg) => boolean, fixed: ReadonlyArray<Fixed>,
): { lanes: number[]; gap: number } {
  const m = M.length;
  const K = Math.max(...slots) + 1;
  const cLo = Math.max(...M.map((s) => s.bandLo));
  const cHi = Math.min(...M.map((s) => s.bandHi));
  let gap = NUDGE_GAP;
  if (K > 1 && cLo <= cHi && (K - 1) * gap > cHi - cLo) gap = Math.max(LANE_GAP_MIN, (cHi - cLo) / (K - 1));
  // середина стопки: пересечение полос; при пустом или бесконечном пересечении — среднее
  // «естественных» мест (середина своей полосы, у колонны — стартовая колонна)
  let center: number;
  if (Number.isFinite(cLo) && Number.isFinite(cHi) && cLo <= cHi) center = (cLo + cHi) / 2;
  else {
    const natural = M.map((s) => {
      if (s.idx === 2) return s.edge.cand?.x ?? s.lane;
      return Number.isFinite(s.bandLo) && Number.isFinite(s.bandHi) ? (s.bandLo + s.bandHi) / 2 : s.lane;
    });
    center = natural.reduce((acc, v) => acc + v, 0) / m;
  }
  const lo = M.map((s) => s.bandLo), hi = M.map((s) => s.bandHi);
  const desired = M.map((_, i) => clamp(center + (slots[i] - (K - 1) / 2) * gap, lo[i], hi[i]));
  M.forEach((s, i) => {
    for (const f of fixed) {
      if (f.edge === s.edge || runOverlap(f, s) <= EPS) continue;
      const roomAbove = f.pos - lo[i], roomBelow = hi[i] - f.pos;
      const canAbove = roomAbove >= gap - EPS, canBelow = roomBelow >= gap - EPS;
      let above: boolean;
      if (canAbove && canBelow) above = desired[i] <= f.pos;
      else if (canAbove !== canBelow) above = canAbove;
      else above = roomAbove >= roomBelow;
      if (above) hi[i] = Math.min(hi[i], f.pos - gap); else lo[i] = Math.max(lo[i], f.pos + gap);
    }
  });
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (!interacts(M[i], M[j]) || slots[i] === slots[j]) continue;
      pairs.push(slots[i] < slots[j] ? [i, j] : [j, i]);
    }
  }
  pairs.sort((p, q) => slots[p[0]] - slots[q[0]] || slots[p[1]] - slots[q[1]]);
  // ОТСЕВ НЕВЫПОЛНИМЫХ ЦЕПОЧЕК: порядок номеров может через дорожку с широкой полосой
  // связать дорожки разных каналов и потребовать невозможного (нижняя дорожка верхнего
  // канала ниже верхней дорожки нижнего). Минимально достижимая позиция считается вперёд
  // по номерам; пара, которую полоса нижней дорожки не вмещает, отбрасывается — физически
  // такие дорожки и так в разных каналах. Остаток выполним, и прогоны ниже не качаются.
  const minPos = [...lo];
  const feasible: Array<[number, number]> = [];
  for (const [a, b] of pairs) {
    if (minPos[a] + gap > hi[b] + EPS) continue;
    minPos[b] = Math.max(minPos[b], minPos[a] + gap);
    feasible.push([a, b]);
  }
  const x = desired.map((d, i) => clamp(d, lo[i], hi[i]));
  for (let it = 0; it < 16; it++) {
    let changed = false;
    for (const [a, b] of feasible) {
      const need = x[a] + gap;
      if (x[b] < need - 1e-6) { x[b] = Math.min(need, hi[b]); changed = true; }
    }
    for (let k = feasible.length - 1; k >= 0; k--) {
      const [a, b] = feasible[k];
      const need = x[b] - gap;
      if (x[a] > need + 1e-6) { x[a] = Math.max(need, lo[a]); changed = true; }
    }
    if (!changed) break;
  }
  if (__zDebug.trace && M.some((sg) => sg.members.some((m) => m.id.startsWith(__zDebug.trace)))) {
    zlog("dist", `gap=${gap.toFixed(1)} center=${center.toFixed(1)} K=${K}`, M.map((sg, i) => `${sg.edge.id.slice(0, 8)}#${sg.idx} s${slots[i]} lo=${lo[i].toFixed(0)} hi=${hi[i].toFixed(0)} d=${desired[i].toFixed(0)} x=${x[i].toFixed(0)}`).join(" "), `pairs=${feasible.map(([a, b]) => `${a}>${b}`).join(",")}`);
  }
  return { lanes: x.map(half), gap };
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
  /** общие плеча концов (ports.ts, PORT_SHARE): id группы на конце s / t */
  shares?: ReadonlyMap<string, { s?: string; t?: string }>;
  obstacles: ReadonlyArray<NodeRect>;
  rectOf: (id: string) => NodeRect | undefined;
  hardOf?: (groupId: string) => ReadonlyArray<NodeRect>;
}): ZRoutesResult {
  const { groups, ports, shares, obstacles, rectOf, hardOf } = params;
  const routes = new Map<string, EdgePoint[]>();
  const portKeys = new Map<string, { s?: number; t?: number }>();
  const hintXs = new Set<number>(), hintYs = new Set<number>();
  const edges: ZEdge[] = [];
  const straights: Straight[] = [];

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
      x: NaN, colLo: NaN, colHi: NaN, lanes: [], slots: [], adjU: true, adjD: true,
      cand: null, cands: [], exclude, hard,
      uNode: sIsU ? g.source : g.target, dNode: sIsU ? g.target : g.source, enable: null,
      shareU: sIsU ? shares?.get(g.id)?.s : shares?.get(g.id)?.t,
      shareD: sIsU ? shares?.get(g.id)?.t : shares?.get(g.id)?.s,
    };
    // ПРЯМАЯ: порты в одной колонне — дорожка не нужна, достаточно чистого отрезка
    if (Math.abs(uAlong - dAlong) <= EPS) {
      const straight = [{ ...pp.s.point }, { ...pp.t.point }];
      if (!pathCrossesRects(straight, [...bodies, ...hard])) {
        routes.set(g.id, straight);
        straights.push({ orient: o, along: uAlong, lo: uAcross, hi: dAcross });
      }
      continue;
    }
    const cands: Cand[] = [];
    // СОСЕДСТВО дорожки с концом: между границей конца и дорожкой на её пробеге нет ряда
    // тел (иначе дорожка лежит за рядом узлов — «длинная» вертикаль сквозь соседний
    // канал). Тело считается лежащим между, если между границей и полосой — его
    // СЕРЕДИНА поперёк: сосед, выступающий в просвет краем на десяток пикселей, ряда не
    // образует (дорожка идёт мимо него, а не за ним).
    const adjacent = (fromAcross: number, toAcross: number, spanLo: number, spanHi: number): boolean => {
      const c0 = Math.min(fromAcross, toAcross), c1 = Math.max(fromAcross, toAcross);
      const blocks = (r: NodeRect): boolean => {
        const [a0, a1] = rectAlong(o, r);
        const [b0, b1] = rectAcross(o, r);
        const mid = (b0 + b1) / 2;
        return a0 < spanHi && a1 > spanLo && mid > c0 && mid < c1;
      };
      if (obstacles.some((r) => !exclude.some((e) => sameRect(e, r)) && blocks(r))) return false;
      return !hard.some(blocks);
    };
    const spanLo = Math.min(uAlong, dAlong), spanHi = Math.max(uAlong, dAlong);
    // ряды тел (across с клиренсом), чьи along-диапазоны задевают пробег [lo, hi]
    const bodyRows = (lo: number, hi: number): Array<[number, number]> => {
      const rows: Array<[number, number]> = [];
      const consider = (r: NodeRect, pad: number): void => {
        const [a0, a1] = rectAlong(o, r);
        if (a0 - pad >= hi || a1 + pad <= lo) return;
        const [c0, c1] = rectAcross(o, r);
        rows.push([c0 - pad, c1 + pad]);
      };
      for (const r of obstacles) if (!exclude.some((e) => sameRect(e, r))) consider(r, Z_CLEAR);
      for (const r of hard) consider(r, 0);
      return rows;
    };
    const intervals = laneIntervals(o, uAlong, dAlong, uAcross, dAcross, obstacles, exclude, hard);
    intervals.forEach((iv, k) => cands.push({
      kind: "z", x: NaN, colLo: NaN, colHi: NaN, bands: [iv],
      adjU: adjacent(uAcross, iv[0], spanLo, spanHi), adjD: adjacent(iv[1], dAcross, spanLo, spanHi),
      detour: 0, order: intervals.length - 1 - k,
    }));
    // ZZ по каждой свободной колонне между телами полосы (аналог фиктивного узла ELK).
    // Полоса колонны — просвет с клиренсом БЕЗ зон собственных портовых рядов (колонна
    // ближе клиренса к колонне порта — это Z с паразитной ступенькой); стартовая колонна —
    // середина между портами, зажатая в ближайший кусок полосы.
    const mid = (uAlong + dAlong) / 2;
    const holes: Array<[number, number]> = [[uAlong - Z_CLEAR, uAlong + Z_CLEAR], [dAlong - Z_CLEAR, dAlong + Z_CLEAR]];
    freeColumns(o, uAcross, dAcross, obstacles, exclude, hard).forEach(([a, b], k) => {
      const lo = a + Z_CLEAR, hi = b - Z_CLEAR;
      if (lo > hi + EPS) return;
      const pieces = subtractHoles([lo, hi], holes);
      if (pieces.length === 0) return;
      const pref = clamp(mid, lo, hi);
      let piece = pieces[0], bestDist = Infinity;
      for (const pc of pieces) {
        const d = pref < pc[0] ? pc[0] - pref : pref > pc[1] ? pref - pc[1] : 0;
        if (d < bestDist) { bestDist = d; piece = pc; }
      }
      const x = half(clamp(pref, piece[0], piece[1]));
      if (!Number.isFinite(x)) return;
      const i1 = laneIntervals(o, uAlong, x, uAcross, dAcross, obstacles, exclude, hard);
      const i2 = laneIntervals(o, x, dAlong, uAcross, dAcross, obstacles, exclude, hard);
      if (i1.length === 0 || i2.length === 0) return;
      // Дорожки ZZ лежат в РАЗНЫХ каналах: между ними ряд тел, который колонна обходит
      // (общий канал — дело Z). Когда колонна порта свободна, интервал одной дорожки
      // тянется через несколько каналов и накрывает интервал другой — тогда он режется
      // рядами тел на пробеге ДРУГОЙ дорожки (их колонна и обходит), и берётся кусок у
      // своего конца: так встречная пара получает вложенную ZZ рядом с ZZ близнеца.
      let b1 = i1[0], b2 = i2[i2.length - 1];   // ближние к U и к D
      if (b1[1] > b2[0] - LANE_GAP_MIN) {
        const p1 = subtractHoles(b1, bodyRows(Math.min(x, dAlong), Math.max(x, dAlong)));
        const p2 = subtractHoles(b2, bodyRows(Math.min(uAlong, x), Math.max(uAlong, x)));
        if (p1.length === 0 || p2.length === 0) return;
        b1 = p1[0]; b2 = p2[p2.length - 1];
        if (b1[1] > b2[0] - LANE_GAP_MIN) return;
      }
      const [b1Lo, b1Hi] = b1, [b2Lo, b2Hi] = b2;
      cands.push({
        kind: "zz", x, colLo: piece[0], colHi: piece[1], bands: [[b1Lo, b1Hi], [b2Lo, b2Hi]],
        adjU: adjacent(uAcross, b1Lo, Math.min(uAlong, x), Math.max(uAlong, x)),
        adjD: adjacent(b2Hi, dAcross, Math.min(x, dAlong), Math.max(x, dAlong)),
        detour: Math.abs(x - uAlong) + Math.abs(x - dAlong) - Math.abs(uAlong - dAlong),
        order: intervals.length + k,
      });
    });
    // РАЗРЕШАЮЩИЙ КЛЮЧ. Z нет вовсе, когда стаб в ряду текущего порта упирается в тело
    // соседней колонны (порт стоит напротив узла). Другой порт той же стороны мог бы
    // открыть Z: пробуем точки вдоль стороны конца и берём ближайшую к текущему порту,
    // при которой интервалы дорожки непусты, — она становится ключом порядка порта, и
    // следующий круг портов ставит связь напротив просвета. Сначала конец U, потом D.
    if (intervals.length === 0) {
      const probe = (end: "u" | "d"): number | undefined => {
        const r = rectOf(end === "u" ? edge.uNode : edge.dNode);
        if (!r) return undefined;
        const [a0, a1] = rectAlong(o, r);
        const lo = a0 + Z_CLEAR, hi = a1 - Z_CLEAR;
        const cur = end === "u" ? uAlong : dAlong;
        let best: number | undefined, bestDist = Infinity;
        for (let k = 0; k <= 8; k++) {
          const q = lo + ((hi - lo) * k) / 8;
          const ivs = end === "u"
            ? laneIntervals(o, q, dAlong, uAcross, dAcross, obstacles, exclude, hard)
            : laneIntervals(o, uAlong, q, uAcross, dAcross, obstacles, exclude, hard);
          if (ivs.length === 0) continue;
          const d = Math.abs(q - cur);
          if (d < bestDist) { bestDist = d; best = q; }
        }
        return best;
      };
      const u = probe("u");
      const d = u === undefined ? probe("d") : undefined;
      if (u !== undefined || d !== undefined) edge.enable = { ...(u !== undefined ? { u } : {}), ...(d !== undefined ? { d } : {}) };
    }
    if (cands.length === 0) {
      // ни Z, ни ZZ — связь уйдёт в A*, но разрешающий ключ может открыть Z в следующем круге
      if (edge.enable) {
        const key: { s?: number; t?: number } = {};
        if (edge.enable.u !== undefined) key[sIsU ? "s" : "t"] = edge.enable.u;
        if (edge.enable.d !== undefined) key[sIsU ? "t" : "s"] = edge.enable.d;
        portKeys.set(g.id, key);
      }
      continue;
    }
    edge.cands = cands;
    edges.push(edge);
    zlog(g.id.slice(0, 8), "cands", cands.map((c) => `${c.kind}${c.bands.map((b) => `[${b[0].toFixed(0)}..${b[1].toFixed(0)}]`).join("")}${c.kind === "zz" ? `x${c.x}(${c.colLo.toFixed(0)}..${c.colHi.toFixed(0)})` : ""}`).join(" "));
  }

  // ── сегменты раздачи по ориентациям ─────────────────────────────────────────────
  // Ориентации o принадлежат дорожки o-связей и колонны ZZ связей поперечной ориентации.
  // Ключ общего плеча у дорожки: дорожка в канале, соседнем с общим концом, — часть
  // ствола (Z — единственная дорожка, у ZZ — ближняя к концу).
  const shareKeyOf = (e: ZEdge, idx: number): string | undefined => {
    if (e.kind === "z") return (e.adjU && e.shareU) || (e.adjD && e.shareD) || undefined;
    if (idx === 0) return e.adjU ? e.shareU : undefined;
    return e.adjD ? e.shareD : undefined;
  };
  const segsOf = (o: Orient): Seg[] => {
    const out: Seg[] = [];
    for (const e of edges) {
      const c = e.cand;
      if (!c) continue;
      if (e.orient === o) {
        if (e.kind === "z") {
          out.push({
            edge: e, members: [e], share: shareKeyOf(e, 0), orient: o, idx: 0,
            verts: [{ along: e.uAlong, dir: "up" }, { along: e.dAlong, dir: "down" }],
            lo: Math.min(e.uAlong, e.dAlong), hi: Math.max(e.uAlong, e.dAlong),
            bandLo: c.bands[0][0], bandHi: c.bands[0][1], slot: e.slots[0], lane: e.lanes[0],
          });
        } else {
          out.push({
            edge: e, members: [e], share: shareKeyOf(e, 0), orient: o, idx: 0,
            verts: [{ along: e.uAlong, dir: "up" }, { along: e.x, dir: "down" }],
            lo: Math.min(e.uAlong, e.x), hi: Math.max(e.uAlong, e.x),
            bandLo: c.bands[0][0], bandHi: c.bands[0][1], slot: e.slots[0], lane: e.lanes[0],
          });
          out.push({
            edge: e, members: [e], share: shareKeyOf(e, 1), orient: o, idx: 1,
            verts: [{ along: e.x, dir: "up" }, { along: e.dAlong, dir: "down" }],
            lo: Math.min(e.x, e.dAlong), hi: Math.max(e.x, e.dAlong),
            bandLo: c.bands[1][0], bandHi: c.bands[1][1], slot: e.slots[1], lane: e.lanes[1],
          });
        }
      } else if (e.kind === "zz") {
        // колонна ZZ в поперечной ориентации: across — сама колонна, пробег — между
        // дорожками; вертикали на концах уходят к портовым рядам (вверх, если ряд выше)
        const l0 = e.lanes[0], l1 = e.lanes[1];
        out.push({
          edge: e, members: [e], orient: o, idx: 2,
          verts: [{ along: l0, dir: e.uAlong < e.x ? "up" : "down" }, { along: l1, dir: e.dAlong < e.x ? "up" : "down" }],
          lo: Math.min(l0, l1), hi: Math.max(l0, l1), bandLo: e.colLo, bandHi: e.colHi, slot: 0, lane: e.x,
        });
      }
    }
    return mergeShared(out);
  };
  // СТВОЛЫ: сегменты одного общего плеча с пересекающимися полосами сливаются в один
  // (вертикали — объединение, пробег — охват, полоса — пересечение); несовместимые по
  // полосе члены образуют второй ствол ниже по стволу первого. Части запоминаются, чтобы
  // вернуть дорожку каждому члену.
  const partsOf = new Map<Seg, Seg[]>();
  const mergeShared = (S: Seg[]): Seg[] => {
    const out: Seg[] = [];
    const byShare = new Map<string, Seg[]>();
    for (const sg of S) {
      if (!sg.share) { out.push(sg); continue; }
      const arr = byShare.get(sg.share);
      if (arr) arr.push(sg); else byShare.set(sg.share, [sg]);
    }
    for (const arr of byShare.values()) {
      if (arr.length === 1) { out.push(arr[0]); continue; }
      arr.sort((p, q) => (p.bandLo + p.bandHi) - (q.bandLo + q.bandHi) || (p.edge.id < q.edge.id ? -1 : 1));
      const runs: Array<{ seg: Seg; parts: Seg[] }> = [];
      for (const sg of arr) {
        const last = runs.length > 0 ? runs[runs.length - 1] : null;
        if (last && Math.min(last.seg.bandHi, sg.bandHi) - Math.max(last.seg.bandLo, sg.bandLo) >= -EPS) {
          const c0 = last.seg;
          last.seg = {
            ...c0, members: [...c0.members, ...sg.members], verts: [...c0.verts, ...sg.verts],
            lo: Math.min(c0.lo, sg.lo), hi: Math.max(c0.hi, sg.hi),
            bandLo: Math.max(c0.bandLo, sg.bandLo), bandHi: Math.min(c0.bandHi, sg.bandHi),
            lane: (c0.lane * last.parts.length + sg.lane) / (last.parts.length + 1),
          };
          last.parts.push(sg);
          continue;
        }
        runs.push({ seg: { ...sg }, parts: [sg] });
      }
      for (const r of runs) {
        if (r.parts.length > 1) partsOf.set(r.seg, r.parts);
        out.push(r.seg);
      }
    }
    return out;
  };
  // Неподвижные отрезки, параллельные дорожкам ориентации o: стабы и прямые связей
  // поперечной ориентации (их along — across для o).
  const fixedOf = (o: Orient): Fixed[] => {
    const out: Fixed[] = [];
    for (const e of edges) {
      if (e.orient === o || !e.cand) continue;
      const first = e.lanes[0], last = e.lanes[e.lanes.length - 1];
      out.push({ edge: e, pos: e.uAlong, lo: Math.min(e.uAcross, first), hi: Math.max(e.uAcross, first) });
      out.push({ edge: e, pos: e.dAlong, lo: Math.min(last, e.dAcross), hi: Math.max(last, e.dAcross) });
    }
    for (const s of straights) if (s.orient !== o) out.push({ edge: null, pos: s.along, lo: Math.min(s.lo, s.hi), hi: Math.max(s.lo, s.hi) });
    return out;
  };
  const interacts = (a: Seg, b: Seg): boolean =>
    !a.members.some((m) => b.members.includes(m)) &&
    runOverlap(a, b) > -NUDGE_GAP &&
    Math.min(a.bandHi, b.bandHi) - Math.max(a.bandLo, b.bandLo) >= -EPS;

  // Раздача дорожек одной ориентации: компоненты по перекрытию пробега (с зазором) и
  // полос, внутри — зависимости, разрыв циклов, топологические номера, позиции через
  // решатель. hints — собирать ли свободные дорожки (финальный вызов).
  const assign = (o: Orient, hints: boolean): void => {
    const S = segsOf(o);
    const n = S.length;
    if (n === 0) return;
    const F = fixedOf(o);
    const parent = S.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
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
      const { lanes, gap } = distribute(M, slots, interacts, F);
      M.forEach((s, i) => {
        s.slot = slots[i];
        s.lane = lanes[i];
        for (const part of partsOf.get(s) ?? [s]) {
          if (part.idx === 2) part.edge.x = s.lane;
          else { part.edge.lanes[part.idx] = s.lane; part.edge.slots[part.idx] = s.slot; }
        }
      });
      if ((hints || (__zDebug.trace && M.some((s) => s.edge.id.startsWith(__zDebug.trace)))) && m > 1) zlog("comp", o, M.map((s) => `${s.edge.id.slice(0, 8)}#${s.idx}[${s.bandLo.toFixed(0)}..${s.bandHi.toFixed(0)}|${s.lo.toFixed(0)}..${s.hi.toFixed(0)}]s${s.slot}@${s.lane}`).join(" "));
      if (!hints) continue;
      // свободные дорожки по обе стороны стопки — подсказки A* связям без Z
      let lo = 0, hi = 0;
      M.forEach((s, i) => { if (s.lane < M[lo].lane) lo = i; if (s.lane > M[hi].lane) hi = i; });
      const below = M[lo].lane - gap, above = M[hi].lane + gap;
      const sink = o === "v" ? hintYs : hintXs;
      if (below >= M[lo].bandLo - EPS) sink.add(half(below));
      if (above <= M[hi].bandHi + EPS) sink.add(half(above));
    }
  };
  // Обе ориентации кругами до сходимости (дорожки и колонны зависят друг от друга:
  // первый круг может упорядочить колонны по дорожкам-серединам, и только следующий
  // круг дорожек увидит настоящие колонны); первой — ориентация большинства связей.
  // Потолок кругов — защита от качелей; на сценах полигона сходится за 2–3.
  const nV = edges.filter((e) => e.orient === "v").length;
  const order: Orient[] = nV >= edges.length - nV ? ["v", "h"] : ["h", "v"];
  const MAX_ROUNDS = 4;
  const snapshot = (): number[] => edges.flatMap((e) => [...e.lanes, e.x]);
  const assignLanes = (hints: boolean): void => {
    let prev = snapshot();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS - 1;
      for (const o of order) assign(o, hints && last);
      const cur = snapshot();
      const same = cur.length === prev.length && cur.every((v, i) => v === prev[i] || (Number.isNaN(v) && Number.isNaN(prev[i])));
      if (same) {
        // сошлось: подсказки собираются отдельным проходом, если их ещё не собирали
        if (hints && !last) for (const o of order) assign(o, true);
        break;
      }
      prev = cur;
    }
  };

  // Ломаная связи по текущим дорожкам (source → target); null — ZZ сложился (нижняя
  // дорожка не ниже верхней) либо маршрут режет тело / чужую рамку.
  const buildRoute = (e: ZEdge): EdgePoint[] | null => {
    const o = e.orient;
    if (e.kind === "zz" && e.lanes[1] <= e.lanes[0] + EPS) return null;
    const ud: EdgePoint[] = e.kind === "z"
      ? [mk(o, e.uAlong, e.uAcross), mk(o, e.uAlong, e.lanes[0]), mk(o, e.dAlong, e.lanes[0]), mk(o, e.dAlong, e.dAcross)]
      : [
        mk(o, e.uAlong, e.uAcross), mk(o, e.uAlong, e.lanes[0]), mk(o, e.x, e.lanes[0]),
        mk(o, e.x, e.lanes[1]), mk(o, e.dAlong, e.lanes[1]), mk(o, e.dAlong, e.dAcross),
      ];
    const pts = cleanup(e.sIsU ? ud : [...ud].reverse());
    const bodies = obstacles.filter((r) => !e.exclude.some((x) => sameRect(x, r)));
    if (pathCrossesRects(pts, [...bodies, ...e.hard])) return null;
    return pts;
  };

  // ВСТРЕЧНЫЕ ПАРЫ (две связи между теми же узлами одной ориентации): в цене их взаимный
  // крест стоит вдвое (пара, режущая сама себя, читается как ошибка — у ELK её не бывает),
  // а в спуске они ходят и ПАРОЙ: близнецу подбирается «тот же» вариант (Z — с общей
  // полосой, ZZ — с общим просветом колонны). Поодиночке вложенная пара недостижима:
  // первый шаг (одна связь в обход, вторая на месте) дороже исходного, и спуск его не
  // делает.
  const twinOf = new Map<ZEdge, ZEdge>();
  {
    const byPairKey = new Map<string, ZEdge[]>();
    for (const e of edges) {
      const k = e.uNode < e.dNode ? `${e.uNode}|${e.dNode}` : `${e.dNode}|${e.uNode}`;
      const arr = byPairKey.get(k);
      if (arr) arr.push(e); else byPairKey.set(k, [e]);
    }
    for (const arr of byPairKey.values()) {
      if (arr.length === 2 && arr[0].orient === arr[1].orient) { twinOf.set(arr[0], arr[1]); twinOf.set(arr[1], arr[0]); }
    }
  }
  const TWIN_CROSS_FACTOR = 2;
  // члены одного общего плеча законно делят стаб и ствол — их наложение не считается
  const sharesEnd = (a: ZEdge, b: ZEdge): boolean =>
    (a.shareU !== undefined && a.shareU === b.shareU) || (a.shareD !== undefined && a.shareD === b.shareD);

  // Истинная цена сцены по текущему выбору: кресты и наложения между всеми Z-маршрутами,
  // невозможные маршруты (как несколько крестов — они уйдут в A*), крюки ZZ.
  const INVALID_COST = 3 * CAND_CROSS_COST;
  const OVERLAP_COST_Z = 2 * CAND_CROSS_COST;
  const costParts = { cr: 0, ov: 0, inv: 0, det: 0, ovPairs: [] as string[] };
  // прямые пар одной колонны — тоже маршруты сцены: колонна ZZ, режущая прямую, стоит
  // креста, иначе ZZ сквозь прямую «бесплатна» и побеждает чистый Z
  const straightPts: EdgePoint[][] = [];
  for (const [id, pts] of routes) if (pts.length === 2 && straights.length > 0 && groups.some((g) => g.id === id)) straightPts.push(pts);
  const sceneCost = (): number => {
    assignLanes(false);
    const built: EdgePoint[][] = [...straightPts];
    const builtIds: string[] = straightPts.map(() => "straight");
    const builtEdges: Array<ZEdge | null> = straightPts.map(() => null);
    let cost = 0;
    costParts.cr = 0; costParts.ov = 0; costParts.inv = 0; costParts.det = 0; costParts.ovPairs = [];
    for (const e of edges) {
      const pts = buildRoute(e);
      if (pts) { built.push(pts); builtIds.push(e.id.slice(0, 8)); builtEdges.push(e); } else { cost += INVALID_COST; costParts.inv++; }
      if (e.kind === "zz") {
        const d = Math.abs(e.x - e.uAlong) + Math.abs(e.x - e.dAlong) - Math.abs(e.uAlong - e.dAlong);
        cost += d; costParts.det += d;
      }
    }
    for (let i = 0; i < built.length; i++) {
      for (let j = i + 1; j < built.length; j++) {
        const c = crossings(built[i], built[j]);
        const ei = builtEdges[i], ej = builtEdges[j];
        const twins = ei !== null && ej !== null && twinOf.get(ei) === ej;
        cost += c * CAND_CROSS_COST * (twins ? TWIN_CROSS_FACTOR : 1); costParts.cr += c;
        if (!(ei !== null && ej !== null && sharesEnd(ei, ej)) && overlapping(built[i], built[j])) {
          cost += OVERLAP_COST_Z; costParts.ov++;
          if (__zDebug.on) costParts.ovPairs.push(`${builtIds[i]}~${builtIds[j]}`);
        }
      }
    }
    return cost;
  };

  // ── выбор варианта: старт без соседей, затем покоординатный спуск по цене сцены ──
  for (const e of edges) {
    const start = [...e.cands].sort((a, b) => a.detour - b.detour || a.order - b.order)[0];
    applyCand(e, start);
  }
  const overlap1 = (a: [number, number], b: [number, number]): number => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  const matchCand = (t: ZEdge, c: Cand): Cand | undefined => {
    let best: Cand | undefined, bestOv = -Infinity;
    for (const tc of t.cands) {
      if (tc.kind !== c.kind) continue;
      const ov = c.kind === "zz" ? overlap1([tc.colLo, tc.colHi], [c.colLo, c.colHi]) : overlap1(tc.bands[0], c.bands[0]);
      if (ov > bestOv) { bestOv = ov; best = tc; }
    }
    return bestOv > -EPS ? best : undefined;
  };
  const movable = edges.filter((e) => e.cands.length > 1);
  if (movable.length > 0) {
    let best = sceneCost();
    let evals = 0;
    const MAX_EVALS = 400;
    for (let pass = 0; pass < 3 && evals < MAX_EVALS; pass++) {
      let improved = false;
      for (const e of movable) {
        const current = e.cand;
        const twin = twinOf.get(e);
        let moved = false;
        for (const c of e.cands) {
          if (c === current || evals >= MAX_EVALS) continue;
          // сначала парный ход (если близнец есть и у него есть парный вариант), потом одиночный
          const twinCand = twin ? matchCand(twin, c) : undefined;
          const twinCurrent = twin?.cand ?? null;
          const steps: Array<Cand | undefined> = twinCand && twinCand !== twinCurrent ? [twinCand, undefined] : [undefined];
          for (const tc of steps) {
            if (evals >= MAX_EVALS) break;
            applyCand(e, c);
            if (twin && tc) applyCand(twin, tc);
            evals++;
            const cost = sceneCost();
            zlog(e.id.slice(0, 8), "try", c.kind, c.bands.map((b) => `${b[0].toFixed(0)}..${b[1].toFixed(0)}`).join("/"), Number.isFinite(c.x) ? `x=${c.x}` : "", tc ? "+twin" : "", `cost=${cost.toFixed(0)}`, `best=${best.toFixed(0)}`, `cr=${costParts.cr} ov=${costParts.ov} inv=${costParts.inv} det=${costParts.det.toFixed(0)}`, costParts.ovPairs.join(","));
            if (cost < best - EPS) { best = cost; improved = true; moved = true; break; }
            if (current) applyCand(e, current);
            if (twin && tc && twinCurrent) applyCand(twin, twinCurrent);
          }
          if (moved) break;
        }
      }
      if (!improved) break;
    }
  }
  assignLanes(true);
  for (const e of edges) {
    const c = e.cand;
    zlog(e.id.slice(0, 8), "→", e.kind, c ? c.bands.map((b, i) => `${b[0].toFixed(0)}..${b[1].toFixed(0)}@${e.lanes[i]}`).join("/") : "", Number.isFinite(e.x) ? `x=${e.x}` : "");
  }

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
  const slotOf = (e: ZEdge): number => Math.max(...e.slots);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = built.get(ids[i]), B = built.get(ids[j]);
      if (!A || !B || dropped.has(ids[i]) || dropped.has(ids[j])) continue;
      if (sharesEnd(A.edge, B.edge) || !overlapping(A.pts, B.pts)) continue;
      const sa = slotOf(A.edge), sb = slotOf(B.edge);
      const loser = sa > sb || (sa === sb && ids[i] > ids[j]) ? ids[i] : ids[j];
      zlog(loser.slice(0, 8), "DROP overlap with", (loser === ids[i] ? ids[j] : ids[i]).slice(0, 8));
      dropped.add(loser);
    }
  }
  for (const id of ids) {
    const b = built.get(id);
    if (!b) continue;
    if (!dropped.has(id)) routes.set(id, b.pts);
    // КЛЮЧИ ПОРЯДКА ПОРТОВ (доводка E85) — аналог позиции фиктивного узла ELK в соседнем
    // слое: у ZZ конец, чья дорожка в соседнем канале, сортируется по колонне X (туда
    // уходит дорожка); конец без соседней дорожки (вертикаль идёт сквозь соседний канал
    // прямо из порта) — по текущему along порта: вертикаль проходит соседний канал именно
    // там, и ключ закрепляет порт, пока маршрут чист (центр узла давал ничьи между
    // длинными связями одного узла, и порядок решал id). Связь без Z отдаёт разрешающий
    // ключ. Ключ есть и у связи, уступившей A* по наложению: её порт стоит там, где легла
    // бы её дорожка.
    const e = b.edge;
    const key: { s?: number; t?: number } = {};
    const uKey = e.sIsU ? "s" : "t", dKey = e.sIsU ? "t" : "s";
    if (e.kind === "zz") {
      key[uKey] = e.adjU ? e.x : e.uAlong;
      key[dKey] = e.adjD ? e.x : e.dAlong;
    } else {
      if (!e.adjU) key[uKey] = e.uAlong;
      if (!e.adjD) key[dKey] = e.dAlong;
    }
    if (e.enable) {
      if (e.enable.u !== undefined) key[uKey] = e.enable.u;
      if (e.enable.d !== undefined) key[dKey] = e.enable.d;
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
