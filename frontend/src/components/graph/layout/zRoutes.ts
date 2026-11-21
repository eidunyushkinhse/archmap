// Z-МАРШРУТЫ С УПОРЯДОЧЕНИЕМ ДОРОЖЕК (Ф2 эпика «стрелки без жёстких хэндлов»,
// docs/archive/plan-arrows-ports.md, правило R5 «своя дорожка»).
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
import type { Size } from "./labelBox";
import { NUDGE_GAP } from "./channelNudge";
import { diag } from "./diag";

const EPS = 0.5;
// Отладочный след выбора вариантов: полигон стрелок включает его флагом (в проде молчит).
export const __zDebug: { on: boolean; lines: string[]; trace: string } = { on: false, lines: [], trace: "" };
// Вызовы с дорогими аргументами (map/join/toFixed) стоят под `if (__zDebug.on)`: аргументы
// вычисляются до входа в zlog, и выключенный след иначе платил бы за них на каждой пробе.
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
/** Запас вокруг плашки подписи на отрезке-носителе (Ф3): с каждой стороны поперёк и вдоль, px. */
export const LABEL_PAD = 4;
/** Цена связи с подписью без носителя (Ф3): половина креста — носитель важнее крюка, но не креста. */
/** Носители подписей (Ф3) — выключатели для полигона (ARCHMAP_LABELS=0 → поведение Ф2). */
export const LABEL_HOSTS = { on: true, lostCost: 100 };
/**
 * Предел смещения дорожки/колонны ради плашки, px (Ф3): если место с толщиной под свою
 * плашку или с обходом чужих слотов дальше от желаемого, чем место без них, больше чем на
 * столько, — толщина снимается (слоты игнорируются): крюк в полсотни пикселей и кресты
 * за ним стоят дороже подписи впритык (цена потери носителя — полкреста).
 */
export const LABEL_SHIFT_TOL = 50;

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
  thick: number;           // толщина поперёк под плашку подписи (Ф3): 0 — сегмент без подписи
  preShrunk?: boolean;     // полоса уже сужена под толщину (колонна: от тел просвета, не от зон портов)
  parts?: Seg[];           // у ствола из нескольких сегментов — его части (им раздача возвращает дорожку)
}

/**
 * НОСИТЕЛЬ ПОДПИСИ (Ф3, калька слоя подписей ELK): плашка лежит на отрезке ВДОЛЬ оси
 * потока — стабе у конца D (как inline-подпись ELK перед целью), стабе у конца U,
 * колонне ZZ (как подпись на длинном ребре в промежуточном слое) — и лишь в крайнем
 * случае на дорожке канала (поперёк потока, где её ширина ложится на соседние дорожки).
 * Носитель получает СЛОТ: полосу поперёк потока в ширину плашки с запасом, из которой
 * раздача выталкивает чужие дорожки (стаб соседа не проходит сквозь плашку), и толщину
 * в раздаче поперечной ориентации (колонны и стабы соседей держат от плашки запас).
 */
type Host = "dstub" | "ustub" | "column" | "lane0" | "lane1" | "none";

// Вариант маршрута связи: Z (одна дорожка в интервале band) либо ZZ (две дорожки и
// колонна между ними; x — стартовая колонна, colLo..colHi — её полоса).
interface Cand {
  kind: "z" | "zz";
  x: number;
  colLo: number;           // полоса колонны: кусок просвета без зон собственных портовых рядов
  colHi: number;
  freeLo: number;          // сам просвет между телами (Ф3: от него считается место под плашку)
  freeHi: number;
  bands: Array<[number, number]>;  // интервалы across дорожек (1 у Z, 2 у ZZ)
  adjU: boolean;                   // крайняя верхняя дорожка — в канале, соседнем с U
  adjD: boolean;                   // крайняя нижняя дорожка — в канале, соседнем с D
  detour: number;                  // лишняя длина против прямого Z
  order: number;                   // ранг при равенстве: Z по близости к D, ZZ после
}

interface ZEdge {
  id: string;
  ix: number;              // номер в списке связей вызова (адрес в памяти проб)
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
  freeLo: number;          // просвет колонны по телам (Ф3)
  freeHi: number;
  lanes: number[];         // across дорожек (1 у Z, 2 у ZZ) — переменные раздачи
  slots: number[];         // номера дорожек (разрешение наложений)
  adjU: boolean;           // см. Cand
  adjD: boolean;
  cand: Cand | null;
  cands: Cand[];
  exclude: NodeRect[];
  hard: ReadonlyArray<NodeRect>;
  // Тела сцены без тел своих концов (obstacles минус exclude, в прежнем порядке) и они же
  // вместе с hard — препятствия проверки маршрута. Считаются ОДИН раз при создании связи:
  // прежде фильтр тел крутился на каждой пробе спуска для каждой связи (perf, render-scale).
  bodies: NodeRect[];
  blockers: NodeRect[];
  label?: Size;            // габарит плашки подписи (Ф3)
  lenFlow: number;         // протяжённость плашки вдоль отрезка потока (стаб/колонна) и поперёк него
  thickFlow: number;
  lenLane: number;         // то же для дорожки канала
  thickLane: number;
  host: Host;              // носитель подписи при текущем варианте (Ф3)
  hostOff: boolean;        // носитель выключен спуском: его ограничения стоили дороже плашки
  hostLost: boolean;       // слот носителя режет чужая линия (точная проверка по маршрутам сцены)
  uNode: string;           // узел конца U / D (ключи портов)
  dNode: string;
  shareU?: string;         // общее плечо на конце U / D (прототип, заход 4)
  shareD?: string;
  // РАЗРЕШАЮЩИЙ КЛЮЧ: у связи без единого Z (стаб в ряду порта упирается в тело) —
  // along конца, где другой порт той же стороны открыл бы Z; null — такого нет
  enable: { u?: number; d?: number } | null;
}

/** Прямая пары одной колонны: неподвижный отрезок для раздачи поперечных дорожек. */
interface Straight {
  id: string; orient: Orient; along: number; lo: number; hi: number;
  label?: Size;                  // габарит подписи (Ф3)
  slot: [number, number] | null; // слот подписи на прямой (across с запасом); null — носителя нет
  thick: number;                 // поперечная протяжённость плашки с запасом (0 — без подписи)
}

/** Цена креста при выборе варианта дорожки — та же, что у A* (routeAll.DEFAULT_CROSS_COST). */
const CAND_CROSS_COST = 200;

