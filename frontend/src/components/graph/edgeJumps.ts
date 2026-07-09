// «Мостики» (line jumps): стрелка, пересекающая другую стрелку, перепрыгивает её
// полудугой. Чистая геометрия — детект пересечений + сборка SVG-пути с дугами.
//
// Правило (по запросу): дуга появляется ТОЛЬКО на «крестике» — когда два сегмента
// перпендикулярны и пересекаются СТРОГО ВНУТРИ обоих. Если две стрелки идут вместе
// (исходят из одного хэндла, коллинеарны до чьего-то излома), их совпадающие
// сегменты ПАРАЛЛЕЛЬНЫ → не крестик → дуги нет. Строгая «внутренность» отсекает и
// T-стыки (конец одной лежит на другой), и общий хэндл, и углы.
//
// «ДУГА ВСЕГДА» (2026-07-09): раньше прыгало только горизонтальное ребро, и если
// пересечение лежало ближе r+jr к его излому — дуга молча пропадала (класс жалобы:
// крест у поворота соседки по каналу, зазор канала 12 < 18). Теперь ось и радиус
// выбирает computeJumps по фактически доступной ПРЯМОЙ части сегментов (после трима
// скруглений): горизонталь с полным jr → иначе вертикаль с полным jr → иначе ось с
// большим запасом и УМЕНЬШЕННЫМ радиусом (деградация вместо отказа). Непокрытым
// остаётся только вырожденный крест в зоне скруглений ОБОИХ рёбер — там линия уже
// не идёт по оси и дуге физически негде стоять.
//
// Конвенции выгиба: горизонтальная дуга — вверх (к меньшему y), вертикальная — вправо
// (к большему x). На каждом крестике прыгает ровно одна стрелка.
import type { EdgePoint } from "../../types";
import { segments } from "./edgePath";
import { JUMP_RADIUS, EDGE_CORNER_RADIUS } from "./constants";

export interface JumpPoint {
  x: number;
  y: number;
  /** эффективный радиус дуги этого мостика (деградирует в тесноте) */
  jr: number;
}

const EPS = 0.5;
// минимальный видимый радиус мостика: меньше — дуга неотличима от разрыва
const JR_MIN = 2;

// Прямая часть сегмента i ломаной pts ПО ПРОДОЛЬНОЙ ОСИ — [lo, hi] после трима под
// скругления углов (та же формула rr = min(r, l1/2, l2/2), что в buildPathWithJumps;
// концы ломаной не тримятся). По ней computeJumps решает, влезет ли дуга.
function straightSpan(pts: EdgePoint[], i: number, r: number): { lo: number; hi: number } {
  const n = pts.length;
  const p = pts[i], q = pts[i + 1];
  const horiz = Math.abs(p.y - q.y) <= Math.abs(p.x - q.x);
  const at = (t: EdgePoint): number => (horiz ? t.x : t.y);
  const len = (a: EdgePoint, b: EdgePoint): number => Math.hypot(b.x - a.x, b.y - a.y);
  let start = at(p);
  let end = at(q);
  const dir = Math.sign(end - start) || 1;
  if (i > 0) {
    const rr = Math.min(r, len(pts[i - 1], p) / 2, len(p, q) / 2);
    start += dir * rr;
  }
  if (i + 2 < n) {
    const rr = Math.min(r, len(p, q) / 2, len(q, pts[i + 2]) / 2);
    end -= dir * rr;
  }
  return { lo: Math.min(start, end), hi: Math.max(start, end) };
}

