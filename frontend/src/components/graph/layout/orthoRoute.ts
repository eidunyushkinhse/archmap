// Ортогональная маршрутизация одного ребра в обход узлов (эпик стрелок, фаза A2 — R1).
// Чистая функция: даны концы (start/end, на хэндлах) и препятствия-прямоугольники (тела
// ЧУЖИХ узлов — без узлов-концов этого ребра), строит кратчайший ортогональный путь,
// огибающий препятствия, со штрафом за повороты (меньше изломов при равной длине).
//
// Метод (как в libavoid / «escape graph»): строим visibility-сетку (Hanan) из «интересных»
// координат — границы препятствий, раздвинутые на клиренс margin, плюс координаты концов;
// рёбра сетки между соседними вершинами проходимы, если осевой отрезок не режет тело узла;
// поверх — A* с эвристикой-манхэттеном и штрафом за поворот. Глобальная минимизация
// пересечений между РАЗНЫМИ стрелками (R3) и расталкивание совпавших плеч — отдельная
// фаза A3, здесь маршрутизируется одно ребро. См. ARROWS_ROUTING_ANALYSIS.md §4 (R-1), §6.
import type { EdgePoint } from "../../../types";
import { cleanup, pathCrossesRects, type NodeRect } from "../edgePath";

export interface RouteOptions {
  margin?: number;       // клиренс грид-линий от тел узлов, px (зазор обхода)
  bendPenalty?: number;  // штраф за поворот в px-эквиваленте (предпочесть меньше изломов)
  // Доп. стоимость хода по грид-сегменту (x1,y1)→(x2,y2), px-эквивалент. Только ПОЛОЖИТЕЛЬНАЯ
  // (иначе эвристика перестанет быть допустимой). Используется глобальным роутером routeAll
  // для штрафа за пересечение уже проложенных стрелок (R3). По умолчанию — без доплаты.
  moveCost?: (x1: number, y1: number, x2: number, y2: number) => number;
  // Дополнительные координаты грид-линий (помимо концов и границ препятствий). Глобальный
  // роутср даёт сюда концы ВСЕХ рёбер набора — чтобы было куда свернуть в объезд чужой стрелки.
  extraXs?: number[];
  extraYs?: number[];
}

const DEFAULT_MARGIN = 12;
const DEFAULT_BEND_PENALTY = 40;
const EPS = 0.5;

// Направление последнего хода: нет / горизонтальный / вертикальный (для штрафа за поворот).
const NONE = 0, HOR = 1, VER = 2;

// Отсортированные уникальные координаты (близкие в пределах eps сливаются в одну линию).
function axisLines(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(out[out.length - 1] - v) > EPS) out.push(v);
  }
  return out;
}

// Индекс линии, ближайшей к координате (концы гарантированно добавлены в набор).
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

export function routeOrthogonal(
  start: EdgePoint,
  end: EdgePoint,
  obstacles: NodeRect[],
  opts?: RouteOptions,
): EdgePoint[] {
  const margin = opts?.margin ?? DEFAULT_MARGIN;
  const bendPenalty = opts?.bendPenalty ?? DEFAULT_BEND_PENALTY;
  const moveCost = opts?.moveCost;

  // Грид-линии: раздвинутые на клиренс границы препятствий + координаты концов + подсказки.
  const xsRaw = [start.x, end.x, ...(opts?.extraXs ?? [])];
  const ysRaw = [start.y, end.y, ...(opts?.extraYs ?? [])];
  for (const r of obstacles) {
    xsRaw.push(r.x - margin, r.x + r.w + margin);
    ysRaw.push(r.y - margin, r.y + r.h + margin);
  }
  const xs = axisLines(xsRaw);
  const ys = axisLines(ysRaw);
  const NX = xs.length, NY = ys.length;

  const startI = lineIndex(xs, start.x), startJ = lineIndex(ys, start.y);
  const endI = lineIndex(xs, end.x), endJ = lineIndex(ys, end.y);

  // Кодирование состояния A*: ((i*NY + j)*3 + dir). dir ∈ {NONE,HOR,VER}.
  const encode = (i: number, j: number, dir: number): number => (i * NY + j) * 3 + dir;

  // Проходим ли осевой отрезок между двумя вершинами сетки (не режет ли тело узла).
  const passable = (i1: number, j1: number, i2: number, j2: number): boolean =>
    !pathCrossesRects(
      [{ x: xs[i1], y: ys[j1] }, { x: xs[i2], y: ys[j2] }],
      obstacles,
    );

  const h = (i: number, j: number): number =>
    Math.abs(xs[i] - end.x) + Math.abs(ys[j] - end.y);

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const open = new MinHeap();

  const startKey = encode(startI, startJ, NONE);
  gScore.set(startKey, 0);
  open.push(startKey, h(startI, startJ));

  let goalKey = -1;
  while (open.size > 0) {
    const key = open.pop();
    if (closed.has(key)) continue;
    closed.add(key);

    const dir = key % 3;
    const cell = (key - dir) / 3;
    const j = cell % NY;
    const i = (cell - j) / NY;

    if (i === endI && j === endJ) { goalKey = key; break; }

    const g = gScore.get(key)!;
    // Четыре соседа: ±1 по X (горизонтальный ход) и ±1 по Y (вертикальный ход).
    const moves: Array<[number, number, number]> = [
      [i - 1, j, HOR], [i + 1, j, HOR],
      [i, j - 1, VER], [i, j + 1, VER],
    ];
    for (const [ni, nj, md] of moves) {
      if (ni < 0 || ni >= NX || nj < 0 || nj >= NY) continue;
      if (!passable(i, j, ni, nj)) continue;
      const segLen = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      if (segLen <= EPS) continue; // вырожденный (слипшиеся линии)
      const turn = dir !== NONE && dir !== md ? bendPenalty : 0;
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

  // Путь не найден (узел заперт). Частая причина в плотной рамке: раздутые на клиренс
  // границы соседних узлов перекрылись и не оставили грид-канала в зазоре между ними.
  // Прежде чем сдаться на прямой отрезок (который прошёл бы СКВОЗЬ узлы), пробуем без
  // клиренса — каналы вдоль самих границ узлов (касание границей не считается пересечением,
  // pathCrossesRects с eps=1). Только так «обход узлов жёсткий» держится и в тесноте.
  if (goalKey < 0) {
    if (margin > EPS) return routeOrthogonal(start, end, obstacles, { ...opts, margin: 0 });
    return cleanup([{ x: start.x, y: start.y }, { x: end.x, y: end.y }]);
  }

  // Реконструкция: от цели по cameFrom к старту, затем разворот и чистка коллинеарных.
  const pts: EdgePoint[] = [];
  let cur = goalKey;
  for (;;) {
    const dir = cur % 3;
    const cell = (cur - dir) / 3;
    const j = cell % NY;
    const i = (cell - j) / NY;
    pts.push({ x: xs[i], y: ys[j] });
    const prev = cameFrom.get(cur);
    if (prev === undefined) break;
    cur = prev;
  }
  pts.reverse();
  return cleanup(pts);
}
