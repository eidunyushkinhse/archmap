// «Мостики» (line jumps): стрелка, пересекающая другую стрелку, перепрыгивает её
// полудугой. Чистая геометрия — детект пересечений + сборка SVG-пути с дугами.
//
// Правило (по запросу): дуга появляется ТОЛЬКО на «крестике» — когда два сегмента
// перпендикулярны и пересекаются СТРОГО ВНУТРИ обоих. Если две стрелки идут вместе
// (исходят из одного хэндла, коллинеарны до чьего-то излома), их совпадающие
// сегменты ПАРАЛЛЕЛЬНЫ → не крестик → дуги нет. Строгая «внутренность» отсекает и
// T-стыки (конец одной лежит на другой), и общий хэндл, и углы.
//
// Перепрыгивает всегда ГОРИЗОНТАЛЬНОЕ ребро (стандартная конвенция line-hop), дуга
// выгибается вверх (к меньшему y). На каждом крестике прыгает ровно одна стрелка.
import type { EdgePoint } from "../../types";
import { segments } from "./edgePath";

export interface JumpPoint {
  x: number;
  y: number;
}

const EPS = 0.5;

// Для набора ломаных (id → точки) возвращает точки-«мостики» по каждому ребру.
export function computeJumps(polys: Map<string, EdgePoint[]>): Map<string, JumpPoint[]> {
  const ids = [...polys.keys()];
  const result = new Map<string, JumpPoint[]>(ids.map((id) => [id, []]));
  const segs = new Map(ids.map((id) => [id, segments(polys.get(id)!)]));

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const segA = segs.get(ids[i])!;
      const segB = segs.get(ids[j])!;
      for (const sa of segA) {
        for (const sb of segB) {
          if (sa.orient === sb.orient) continue; // параллельны → совместный ход, не крестик
          const h = sa.orient === "h" ? sa : sb; // горизонтальный сегмент
          const v = sa.orient === "h" ? sb : sa; // вертикальный сегмент
          const hy = h.y1;
          const vx = v.x1;
          const hxMin = Math.min(h.x1, h.x2);
          const hxMax = Math.max(h.x1, h.x2);
          const vyMin = Math.min(v.y1, v.y2);
          const vyMax = Math.max(v.y1, v.y2);
          // СТРОГО внутри обоих сегментов → исключаем общие концы/углы/T-стыки
          if (vx > hxMin + EPS && vx < hxMax - EPS && hy > vyMin + EPS && hy < vyMax - EPS) {
            const horizId = sa.orient === "h" ? ids[i] : ids[j]; // прыгает горизонтальное ребро
            result.get(horizId)!.push({ x: vx, y: hy });
          }
        }
      }
    }
  }
  return result;
}

// Прямой отрезок start→end (продолжение текущей точки пера) с «мостиками» над теми
// jumps, что лежат на нём. Дуги только на ГОРИЗОНТАЛЬНОМ отрезке; вертикаль/прочее —
// прямая линия. Дуга выгибается вверх (к меньшему y) при любом направлении хода.
function straightWithJumps(start: EdgePoint, end: EdgePoint, jumps: JumpPoint[], jr: number): string {
  if (Math.abs(start.y - end.y) > EPS) return ` L ${end.x},${end.y}`;
  const y = start.y;
  const dir = end.x >= start.x ? 1 : -1;
  const lo = Math.min(start.x, end.x);
  const hi = Math.max(start.x, end.x);
  // мостик целиком умещается на отрезке (с запасом jr от концов, чтобы дуга не лезла в угол)
  const hops = jumps
    .filter((p) => Math.abs(p.y - y) <= EPS && p.x - jr > lo && p.x + jr < hi)
    .sort((p, q) => dir * (p.x - q.x)); // в порядке хода пера
  if (hops.length === 0) return ` L ${end.x},${end.y}`;
  let d = "";
  for (const hop of hops) {
    const before = hop.x - dir * jr;
    const after = hop.x + dir * jr;
    const sweep = dir > 0 ? 1 : 0; // выгиб вверх (к меньшему y) независимо от направления
    d += ` L ${before},${y} A ${jr} ${jr} 0 0 ${sweep} ${after},${y}`;
  }
  d += ` L ${end.x},${end.y}`;
  return d;
}

// SVG-путь по ортогональной ломаной со скруглением углов радиуса r (как roundedPolyline)
// + полудуги-«мостики» радиуса jr над точками jumps на горизонтальных сегментах.
export function buildPathWithJumps(
  pts: EdgePoint[],
  r: number,
  jumps: JumpPoint[],
  jr: number,
): string {
  const n = pts.length;
  if (n < 2) return "";
  // Точки трима углов на внутренних вершинах (a — подход к вершине, b — выход из неё).
  const a: Record<number, EdgePoint> = {};
  const b: Record<number, EdgePoint> = {};
  for (let j = 1; j < n - 1; j++) {
    const p0 = pts[j - 1];
    const p1 = pts[j];
    const p2 = pts[j + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    a[j] = { x: p1.x - ((p1.x - p0.x) / l1) * rr, y: p1.y - ((p1.y - p0.y) / l1) * rr };
    b[j] = { x: p1.x + ((p2.x - p1.x) / l2) * rr, y: p1.y + ((p2.y - p1.y) / l2) * rr };
  }

  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    // Прямая часть сегмента i: от выхода прошлого угла (или старта) до подхода к след. углу (или конца)
    const start = i === 0 ? pts[0] : b[i];
    const end = i === n - 2 ? pts[n - 1] : a[i + 1];
    d += straightWithJumps(start, end, jumps, jr);
    // Скругление угла на вершине i+1 (если она внутренняя)
    if (i + 1 <= n - 2) {
      const p1 = pts[i + 1];
      const bb = b[i + 1];
      d += ` Q ${p1.x},${p1.y} ${bb.x},${bb.y}`;
    }
  }
  return d;
}
