// Ортогональная маршрутизация одного ребра в обход узлов (эпик стрелок, фаза A2 — R1;
// переписано в V2.1–V2.2, см. ARROWS_V2_ANALYSIS.md).
//
// Метод (как в libavoid / «escape graph»): строим visibility-сетку (Hanan) из «интересных»
// координат — границы препятствий, раздвинутые на клиренс margin, плюс координаты портов;
// рёбра сетки между соседними вершинами проходимы, если осевой отрезок не режет тело узла;
// поверх — A* с эвристикой-манхэттеном и штрафом за поворот.
//
// V2.1 — НАПРАВЛЕННЫЕ ПОРТЫ (лечение «шпилек»): порт знает свою сторону (side). Маршрут
// обязан выйти из порта вдоль внешней нормали стороны на стаб (EDGE_STUB) и войти в цель
// против её нормали — стаб входит в маршрут ПО ПОСТРОЕНИЮ (A* стартует/финиширует на
// стаб-точках, крайние сегменты приклеиваются к ломаной). Прежний пост-патч
// ensureOutwardStubs, приклеивавший разворот на 180°, авто-маршрутам больше не нужен.
// Направления в состоянии A* ЗНАКОВЫЕ: ход назад по той же линии запрещён — разворот
// внутри маршрута невозможен физически, а не дорог.
//
// V2.2 — ПОРТЫ-КАНДИДАТЫ: routePorts ищет ОДИН маршрут сразу из множества стартовых и
// целевых портов (multi-source / multi-target A*, аналог PortCandidates у yFiles):
// выбор стороны — часть поиска с реальными штрафами, а не отдельная проба.
// Тела СВОИХ узлов передаёт вызывающий как обычные препятствия (порты-стабы снаружи).
import type { EdgePoint } from "../../../types";
import { cleanup, pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";
import { EDGE_STUB } from "../constants";

export interface RouteOptions {
  margin?: number;       // клиренс грид-линий от тел узлов, px (зазор обхода)
  bendPenalty?: number;  // штраф за поворот в px-эквиваленте (предпочесть меньше изломов)
  // Доп. стоимость хода по грид-сегменту (x1,y1)→(x2,y2), px-эквивалент. Только ПОЛОЖИТЕЛЬНАЯ
  // (иначе эвристика перестанет быть допустимой). Используется глобальным роутером routeAll
  // для штрафа за пересечение уже проложенных стрелок (R3). По умолчанию — без доплаты.
  moveCost?: (x1: number, y1: number, x2: number, y2: number) => number;
  // Дополнительные координаты грид-линий (помимо портов и границ препятствий). Глобальный
  // роутер даёт сюда порты ВСЕХ рёбер набора — чтобы было куда свернуть в объезд чужой стрелки.
  extraXs?: number[];
  extraYs?: number[];
  stub?: number;         // длина обязательного выхода/входа вдоль нормали порта
  // КЭШ ПОДГОТОВЛЕННОЙ СЕТКИ (оптимизация 2026-07): routeAll зовёт routePorts для одного
  // терминала несколько раз (проход 1, итерации rip-up) — меняется только moveCost, а
  // сетка, раздутые тела, проходимость грид-шагов и эвристика от него НЕ зависят. Задав
  // gridCache + cacheKey, вызывающий разрешает переиспользовать их между вызовами.
  // Ключ включает margin (ступенчатый сброс клиренса строит ДРУГУЮ сетку).
  cacheKey?: string;
  gridCache?: RouteGridCache;
}

// Подготовленная сетка терминала (см. RouteOptions.gridCache). Содержимое приватно для
// модуля: снаружи кэш — непрозрачный Map, который вызывающий лишь создаёт и передаёт.
interface PreparedGrid {
  xs: number[];
  ys: number[];
  grown: NodeRect[];
  sOrigins: EdgePoint[];
  eOrigins: EdgePoint[];
  goals: Map<number, { endIdx: number; forbidden: number }[]>;
  hPass: Int8Array;    // проходимость шага (i,j)→(i+1,j); -1 не считана, 0 нет, 1 да
  vPass: Int8Array;    // проходимость шага (i,j)→(i,j+1)
  hMemo: Float64Array; // эвристика вершины (i*NY+j); -1 не считана
}
export type RouteGridCache = Map<string, PreparedGrid>;

// Порт: точка стыковки (хэндл) и, опционально, сторона узла. Со стороной маршрут обязан
// выйти/войти вдоль её нормали (направленная видимость); без — как свободная вершина.
export interface PortCandidate {
  point: EdgePoint;
  side?: EdgeSide;
  // Надбавка к стоимости пути за ИСПОЛЬЗОВАНИЕ этого порта (>= 0). Мягкий рычаг против
  // нелегальной парковки (Т4: вход в порт, занятый чужим ВЫХОДОМ, и наоборот): дорогой
  // порт проигрывает соседнему слоту, но в полной блокаде остаётся достижим.
  penalty?: number;
}

export interface PortsRoute {
  pts: EdgePoint[];   // полная ломаная [хэндл старта, ..., хэндл цели] (стабы включены)
  startIdx: number;   // индекс выбранного стартового порта
  endIdx: number;     // индекс выбранного целевого порта
}

const DEFAULT_MARGIN = 12;
const DEFAULT_BEND_PENALTY = 40;
const EPS = 0.5;

// Знаковые направления хода (для запрета разворота и штрафа за поворот).
const NONE = 0, XP = 1, XM = 2, YP = 3, YM = 4;
const OPPOSITE = [NONE, XM, XP, YM, YP];
const isHor = (d: number): boolean => d === XP || d === XM;

// Внешняя нормаль стороны → знаковое направление выхода из порта.
const OUT_DIR: Record<EdgeSide, number> = { left: XM, right: XP, top: YM, bottom: YP };
const OUT_VEC: Record<EdgeSide, { ox: number; oy: number }> = {
  left: { ox: -1, oy: 0 }, right: { ox: 1, oy: 0 },
  top: { ox: 0, oy: -1 }, bottom: { ox: 0, oy: 1 },
};

// Клиренс вдоль внешней нормали порта до первого чужого тела: узлы легально стоят и в
// 12px друг от друга (NODE_SEP_PAD) — полный стаб 20 воткнул бы стаб-точку ВНУТРЬ соседа,
// и порт остался бы без маршрута. Стаб укорачивается до зазора (минимум 2px).
function clampStub(point: EdgePoint, side: EdgeSide, obstacles: NodeRect[], stub: number): number {
  const { ox, oy } = OUT_VEC[side];
  let clearance = Infinity;
  for (const r of obstacles) {
    // перпендикулярная к нормали координата должна попадать в створ прямоугольника
    const inSpan = ox !== 0
      ? point.y > r.y + EPS && point.y < r.y + r.h - EPS
      : point.x > r.x + EPS && point.x < r.x + r.w - EPS;
    if (!inSpan) continue;
    // расстояние вдоль луча нормали до ближней грани (луч стартует на грани СВОЕГО узла)
    const t = ox > 0 ? r.x - point.x
      : ox < 0 ? point.x - (r.x + r.w)
      : oy > 0 ? r.y - point.y
      : point.y - (r.y + r.h);
    if (t > EPS && t < clearance) clearance = t;
  }
  return Math.max(2, Math.min(stub, clearance - 2));
}

// Стаб-точка порта: точка входа в сетку A* (хэндл + нормаль·stub); без стороны — сам хэндл.
function portOrigin(p: PortCandidate, obstacles: NodeRect[], stub: number): EdgePoint {
  if (!p.side) return p.point;
  const { ox, oy } = OUT_VEC[p.side];
  const s = clampStub(p.point, p.side, obstacles, stub);
  return { x: p.point.x + ox * s, y: p.point.y + oy * s };
}

// Отсортированные уникальные координаты (близкие в пределах eps сливаются в одну линию).
function axisLines(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(out[out.length - 1] - v) > EPS) out.push(v);
  }
  return out;
}

