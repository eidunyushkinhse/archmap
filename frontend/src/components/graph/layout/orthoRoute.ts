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
}

// Порт: точка стыковки (хэндл) и, опционально, сторона узла. Со стороной маршрут обязан
// выйти/войти вдоль её нормали (направленная видимость); без — как свободная вершина.
export interface PortCandidate {
  point: EdgePoint;
  side?: EdgeSide;
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
    const k = this.keys.pop()!; const p = this.prio.pop()!;
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

/**
 * Один маршрут из ЛЮБОГО стартового порта в ЛЮБОЙ целевой (multi-source/multi-target A*).
 * Вход в поиск у всех портов бесплатный — побеждает пара с лучшим суммарным маршрутом
 * (длина + повороты + moveCost). null — пути нет (вызывающий решает, чем откатиться).
 */
export function routePorts(
  starts: PortCandidate[],
  ends: PortCandidate[],
  obstacles: NodeRect[],
  opts?: RouteOptions,
): PortsRoute | null {
  const margin = opts?.margin ?? DEFAULT_MARGIN;
  const bendPenalty = opts?.bendPenalty ?? DEFAULT_BEND_PENALTY;
  const moveCost = opts?.moveCost;
  const stub = opts?.stub ?? EDGE_STUB;

  const sOrigins = starts.map((p) => portOrigin(p, obstacles, stub));
  const eOrigins = ends.map((p) => portOrigin(p, obstacles, stub));

  // Грид-линии: раздвинутые на клиренс границы препятствий + порты (хэндлы и стаб-точки)
  // + подсказки. Хэндлы дают линии вдоль граней своих узлов — каналы общей решётки набора.
  const xsRaw: number[] = [...(opts?.extraXs ?? [])];
  const ysRaw: number[] = [...(opts?.extraYs ?? [])];
  for (const p of [...starts, ...ends]) { xsRaw.push(p.point.x); ysRaw.push(p.point.y); }
  for (const p of [...sOrigins, ...eOrigins]) { xsRaw.push(p.x); ysRaw.push(p.y); }
  for (const r of obstacles) {
    xsRaw.push(r.x - margin, r.x + r.w + margin);
    ysRaw.push(r.y - margin, r.y + r.h + margin);
  }
  const xs = axisLines(xsRaw);
  const ys = axisLines(ysRaw);
  const NX = xs.length, NY = ys.length;

  // Кодирование состояния A*: ((i*NY + j)*5 + dir). dir — знаковое направление ПРИХОДА.
  const encode = (i: number, j: number, dir: number): number => (i * NY + j) * 5 + dir;

  // Проходим ли осевой отрезок между двумя вершинами сетки. Препятствия РАЗДУТЫ на
  // клиренс margin (канон libavoid shapeBufferDistance): в общей решётке набора есть
  // линии по ГРАНЯМ чужих узлов (порты соседей), и без раздутия маршрут легально ехал
  // вдоль самой грани («по грани», 0px зазора). Ход ровно по раздутой границе — касание,
  // не пересечение (eps в pathCrossesRects) → дистанция margin достижима, ближе нельзя.
  const grown = obstacles.map((r) => ({
    x: r.x - margin, y: r.y - margin, w: r.w + 2 * margin, h: r.h + 2 * margin,
  }));
  const passable = (i1: number, j1: number, i2: number, j2: number): boolean =>
    !pathCrossesRects(
      [{ x: xs[i1], y: ys[j1] }, { x: xs[i2], y: ys[j2] }],
      grown,
    );

  // Эвристика: минимальный манхэттен до ближайшей целевой стаб-точки (допустима и согласована).
  const h = (i: number, j: number): number => {
    let best = Infinity;
    for (const g of eOrigins) {
      const d = Math.abs(xs[i] - g.x) + Math.abs(ys[j] - g.y);
      if (d < best) best = d;
    }
    return best;
  };

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

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const seedOf = new Map<number, number>(); // стартовое состояние → индекс порта
  const closed = new Set<number>();
  const open = new MinHeap();

  sOrigins.forEach((o, k) => {
    const i = lineIndex(xs, o.x), j = lineIndex(ys, o.y);
    // Направленный порт сеется как «уже идущий наружу»: запрет разворота не даст первому
    // ходу нырнуть обратно к узлу, а первый поворот честно заплатит bendPenalty.
    const side = starts[k].side;
    const key = encode(i, j, side ? OUT_DIR[side] : NONE);
    if ((gScore.get(key) ?? Infinity) > 0) {
      gScore.set(key, 0);
      seedOf.set(key, k);
      open.push(key, h(i, j));
    }
  });

  let goalKey = -1, goalEndIdx = -1;
  while (open.size > 0) {
    const key = open.pop();
    if (closed.has(key)) continue;
    closed.add(key);

    const dir = key % 5;
    const cell = (key - dir) / 5;
    const j = cell % NY;
    const i = (cell - j) / NY;

    const atGoal = goals.get(cell);
    if (atGoal) {
      const hit = atGoal.find((g) => dir !== g.forbidden);
      if (hit) { goalKey = key; goalEndIdx = hit.endIdx; break; }
    }

    const g = gScore.get(key)!;
    // Четыре соседа со знаковым направлением хода; разворот (ход против dir) запрещён.
    const moves: Array<[number, number, number]> = [
      [i + 1, j, XP], [i - 1, j, XM],
      [i, j + 1, YP], [i, j - 1, YM],
    ];
    for (const [ni, nj, md] of moves) {
      if (ni < 0 || ni >= NX || nj < 0 || nj >= NY) continue;
      if (md === OPPOSITE[dir]) continue;
      if (!passable(i, j, ni, nj)) continue;
      const segLen = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      if (segLen <= EPS) continue; // вырожденный (слипшиеся линии)
      const turn = dir !== NONE && isHor(dir) !== isHor(md) ? bendPenalty : 0;
      const extra = moveCost ? moveCost(xs[i], ys[j], xs[ni], ys[nj]) : 0;
      const ng = g + segLen + turn + extra;
      const nkey = encode(ni, nj, md);
      if (ng < (gScore.get(nkey) ?? Infinity)) {
        gScore.set(nkey, ng);
        cameFrom.set(nkey, key);
        open.push(nkey, ng + h(ni, nj));
      }
    }
  }

  if (goalKey < 0) {
    // Пути нет (узел заперт). Частая причина в плотной рамке: раздутые на клиренс границы
    // соседних узлов перекрылись и не оставили грид-канала. Клиренс сбрасываем СТУПЕНЧАТО
    // (12 → 6 → 3 → 0, аналог сжатия shapeBufferDistance у libavoid): маршрут в тесноте
    // сохраняет хоть какой-то зазор от граней, а не сразу липнет к ним.
    if (margin > EPS) {
      const next = margin >= 2 ? margin / 2 : 0;
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
    const prev = cameFrom.get(cur);
    if (prev === undefined) break;
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