// Применить вариант к связи: вид, колонна, стартовые дорожки (середины полос).
function applyCand(e: ZEdge, c: Cand): void {
  e.kind = c.kind;
  e.x = c.x;
  e.colLo = c.colLo;
  e.colHi = c.colHi;
  e.freeLo = c.freeLo;
  e.freeHi = c.freeHi;
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
  soft: ReadonlyArray<NodeRect> = [],
): Array<[number, number]> {
  const busy: Array<[number, number]> = [];
  const add = (r: NodeRect, pad: number): void => {
    const [c0, c1] = rectAcross(o, r);
    // вне полосы — по самому телу: сосед ряда U (или D), чья раздутая на клиренс граница
    // лишь касается начала дорожек, колонну под собой не запрещает (Ф3: прежде такой
    // сосед съедал просвет, и колонна с подписью уходила в обход)
    if (c1 <= uAcross + EPS || c0 >= dAcross - EPS) return;
    const [a0, a1] = rectAlong(o, r);
    busy.push([a0 - pad, a1 + pad]);
  };
  for (const r of obstacles) if (!exclude.some((e) => sameRect(e, r))) add(r, Z_CLEAR);
  // граница чужой рамки — не тело, но колонна вплотную к пунктиру читается как её часть;
  // чужие плашки просветы не раздувают (раздутые, они съедали просветы у узлов целиком)
  for (const r of hard) add(r, Z_CLEAR);
  for (const r of soft) add(r, 0);
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
// (зависимости дописываются в общий список out — без массива на каждую пару)
function pairDeps(out: Dep[], i: number, j: number, a: Seg, b: Seg): void {
  const dIJ = LANE_CONFLICT_PENALTY * orderConflicts(a, b) + orderCrossings(a, b);
  const dJI = LANE_CONFLICT_PENALTY * orderConflicts(b, a) + orderCrossings(b, a);
  if (dIJ < dJI) { out.push({ from: i, to: j, weight: dJI - dIJ }); return; }
  if (dJI < dIJ) { out.push({ from: j, to: i, weight: dIJ - dJI }); return; }
  const t = tieBreak(a, b);
  if (t > 0) { out.push({ from: i, to: j, weight: TIE_WEIGHT }); return; }
  if (t < 0) { out.push({ from: j, to: i, weight: TIE_WEIGHT }); return; }
  // порядок безразличен и для крестов, и для вложения, но дорожки обязаны быть разными:
  // пара нулевых зависимостей, одну из них снимет разрыв циклов
  out.push({ from: i, to: j, weight: 0 }, { from: j, to: i, weight: 0 });
}

// Жадный разрыв циклов (Eades–Lin–Smyth): стоки — в хвост порядка, истоки — в голову,
// при тупике — вершина с максимальным (out − in). Зависимости против порядка:
// ненулевые разворачиваются, нулевые снимаются. Детерминизм — обход по индексам
// (сегменты заранее отсортированы по id).
// Исходящие (by = "from") или входящие (by = "to") зависимости каждой вершины списками в
// порядке deps: вершина k — номера зависимостей list[start[k] .. start[k + 1]).
function depsBy(n: number, deps: Dep[], by: "from" | "to"): { start: Int32Array; list: Int32Array } {
  const start = new Int32Array(n + 1);
  for (const d of deps) start[d[by] + 1]++;
  for (let k = 0; k < n; k++) start[k + 1] += start[k];
  const fill = start.slice(0, n), list = new Int32Array(deps.length);
  for (let q = 0; q < deps.length; q++) list[fill[deps[q][by]]++] = q;
  return { start, list };
}

function breakCycles(n: number, deps: Dep[]): Dep[] {
  const inW = new Array<number>(n).fill(0), outW = new Array<number>(n).fill(0);
  for (const d of deps) { outW[d.from] += d.weight; inW[d.to] += d.weight; }
  const alive = new Array<boolean>(n).fill(true);
  const left: number[] = [], right: number[] = [];
  let remaining = n;
  // снятие вершины обходит только её зависимости (списки смежности в порядке deps), а не
  // весь список на каждую вершину: правки одной ячейки inW/outW идут в прежнем порядке
  const outs = depsBy(n, deps, "from"), ins = depsBy(n, deps, "to");
  const remove = (k: number): void => {
    alive[k] = false; remaining--;
    for (let t = outs.start[k]; t < outs.start[k + 1]; t++) { const d = deps[outs.list[t]]; if (alive[d.to]) inW[d.to] -= d.weight; }
    for (let t = ins.start[k]; t < ins.start[k + 1]; t++) { const d = deps[ins.list[t]]; if (alive[d.from]) outW[d.from] -= d.weight; }
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
  // исходящие вершины k — её список смежности в порядке dag (тот же обход, что прежний
  // перебор всего dag с пропуском чужих)
  const outs = depsBy(n, dag, "from");
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    for (let t = outs.start[k]; t < outs.start[k + 1]; t++) {
      const d = dag[outs.list[t]];
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
 * Неподвижные препятствия раздачи одной ориентации. Препятствие — параллельное дорожкам
 * (стаб или прямая чужой связи; thick > 0 — на этом пробеге лежит плашка подписи, дорожка
 * держит от неё запас) либо СЛОТ ПОДПИСИ поперёк дорожек (slot): pos — середина слота
 * across, lo..hi — along-полоса плашки, thick — высота слота; дорожка с пробегом в этой
 * полосе выходит из слота на ту сторону, откуда приходит её вертикаль. edge — номер
 * связи-владельца в списке вызова (−1 у прямой). Хранятся столбцами (perf, эпик
 * render-scale): раздача идёт на каждой пробе спуска, и объект на препятствие кормил
 * сборщик мусора.
 */
class FixedCols {
  n = 0;
  edge = new Int32Array(64);
  pos = new Float64Array(64);
  lo = new Float64Array(64);
  hi = new Float64Array(64);
  thick = new Float64Array(64);
  slot = new Uint8Array(64);
  add(edge: number, pos: number, lo: number, hi: number, thick: number, slot: boolean): void {
    if (this.n === this.pos.length) {
      const len = this.pos.length * 2;
      const i32 = new Int32Array(len); i32.set(this.edge); this.edge = i32;
      const u8 = new Uint8Array(len); u8.set(this.slot); this.slot = u8;
      const grow = (a: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> => { const g = new Float64Array(len); g.set(a); return g; };
      this.pos = grow(this.pos); this.lo = grow(this.lo); this.hi = grow(this.hi); this.thick = grow(this.thick);
    }
    const k = this.n++;
    this.edge[k] = edge; this.pos[k] = pos; this.lo[k] = lo; this.hi[k] = hi; this.thick[k] = thick; this.slot[k] = slot ? 1 : 0;
  }
}

/**
 * Применимые препятствия сегментов одной раздачи: у сегмента k (номер в списке раздачи) —
 * записи [start[k], start[k + 1]) в общих буферах. fi — номер препятствия, code — вид: 0 —
 * отрезок, у слота подписи 1 + up + 2·down (с какой стороны к слоту приходит вертикаль
 * дорожки); flags[k]: 1 — среди них есть слот, 2 — есть отрезок с толщиной плашки. Применимы
 * чужие препятствия с общим пробегом; от зазора это не зависит, поэтому список считается один
 * раз на раздачу, а не в каждом из до четырёх вариантов разрешения (и входит в ключ памяти
 * раздачи компоненты).
 *
 * БЛИЖНИЕ ЗАПИСИ (nStart/nq): у сегмента k — номера записей nq[nStart[k] .. nStart[k + 1]) в
 * порядке списка, кроме ДАЛЬНИХ. Дальняя — двустороннее препятствие (отрезок или слот без
 * стороны либо с обеими), чья наибольшая возможная зона (полузазор не больше
 * max(NUDGE_GAP, полусуммы толщин) с запасом в пиксель) целиком вне внешней полосы
 * сегмента. Вычитание такой зоны не меняет ни одного куска, пока все куски шире 2·EPS (см.
 * resolvePieces) — полоса разрешения лежит внутри внешней полосы.
 */
class AppTable {
  start = new Int32Array(65);
  flags = new Uint8Array(64);
  fi = new Int32Array(256);
  code = new Uint8Array(256);
  nStart = new Int32Array(65);
  nq = new Int32Array(256);
  build(S: ReadonlyArray<Seg>, F: FixedCols): void {
    const n = S.length;
    if (this.flags.length < n) { this.flags = new Uint8Array(2 * n); this.start = new Int32Array(2 * n + 1); this.nStart = new Int32Array(2 * n + 1); }
    let m = 0, nn = 0;
    const fEdge = F.edge, fLoA = F.lo, fHiA = F.hi, fSlot = F.slot, fThick = F.thick, fPos = F.pos, nF = F.n;
    for (let k = 0; k < n; k++) {
      const s = S[k], own = s.edge.ix, sLo = s.lo, sHi = s.hi;
      const bLo = s.bandLo, bHi = s.bandHi, sTh = Math.max(s.thick, 0);
      // запас зоны у препятствия без толщины — один на сегмент (у NaN-толщины его нет)
      const G0 = Math.max(NUDGE_GAP, sTh / 2) + 1;
      this.start[k] = m;
      this.nStart[k] = nn;
      let flags = 0;
      for (let f = 0; f < nF; f++) {
        // runOverlap(f, s) > EPS, слово в слово; перед ним — необходимое условие (разность
        // больше EPS > 0 лишь при min > max, то есть fHi > sLo и fLo < sHi; с NaN оба ложны)
        if (!(fHiA[f] > sLo && fLoA[f] < sHi)) continue;
        if (fEdge[f] === own || !(Math.min(fHiA[f], sHi) - Math.max(fLoA[f], sLo) > EPS)) continue;
        let code = 0;
        if (fSlot[f] === 1) {
          const fLo = fLoA[f], fHi = fHiA[f];
          let up = false, down = false;
          for (const v of s.verts) {
            if (!within(v.along, fLo, fHi)) continue;
            if (v.dir === "up") up = true; else down = true;
          }
          code = 1 + (up ? 1 : 0) + (down ? 2 : 0);
          flags |= 1;
        } else if (fThick[f] !== 0) flags |= 2;
        if (m === this.fi.length) {
          const i32 = new Int32Array(2 * m); i32.set(this.fi); this.fi = i32;
          const u8 = new Uint8Array(2 * m); u8.set(this.code); this.code = u8;
          const nq = new Int32Array(2 * m); nq.set(this.nq); this.nq = nq;
        }
        let far = false;
        if (code === 0 || code === 1 || code === 4) {
          const th = fThick[f];
          const G = th > 0 ? Math.max(NUDGE_GAP, (th + sTh) / 2) + 1 : th <= 0 ? G0 : NaN;
          far = fPos[f] - G >= bHi || fPos[f] + G <= bLo;
        }
        if (!far) this.nq[nn++] = m;
        this.fi[m] = f; this.code[m] = code; m++;
      }
      this.flags[k] = flags;
    }
    this.start[n] = m;
    this.nStart[n] = nn;
  }
}

// Куски полосы [lo0, hi0] за вычетом зон применимых препятствий [q0, q1) таблицы app (см.
// distribute, «НЕПОДВИЖНЫЕ ПРЕПЯТСТВИЯ») и ближайший к d кусок — в RESOLVED; ложь — кусков
// нет либо ни один не ближе бесконечности (расстояние не число). Куски — плоскими парами в
// двух переиспользуемых массивах (функция не повторно входима: раздача однопоточна).
const RESOLVED: [number, number] = [0, 0];
let piecesA: number[] = [], piecesB: number[] = [];
// Вычитание зоны записи q из кусков piecesA (результат — снова в piecesA).
function cutPieces(q: number, app: AppTable, F: FixedCols, gap: number, ownThick: number, useSlots: boolean, useThick: boolean): void {
  const f = app.fi[q], code = app.code[q];
  const slot = code !== 0;
  if (slot && !useSlots) return;
  const up = slot && ((code - 1) & 1) !== 0, down = slot && ((code - 1) & 2) !== 0;
  const g = Math.max(slot ? 0 : gap, ((useThick ? F.thick[f] : 0) + ownThick) / 2);
  const z0 = F.pos[f] - g, z1 = F.pos[f] + g;
  const keepLo = !(slot && down && !up), keepHi = !(slot && up && !down);
  const cur = piecesA, nxt = piecesB;
  nxt.length = 0;
  for (let t = 0; t < cur.length; t += 2) {
    const a = cur[t], b = cur[t + 1];
    if (keepLo && z0 > a + EPS) { const nb = Math.min(b, z0); if (nb >= a - EPS) nxt.push(a, nb); }
    if (keepHi && z1 < b - EPS) { const na = Math.max(a, z1); if (b >= na - EPS) nxt.push(na, b); }
  }
  piecesA = nxt; piecesB = cur;
}
// Все куски шире 2·EPS в обоих смыслах сравнений cutPieces: зона целиком выше куска
// (z0 ≥ b) оставляет его как есть при b > a + EPS, целиком ниже (z1 ≤ a) — при a < b − EPS.
function allWide(): boolean {
  const cur = piecesA;
  for (let t = 0; t < cur.length; t += 2) {
    const a = cur[t], b = cur[t + 1];
    if (!(b > a + EPS && a < b - EPS)) return false;
  }
  return true;
}
// Сегмент k таблицы app: сначала только его ближние записи (дальние, пока куски широкие,
// ничего не режут — см. AppTable); как только кусок стал узким, — все оставшиеся записи
// подряд, в том числе дальние, как в прежнем полном проходе. narrowSeen — был ли такой
// переход (тогда итог раздачи зависит и от дальних записей; см. память компонент).
let narrowSeen = false;
function resolvePieces(
  lo0: number, hi0: number, k: number, app: AppTable, F: FixedCols,
  gap: number, ownThick: number, useSlots: boolean, useThick: boolean, d: number,
): boolean {
  piecesA.length = 0;
  piecesA.push(lo0, hi0);
  const q1 = app.start[k + 1];
  let q = app.start[k];
  if (allWide()) {
    q = q1;
    const n1 = app.nStart[k + 1];
    for (let t = app.nStart[k]; t < n1; t++) {
      const qq = app.nq[t];
      cutPieces(qq, app, F, gap, ownThick, useSlots, useThick);
      if (piecesA.length === 0) return false;
      if (!allWide()) { q = qq + 1; narrowSeen = true; break; }
    }
  } else narrowSeen = true;
  for (; q < q1; q++) {
    cutPieces(q, app, F, gap, ownThick, useSlots, useThick);
    if (piecesA.length === 0) return false;
  }
  const cur = piecesA;
  let bestD = Infinity, found = false;
  for (let t = 0; t < cur.length; t += 2) {
    const a = cur[t], b = cur[t + 1];
    const dist = d < a ? a - d : d > b ? d - b : 0;
    if (dist < bestD - EPS) { bestD = dist; RESOLVED[0] = a; RESOLVED[1] = b; found = true; }
  }
  return found;
}
const distTo = (d: number, a: number, b: number): number => (d < a ? a - d : d > b ? d - b : 0);

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
  M: Seg[], slots: number[], ipairs: ReadonlyArray<number>,
  ks: ReadonlyArray<number>, app: AppTable, F: FixedCols, edgeIds: ReadonlyArray<string>,
): { lanes: number[]; gap: number } {
  const m = M.length;
  const K = Math.max(...slots) + 1;
  const cLo = Math.max(...M.map((s) => s.bandLo));
  const cHi = Math.min(...M.map((s) => s.bandHi));
  let gap = NUDGE_GAP;
  if (K > 1 && cLo <= cHi && (K - 1) * gap > cHi - cLo) gap = Math.max(LANE_GAP_MIN, (cHi - cLo) / (K - 1));
  // середина стопки: пересечение полос; при пустом или бесконечном пересечении — среднее
  // «естественных» мест (середина своей полосы, у колонны — стартовая колонна)
  const natural = M.map((s) => {
    if (s.idx === 2) return s.edge.cand?.x ?? s.lane;
    return Number.isFinite(s.bandLo) && Number.isFinite(s.bandHi) ? (s.bandLo + s.bandHi) / 2 : s.lane;
  });
  let center: number;
  if (Number.isFinite(cLo) && Number.isFinite(cHi) && cLo <= cHi) center = (cLo + cHi) / 2;
  else center = natural.reduce((acc, v) => acc + v, 0) / m;
  const lo = M.map((s) => s.bandLo), hi = M.map((s) => s.bandHi);
  // ТОЛЩИНА ПОД ПОДПИСЬ (Ф3): сегмент-носитель плашки занимает поперёк полосу толщиной
  // thick (плашка + запас с обеих сторон). Зазор пары — не меньше полусуммы толщин
  // (линия соседа не ближе запаса к краю плашки), от тел — полоса сужается так, чтобы
  // край плашки держал запас от тела (клиренс Z_CLEAR уже в полосе). Где места под
  // толщину нет (полоса уже плашки, пара не вмещается в полосы, неподвижная линия не
  // обойти), толщина ДЕГРАДИРУЕТ до обычного зазора линий — плашка ляжет впритык к
  // соседу, но дорожки не сольются; режет ли линия плашку, сцена проверяет по готовым
  // маршрутам (hostLost), а не по этим догадкам.
  const thick = M.map((s) => s.thick);
  const degrade = (i: number): void => { thick[i] = 0; };
  const pairGap = (i: number, j: number): number => Math.max(gap, (thick[i] + thick[j]) / 2);
  M.forEach((s, i) => {
    if (thick[i] <= 0 || s.preShrunk) return;
    const sh = Math.max(0, thick[i] / 2 - Z_CLEAR);
    if (hi[i] - lo[i] < 2 * sh + EPS) { degrade(i); return; }
    lo[i] += sh; hi[i] -= sh;
  });
  // желаемая позиция: дорожки — стопка равным шагом вокруг середины канала; колонна ZZ —
  // её стартовая колонна (колонны одного компонента раскиданы по сцене, стопочный сдвиг
  // по номеру уносил колонну за стаб соседа и заставлял петлю обходить лишнюю связь)
  const desired = M.map((s, i) => clamp(s.idx === 2 ? natural[i] : center + (slots[i] - (K - 1) / 2) * gap, lo[i], hi[i]));
  // НЕПОДВИЖНЫЕ ПРЕПЯТСТВИЯ: полоса минус зоны всех препятствий с общим пробегом (линия
  // ± зазор, слот подписи целиком, у носителя — ещё полтолщины своей плашки); слот
  // подписи ещё и диктует сторону — ту, откуда приходит вертикаль дорожки (стаб соседа не
  // проходит сквозь плашку). Из оставшихся кусков берётся ближайший к желаемой позиции.
  // Прежний последовательный выбор «выше/ниже» по одному препятствию загонял дорожку
  // между двумя линиями, где места нет, и полоса схлопывалась. Кусков нет — ограничения
  // снимаются по мягкости: своя толщина (носитель потерян), чужие слоты (их носители
  // потеряны), толщины чужих стабов; в крайнем случае полоса остаётся как есть (дорожка
  // ляжет на линию и уступит A* по наложению, как прежде).
  const band0Lo = lo.slice(), band0Hi = hi.slice();
  // применимые препятствия сегмента i — записи таблицы app у его номера ks[i] (AppTable);
  // вариант разрешения (resolvePieces) — кусок (pLo, pHi), ok — он есть
  const resolveAll = (): void => {
    for (let i = 0; i < m; i++) {
      lo[i] = band0Lo[i]; hi[i] = band0Hi[i];
      const k = ks[i], q0 = app.start[k], q1 = app.start[k + 1];
      if (q0 === q1) continue;
      const hasSlot = (app.flags[k] & 1) !== 0, hasThick = (app.flags[k] & 2) !== 0;
      const d = desired[i];
      let ok = resolvePieces(lo[i], hi[i], k, app, F, gap, thick[i], true, true, d);
      let pLo = RESOLVED[0], pHi = RESOLVED[1];
      // своя толщина уводит слишком далеко — плашка ляжет впритык, зато без крюка
      if (thick[i] > 0) {
        const okThin = resolvePieces(lo[i], hi[i], k, app, F, gap, 0, true, true, d);
        if (!ok || distTo(d, pLo, pHi) > (okThin ? distTo(d, RESOLVED[0], RESOLVED[1]) : Infinity) + LABEL_SHIFT_TOL) {
          degrade(i); ok = okThin; pLo = RESOLVED[0]; pHi = RESOLVED[1];
        }
      }
      // чужие слоты уводят слишком далеко — их носители потеряны (точная проверка это увидит).
      // Без слотов среди применимых вариант «без слотов» по построению равен уже выбранному
      // (та же толщина, те же препятствия) — повторный расчёт пропускается.
      if (hasSlot) {
        const okNo = resolvePieces(lo[i], hi[i], k, app, F, gap, thick[i], false, true, d);
        if (!ok || distTo(d, pLo, pHi) > (okNo ? distTo(d, RESOLVED[0], RESOLVED[1]) : Infinity) + LABEL_SHIFT_TOL) {
          ok = okNo; pLo = RESOLVED[0]; pHi = RESOLVED[1];
        }
      }
      // Сюда доходят, только если и вариант без слотов пуст; без толщин у чужих отрезков
      // вариант «без толщин» совпадает с ним и тоже пуст.
      if (!ok && hasThick) {
        ok = resolvePieces(lo[i], hi[i], k, app, F, gap, thick[i], false, false, d);
        pLo = RESOLVED[0]; pHi = RESOLVED[1];
      }
      const s = M[i];
      if (__zDebug.trace && s.members.some((mm) => mm.id.startsWith(__zDebug.trace))) {
        const fs: string[] = [];
        for (let q = q0; q < q1; q++) {
          const f = app.fi[q];
          fs.push(`${F.edge[f] >= 0 ? edgeIds[F.edge[f]].slice(0, 8) : "straight"}@${F.pos[f].toFixed(0)}${F.slot[f] === 1 ? "s" : ""}${F.thick[f] > 0 ? `t${F.thick[f]}` : ""}`);
        }
        zlog(s.edge.id.slice(0, 8), "fix", `#${s.idx}`, `d=${d.toFixed(0)}`, `gap=${gap}`, `band=${lo[i].toFixed(0)}..${hi[i].toFixed(0)}`, `→ ${ok ? `${pLo.toFixed(0)}..${pHi.toFixed(0)}` : "none"}`, fs.join(" "));
      }
      if (!ok) continue;
      lo[i] = pLo; hi[i] = pHi;
    }
  };
  resolveAll();
  // СЖАТИЕ ШАГА ПОД СЛОТЫ (Ф3): слоты подписей отбирают у стопки часть канала; если
  // оставшееся общее место стопку с шагом не вмещает, шаг сжимается (не ниже дна), и
  // препятствия пересчитываются с новым зазором линий
  if (K > 1) {
    const rLo = Math.max(...lo), rHi = Math.min(...hi);
    if (Number.isFinite(rLo) && Number.isFinite(rHi) && rLo <= rHi && (K - 1) * gap > rHi - rLo + EPS) {
      const g2 = Math.max(LANE_GAP_MIN, (rHi - rLo) / (K - 1));
      if (g2 < gap - EPS) { gap = g2; resolveAll(); }
    }
  }
  // взаимодействующие пары (ipairs: i·m + j по возрастанию — порядок перебора i < j): верхняя,
  // нижняя, зазор — плоскими массивами; порядок — устойчивая сортировка по номерам дорожек
  // (верхней, затем нижней), при равенстве — порядок перебора
  const pTop: number[] = [], pBot: number[] = [], pGap: number[] = [];
  for (const code of ipairs) {
    const i = (code / m) | 0, j = code - i * m;
    if (slots[i] === slots[j]) continue;
    const gp = pairGap(i, j);
    if (slots[i] < slots[j]) { pTop.push(i); pBot.push(j); } else { pTop.push(j); pBot.push(i); }
    pGap.push(gp);
  }
  const pOrder = pTop.map((_, k) => k).sort((p, q) => slots[pTop[p]] - slots[pTop[q]] || slots[pBot[p]] - slots[pBot[q]] || p - q);
  // ОТСЕВ НЕВЫПОЛНИМЫХ ЦЕПОЧЕК: порядок номеров может через дорожку с широкой полосой
  // связать дорожки разных каналов и потребовать невозможного (нижняя дорожка верхнего
  // канала ниже верхней дорожки нижнего). Минимально достижимая позиция считается вперёд
  // по номерам; пара, которую полоса нижней дорожки не вмещает, отбрасывается — физически
  // такие дорожки и так в разных каналах. Остаток выполним, и прогоны ниже не качаются.
  const minPos = [...lo];
  const fTop: number[] = [], fBot: number[] = [], fGap: number[] = [];   // выполнимые пары
  for (const k of pOrder) {
    const a = pTop[k], b = pBot[k];
    let gp = pGap[k];
    // пара не вмещается с толщинами — сначала снимаем толщины (линии всё ещё разводятся
    // обычным зазором), и лишь невыполнимая и так пара отбрасывается
    if (gp > gap && minPos[a] + gp > hi[b] + EPS) { degrade(a); degrade(b); gp = gap; }
    if (minPos[a] + gp > hi[b] + EPS) continue;
    minPos[b] = Math.max(minPos[b], minPos[a] + gp);
    fTop.push(a); fBot.push(b); fGap.push(gp);
  }
  const x = desired.map((d, i) => clamp(d, lo[i], hi[i]));
  const nF = fTop.length;
  for (let it = 0; it < 16; it++) {
    let changed = false;
    for (let k = 0; k < nF; k++) {
      const a = fTop[k], b = fBot[k];
      const need = x[a] + fGap[k];
      if (x[b] < need - 1e-6) { x[b] = Math.min(need, hi[b]); changed = true; }
    }
    for (let k = nF - 1; k >= 0; k--) {
      const a = fTop[k], b = fBot[k];
      const need = x[b] - fGap[k];
      if (x[a] > need + 1e-6) { x[a] = Math.max(need, lo[a]); changed = true; }
    }
    if (!changed) break;
  }
  // страховка: несовместные ограничения не выталкивают дорожку из её полосы (на край тела)
  M.forEach((s, i) => { if (lo[i] > hi[i] + EPS) { x[i] = clamp(desired[i], s.bandLo, s.bandHi); if (__zDebug.on) zlog(s.edge.id.slice(0, 8), "band-empty", `#${s.idx}`, `lo=${lo[i].toFixed(0)}`, `hi=${hi[i].toFixed(0)}`, `band=${s.bandLo.toFixed(0)}..${s.bandHi.toFixed(0)}`, `col=${s.edge.colLo.toFixed(0)}..${s.edge.colHi.toFixed(0)}`, `free=${s.edge.freeLo.toFixed(0)}..${s.edge.freeHi.toFixed(0)}`, `thick=${s.thick}`, `gap=${gap}`); } });
  if (__zDebug.trace && M.some((sg) => sg.members.some((m) => m.id.startsWith(__zDebug.trace)))) {
    zlog("dist", `gap=${gap.toFixed(1)} center=${center.toFixed(1)} K=${K}`, M.map((sg, i) => `${sg.edge.id.slice(0, 8)}#${sg.idx} s${slots[i]} lo=${lo[i].toFixed(0)} hi=${hi[i].toFixed(0)} d=${desired[i].toFixed(0)} x=${x[i].toFixed(0)}`).join(" "), `pairs=${fTop.map((a, k) => `${a}>${fBot[k]}:${fGap[k].toFixed(0)}`).join(",")}`);
  }
  return { lanes: x.map(half), gap };
}

// ── ПАМЯТЬ ПРОБ СПУСКА (perf, эпик render-scale, docs/plan-render-scale.md) ─────────
// Спуск пробует вариант одной связи и ради одного числа пересчитывает цену всей сцены. Перебор
// остаётся прежним (те же пробы в том же порядке, те же решения), дешевле становится каждая
// проба: вычисления, чьи входы не изменились, берутся из памяти. Память держится по ТОЧНЫМ
// входам (все числа, которые вычисление читает), а не по набору вариантов: состояние
// переезжает между пробами (дорожки отвергнутой пробы остаются соседям), и другой вход — это
// просто промах. Живёт память внутри одного вызова zRoutes; под отладочным следом выключена
// (след прежний), при diag.__ARCHMAP_Z_SELFCHECK каждое попадание считается ещё и честно.

/** Побитовое равенство чисел: -0 и 0 различаются, NaN равен NaN. */
const sameNum = (a: number, b: number): boolean => (a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b);

/**
 * Ключ точных входов: числа подряд в буфер, хэш по битам, сверка при совпадении хэша — тоже
 * по битам (строже равенства: лишний промах безопасен, ложное попадание нет). Строковый
 * ключ на каждую компоненту съел бы весь выигрыш.
 */
class ExactKey {
  private f = new Float64Array(256);
  private u = new Uint32Array(this.f.buffer);
  private n = 0;
  reset(): void { this.n = 0; }
  push(v: number): void {
    if (this.n === this.f.length) {
      const g = new Float64Array(this.f.length * 2);
      g.set(this.f);
      this.f = g;
      this.u = new Uint32Array(g.buffer);
    }
    this.f[this.n++] = v;
  }
  hash(): number {
    let h = 0x811c9dc5 ^ this.n;
    const w = 2 * this.n, u = this.u;
    for (let i = 0; i < w; i++) h = Math.imul(h ^ u[i], 0x01000193);
    return (h ^ (h >>> 15)) >>> 0;
  }
  copy(): Uint32Array { return this.u.slice(0, 2 * this.n); }
  same(k: Uint32Array): boolean {
    if (k.length !== 2 * this.n) return false;
    const u = this.u;
    for (let i = 0; i < k.length; i++) if (k[i] !== u[i]) return false;
    return true;
  }
}

/**
 * Память «точный ключ → результат» с двумя поколениями: заполненное поколение уходит в
 * старое, старое выбрасывается. Попадание в старое поколение переносит запись в текущее, так
 * что живые записи переживают смену поколения, а память вызова ограничена.
 */
class ExactMemo<V> {
  private cur = new Map<number, Array<{ key: Uint32Array; v: V }>>();
  private old = new Map<number, Array<{ key: Uint32Array; v: V }>>();
  private size = 0;
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  get(h: number, k: ExactKey): V | undefined {
    const a = this.cur.get(h);
    if (a) for (const it of a) if (k.same(it.key)) return it.v;
    const b = this.old.get(h);
    if (b) for (const it of b) if (k.same(it.key)) { this.put(h, k, it.v); return it.v; }
    return undefined;
  }
  put(h: number, k: ExactKey, v: V): void {
    if (this.size >= this.limit) { this.old = this.cur; this.cur = new Map(); this.size = 0; }
    const it = { key: k.copy(), v };
    const a = this.cur.get(h);
    if (a) a.push(it); else this.cur.set(h, [it]);
    this.size++;
  }
}
/** Записей в поколении памяти раздачи компонент: с запасом на все компоненты нескольких проб. */
const COMP_MEMO_LIMIT = 4096;

/** Результат раздачи компоненты: номера дорожек, позиции, шаг. */
interface CompResult { slots: number[]; lanes: number[]; gap: number }

const selfCheckFail = (name: string): never => {
  throw new Error(`самопроверка кэша Z-роутера «${name}»: готовый результат разошёлся с честным расчётом`);
};
// Сверка готового результата с честным расчётом: расхождение — исключение, совпадение —
// в счёт сверок по названию кэша, если включивший самопроверку завёл счётчик (diag).
const selfCheckAssert = (ok: boolean, name: string): void => {
  if (!ok) selfCheckFail(name);
  const c = diag.__ARCHMAP_Z_SELFCHECK_COUNT;
  if (c) c[name] = (c[name] ?? 0) + 1;
};
const sameNums = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
  a.length === b.length && a.every((v, i) => sameNum(v, b[i]));
const samePts = (a: EdgePoint[] | null, b: EdgePoint[] | null): boolean =>
  a === null || b === null ? a === b
    : a.length === b.length && a.every((p, i) => sameNum(p.x, b[i].x) && sameNum(p.y, b[i].y));

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
  /**
   * ЯКОРЬ ПОДПИСИ (Ф3): точка маршрута, где роутер зарезервировал слот под плашку
   * (середина стаба-носителя, колонны или прямой). Размещение плашек берёт её желаемой
   * позицией; связи без носителя якоря не имеют.
   */
  labelAnchors: Map<string, EdgePoint>;
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
  /** границы ЧУЖИХ рамок связи: сквозь них Z не ходит, колонна ZZ держит от них клиренс */
  hardOf?: (groupId: string) => ReadonlyArray<NodeRect>;
  /** чужие плашки подписей: сквозь них Z не ходит, но просветы они не раздувают */
  softOf?: (groupId: string) => ReadonlyArray<NodeRect>;
  /** габарит плашки подписи связи (Ф3): дорожка-носитель получает толщину под неё */
  labelBoxOf?: (groupId: string) => Size | undefined;
}): ZRoutesResult {
  const { groups, ports, shares, obstacles, rectOf, hardOf, softOf, labelBoxOf } = params;
  // память проб спуска (см. «ПАМЯТЬ ПРОБ СПУСКА»): под отладочным следом выключена
  const cacheOn = !__zDebug.on && !__zDebug.trace;
  const selfCheck = cacheOn && diag.__ARCHMAP_Z_SELFCHECK === true;
  // счётчики перебора (diag.__ARCHMAP_Z_STATS): заводит измеритель, в проде их нет
  const stats = diag.__ARCHMAP_Z_STATS;
  const count = (name: string): void => { if (stats) stats[name] = (stats[name] ?? 0) + 1; };
  count("calls");
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
    const exclude = [rectOf(g.source), rectOf(g.target)].filter((r): r is NodeRect => !!r);
    const frames = hardOf?.(g.id) ?? [];
    const hard = [...frames, ...(softOf?.(g.id) ?? [])];
    const bodies = obstacles.filter((r) => !exclude.some((e) => sameRect(e, r)));
    // ПРЯМАЯ: порты в одной колонне — дорожка не нужна, достаточно чистого отрезка (и
    // клиренс Z ей не нужен: сближенная пара с выровненными портами — именно этот случай)
    if (Math.abs(uAlong - dAlong) <= EPS && dAcross - uAcross > EPS) {
      const straight = [{ ...pp.s.point }, { ...pp.t.point }];
      if (!pathCrossesRects(straight, [...bodies, ...hard])) {
        routes.set(g.id, straight);
        const lab = labelBoxOf?.(g.id);
        straights.push({ id: g.id, orient: o, along: uAlong, lo: uAcross, hi: dAcross, label: lab, slot: null, thick: 0 });
      }
      continue;
    }
    if (dAcross - uAcross < 2 * Z_CLEAR - EPS) continue; // узлы вплотную/перекрыты — не Z
    const lab = labelBoxOf?.(g.id);
    const edge: ZEdge = {
      id: g.id, ix: -1, orient: o, sIsU, kind: "z", uAlong, dAlong, uAcross, dAcross,
      x: NaN, colLo: NaN, colHi: NaN, freeLo: NaN, freeHi: NaN, lanes: [], slots: [], adjU: true, adjD: true,
      cand: null, cands: [], exclude, hard, bodies, blockers: [...bodies, ...hard], label: lab,
      lenFlow: lab ? (o === "v" ? lab.h : lab.w) : 0, thickFlow: lab ? (o === "v" ? lab.w : lab.h) : 0,
      lenLane: lab ? (o === "v" ? lab.w : lab.h) : 0, thickLane: lab ? (o === "v" ? lab.h : lab.w) : 0,
      host: "none", hostOff: false, hostLost: false,
      uNode: sIsU ? g.source : g.target, dNode: sIsU ? g.target : g.source, enable: null,
      shareU: sIsU ? shares?.get(g.id)?.s : shares?.get(g.id)?.t,
      shareD: sIsU ? shares?.get(g.id)?.t : shares?.get(g.id)?.s,
    };
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
      if (bodies.some(blocks)) return false;
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
      for (const r of bodies) consider(r, Z_CLEAR);
      for (const r of hard) consider(r, 0);
      return rows;
    };
    const intervals = laneIntervals(o, uAlong, dAlong, uAcross, dAcross, obstacles, exclude, hard);
    intervals.forEach((iv, k) => cands.push({
      kind: "z", x: NaN, colLo: NaN, colHi: NaN, freeLo: NaN, freeHi: NaN, bands: [iv],
      adjU: adjacent(uAcross, iv[0], spanLo, spanHi), adjD: adjacent(iv[1], dAcross, spanLo, spanHi),
      detour: 0, order: intervals.length - 1 - k,
    }));
    // ZZ по каждой свободной колонне между телами полосы (аналог фиктивного узла ELK).
    // Полоса колонны — просвет с клиренсом БЕЗ зон собственных портовых рядов (колонна
    // ближе клиренса к колонне порта — это Z с паразитной ступенькой); стартовая колонна —
    // середина между портами, зажатая в ближайший кусок полосы.
    const mid = (uAlong + dAlong) / 2;
    const holes: Array<[number, number]> = [[uAlong - Z_CLEAR, uAlong + Z_CLEAR], [dAlong - Z_CLEAR, dAlong + Z_CLEAR]];
    // просветы уже с клиренсом от тел (freeColumns) — второй отступ отнимал у коридора
    // между двумя телами 24 px и сжимал шаг строк до минимума
    let zzOrder = intervals.length;
    freeColumns(o, uAcross, dAcross, obstacles, exclude, frames, softOf?.(g.id) ?? []).forEach(([a, b]) => {
      const lo = a, hi = b;
      if (lo > hi + EPS) return;
      const pieces = subtractHoles([lo, hi], holes);
      if (pieces.length === 0) return;
      const pref = clamp(mid, lo, hi);
      // вариант на КАЖДЫЙ кусок просвета (Ф3): прежде брался лишь ближайший к середине
      // портов, а он бывает обрезком в несколько пикселей между телом и зоной своего
      // порта — колонне с подписью там не встать, широкий кусок рядом оставался невидим
      const sorted = [...pieces].sort((p, q) => {
        const dp = pref < p[0] ? p[0] - pref : pref > p[1] ? pref - p[1] : 0;
        const dq = pref < q[0] ? q[0] - pref : pref > q[1] ? pref - q[1] : 0;
        return dp - dq;
      });
      for (const piece of sorted) {
      // округление до полпикселя не должно вытолкнуть колонну за край просвета (дробные
      // позиции ELK): край — это раздутое тело, и интервалы дорожек там пусты
      let x = half(clamp(pref, piece[0], piece[1]));
      if (x < piece[0]) x += 0.5;
      if (x > piece[1]) x -= 0.5;
      if (!Number.isFinite(x) || x < piece[0] || x > piece[1]) continue;
      const i1 = laneIntervals(o, uAlong, x, uAcross, dAcross, obstacles, exclude, hard);
      const i2 = laneIntervals(o, x, dAlong, uAcross, dAcross, obstacles, exclude, hard);
      if (i1.length === 0 || i2.length === 0) { if (__zDebug.on) zlog(g.id.slice(0, 8), "zz-skip", `x=${x}`, `i1=${i1.length}`, `i2=${i2.length}`); continue; }
      // Дорожки ZZ лежат в РАЗНЫХ каналах: между ними ряд тел, который колонна обходит
      // (общий канал — дело Z). Когда колонна порта свободна, интервал одной дорожки
      // тянется через несколько каналов и накрывает интервал другой — тогда он режется
      // рядами тел на пробеге ДРУГОЙ дорожки (их колонна и обходит), и берётся кусок у
      // своего конца: так встречная пара получает вложенную ZZ рядом с ZZ близнеца.
      let b1 = i1[0], b2 = i2[i2.length - 1];   // ближние к U и к D
      if (b1[1] > b2[0] - LANE_GAP_MIN) {
        const p1 = subtractHoles(b1, bodyRows(Math.min(x, dAlong), Math.max(x, dAlong)));
        const p2 = subtractHoles(b2, bodyRows(Math.min(uAlong, x), Math.max(uAlong, x)));
        if (p1.length === 0 || p2.length === 0) { if (__zDebug.on) zlog(g.id.slice(0, 8), "zz-skip", `x=${x}`, "split empty"); continue; }
        b1 = p1[0]; b2 = p2[p2.length - 1];
        if (b1[1] > b2[0] - LANE_GAP_MIN) { if (__zDebug.on) zlog(g.id.slice(0, 8), "zz-skip", `x=${x}`, "same channel after split"); continue; }
      }
      const [b1Lo, b1Hi] = b1, [b2Lo, b2Hi] = b2;
      cands.push({
        kind: "zz", x, colLo: piece[0], colHi: piece[1], freeLo: lo, freeHi: hi, bands: [[b1Lo, b1Hi], [b2Lo, b2Hi]],
        adjU: adjacent(uAcross, b1Lo, Math.min(uAlong, x), Math.max(uAlong, x)),
        adjD: adjacent(b2Hi, dAcross, Math.min(x, dAlong), Math.max(x, dAlong)),
        detour: Math.abs(x - uAlong) + Math.abs(x - dAlong) - Math.abs(uAlong - dAlong),
        order: zzOrder++,
      });
      }
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
    edge.ix = edges.length;
    edges.push(edge);
    if (__zDebug.on) zlog(g.id.slice(0, 8), "free", freeColumns(o, uAcross, dAcross, obstacles, exclude, frames, softOf?.(g.id) ?? []).map(([a, b]) => `${a.toFixed(0)}..${b.toFixed(0)}`).join(" "), "hard", hard.map((r) => `[${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}x${r.h.toFixed(0)}]`).join(""));
    if (__zDebug.on) zlog(g.id.slice(0, 8), "cands", cands.map((c) => `${c.kind}${c.bands.map((b) => `[${b[0].toFixed(0)}..${b[1].toFixed(0)}]`).join("")}${c.kind === "zz" ? `x${c.x}(${c.colLo.toFixed(0)}..${c.colHi.toFixed(0)})` : ""}`).join(" "));
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
  // ── НОСИТЕЛЬ ПОДПИСИ (Ф3) ───────────────────────────────────────────────────────
  // Порты всех концов по сторонам узлов: чужой порт той же стороны в ширину плашки от
  // нашего — его стаб прошёл бы сквозь плашку на стабе (порты неподвижны, слот не спасёт).
  const sidePorts: Array<{ gid: string; side: EdgeSide; along: number; across: number }> = [];
  for (const g of sorted) {
    const pp = ports.get(g.id);
    if (!pp) continue;
    for (const end of [pp.s, pp.t]) {
      const o: Orient = end.side === "top" || end.side === "bottom" ? "v" : "h";
      sidePorts.push({ gid: g.id, side: end.side, along: alongOf(o, end.point), across: acrossOf(o, end.point) });
    }
  }
  const sideOf = (o: Orient, end: "u" | "d"): EdgeSide => (o === "v" ? (end === "u" ? "bottom" : "top") : (end === "u" ? "right" : "left"));
  // сторона свободна под плашку на стабе: ни одного чужого порта той же стороны (на этом
  // узле или соседе того же ряда) ближе полуширины плашки с запасом
  const sideFree = (gid: string, side: EdgeSide, along: number, across: number, thickFlow: number, lenFlow: number): boolean => {
    const dx = thickFlow / 2 + LABEL_PAD;
    return !sidePorts.some((p) => p.gid !== gid && p.side === side && Math.abs(p.along - along) < dx - EPS && Math.abs(p.across - across) <= lenFlow + 2 * LABEL_PAD);
  };
  // под слотом нет тел, чужих рамок и чужих прямых той же ориентации (bodies — тела сцены
  // без тел концов связи)
  const slotFree = (o: Orient, bodies: ReadonlyArray<NodeRect>, hard: ReadonlyArray<NodeRect>, id: string, along: number, aLo: number, aHi: number, thickFlow: number): boolean => {
    const x0 = along - thickFlow / 2 - LABEL_PAD, x1 = along + thickFlow / 2 + LABEL_PAD;
    const hits = (r: NodeRect): boolean => {
      const [a0, a1] = rectAlong(o, r);
      const [c0, c1] = rectAcross(o, r);
      return a0 < x1 - EPS && a1 > x0 + EPS && c0 < aHi - EPS && c1 > aLo + EPS;
    };
    if (bodies.some(hits)) return false;
    if (hard.some(hits)) return false;
    return !straights.some((st) => st.id !== id && st.orient === o && Math.abs(st.along - along) < thickFlow / 2 + LABEL_PAD - EPS && st.lo < aHi - EPS && st.hi > aLo + EPS);
  };
  // носитель при варианте c: стаб у D → стаб у U → колонна ZZ → самая длинная личная
  // дорожка, вмещающая плашку вдоль → нет. Стаб годится личным (не общее плечо, E95),
  // длиной в плашку с запасом (полоса дорожки у этого конца оставляет место), со
  // свободной стороной и чистым слотом. Слот стаба — вплотную к узлу: он бронирует место
  // в канале; отступ плашки от конца стрелки (Ф5, LABEL_END.clear) добавляет размещение
  // (placeLabels), когда стаб за слотом свободен от чужих линий, — сдвиг слота здесь
  // отнимал бы место у дорожек и менял маршруты (замер полигона 2026-10-12: кресты и
  // резы гуляли в обе стороны).
  const hostOf = (e: ZEdge, c: Cand): Host => {
    if (!e.label || !LABEL_HOSTS.on || e.hostOff) return "none";
    const o = e.orient;
    const need = e.lenFlow + 2 * LABEL_PAD;
    const last = c.bands[c.bands.length - 1], first = c.bands[0];
    if (e.shareD === undefined && last[0] <= e.dAcross - need + EPS
      && sideFree(e.id, sideOf(o, "d"), e.dAlong, e.dAcross, e.thickFlow, e.lenFlow)
      && slotFree(o, e.bodies, e.hard, e.id, e.dAlong, e.dAcross - need, e.dAcross, e.thickFlow)) return "dstub";
    if (e.shareU === undefined && first[1] >= e.uAcross + need - EPS
      && sideFree(e.id, sideOf(o, "u"), e.uAlong, e.uAcross, e.thickFlow, e.lenFlow)
      && slotFree(o, e.bodies, e.hard, e.id, e.uAlong, e.uAcross, e.uAcross + need, e.thickFlow)) return "ustub";
    // колонна: пробег между каналами вмещает плашку вдоль, просвет между телами — поперёк
    if (c.kind === "zz" && c.bands[1][0] - c.bands[0][1] >= need - EPS && c.freeHi - c.freeLo + 2 * Z_CLEAR >= e.thickFlow + 2 * LABEL_PAD - EPS) return "column";
    const along = e.lenLane + 2 * LABEL_PAD;
    const run0 = c.kind === "z" ? Math.abs(e.uAlong - e.dAlong) : Math.abs(e.uAlong - c.x);
    const run1 = c.kind === "zz" ? Math.abs(c.x - e.dAlong) : 0;
    const ok0 = run0 >= along && e.shareU === undefined;
    const ok1 = c.kind === "zz" && run1 >= along && e.shareD === undefined;
    if (ok0 && (!ok1 || run0 >= run1)) return "lane0";
    if (ok1) return "lane1";
    return "none";
  };
  const apply = (e: ZEdge, c: Cand): void => { applyCand(e, c); e.host = hostOf(e, c); };
  // слот подписи на стабе (across с запасом) и колонне (середина пробега между дорожками)
  const slotOfHost = (e: ZEdge): [number, number] | null => {
    const need = e.lenFlow + 2 * LABEL_PAD;
    if (e.host === "dstub") return [e.dAcross - need, e.dAcross];
    if (e.host === "ustub") return [e.uAcross, e.uAcross + need];
    if (e.host === "column" && e.lanes.length === 2 && e.lanes[1] - e.lanes[0] >= need - EPS) {
      const mid = (e.lanes[0] + e.lanes[1]) / 2;
      return [mid - need / 2, mid + need / 2];
    }
    return null;
  };
  const hostAlong = (e: ZEdge): number => (e.host === "dstub" ? e.dAlong : e.host === "ustub" ? e.uAlong : e.x);
  // прямоугольник плашки на носителе (с запасом) в координатах сцены; null — носителя нет
  const slotRectOf = (e: ZEdge): NodeRect | null => {
    const o = e.orient;
    const slot = slotOfHost(e);
    if (slot) {
      const a = hostAlong(e), hw = e.thickFlow / 2 + LABEL_PAD;
      const p0 = mk(o, a - hw, slot[0]), p1 = mk(o, a + hw, slot[1]);
      return { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) };
    }
    if (e.host === "lane0" || e.host === "lane1") {
      const k = e.host === "lane0" ? 0 : 1;
      const a0 = k === 0 ? e.uAlong : e.x, a1 = k === 0 ? (e.kind === "z" ? e.dAlong : e.x) : e.dAlong;
      const mid = (a0 + a1) / 2, hl = e.lenLane / 2 + LABEL_PAD, ht = e.thickLane / 2 + LABEL_PAD;
      const p0 = mk(o, mid - hl, e.lanes[k] - ht), p1 = mk(o, mid + hl, e.lanes[k] + ht);
      return { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) };
    }
    return null;
  };
  // осевой отрезок заходит внутрь прямоугольника (глубже EPS)
  const segInRect = (p: EdgePoint, q: EdgePoint, r: NodeRect): boolean => {
    const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x), y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
    return x1 > r.x + EPS && x0 < r.x + r.w - EPS && y1 > r.y + EPS && y0 < r.y + r.h - EPS;
  };
  // прямые с подписью: слот — середина прямой, если она длиннее плашки с запасом, стороны
  // обоих концов свободны и под слотом чисто
  for (const st of straights) {
    if (!st.label || !LABEL_HOSTS.on) continue;
    const lenFlow = st.orient === "v" ? st.label.h : st.label.w;
    const thickFlow = st.orient === "v" ? st.label.w : st.label.h;
    const need = lenFlow + 2 * LABEL_PAD;
    if (st.hi - st.lo < need - EPS) continue;
    const mid = (st.lo + st.hi) / 2;
    const slot: [number, number] = [mid - need / 2, mid + need / 2];
    const g = groups.find((x) => x.id === st.id);
    const excl = g ? [rectOf(g.source), rectOf(g.target)].filter((r): r is NodeRect => !!r) : [];
    if (!sideFree(st.id, sideOf(st.orient, "u"), st.along, st.lo, thickFlow, lenFlow)) continue;
    if (!sideFree(st.id, sideOf(st.orient, "d"), st.along, st.hi, thickFlow, lenFlow)) continue;
    const stBodies = obstacles.filter((r) => !excl.some((e) => sameRect(e, r)));
    if (!slotFree(st.orient, stBodies, hardOf?.(st.id) ?? [], st.id, st.along, slot[0], slot[1], thickFlow)) continue;
    st.slot = slot;
    st.thick = thickFlow + 2 * LABEL_PAD;
  }
  const segsOf = (o: Orient): Seg[] => {
    const out: Seg[] = [];
    for (const e of edges) {
      const c = e.cand;
      if (!c) continue;
      if (e.orient === o) {
        // носитель на стабе: полоса дорожки у этого конца оставляет стабу длину плашки с
        // запасом; носитель на дорожке — толщина поперёк
        const need = e.lenFlow + 2 * LABEL_PAD;
        const tLane = e.thickLane + 2 * LABEL_PAD;
        const nB = c.bands.length;
        const bandOf = (k: number): [number, number] => {
          let [lo, hi] = c.bands[k];
          if (e.host === "dstub" && k === nB - 1) hi = Math.min(hi, e.dAcross - need);
          if (e.host === "ustub" && k === 0) lo = Math.max(lo, e.uAcross + need);
          return [lo, hi];
        };
        const [b0lo, b0hi] = bandOf(0);
        if (e.kind === "z") {
          out.push({
            edge: e, members: [e], share: shareKeyOf(e, 0), orient: o, idx: 0,
            verts: [{ along: e.uAlong, dir: "up" }, { along: e.dAlong, dir: "down" }],
            lo: Math.min(e.uAlong, e.dAlong), hi: Math.max(e.uAlong, e.dAlong),
            bandLo: b0lo, bandHi: b0hi, slot: e.slots[0], lane: e.lanes[0], thick: e.host === "lane0" ? tLane : 0,
          });
        } else {
          const [b1lo, b1hi] = bandOf(1);
          out.push({
            edge: e, members: [e], share: shareKeyOf(e, 0), orient: o, idx: 0,
            verts: [{ along: e.uAlong, dir: "up" }, { along: e.x, dir: "down" }],
            lo: Math.min(e.uAlong, e.x), hi: Math.max(e.uAlong, e.x),
            bandLo: b0lo, bandHi: b0hi, slot: e.slots[0], lane: e.lanes[0], thick: e.host === "lane0" ? tLane : 0,
          });
          out.push({
            edge: e, members: [e], share: shareKeyOf(e, 1), orient: o, idx: 1,
            verts: [{ along: e.x, dir: "up" }, { along: e.dAlong, dir: "down" }],
            lo: Math.min(e.x, e.dAlong), hi: Math.max(e.x, e.dAlong),
            bandLo: b1lo, bandHi: b1hi, slot: e.slots[1], lane: e.lanes[1], thick: e.host === "lane1" ? tLane : 0,
          });
        }
      } else if (e.kind === "zz") {
        // колонна ZZ в поперечной ориентации: across — сама колонна, пробег — между
        // дорожками; вертикали на концах уходят к портовым рядам (вверх, если ряд выше);
        // колонна-носитель подписи — с толщиной плашки
        const l0 = e.lanes[0], l1 = e.lanes[1];
        const tCol = e.host === "column" ? e.thickFlow + 2 * LABEL_PAD : 0;
        // полоса колонны-носителя: край плашки держит запас от тел просвета (клиренс уже в
        // просвете), зоны собственных портовых рядов плашке не помеха
        const sh = Math.max(0, tCol / 2 - Z_CLEAR);
        const bLo = tCol > 0 ? Math.max(e.colLo, e.freeLo + sh) : e.colLo;
        const bHi = tCol > 0 ? Math.min(e.colHi, e.freeHi - sh) : e.colHi;
        const fits = tCol > 0 && bHi >= bLo - EPS;
        out.push({
          edge: e, members: [e], orient: o, idx: 2,
          verts: [{ along: l0, dir: e.uAlong < e.x ? "up" : "down" }, { along: l1, dir: e.dAlong < e.x ? "up" : "down" }],
          lo: Math.min(l0, l1), hi: Math.max(l0, l1), bandLo: fits ? bLo : e.colLo, bandHi: fits ? bHi : e.colHi, slot: 0, lane: e.x,
          thick: fits ? tCol : 0, preShrunk: true,
        });
      }
    }
    return mergeShared(out);
  };
  // СТВОЛЫ: сегменты одного общего плеча с пересекающимися полосами сливаются в один
  // (вертикали — объединение, пробег — охват, полоса — пересечение); несовместимые по
  // полосе члены образуют второй ствол ниже по стволу первого. Части запоминаются на самом
  // стволе (Seg.parts), чтобы вернуть дорожку каждому члену; прежняя карта «ствол → части»
  // на весь вызов копила тысячи мёртвых сегментов.
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
            lane: (c0.lane * last.parts.length + sg.lane) / (last.parts.length + 1), thick: 0,
          };
          last.parts.push(sg);
          continue;
        }
        runs.push({ seg: { ...sg }, parts: [sg] });
      }
      for (const r of runs) {
        if (r.parts.length > 1) r.seg.parts = r.parts;
        out.push(r.seg);
      }
    }
    return out;
  };
  // Неподвижные отрезки, параллельные дорожкам ориентации o: стабы и прямые связей
  // поперечной ориентации (их along — across для o).
  const fixedCols = new FixedCols();
  const fixedOf = (o: Orient): FixedCols => {
    const out = fixedCols;
    out.n = 0;
    for (const e of edges) {
      if (!e.cand) continue;
      const slot = slotOfHost(e);
      if (e.orient !== o) {
        const first = e.lanes[0], last = e.lanes[e.lanes.length - 1];
        out.add(e.ix, e.uAlong, Math.min(e.uAcross, first), Math.max(e.uAcross, first), 0, false);
        out.add(e.ix, e.dAlong, Math.min(last, e.dAcross), Math.max(last, e.dAcross), 0, false);
        // стаб-носитель подписи: на пробеге слота — толщина плашки
        if (slot && (e.host === "dstub" || e.host === "ustub")) {
          out.add(e.ix, hostAlong(e), slot[0], slot[1], e.thickFlow + 2 * LABEL_PAD, false);
        }
      } else if (slot) {
        // слот подписи на отрезке потока — поперечное препятствие дорожкам этой ориентации
        const a = hostAlong(e);
        out.add(e.ix, (slot[0] + slot[1]) / 2, a - e.thickFlow / 2 - LABEL_PAD, a + e.thickFlow / 2 + LABEL_PAD, slot[1] - slot[0], true);
      }
    }
    for (const s of straights) {
      if (s.orient !== o) {
        out.add(-1, s.along, Math.min(s.lo, s.hi), Math.max(s.lo, s.hi), 0, false);
        if (s.slot) out.add(-1, s.along, s.slot[0], s.slot[1], s.thick, false);
      } else if (s.slot) {
        const half2 = s.thick / 2;
        out.add(-1, (s.slot[0] + s.slot[1]) / 2, s.along - half2, s.along + half2, s.slot[1] - s.slot[0], true);
      }
    }
    return out;
  };
  // ПРОХОД ПО ПОЛОСАМ: взаимодействие требует перекрытия полос (min(bandHi) − max(bandLo) ≥
  // −EPS). У сегмента b после a в порядке bandLo это перекрытие не больше a.bandHi − b.bandLo,
  // а дальше по bandLo оно только убывает — проход по парам (a, b) обрывается, как только
  // a.bandHi − b.bandLo < −EPS. Полосы уже пробегов, и пар-кандидатов вдвое-вчетверо меньше,
  // чем при проходе по lo (замер hub50-expand: 2,7 млн против 5,8 млн у дорожек «v»). NaN в
  // полосе ломает порядок сортировки — тогда false, и вызывающий идёт прежним путём.
  const bandOrder = (S: ReadonlyArray<Seg>): number[] | null => {
    for (const sg of S) if (Number.isNaN(sg.bandLo) || Number.isNaN(sg.bandHi)) return null;
    return S.map((_, k) => k).sort((a, b) => S[a].bandLo - S[b].bandLo || a - b);
  };
  const eachBandPair = (S: ReadonlyArray<Seg>, order: ReadonlyArray<number>, fn: (i: number, j: number) => void): void => {
    const n = order.length;
    for (let p = 0; p < n; p++) {
      const ia = order[p], a = S[ia];
      for (let q = p + 1; q < n; q++) {
        const ib = order[q], b = S[ib];
        if (!(a.bandHi - b.bandLo >= -EPS)) break;
        if (interacts(a, b)) fn(ia, ib);
      }
    }
  };
  // Общий член (одна связь в обоих сегментах) — не взаимодействие. У несклеенных сегментов
  // по одному члену, и проверка сводится к сравнению двух связей (быстрый путь).
  const interacts = (a: Seg, b: Seg): boolean => {
    const am = a.members, bm = b.members;
    if (am.length === 1 && bm.length === 1) { if (am[0] === bm[0]) return false; }
    else if (am.some((m) => bm.includes(m))) return false;
    return runOverlap(a, b) > -NUDGE_GAP && Math.min(a.bandHi, b.bandHi) - Math.max(a.bandLo, b.bandLo) >= -EPS;
  };

  // Раздача дорожек одной ориентации: компоненты по перекрытию пробега (с зазором) и
  // полос, внутри — зависимости, разрыв циклов, топологические номера, позиции через
  // решатель. hints — собирать ли свободные дорожки (финальный вызов).
  // Раздача одной компоненты: зависимости пар, разрыв циклов, номера дорожек, позиции.
  // ks — номера сегментов компоненты в списке раздачи (адреса в таблице применимых app).
  const edgeIds = edges.map((e) => e.id);
  const appTable = new AppTable();
  const solveComp = (M: Seg[], ks: ReadonlyArray<number>, F: FixedCols): CompResult => {
    const m = M.length;
    const pairs = interactingPairs(M);
    const deps: Dep[] = [];
    for (const code of pairs) {
      const i = (code / m) | 0, j = code - i * m;
      pairDeps(deps, i, j, M[i], M[j]);
    }
    const slots = slotsOf(m, breakCycles(m, deps));
    const { lanes, gap } = distribute(M, slots, pairs, ks, appTable, F, edgeIds);
    return { slots, lanes, gap };
  };
  // Взаимодействующие пары сегментов компоненты (interacts), закодированные i·m + j (i < j)
  // по возрастанию — в порядке прежнего перебора всех пар. У больших компонент пары с
  // перекрытием пробега ищутся проходом по сегментам в порядке lo (как в assignFull), потом
  // сортируются в порядок (i, j).
  const interactingPairs = (M: Seg[]): number[] => {
    const m = M.length, out: number[] = [];
    const order = m > 8 ? bandOrder(M) : null;
    if (!order) {
      for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) if (interacts(M[i], M[j])) out.push(i * m + j);
      return out;
    }
    eachBandPair(M, order, (ia, ib) => { out.push(ia < ib ? ia * m + ib : ib * m + ia); });
    return out.sort((x, y) => x - y);
  };
  // ПАМЯТЬ РАЗДАЧИ КОМПОНЕНТЫ. Результат компоненты зависит только от её сегментов (в их
  // порядке: разрыв циклов идёт по индексам) и применимых к ним препятствий. При пробе одной
  // связи почти все компоненты получают ровно те же входы, что в прошлый раз, и берутся из
  // памяти. Ключ — все числа, которые читает solveComp (pairDeps, tieBreak, distribute,
  // interacts):
  //   сегмент — вид (idx), члены (номера связей; первый — владелец: его uAlong/dAlong читает
  //   tieBreak, они в вызове неизменны), вертикали (along, направление), пробег, полоса,
  //   толщина, preShrunk; дорожка — только при бесконечной полосе (её читают natural и
  //   tieBreak, при конечной — середина полосы); у колонны — естественное место (cand.x);
  //   препятствие — pos, толщина и вид: обычный отрезок либо слот со стороной вертикали
  //   (up/down). Пробег препятствия и его связь участвуют лишь в применимости, она уже
  //   отражена составом списка.
  // ДВА УРОВНЯ. Первый ключ берёт из препятствий только ближние записи (AppTable) и признак
  // «применимые есть вообще»: без них сегмент разрешение пропускает, а с одними дальними
  // проходит его (при бесконечной желаемой позиции кусок не находится, и толщина
  // деградирует). Дальние ничего не режут, пока куски полосы широкие, а флаги таблицы (есть
  // слот, есть толщина) при одних дальних лишь добавляют вариант разрешения, равный уже
  // выбранному. Пока ни одно разрешение не перешло на полный проход (narrowSeen), итог —
  // функция первого ключа; был ли переход, решают те же входы. Запись первого уровня
  // помнит, был ли он: если был, итог ищется во втором уровне по полному ключу (все
  // применимые записи), как прежде.
  // Ближние записи — подмножество полного списка, поэтому с ним ключ первого уровня короче,
  // а сдвиг дальнего чужого стаба по сцене компоненту больше не пересчитывает.
  const compMemo = new ExactMemo<{ res: CompResult | null }>(COMP_MEMO_LIMIT);
  const compMemoFull = new ExactMemo<CompResult>(COMP_MEMO_LIMIT);
  const compKey = new ExactKey();
  const keyOfCompNear = (M: Seg[], ks: ReadonlyArray<number>, F: FixedCols): void => {
    const k = compKey, app = appTable;
    k.reset();
    k.push(M.length);
    for (let i = 0; i < M.length; i++) {
      const s = M[i];
      k.push(s.idx);
      k.push(s.members.length);
      for (const mem of s.members) k.push(mem.ix);
      k.push(s.verts.length);
      for (const v of s.verts) { k.push(v.along); k.push(v.dir === "up" ? 0 : 1); }
      k.push(s.lo); k.push(s.hi); k.push(s.bandLo); k.push(s.bandHi);
      k.push(Number.isFinite(s.bandLo) && Number.isFinite(s.bandHi) ? 0 : s.lane);
      k.push(s.thick); k.push(s.preShrunk ? 1 : 0);
      k.push(s.idx === 2 ? (s.edge.cand?.x ?? s.lane) : 0);
      const t0 = app.nStart[ks[i]], t1 = app.nStart[ks[i] + 1];
      k.push(app.start[ks[i] + 1] > app.start[ks[i]] ? 1 : 0);
      k.push(t1 - t0);
      for (let t = t0; t < t1; t++) { const q = app.nq[t], f = app.fi[q]; k.push(F.pos[f]); k.push(F.thick[f]); k.push(app.code[q]); }
    }
  };
  const keyOfComp = (M: Seg[], ks: ReadonlyArray<number>, F: FixedCols): void => {
    const k = compKey, app = appTable;
    k.reset();
    k.push(M.length);
    for (let i = 0; i < M.length; i++) {
      const s = M[i];
      k.push(s.idx);
      k.push(s.members.length);
      for (const mem of s.members) k.push(mem.ix);
      k.push(s.verts.length);
      for (const v of s.verts) { k.push(v.along); k.push(v.dir === "up" ? 0 : 1); }
      k.push(s.lo); k.push(s.hi); k.push(s.bandLo); k.push(s.bandHi);
      k.push(Number.isFinite(s.bandLo) && Number.isFinite(s.bandHi) ? 0 : s.lane);
      k.push(s.thick); k.push(s.preShrunk ? 1 : 0);
      k.push(s.idx === 2 ? (s.edge.cand?.x ?? s.lane) : 0);
      const q0 = app.start[ks[i]], q1 = app.start[ks[i] + 1];
      k.push(q1 - q0);
      for (let q = q0; q < q1; q++) { const f = app.fi[q]; k.push(F.pos[f]); k.push(F.thick[f]); k.push(app.code[q]); }
    }
  };
  // Большие компоненты (канал во всю ширину уровня) меняются почти с каждой пробой: их
  // повторы ловит память раздачи ориентации, а своя память попадает в единицы процентов
  // (замер: 3–8% у компонент из 41+ сегментов) и тратит время на длинный ключ — её нет.
  const COMP_MEMO_MAX = 20;
  const checkComp = (hit: CompResult, M: Seg[], ks: ReadonlyArray<number>, F: FixedCols, name: string): void => {
    const honest = solveComp(M, ks, F);
    selfCheckAssert(sameNums(hit.slots, honest.slots) && sameNums(hit.lanes, honest.lanes) && sameNum(hit.gap, honest.gap), name);
  };
  const solveFull = (M: Seg[], ks: ReadonlyArray<number>, F: FixedCols, known: CompResult | null): CompResult => {
    keyOfComp(M, ks, F);
    const h = compKey.hash();
    const hit = compMemoFull.get(h, compKey);
    if (hit) {
      if (selfCheck) checkComp(hit, M, ks, F, "раздача компоненты (полный ключ)");
      return hit;
    }
    const res = known ?? solveComp(M, ks, F);
    compMemoFull.put(h, compKey, res);
    return res;
  };
  const solveCompMemo = (M: Seg[], ks: ReadonlyArray<number>, F: FixedCols): CompResult => {
    if (!cacheOn || M.length > COMP_MEMO_MAX) return solveComp(M, ks, F);
    keyOfCompNear(M, ks, F);
    const h = compKey.hash();
    const hit = compMemo.get(h, compKey);
    if (hit) {
      if (hit.res === null) return solveFull(M, ks, F, null);
      if (selfCheck) checkComp(hit.res, M, ks, F, "раздача компоненты (ближние препятствия)");
      return hit.res;
    }
    narrowSeen = false;
    const res = solveComp(M, ks, F);
    const narrow = narrowSeen;
    // ключ первого уровня ещё в compKey: запись — до того, как его сменит полный ключ
    compMemo.put(h, compKey, { res: narrow ? null : res });
    return narrow ? solveFull(M, ks, F, res) : res;
  };
  // Раздача ориентации o целиком. rec — запись того, что она пишет в связи (для памяти
  // раздачи ориентации): четвёрки «номер связи, вид отрезка (0/1 — дорожка, 2 — колонна),
  // позиция, номер дорожки».
  const assignFull = (o: Orient, hints: boolean, rec: number[] | null): void => {
    const S = segsOf(o);
    const n = S.length;
    if (n === 0) return;
    const F = fixedOf(o);
    appTable.build(S, F);
    const parent = S.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    // Компоненты: пары взаимодействующих сегментов проходом по полосам (eachBandPair).
    // Разбиение на компоненты и их порядок (по меньшему номеру сегмента) от порядка слияний не
    // зависят. NaN в полосе — прежний полный перебор пар.
    const order = bandOrder(S);
    if (order) {
      eachBandPair(S, order, (ia, ib) => { parent[find(ia)] = find(ib); });
    } else {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) if (interacts(S[i], S[j])) parent[find(i)] = find(j);
      }
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
      const { slots, lanes, gap } = solveCompMemo(M, members, F);
      M.forEach((s, i) => {
        s.slot = slots[i];
        s.lane = lanes[i];
        for (const part of s.parts ?? [s]) {
          if (part.idx === 2) part.edge.x = s.lane;
          else { part.edge.lanes[part.idx] = s.lane; part.edge.slots[part.idx] = s.slot; }
          if (rec) rec.push(part.edge.ix, part.idx, s.lane, s.slot);
        }
      });
      if (__zDebug.on && (hints || (__zDebug.trace && M.some((s) => s.edge.id.startsWith(__zDebug.trace)))) && m > 1) zlog("comp", o, M.map((s) => `${s.edge.id.slice(0, 8)}#${s.idx}[${s.bandLo.toFixed(0)}..${s.bandHi.toFixed(0)}|${s.lo.toFixed(0)}..${s.hi.toFixed(0)}]s${s.slot}@${s.lane}`).join(" "));
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
  // ПАМЯТЬ РАЗДАЧИ ОРИЕНТАЦИИ. Почти каждая проба делает два круга раздачи, и второй круг
  // обычно лишь подтверждает первый: его входы совпадают с входами первого. Раздача
  // ориентации — функция того, что читают segsOf и fixedOf; ключ — ровно эти числа по
  // связям, а свои же итоги, которые раздача не читает, в него не входят (иначе второй круг
  // всегда отличался бы от первого):
  //   у каждой связи — вариант и носитель подписи;
  //   связь этой ориентации — колонна у ZZ (вертикали дорожек), дорожки у носителя-колонны
  //   (его слот — препятствие); свои дорожки она иначе не читает (полосы дорожек конечны,
  //   и natural/tieBreak берут середину полосы; нечисловая полоса — дорожки в ключе);
  //   связь поперечной ориентации — крайние дорожки (стабы и пробег колонны), у ZZ — по какую
  //   сторону от колонны лежат порты (направления вертикалей колонны) и сама колонна, если
  //   её полоса не конечна (её читают natural и tieBreak).
  // Попадание повторяет записи прошлой раздачи с тем же ключом. С подсказками A* (финальный
  // вызов) раздача считается всегда.
  const HOST_CODE: Record<Host, number> = { none: 0, dstub: 1, ustub: 2, column: 3, lane0: 4, lane1: 5 };
  const assignKey = new ExactKey();
  const assignMemo = new ExactMemo<number[]>(COMP_MEMO_LIMIT);
  // варианты с нечисловой полосой дорожки (на деле их не бывает): при таком варианте у любой
  // связи ориентации полоса ствола может стать нечисловой, и тогда дорожки всех её связей
  // читаются (natural, tieBreak, средняя дорожка ствола) — они идут в ключ
  const openCands = new Set<Cand>();
  for (const e of edges) for (const c of e.cands) if (!c.bands.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b))) openCands.add(c);
  const keyOfAssign = (o: Orient): void => {
    const k = assignKey;
    k.reset();
    k.push(o === "v" ? 0 : 1);
    const open = openCands.size > 0 && edges.some((e) => e.orient === o && e.cand !== null && openCands.has(e.cand));
    for (const e of edges) {
      k.push(e.cand ? e.cands.indexOf(e.cand) : -1);
      k.push(HOST_CODE[e.host]);
      if (e.orient === o) {
        if (e.kind === "zz") k.push(e.x);
        const ownLanes = e.host === "column" || open;
        k.push(ownLanes ? 1 : 0);
        if (ownLanes) for (const v of e.lanes) k.push(v);
      } else {
        k.push(e.lanes[0]); k.push(e.lanes[e.lanes.length - 1]);
        if (e.kind === "zz") {
          k.push(e.uAlong < e.x ? 1 : 0); k.push(e.dAlong < e.x ? 1 : 0);
          k.push(Number.isFinite(e.colLo) && Number.isFinite(e.colHi) ? 0 : e.x);
        }
      }
    }
  };
  const replay = (rec: ReadonlyArray<number>): void => {
    for (let q = 0; q < rec.length; q += 4) {
      const e = edges[rec[q]], idx = rec[q + 1];
      if (idx === 2) e.x = rec[q + 2];
      else { e.lanes[idx] = rec[q + 2]; e.slots[idx] = rec[q + 3]; }
    }
  };
  const assign = (o: Orient, hints: boolean): void => {
    if (!cacheOn || hints) { assignFull(o, hints, null); return; }
    keyOfAssign(o);
    const h = assignKey.hash();
    const hit = assignMemo.get(h, assignKey);
    if (hit) {
      if (selfCheck) {
        const honest: number[] = [];
        assignFull(o, false, honest);
        selfCheckAssert(sameNums(hit, honest), "раздача ориентации");
      }
      replay(hit);
      return;
    }
    const rec: number[] = [];
    // assignFull не трогает ключ (у памяти компонент свой), запись идёт по нему же
    assignFull(o, false, rec);
    assignMemo.put(h, assignKey, rec);
  };
  // Обе ориентации кругами до сходимости (дорожки и колонны зависят друг от друга:
  // первый круг может упорядочить колонны по дорожкам-серединам, и только следующий
  // круг дорожек увидит настоящие колонны); первой — ориентация большинства связей.
  // Потолок кругов — защита от качелей; на сценах полигона сходится за 2–3.
  const nV = edges.filter((e) => e.orient === "v").length;
  const order: Orient[] = nV >= edges.length - nV ? ["v", "h"] : ["h", "v"];
  const MAX_ROUNDS = 4;
  // Снимок переменных раздачи (дорожки и колонна каждой связи) для проверки сходимости —
  // в два переиспользуемых буфера: длина дорожек связи внутри раздачи не меняется.
  let snapA = new Float64Array(0), snapB = new Float64Array(0);
  const snapshot = (buf: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> => {
    let n = 0;
    for (const e of edges) n += e.lanes.length + 1;
    const out = buf.length === n ? buf : new Float64Array(n);
    let k = 0;
    for (const e of edges) {
      for (const v of e.lanes) out[k++] = v;
      out[k++] = e.x;
    }
    return out;
  };
  const assignLanes = (hints: boolean): void => {
    let prev = snapA = snapshot(snapA);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS - 1;
      for (const o of order) assign(o, hints && last);
      const cur = prev === snapA ? (snapB = snapshot(snapB)) : (snapA = snapshot(snapA));
      let same = true;
      for (let k = 0; k < cur.length; k++) {
        const v = cur[k], p = prev[k];
        if (v !== p && !(Number.isNaN(v) && Number.isNaN(p))) { same = false; break; }
      }
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
    if (pathCrossesRects(pts, e.blockers)) return null;
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
  const costParts = { cr: 0, ov: 0, inv: 0, det: 0, lost: 0, ovPairs: [] as string[], crPairs: [] as string[] };
  // прямые пар одной колонны — тоже маршруты сцены: колонна ZZ, режущая прямую, стоит
  // креста, иначе ZZ сквозь прямую «бесплатна» и побеждает чистый Z
  const straightPts: EdgePoint[][] = [];
  for (const [id, pts] of routes) if (pts.length === 2 && straights.length > 0 && groups.some((g) => g.id === id)) straightPts.push(pts);
  // ПАМЯТЬ МАРШРУТОВ, ПАР И СЛОТОВ (см. «ПАМЯТЬ ПРОБ СПУСКА»). Маршрут связи — чистая
  // функция её геометрии (вид, дорожки, колонна; порты и тела в вызове неизменны): связь
  // помнит последние ROUTE_RECENT геометрий с маршрутами, и каждый маршрут несёт номер.
  // Отвергнутая проба сдвигает дорожки соседей, следующая возвращает их на прежние места —
  // возвращённый маршрут сохраняет прежний номер. Кресты и наложение пары зависят только от
  // двух маршрутов, касание слота подписи чужой линией — от слота и маршрута: их результаты
  // держатся по номерам (у пары — PAIR_WAYS последних сочетаний) и пересчитываются только
  // для новых сочетаний. Цена собирается из тех же слагаемых в прежнем порядке: связи
  // (недопустимые, крюки), пары (i, j) — наложения и кресты в порядке первого появления
  // точки, потерянные носители по связям.
  interface BuiltRoute { kind: "z" | "zz"; l0: number; l1: number; x: number; pts: EdgePoint[] | null; id: number; box: Box }
  const ROUTE_RECENT = 8, PAIR_WAYS = 4;
  let routeSerial = 0;
  const routeRecent: BuiltRoute[][] = edges.map(() => []);
  const routeOf = (e: ZEdge): BuiltRoute => {
    const zz = e.kind === "zz";
    const l0 = e.lanes[0], l1 = zz ? e.lanes[1] : 0, x = zz ? e.x : 0;
    const recent = routeRecent[e.ix];
    if (cacheOn) {
      for (let k = 0; k < recent.length; k++) {
        const m = recent[k];
        if (m.kind !== e.kind || !sameNum(m.l0, l0) || !sameNum(m.l1, l1) || !sameNum(m.x, x)) continue;
        if (selfCheck) selfCheckAssert(samePts(m.pts, buildRoute(e)), "маршрут связи");
        if (k > 0) { recent.splice(k, 1); recent.unshift(m); }
        return m;
      }
    }
    const pts = buildRoute(e);
    const r: BuiltRoute = { kind: e.kind, l0, l1, x, pts, id: ++routeSerial, box: pts ? boxOf(pts) : NO_BOX };
    recent.unshift(r);
    if (recent.length > ROUTE_RECENT) recent.pop();
    return r;
  };
  // МЕСТА МАРШРУТОВ: прямая k — место k, связь — место nS + её номер; места растут в порядке
  // обхода цены (сначала прямые, потом связи), пара мест (a < b) — ячейка a × nP + b.
  const nS = straightPts.length, nP = nS + edges.length;
  const placeEdge: Array<ZEdge | null> = [...straightPts.map(() => null), ...edges];
  const placePts: EdgePoint[][] = [...straightPts, ...edges.map(() => [])];
  const straightIds = straightPts.map(() => ++routeSerial);
  // габариты маршрутов мест (x0, x1, y0, y1 подряд) — отсев далёких пар
  const placeBox = new Float64Array(nP * 4);
  straightPts.forEach((pts, k) => placeBox.set(boxOf(pts), 4 * k));
  const nameOf = (p: number): string => { const e = placeEdge[p]; return e ? e.id.slice(0, 8) : "straight"; };
  // память пар: ячейка — PAIR_WAYS записей (номера маршрутов, кресты, наложение) по кругу
  const NO_KEYS: CrossKey[] = [];
  const pairIdA = new Int32Array(nP * nP * PAIR_WAYS), pairIdB = new Int32Array(nP * nP * PAIR_WAYS);   // 0 — пусто
  const pairOv = new Uint8Array(nP * nP * PAIR_WAYS);
  const pairNext = new Uint8Array(nP * nP);
  const pairKeys: CrossKey[][] = new Array<CrossKey[]>(nP * nP * PAIR_WAYS).fill(NO_KEYS);
  // РАЗРЕЖЕННАЯ СУММА ПАР. Слагаемые дают только пары с крестами или наложением, таких
  // немного. Пара пересчитывается (через память пар), лишь когда сменился маршрут одного из
  // её мест; у каждого места — список ненулевых партнёров с большими местами по возрастанию,
  // и сумма обходит их в порядке (a, b), том же, что полный перебор пар (нулевые пары
  // слагаемых не дают). regId — номер маршрута места, по которому посчитаны его пары (0 —
  // места нет: маршрута нет, связь уступила A*).
  const regId = new Int32Array(nP), newId = new Int32Array(nP);
  const curKeys: CrossKey[][] = new Array<CrossKey[]>(nP * nP).fill(NO_KEYS);
  const curOv = new Uint8Array(nP * nP);
  const nzRow: number[][] = Array.from({ length: nP }, () => []);
  const changedMark = new Uint8Array(nP);
  // ОТСЕВ ДАЛЁКИХ ПАР. Крест лежит внутри отрезков обеих ломаных, то есть в габаритах обеих;
  // наложение — отрезки ближе LANE_GAP_MIN поперёк с общим пробегом вдоль, то есть габариты
  // сходятся ближе LANE_GAP_MIN. Пара, чьи габариты, раздутые на LANE_GAP_MIN (+1 px на
  // округление), не касаются, ни креста, ни наложения не даёт — по построению, без расчёта.
  const NEAR_PAD = LANE_GAP_MIN + 1;
  const near = (a: number, b: number): boolean => {
    const A = 4 * a, B = 4 * b, bx = placeBox;
    return bx[A] - NEAR_PAD <= bx[B + 1] && bx[B] - NEAR_PAD <= bx[A + 1] && bx[A + 2] - NEAR_PAD <= bx[B + 3] && bx[B + 2] - NEAR_PAD <= bx[A + 3];
  };
  // кресты и наложение пары мест a < b с маршрутами по номерам newId; ложь — пара нулевая
  const pairAt = (a: number, b: number): boolean => {
    if (!near(a, b)) {
      if (selfCheck) selfCheckAssert(crossingKeys(placePts[a], placePts[b]).length === 0 && !overlapping(placePts[a], placePts[b]), "отсев далёких пар");
      return false;
    }
    const cell = a * nP + b, idA = newId[a], idB = newId[b];
    const ea = placeEdge[a], eb = placeEdge[b];
    let way = -1;
    if (cacheOn) {
      for (let w = cell * PAIR_WAYS, w1 = w + PAIR_WAYS; w < w1; w++) if (pairIdA[w] === idA && pairIdB[w] === idB) { way = w; break; }
    }
    if (way >= 0) {
      const keys = pairKeys[way], ov = pairOv[way];
      if (selfCheck) {
        const k2 = crossingKeys(placePts[a], placePts[b]);
        const ov2 = !(ea !== null && eb !== null && sharesEnd(ea, eb)) && overlapping(placePts[a], placePts[b]);
        selfCheckAssert((ov2 ? 1 : 0) === ov && k2.length === keys.length && k2.every((k, n) => k === keys[n]), "пара маршрутов");
      }
      curKeys[cell] = keys; curOv[cell] = ov;
      return keys.length > 0 || ov === 1;
    }
    const k2 = crossingKeys(placePts[a], placePts[b]);
    const keys = k2.length > 0 ? k2 : NO_KEYS;
    const ov = !(ea !== null && eb !== null && sharesEnd(ea, eb)) && overlapping(placePts[a], placePts[b]) ? 1 : 0;
    const w = cell * PAIR_WAYS + pairNext[cell];
    pairNext[cell] = (pairNext[cell] + 1) % PAIR_WAYS;
    pairIdA[w] = idA; pairIdB[w] = idB; pairKeys[w] = keys; pairOv[w] = ov;
    curKeys[cell] = keys; curOv[cell] = ov;
    return keys.length > 0 || ov === 1;
  };
  // ненулевой партнёр b в строке места a (по возрастанию)
  const rowSet = (a: number, b: number, nz: boolean): void => {
    const row = nzRow[a];
    let k = 0;
    while (k < row.length && row[k] < b) k++;
    const has = k < row.length && row[k] === b;
    if (nz && !has) row.splice(k, 0, b);
    else if (!nz && has) row.splice(k, 1);
  };
  // слот подписи связи: последние прямоугольники с номерами (как у маршрутов); память
  // «слот × маршрут места» — PAIR_WAYS записей на ячейку (номер слота, номер маршрута, режет ли)
  const lostRects: Array<Array<{ r: NodeRect; gen: number }>> = edges.map(() => []);
  let lostSerial = 0;
  const lostAtGen = new Int32Array(edges.length * nP * PAIR_WAYS), lostAtId = new Int32Array(edges.length * nP * PAIR_WAYS);
  const lostAtHit = new Uint8Array(edges.length * nP * PAIR_WAYS);
  const lostNext = new Uint8Array(edges.length * nP);
  const slotGen = (e: ZEdge, r: NodeRect): number => {
    const recent = lostRects[e.ix];
    if (cacheOn) {
      for (let k = 0; k < recent.length; k++) {
        const q = recent[k].r;
        if (!sameNum(q.x, r.x) || !sameNum(q.y, r.y) || !sameNum(q.w, r.w) || !sameNum(q.h, r.h)) continue;
        const it = recent[k];
        if (k > 0) { recent.splice(k, 1); recent.unshift(it); }
        return it.gen;
      }
    }
    const gen = ++lostSerial;
    recent.unshift({ r, gen });
    if (recent.length > ROUTE_RECENT) recent.pop();
    return gen;
  };
  const slotCut = (pts: EdgePoint[], r: NodeRect): boolean => {
    for (let k = 1; k < pts.length; k++) if (segInRect(pts[k - 1], pts[k], r)) return true;
    return false;
  };
  // режет ли маршрут места p слот r (номер gen) связи e; отрезок, заходящий внутрь слота,
  // лежит в габаритах маршрута — маршрут, чьи габариты слота не касаются, его не режет
  const cutAt = (e: ZEdge, gen: number, r: NodeRect, p: number): boolean => {
    const P = 4 * p, bx = placeBox;
    if (bx[P + 1] < r.x || bx[P] > r.x + r.w || bx[P + 3] < r.y || bx[P + 2] > r.y + r.h) {
      if (selfCheck) selfCheckAssert(!slotCut(placePts[p], r), "отсев далёких слотов");
      return false;
    }
    const cell = e.ix * nP + p, id = newId[p];
    if (cacheOn) {
      for (let w = cell * PAIR_WAYS, w1 = w + PAIR_WAYS; w < w1; w++) {
        if (lostAtGen[w] !== gen || lostAtId[w] !== id) continue;
        const cut = lostAtHit[w] === 1;
        if (selfCheck) selfCheckAssert(slotCut(placePts[p], r) === cut, "слот подписи");
        return cut;
      }
    }
    const cut = slotCut(placePts[p], r);
    const w = cell * PAIR_WAYS + lostNext[cell];
    lostNext[cell] = (lostNext[cell] + 1) % PAIR_WAYS;
    lostAtGen[w] = gen; lostAtId[w] = id; lostAtHit[w] = cut ? 1 : 0;
    return cut;
  };
  // РАЗРЕЖЕННЫЙ СЧЁТ ПОТЕРЯННЫХ НОСИТЕЛЕЙ: у связи со слотом — сколько маршрутов мест режут
  // слот (cutCnt) и кто именно (cutCur); пересчёт — только по сменившимся местам, а при новом
  // слоте — заново. lostReg — номер слота, по которому посчитан счёт (0 — не посчитан).
  const lostReg = new Int32Array(edges.length), cutCnt = new Int32Array(edges.length);
  const cutCur = new Uint8Array(edges.length * nP);
  const crossAt = new Map<CrossKey, number>();
  const changed: number[] = [];
  const sceneCost = (): number => {
    if (stats) count("evals");
    assignLanes(false);
    let cost = 0;
    costParts.cr = 0; costParts.ov = 0; costParts.inv = 0; costParts.det = 0; costParts.lost = 0; costParts.ovPairs = []; costParts.crPairs = [];
    for (let k = 0; k < nS; k++) newId[k] = straightIds[k];
    for (const e of edges) {
      const r = routeOf(e), p = nS + e.ix;
      if (r.pts) { placePts[p] = r.pts; newId[p] = r.id; placeBox.set(r.box, 4 * p); } else { newId[p] = 0; cost += INVALID_COST; costParts.inv++; }
      if (e.kind === "zz") {
        const d = Math.abs(e.x - e.uAlong) + Math.abs(e.x - e.dAlong) - Math.abs(e.uAlong - e.dAlong);
        cost += d; costParts.det += d;
      }
    }
    // сменившиеся места (по возрастанию) и пересчёт их пар: пару двух сменившихся считает
    // меньшее место (своя строка заново), пару с несменившимся меньшим — правка его строки
    changed.length = 0;
    for (let p = 0; p < nP; p++) if (newId[p] !== regId[p]) { changed.push(p); changedMark[p] = 1; }
    for (const p of changed) {
      for (let q = 0; q < p; q++) {
        if (changedMark[q] === 1 || newId[q] === 0) continue;
        rowSet(q, p, newId[p] !== 0 && pairAt(q, p));
      }
      const row = nzRow[p];
      row.length = 0;
      if (newId[p] === 0) continue;
      for (let q = p + 1; q < nP; q++) {
        if (newId[q] !== 0 && pairAt(p, q)) row.push(q);
      }
    }
    for (const p of changed) { changedMark[p] = 0; regId[p] = newId[p]; }
    // кресты — по ТОЧКАМ (Ф3): члены общего плеча режут чужую линию в одной точке — это
    // один крест и для глаза, и для метрики E23; поштучный счёт по парам маршрутов
    // переоценивал ствол в N раз и уводил спуск от эталона
    crossAt.clear();
    for (let a = 0; a < nP; a++) {
      if (newId[a] === 0) continue;
      const ea = placeEdge[a];
      for (const b of nzRow[a]) {
        const cell = a * nP + b, keys = curKeys[cell];
        if (keys.length > 0) {
          const eb = placeEdge[b];
          const w = ea !== null && eb !== null && twinOf.get(ea) === eb ? TWIN_CROSS_FACTOR : 1;
          for (const key of keys) {
            crossAt.set(key, Math.max(crossAt.get(key) ?? 0, w));
            if (__zDebug.trace) costParts.crPairs.push(`${nameOf(a)}×${nameOf(b)}`);
          }
        }
        if (curOv[cell] === 1) {
          cost += OVERLAP_COST_Z; costParts.ov++;
          if (__zDebug.on) costParts.ovPairs.push(`${nameOf(a)}~${nameOf(b)}`);
        }
      }
    }
    for (const w of crossAt.values()) { cost += w * CAND_CROSS_COST; costParts.cr++; }
    // ПОТЕРЯННЫЕ НОСИТЕЛИ (Ф3) — точно, по готовым маршрутам: слот подписи режет чужая
    // линия (Z-маршрут или прямая) → плашка ляжет на линию, носитель потерян
    for (const e of edges) {
      e.hostLost = false;
      if (!e.label || !LABEL_HOSTS.on) { lostReg[e.ix] = 0; continue; }
      if (e.host === "none") { lostReg[e.ix] = 0; cost += LABEL_HOSTS.lostCost; costParts.lost++; continue; }
      const r = slotRectOf(e);
      if (r) {
        const gen = slotGen(e, r), own = nS + e.ix, row = e.ix * nP;
        if (lostReg[e.ix] !== gen) {
          let cnt = 0;
          for (let p = 0; p < nP; p++) {
            const cut = p !== own && newId[p] !== 0 && cutAt(e, gen, r, p);
            cutCur[row + p] = cut ? 1 : 0;
            if (cut) cnt++;
          }
          cutCnt[e.ix] = cnt;
          lostReg[e.ix] = gen;
        } else {
          for (const p of changed) {
            const cut = p !== own && newId[p] !== 0 && cutAt(e, gen, r, p);
            cutCnt[e.ix] += (cut ? 1 : 0) - cutCur[row + p];
            cutCur[row + p] = cut ? 1 : 0;
          }
        }
        e.hostLost = cutCnt[e.ix] > 0;
      } else lostReg[e.ix] = 0;
      if (e.hostLost) { cost += LABEL_HOSTS.lostCost; costParts.lost++; }
    }
    if (selfCheck) {
      const ref = sceneCostRef();
      selfCheckAssert(sameNum(ref.cost, cost) && ref.lost.every((v, i) => v === edges[i].hostLost), "цена сцены (разреженная сумма)");
    }
    return cost;
  };
  // Цена сцены полным перебором без памяти — прежний расчёт слово в слово; эталон для
  // самопроверки разреженной суммы (флаги потерь — в отдельный список, состояние не трогает).
  const sceneCostRef = (): { cost: number; lost: boolean[] } => {
    const built: EdgePoint[][] = [...straightPts];
    const builtEdges: Array<ZEdge | null> = straightPts.map(() => null);
    let cost = 0;
    for (const e of edges) {
      const pts = buildRoute(e);
      if (pts) { built.push(pts); builtEdges.push(e); } else cost += INVALID_COST;
      if (e.kind === "zz") cost += Math.abs(e.x - e.uAlong) + Math.abs(e.x - e.dAlong) - Math.abs(e.uAlong - e.dAlong);
    }
    const at = new Map<CrossKey, number>();
    for (let i = 0; i < built.length; i++) {
      for (let j = i + 1; j < built.length; j++) {
        const ei = builtEdges[i], ej = builtEdges[j];
        const twins = ei !== null && ej !== null && twinOf.get(ei) === ej;
        for (const key of crossingKeys(built[i], built[j])) at.set(key, Math.max(at.get(key) ?? 0, twins ? TWIN_CROSS_FACTOR : 1));
        if (!(ei !== null && ej !== null && sharesEnd(ei, ej)) && overlapping(built[i], built[j])) cost += OVERLAP_COST_Z;
      }
    }
    for (const w of at.values()) cost += w * CAND_CROSS_COST;
    const lost = edges.map(() => false);
    for (const e of edges) {
      if (!e.label || !LABEL_HOSTS.on) continue;
      if (e.host === "none") { cost += LABEL_HOSTS.lostCost; continue; }
      const r = slotRectOf(e);
      if (r) {
        for (let i = 0; i < built.length && !lost[e.ix]; i++) {
          if (builtEdges[i] === e) continue;
          if (slotCut(built[i], r)) lost[e.ix] = true;
        }
      }
      if (lost[e.ix]) cost += LABEL_HOSTS.lostCost;
    }
    return { cost, lost };
  };

  // ── выбор варианта: старт без соседей, затем покоординатный спуск по цене сцены ──
  for (const e of edges) {
    const start = [...e.cands].sort((a, b) => a.detour - b.detour || a.order - b.order)[0];
    apply(e, start);
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
  let best = sceneCost();
  let evals = 0;
  const MAX_EVALS = 400;
  const descend = (): void => {
    if (movable.length === 0) return;
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
            apply(e, c);
            if (twin && tc) apply(twin, tc);
            evals++;
            if (stats) count("tries");
            const cost = sceneCost();
            if (__zDebug.on) zlog(e.id.slice(0, 8), "try", c.kind, c.bands.map((b) => `${b[0].toFixed(0)}..${b[1].toFixed(0)}`).join("/"), Number.isFinite(c.x) ? `x=${c.x}` : "", tc ? "+twin" : "", `cost=${cost.toFixed(0)}`, `best=${best.toFixed(0)}`, `cr=${costParts.cr} ov=${costParts.ov} inv=${costParts.inv} det=${costParts.det.toFixed(0)} lost=${costParts.lost}`, costParts.ovPairs.join(","), __zDebug.trace ? `[${costParts.crPairs.join(" ")}]` : "");
            if (cost < best - EPS) { best = cost; improved = true; moved = true; if (stats) count("accepted"); break; }
            if (current) apply(e, current);
            if (twin && tc && twinCurrent) apply(twin, twinCurrent);
          }
          if (moved) break;
        }
      }
      if (!improved) break;
    }
  };
  // ПРОХОД ПО НОСИТЕЛЯМ (Ф3): носитель — тоже переменная спуска. Его слот и толщина
  // двигают чужие дорожки и колонну; где это стоит креста или крюка дороже плашки (либо
  // слот всё равно режут), носитель выключается, и связь прокладывается как без подписи.
  // После снятия носителей спуск по вариантам повторяется: без их ограничений прежний
  // оптимум (например, вложенная встречная пара) снова достижим.
  const hostPass = (): boolean => {
    let any = false;
    for (let pass = 0; pass < 2; pass++) {
      let improved = false;
      for (const e of edges) {
        if (!e.label || e.host === "none" || !e.cand) continue;
        const prevHost = e.host;
        e.hostOff = true; e.host = "none";
        if (stats) count("hostTries");
        const cost = sceneCost();
        if (__zDebug.on) zlog(e.id.slice(0, 8), "host-off", prevHost, e.hostLost ? "(lost)" : "", `cost=${cost.toFixed(0)}`, `best=${best.toFixed(0)}`, `cr=${costParts.cr} lost=${costParts.lost} det=${costParts.det.toFixed(0)}`);
        if (cost < best - EPS) { best = cost; improved = true; any = true; if (stats) count("hostAccepted"); continue; }
        e.hostOff = false; e.host = prevHost;
      }
      if (!improved) break;
    }
    return any;
  };
  descend();
  if (LABEL_HOSTS.on) {
    for (let round = 0; round < 2; round++) {
      if (!hostPass()) break;
      const before = best;
      descend();
      if (best >= before - EPS) break;
    }
    sceneCost(); // флаги hostLost — по итоговому выбору
  }
  assignLanes(true);
  for (const e of edges) {
    const c = e.cand;
    if (__zDebug.on) zlog(e.id.slice(0, 8), "→", e.kind, c ? c.bands.map((b, i) => `${b[0].toFixed(0)}..${b[1].toFixed(0)}@${e.lanes[i]}`).join("/") : "", Number.isFinite(e.x) ? `x=${e.x}` : "", e.label ? `host=${e.host}${e.hostLost ? "(lost)" : ""}` : "");
  }

  // ── сборка и проверка: тела, чужие рамки, взаимные наложения ───────────────────
  const built = new Map<string, { edge: ZEdge; pts: EdgePoint[] }>();
  for (const e of edges) {
    const pts = buildRoute(e);
    if (!pts) { if (__zDebug.on) zlog(e.id.slice(0, 8), "DROP body/hard/collapsed"); continue; }
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
      if (__zDebug.on) zlog(loser.slice(0, 8), "DROP overlap with", (loser === ids[i] ? ids[j] : ids[i]).slice(0, 8));
      dropped.add(loser);
    }
  }
  const labelAnchors = new Map<string, EdgePoint>();
  for (const st of straights) if (st.slot) labelAnchors.set(st.id, mk(st.orient, st.along, (st.slot[0] + st.slot[1]) / 2));
  for (const id of ids) {
    const b = built.get(id);
    if (!b) continue;
    if (!dropped.has(id)) {
      routes.set(id, b.pts);
      const e = b.edge, o = e.orient;
      const slot = slotOfHost(e);
      if (e.hostLost) { /* слот режет чужая линия — пусть размещение ищет место само */ }
      else if (slot) labelAnchors.set(id, mk(o, hostAlong(e), (slot[0] + slot[1]) / 2));
      else if (e.host === "lane0") labelAnchors.set(id, mk(o, (e.uAlong + (e.kind === "z" ? e.dAlong : e.x)) / 2, e.lanes[0]));
      else if (e.host === "lane1") labelAnchors.set(id, mk(o, (e.x + e.dAlong) / 2, e.lanes[1]));
    }
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
  return { routes, portKeys, gridHints: { xs: [...hintXs].sort(asc), ys: [...hintYs].sort(asc) }, labelAnchors };
}