// Индекс линии, ближайшей к координате (координаты портов гарантированно в наборе).
function lineIndex(lines: number[], v: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const d = Math.abs(lines[i] - v);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Минимальная двоичная куча (ключ состояния + приоритет f). Параллельные массивы.
class MinHeap {
  private keys: number[] = [];
  private prio: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, p: number): void {
    this.keys.push(key); this.prio.push(p);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent); i = parent;
    }
  }
  pop(): number {
    const top = this.keys[0];
    // Вызывающий гарантирует size > 0, поэтому pop() вернёт определённое значение
    const k = this.keys.pop() ?? 0; const p = this.prio.pop() ?? 0;
    if (this.keys.length > 0) {
      this.keys[0] = k; this.prio[0] = p;
      const n = this.keys.length; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2; let m = i;
        if (l < n && this.prio[l] < this.prio[m]) m = l;
        if (r < n && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
    const tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp;
  }
}

// Сборка PreparedGrid терминала: грид-линии, раздутые тела, цели. Кэши проходимости
// и эвристики создаются пустыми и наполняются лениво по ходу поисков.
function prepareGrid(
  starts: PortCandidate[],
  ends: PortCandidate[],
  obstacles: NodeRect[],
  margin: number,
  stub: number,
  extraXs?: number[],
  extraYs?: number[],
): PreparedGrid {
  const sOrigins = starts.map((p) => portOrigin(p, obstacles, stub));
  const eOrigins = ends.map((p) => portOrigin(p, obstacles, stub));

  // Грид-линии: раздвинутые на клиренс границы препятствий + порты (хэндлы и стаб-точки)
  // + подсказки. Хэндлы дают линии вдоль граней своих узлов — каналы общей решётки набора.
  const xsRaw: number[] = [...(extraXs ?? [])];
  const ysRaw: number[] = [...(extraYs ?? [])];
  for (const p of [...starts, ...ends]) { xsRaw.push(p.point.x); ysRaw.push(p.point.y); }
  for (const p of [...sOrigins, ...eOrigins]) { xsRaw.push(p.x); ysRaw.push(p.y); }
  for (const r of obstacles) {
    xsRaw.push(r.x - margin, r.x + r.w + margin);
    ysRaw.push(r.y - margin, r.y + r.h + margin);
  }
  const xs = axisLines(xsRaw);
  const ys = axisLines(ysRaw);
  const NX = xs.length, NY = ys.length;

  // Тела, раздутые на клиренс margin (канон libavoid shapeBufferDistance): в общей решётке
  // набора есть линии по ГРАНЯМ чужих узлов (порты соседей), и без раздутия маршрут легально
  // ехал вдоль самой грани («по грани», 0px зазора). Ход ровно по раздутой границе — касание,
  // не пересечение (eps в pathCrossesRects) → дистанция margin достижима, ближе нельзя.
  const grown = obstacles.map((r) => ({
    x: r.x - margin, y: r.y - margin, w: r.w + 2 * margin, h: r.h + 2 * margin,
  }));

  // Целевые вершины: (i,j) → список кандидатов. Направленный порт принимает приход с любым
  // dir, КРОМЕ его внешней нормали: приход «наружу» означал бы разворот на 180° на шве с
  // приклеиваемым стабом внутрь.
  const goals = new Map<number, { endIdx: number; forbidden: number }[]>();
  eOrigins.forEach((g, k) => {
    const cell = lineIndex(xs, g.x) * NY + lineIndex(ys, g.y);
    const side = ends[k].side;
    const arr = goals.get(cell) ?? [];
    arr.push({ endIdx: k, forbidden: side ? OUT_DIR[side] : -1 });
    goals.set(cell, arr);
  });

  return {
    xs, ys, grown, sOrigins, eOrigins, goals,
    hPass: new Int8Array(Math.max(0, (NX - 1) * NY)).fill(-1),
    vPass: new Int8Array(Math.max(0, NX * (NY - 1))).fill(-1),
    hMemo: new Float64Array(NX * NY).fill(-1),
  };
}

// МЕМО moveCost по НАПРАВЛЕННОМУ грид-шагу (перф-эпик Ф3, 2026-08-20): один и
// тот же ход (i,j)→сосед A* пробует из НЕСКОЛЬКИХ состояний направления прихода
// (до 3, разворот запрещён) и при повторных улучшениях g — замер Zabbix-корня:
// 49М вызовов moveCost на 16.8М экспансий, ~3 оплаты за геометрический шаг.
// Стоимость шага зависит только от его геометрии и направления хода (правило
// крестов «конец включаем, начало исключаем» асимметрично — поэтому ключ
// НАПРАВЛЕННЫЙ: результат побитово тот же, что без мемо). Генерация вместо
// очистки: буферы переживают вызовы, отметка валидна при совпадении gen.
const mcScratch = { val: new Float64Array(0), gen: new Int32Array(0), cur: 0 };

// Скретч flood-fill достижимости (перф-эпик Ф3): генерационные отметки клеток
// и очередь BFS — переживают вызовы, без пер-вызовной очистки.
const floodScratch = { gen: new Int32Array(0), queue: new Int32Array(0), cur: 0 };

// Скретч-буферы состояния A* (gScore/cameFrom/closed): переиспользуются между вызовами,
// растут до максимального встреченного грида. Легально: routePorts синхронна и не
// реентерабельна (moveCost не зовёт роутер), поток один — гонок нет.
const scratch = {
  g: new Float64Array(0),
  came: new Int32Array(0),
  // Генерационные отметки вместо пер-вызовной заливки (перф-эпик Ф3): три
  // fill'а по nStates на КАЖДЫЙ вызов routePorts (замер: 3862 вызова × ~85k
  // состояний ≈ 1 млрд записей на сцене Zabbix-корня) заменены проверкой
  // «отметка == текущее поколение»; семантика доступа побитово та же.
  gen: new Int32Array(0),       // gScore/cameFrom валидны при gen[key] == cur
  closedGen: new Int32Array(0), // состояние закрыто при closedGen[key] == cur
  cur: 0,
};

/**
 * Один маршрут из ЛЮБОГО стартового порта в ЛЮБОЙ целевой (multi-source/multi-target A*).
 * Вход в поиск у всех портов бесплатный — побеждает пара с лучшим суммарным маршрутом
 * (длина + повороты + moveCost). null — пути нет (вызывающий решает, чем откатиться).
 */
// Счётчики объёма поиска (перф-эпик Ф3): накопительные, читаются профильными
// реплеями (scripts/perf-probe + vite-node), в проде — только инкременты int.
// По ним снята атрибуция Zabbix-корня: 3862 вызова A*, 16.8М экспансий,
// 49М→18М вызовов moveCost после мемо шага; сварка хвостов — 19% экспансий,
// маргин-фейлы — 12%.
export const __routeCounters = {
  routePortsCalls: 0, expansions: 0, moveCostCalls: 0,
  marginRetries: 0, weldTails: 0, failedExpansions: 0, weldExpansions: 0,
};
export function routePorts(
  starts: PortCandidate[],
  ends: PortCandidate[],
  obstacles: NodeRect[],
  opts?: RouteOptions,
): PortsRoute | null {
  __routeCounters.routePortsCalls++;
  const expAtStart = __routeCounters.expansions;
  const margin = opts?.margin ?? DEFAULT_MARGIN;
  const bendPenalty = opts?.bendPenalty ?? DEFAULT_BEND_PENALTY;
  const moveCost = opts?.moveCost;
  const stub = opts?.stub ?? EDGE_STUB;

  // Подготовленная сетка терминала — из кэша вызывающего (если дан) или свежая.
  const gridCache = opts?.gridCache;
  const cacheKey = opts?.cacheKey != null && gridCache ? `${opts.cacheKey}@${margin}` : null;
  let grid = cacheKey ? gridCache?.get(cacheKey) : undefined;
  if (!grid) {
    grid = prepareGrid(starts, ends, obstacles, margin, stub, opts?.extraXs, opts?.extraYs);
    if (cacheKey) gridCache?.set(cacheKey, grid);
  }
  const { xs, ys, grown, sOrigins, eOrigins, goals, hPass, vPass, hMemo } = grid;
  const NX = xs.length, NY = ys.length;

  // Мемо направленного шага (см. mcScratch): [h-шаги (NX−1)·NY | v-шаги NX·(NY−1)] × 2.
  const hSteps = (NX - 1) * NY;
  const mc = moveCost;
  let stepCost: ((i: number, j: number, ni: number, nj: number, md: number) => number) | null = null;
  if (mc) {
    const mcSize = (hSteps + NX * (NY - 1)) * 2;
    if (mcSize > mcScratch.val.length) {
      mcScratch.val = new Float64Array(mcSize);
      mcScratch.gen = new Int32Array(mcSize);
    }
    const gen = ++mcScratch.cur;
    const val = mcScratch.val, genArr = mcScratch.gen;
    stepCost = (i, j, ni, nj, md) => {
      const idx = md === XP ? (i * NY + j) * 2
        : md === XM ? ((i - 1) * NY + j) * 2 + 1
        : md === YP ? (hSteps + i * (NY - 1) + j) * 2
        : (hSteps + i * (NY - 1) + (j - 1)) * 2 + 1;
      if (genArr[idx] === gen) return val[idx];
      __routeCounters.moveCostCalls++;
      const v = mc(xs[i], ys[j], xs[ni], ys[nj]);
      genArr[idx] = gen;
      val[idx] = v;
      return v;
    };
  }

  // Кодирование состояния A*: ((i*NY + j)*5 + dir). dir — знаковое направление ПРИХОДА.
  const encode = (i: number, j: number, dir: number): number => (i * NY + j) * 5 + dir;

  // Проходимость грид-шага с ленивым мемо (шаги всегда на соседнюю линию; отрезок
  // симметричен, ключ — канонический «меньший индекс»). От moveCost не зависит →
  // мемо живёт в PreparedGrid и переживает попытки rip-up.
  const stepPassH = (i: number, j: number): boolean => { // (i,j)→(i+1,j)
    const k = i * NY + j;
    let v = hPass[k];
    if (v < 0) {
      v = pathCrossesRects([{ x: xs[i], y: ys[j] }, { x: xs[i + 1], y: ys[j] }], grown) ? 0 : 1;
      hPass[k] = v;
    }
    return v === 1;
  };
  const stepPassV = (i: number, j: number): boolean => { // (i,j)→(i,j+1)
    const k = i * (NY - 1) + j;
    let v = vPass[k];
    if (v < 0) {
      v = pathCrossesRects([{ x: xs[i], y: ys[j] }, { x: xs[i], y: ys[j + 1] }], grown) ? 0 : 1;
      vPass[k] = v;
    }
    return v === 1;
  };

  // Эвристика: минимальный манхэттен до ближайшей целевой стаб-точки (допустима и
  // согласована); мемо по вершине (тоже не зависит от moveCost).
  const h = (i: number, j: number): number => {
    const k = i * NY + j;
    let best = hMemo[k];
    if (best < 0) {
      best = Infinity;
      for (const g of eOrigins) {
        const d = Math.abs(xs[i] - g.x) + Math.abs(ys[j] - g.y);
        if (d < best) best = d;
      }
      hMemo[k] = best;
    }
    return best;
  };

  // Состояние поиска — в скретч-буферах (индекс = ключ состояния).
  const nStates = NX * NY * 5;
  if (scratch.g.length < nStates) {
    scratch.g = new Float64Array(nStates);
    scratch.came = new Int32Array(nStates);
    scratch.gen = new Int32Array(nStates);
    scratch.closedGen = new Int32Array(nStates);
  }
  const gScore = scratch.g, cameFrom = scratch.came;
  const genArr = scratch.gen, closedGen = scratch.closedGen;
  const sGen = ++scratch.cur;
  const seedOf = new Map<number, number>(); // стартовое состояние → индекс порта
  const open = new MinHeap();

  sOrigins.forEach((o, k) => {
    const i = lineIndex(xs, o.x), j = lineIndex(ys, o.y);
    // Направленный порт сеется как «уже идущий наружу»: запрет разворота не даст первому
    // ходу нырнуть обратно к узлу, а первый поворот честно заплатит bendPenalty.
    // Штраф порта — стартовая стоимость семени (при нескольких семенах на одном
    // состоянии побеждает дешёвое).
    const side = starts[k].side;
    const key = encode(i, j, side ? OUT_DIR[side] : NONE);
    const pen = starts[k].penalty ?? 0;
    if (genArr[key] !== sGen || gScore[key] > pen) {
      gScore[key] = pen;
      genArr[key] = sGen;
      cameFrom[key] = -1; // семя — корень цепочки реконструкции
      seedOf.set(key, k);
      open.push(key, pen + h(i, j));
    }
  });

  // Финал с учётом штрафа ЦЕЛЕВОГО порта: нельзя брать первый pop на goal-cell (дорогая
  // цель достигается раньше дешёвой дальней) — копим лучший «финиш» fin = g + penalty и
  // останавливаемся, когда приоритет очереди его превысил (эвристика допустимая, дальше
  // только дороже). При нулевых штрафах поведение эквивалентно прежнему «break на первом
  // достижении»: bestFin = g первого попадания, следующий pop имеет f >= g → стоп.
  // БЫСТРАЯ ПРОВЕРКА ДОСТИЖИМОСТИ (перф-эпик Ф3): почти треть экспансий плотных
  // сцен (Sentry: 8.6М из 27М) — A*, обречённо выжигающий весь достижимый грид
  // ради ответа «пути нет» (запертые порты; маргин-цепочка 12→6→3→1.5→0 повторяет
  // это на каждой ступени). Ненаправленный BFS по КЛЕТКАМ с той же проходимостью
  // шагов (без стоимостей, кучи и moveCost) отвечает то же на порядок дешевле.
  // Ненаправленная недостижимость ⇒ недостижимость в A* (необходимое условие) —
  // результат побитово тот же; направленные тупики (редкость) решает сам A*.
  {
    const nCells = NX * NY;
    if (floodScratch.gen.length < nCells) {
      floodScratch.gen = new Int32Array(nCells);
      floodScratch.queue = new Int32Array(nCells);
    }
    const fGen = ++floodScratch.cur;
    const fSeen = floodScratch.gen, fQ = floodScratch.queue;
    let qLen = 0;
    for (const o of sOrigins) {
      const cell = lineIndex(xs, o.x) * NY + lineIndex(ys, o.y);
      if (fSeen[cell] !== fGen) { fSeen[cell] = fGen; fQ[qLen++] = cell; }
    }
    let reachable = false;
    for (let qi = 0; qi < qLen && !reachable; qi++) {
      const cell = fQ[qi];
      if (goals.has(cell)) { reachable = true; break; }
      const j = cell % NY;
      const i = (cell - j) / NY;
      if (i + 1 < NX && fSeen[cell + NY] !== fGen && stepPassH(i, j)) { fSeen[cell + NY] = fGen; fQ[qLen++] = cell + NY; }
      if (i - 1 >= 0 && fSeen[cell - NY] !== fGen && stepPassH(i - 1, j)) { fSeen[cell - NY] = fGen; fQ[qLen++] = cell - NY; }
      if (j + 1 < NY && fSeen[cell + 1] !== fGen && stepPassV(i, j)) { fSeen[cell + 1] = fGen; fQ[qLen++] = cell + 1; }
      if (j - 1 >= 0 && fSeen[cell - 1] !== fGen && stepPassV(i, j - 1)) { fSeen[cell - 1] = fGen; fQ[qLen++] = cell - 1; }
    }
    if (!reachable) {
      // тот же выход, что у исчерпанного A* (goalKey < 0), но без экспансий
      if (margin > EPS) {
        const next = margin >= 2 ? margin / 2 : 0;
        __routeCounters.marginRetries++;
        return routePorts(starts, ends, obstacles, { ...opts, margin: next });
      }
      return null;
    }
  }

  let goalKey = -1, goalEndIdx = -1;
  let bestFin = Infinity;
  while (open.size > 0) {
    const key = open.pop();
    if (closedGen[key] === sGen) continue;
    __routeCounters.expansions++;

    const dir = key % 5;
    const cell = (key - dir) / 5;
    const j = cell % NY;
    const i = (cell - j) / NY;
    if (bestFin <= gScore[key] + h(i, j)) break; // дешевле уже не будет
    closedGen[key] = sGen;

    const atGoal = goals.get(cell);
    if (atGoal) {
      for (const gl of atGoal) {
        if (dir === gl.forbidden) continue;
        const fin = gScore[key] + (ends[gl.endIdx].penalty ?? 0);
        if (fin < bestFin) { bestFin = fin; goalKey = key; goalEndIdx = gl.endIdx; }
      }
    }

    const g = gScore[key];
    const opp = OPPOSITE[dir];
    // Четыре соседа со знаковым направлением хода (порядок XP, XM, YP, YM — часть
    // детерминизма результата); разворот (ход против dir) запрещён. Развёрнуто в
    // локальную функцию без аллокаций — это самый горячий цикл роутера.
    const expand = (ni: number, nj: number, md: number, pass: boolean): void => {
      if (!pass) return;
      const segLen = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      if (segLen <= EPS) return; // вырожденный (слипшиеся линии)
      const turn = dir !== NONE && isHor(dir) !== isHor(md) ? bendPenalty : 0;
      const extra = stepCost ? stepCost(i, j, ni, nj, md) : 0;
      const ng = g + segLen + turn + extra;
      const nkey = encode(ni, nj, md);
      if (genArr[nkey] !== sGen || ng < gScore[nkey]) {
        gScore[nkey] = ng;
        genArr[nkey] = sGen;
        cameFrom[nkey] = key;
        open.push(nkey, ng + h(ni, nj));
      }
    };
    if (i + 1 < NX && opp !== XP) expand(i + 1, j, XP, stepPassH(i, j));
    if (i - 1 >= 0 && opp !== XM) expand(i - 1, j, XM, stepPassH(i - 1, j));
    if (j + 1 < NY && opp !== YP) expand(i, j + 1, YP, stepPassV(i, j));
    if (j - 1 >= 0 && opp !== YM) expand(i, j - 1, YM, stepPassV(i, j - 1));
  }

  if (goalKey < 0) {
    __routeCounters.failedExpansions += __routeCounters.expansions - expAtStart;
    // Пути нет (узел заперт). Частая причина в плотной рамке: раздутые на клиренс границы
    // соседних узлов перекрылись и не оставили грид-канала. Клиренс сбрасываем СТУПЕНЧАТО
    // (деление пополам, пока margin >= 2, затем 0: 12 → 6 → 3 → 1.5 → 0; аналог сжатия
    // shapeBufferDistance у libavoid): маршрут в тесноте сохраняет хоть какой-то зазор
    // от граней, а не сразу липнет к ним.
    if (margin > EPS) {
      const next = margin >= 2 ? margin / 2 : 0;
      __routeCounters.marginRetries++;
      return routePorts(starts, ends, obstacles, { ...opts, margin: next });
    }
    return null;
  }

  // Реконструкция: от цели по cameFrom к старту; определяем выбранный стартовый порт по
  // семени цепочки, приклеиваем хэндлы направленных портов (стабы), чистим коллинеарные.
  const pts: EdgePoint[] = [];
  let cur = goalKey;
  for (;;) {
    const dir = cur % 5;
    const cell = (cur - dir) / 5;
    const j = cell % NY;
    const i = (cell - j) / NY;
    pts.push({ x: xs[i], y: ys[j] });
    const prev = cameFrom[cur];
    if (prev < 0) break;
    cur = prev;
  }
  const startIdx = seedOf.get(cur) ?? 0;
  pts.reverse();
  if (starts[startIdx].side) pts.unshift({ ...starts[startIdx].point });
  if (ends[goalEndIdx].side) pts.push({ ...ends[goalEndIdx].point });
  return { pts: cleanup(pts), startIdx, endIdx: goalEndIdx };
}

/**
 * Маршрут между двумя портами (обёртка над routePorts, прежняя сигнатура). Стороны портов —
 * через opts.startSide/endSide. Пути нет даже с margin=0 → прямой отрезок-fallback (прежнее
 * поведение; вызывающий исключил свои узлы из препятствий либо смирился с пересечением).
 */
export function routeOrthogonal(
  start: EdgePoint,
  end: EdgePoint,
  obstacles: NodeRect[],
  opts?: RouteOptions & { startSide?: EdgeSide; endSide?: EdgeSide },
): EdgePoint[] {
  const r = routePorts(
    [{ point: start, side: opts?.startSide }],
    [{ point: end, side: opts?.endSide }],
    obstacles,
    opts,
  );
  if (r) return r.pts;
  return cleanup([{ x: start.x, y: start.y }, { x: end.x, y: end.y }]);
}