// Для набора ломаных (id → точки) возвращает точки-«мостики» по каждому ребру.
// r/jr — радиусы скругления углов и мостика (синхронны с buildPathWithJumps).
export function computeJumps(
  polys: Map<string, EdgePoint[]>,
  r: number = EDGE_CORNER_RADIUS,
  jr: number = JUMP_RADIUS,
): Map<string, JumpPoint[]> {
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
          if (!(vx > hxMin + EPS && vx < hxMax - EPS && hy > vyMin + EPS && hy < vyMax - EPS)) continue;
          const horizId = sa.orient === "h" ? ids[i] : ids[j];
          const vertId = sa.orient === "h" ? ids[j] : ids[i];
          // Запас прямой части каждой оси в точке креста (после трима скруглений)
          const spanH = straightSpan(polys.get(horizId)!, h.index, r);
          const spanV = straightSpan(polys.get(vertId)!, v.index, r);
          const availH = Math.min(vx - spanH.lo, spanH.hi - vx);
          const availV = Math.min(hy - spanV.lo, spanV.hi - hy);
          if (availH >= jr) {
            result.get(horizId)!.push({ x: vx, y: hy, jr }); // конвенция: горизонталь первой
          } else if (availV >= jr) {
            result.get(vertId)!.push({ x: vx, y: hy, jr }); // фолбэк: прыгает вертикаль
          } else {
            // деградация: ось с бОльшим запасом, радиус — сколько влезает
            const useH = availH >= availV;
            const jrEff = Math.min(jr, (useH ? availH : availV) - 0.25);
            if (jrEff >= JR_MIN) {
              result.get(useH ? horizId : vertId)!.push({ x: vx, y: hy, jr: jrEff });
            }
            // jrEff < JR_MIN: крест в зоне скруглений обоих рёбер — дуге негде стоять
          }
        }
      }
    }
  }
  return result;
}

// Прямой отрезок start→end (продолжение текущей точки пера) с «мостиками» над теми
// jumps, что лежат на нём. Работает для ОБЕИХ осей: горизонталь выгибается вверх,
// вертикаль — вправо; неосевой отрезок — прямая линия. Радиус дуги — свой у каждого
// мостика (hop.jr, деградация в тесноте); перекрывающиеся соседние дуги сжимаются.
function straightWithJumps(start: EdgePoint, end: EdgePoint, jumps: JumpPoint[], jrDefault: number): string {
  const horiz = Math.abs(start.y - end.y) <= EPS;
  const vert = !horiz && Math.abs(start.x - end.x) <= EPS;
  if (!horiz && !vert) return ` L ${end.x},${end.y}`;
  const along = (p: { x: number; y: number }): number => (horiz ? p.x : p.y);
  const c = horiz ? start.y : start.x; // постоянная (поперечная) координата
  const dir = along(end) >= along(start) ? 1 : -1;
  const lo = Math.min(along(start), along(end));
  const hi = Math.max(along(start), along(end));
  // мостик ложится на отрезок; радиус клампится по фактическому месту (страховка от
  // рассинхрона с computeJumps), совсем невидимый (< JR_MIN) — пропускается
  const hops = jumps
    .filter((p) => Math.abs((horiz ? p.y : p.x) - c) <= EPS && along(p) > lo + EPS && along(p) < hi - EPS)
    .map((p) => ({
      pos: along(p),
      jr: Math.min(p.jr ?? jrDefault, along(p) - lo - 0.25, hi - along(p) - 0.25),
    }))
    .filter((hop) => hop.jr >= JR_MIN)
    .sort((a, b) => dir * (a.pos - b.pos)); // в порядке хода пера
  if (hops.length === 0) return ` L ${end.x},${end.y}`;
  // перекрывающиеся соседние дуги сжимаются до половины зазора (иначе «пила»)
  for (let k = 1; k < hops.length; k++) {
    const gap = Math.abs(hops[k].pos - hops[k - 1].pos);
    if (hops[k - 1].jr + hops[k].jr > gap - 0.5) {
      const half = Math.max((gap - 0.5) / 2, JR_MIN);
      hops[k - 1].jr = Math.min(hops[k - 1].jr, half);
      hops[k].jr = Math.min(hops[k].jr, half);
    }
  }
  let d = "";
  for (const hop of hops) {
    // выгиб: горизонталь — вверх, вертикаль — вправо; формула sweep едина для обеих осей
    const sweep = dir > 0 ? 1 : 0;
    const b1 = hop.pos - dir * hop.jr;
    const b2 = hop.pos + dir * hop.jr;
    if (horiz) d += ` L ${b1},${c} A ${hop.jr} ${hop.jr} 0 0 ${sweep} ${b2},${c}`;
    else d += ` L ${c},${b1} A ${hop.jr} ${hop.jr} 0 0 ${sweep} ${c},${b2}`;
  }
  d += ` L ${end.x},${end.y}`;
  return d;
}

// SVG-путь по ортогональной ломаной со скруглением углов радиуса r (как roundedPolyline)
// + полудуги-«мостики» над точками jumps (обе оси, радиус пер-мостиковый).
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