/** Габариты ломаной: x0, x1, y0, y1. */
type Box = [number, number, number, number];
const NO_BOX: Box = [NaN, NaN, NaN, NaN];
function boxOf(pts: ReadonlyArray<EdgePoint>): Box {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, x1, y0, y1];
}

// Ключ точки креста — пара (half(x), half(y)), как прежняя строка «x|y», но числом: удвоенные
// полупиксели — целые, и в пределах ±2^25 пара упаковывается в одно число без коллизий
// (X·2^26 + Y при |Y| < 2^25). За пределами — прежняя строка: в Map строка с числом не
// совпадает никогда. -0 и 0 дают одну точку и тут, и в строке («0»).
type CrossKey = number | string;
const CROSS_KEY_LIM = 2 ** 25;
function crossKey(x: number, y: number): CrossKey {
  const hx = half(x), hy = half(y);
  const X = hx * 2, Y = hy * 2;
  return Math.abs(X) < CROSS_KEY_LIM && Math.abs(Y) < CROSS_KEY_LIM ? X * 2 * CROSS_KEY_LIM + Y : `${hx}|${hy}`;
}

// Кресты двух ортогональных ломаных: перпендикулярные сегменты, пересечение строго
// внутри обоих (та же семантика, что у метрик качества E23). Возвращает ключи точек
// крестов (полпикселя), чтобы совпадающие плечи стволов давали один крест.
function crossingKeys(a: EdgePoint[], b: EdgePoint[]): CrossKey[] {
  const out: CrossKey[] = [];
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
      if (hx0 + EPS < v0.x && v0.x < hx1 - EPS && vy0 + EPS < h0.y && h0.y < vy1 - EPS) out.push(crossKey(v0.x, h0.y));
    }
  }
  return out;
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
