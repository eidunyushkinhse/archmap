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
// (к большему x). На каждом крестике прыгает ровно одна СТОРОНА: одиночка — одной
// дугой, а если прыгать выпало стороне-пучку (совпадающие плечи) — дугу получает
// КАЖДЫЙ её член (дуги совпадают, визуально одна). См. комментарий у computeJumps.
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
//
// РЕШЕНИЕ ПО ТОЧКЕ, не по-парно (2026-07-09): через один крест могут проходить
// НЕСКОЛЬКО совпадающих плеч (общее плечо пучка из одного хэндла). Прежний
// попарный выбор давал на таком кресте кашу: часть членов пучка получала дугу,
// часть — нет («прямой перекрёсток» насквозь), а одиночке доставались N дублей-
// мостиков в одной точке, которые сжатие перекрывающихся дуг ужимало до
// микродуги JR_MIN (жалоба: крест ОС-хосты→Zabbix Core с плечом трёх стрелок).
// Теперь крестики группируются по точке; сторона-кандидат — с МЕНЬШИМ числом
// совпадающих плеч (одиночка предпочтительнее пучка: одна дуга над слитым
// плечом вместо N), при равенстве — горизонталь (прежняя конвенция). Запас
// стороны — МИНИМУМ по её членам: дуга нужна каждому, иначе член без дуги
// рисует прямую поверх чужой дуги.
export function computeJumps(
  polys: Map<string, EdgePoint[]>,
  r: number = EDGE_CORNER_RADIUS,
  jr: number = JUMP_RADIUS,
): Map<string, JumpPoint[]> {
  const ids = [...polys.keys()];
  const result = new Map<string, JumpPoint[]>(ids.map((id) => [id, []]));
  // Безопасно: id только что извлечён из polys.keys() — ключ гарантированно существует
  const segs = new Map(ids.map((id) => [id, segments(polys.get(id)!)]));

  // 1) все крестики СПИСКОМ; группировка — ниже, КЛАСТЕРАМИ (радиус CLUSTER_R), а не
  // точным совпадением точки: почти-совпадающие плечи (коллинеарная пара, разъехавшаяся
  // на пиксели от стаб-клампов/нюджей) дают кресты в паре px друг от друга — решённые
  // порознь, они расходились («одна огибает, другая игнорирует», жалоба 2026-07-09).
  // Радиус 8 < GAP канала 14: честно разведённые плечи не слипаются.
  interface Member { id: string; index: number }
  interface RawCross { x: number; y: number; hId: string; hIdx: number; vId: string; vIdx: number }
  const crossings: RawCross[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      // Безопасно: segs построена по всем ids — индексация ids[i]/ids[j] всегда даёт ключ
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
          crossings.push({ x: vx, y: hy, hId: horizId, hIdx: h.index, vId: vertId, vIdx: v.index });
        }
      }
    }
  }

  // 2) кластеризация крестов: жадно, детерминированно (сортировка по y,x); крест
  // липнет к кластеру, чей ЯКОРЬ (первый крест) ближе CLUSTER_R по обеим осям —
  // без транзитивных цепочек разброс кластера ≤ CLUSTER_R, и дуга jr=6 накрывает
  // все его кресты от середины
  const CLUSTER_R = 8;
  interface CrossPoint { sumX: number; sumY: number; n: number; hs: Map<string, Member>; vs: Map<string, Member> }
  crossings.sort((a, b) => a.y - b.y || a.x - b.x || a.hId.localeCompare(b.hId) || a.vId.localeCompare(b.vId));
  const points: CrossPoint[] = [];
  const anchors: { x: number; y: number }[] = [];
  for (const c of crossings) {
    let pt: CrossPoint | undefined;
    for (let k = 0; k < anchors.length; k++) {
      if (Math.abs(anchors[k].x - c.x) <= CLUSTER_R && Math.abs(anchors[k].y - c.y) <= CLUSTER_R) { pt = points[k]; break; }
    }
    if (!pt) {
      pt = { sumX: 0, sumY: 0, n: 0, hs: new Map(), vs: new Map() };
      points.push(pt);
      anchors.push({ x: c.x, y: c.y });
    }
    pt.sumX += c.x; pt.sumY += c.y; pt.n++;
    pt.hs.set(`${c.hId}#${c.hIdx}`, { id: c.hId, index: c.hIdx });
    pt.vs.set(`${c.vId}#${c.vIdx}`, { id: c.vId, index: c.vIdx });
  }

  // 3) решение по каждому кластеру. Позиция дуги — СЕРЕДИНА кластера по продольной
  // оси члена, а поперечная координата хопа — ОСЬ САМОГО ЧЛЕНА (иначе фильтр
  // отрисовки «мостик лежит на сегменте» молча выбросил бы хоп).
  const axisOf = (m: Member, horiz: boolean): number => {
    // Безопасно: m.id — из crossings, где hId/vId всегда ∈ ids (ключи polys)
    const pts = polys.get(m.id)!;
    return horiz ? pts[m.index].y : pts[m.index].x;
  };
  for (const pt of points) {
    const meanX = pt.sumX / pt.n;
    const meanY = pt.sumY / pt.n;
    // запас прямой части члена в середине кластера (после трима скруглений)
    const availOf = (m: Member, horiz: boolean): number => {
      // Безопасно: m.id — из crossings, всегда ключ polys (см. axisOf)
      const span = straightSpan(polys.get(m.id)!, m.index, r);
      const c = horiz ? meanX : meanY;
      return Math.min(c - span.lo, span.hi - c);
    };
    const hs = [...pt.hs.values()];
    const vs = [...pt.vs.values()];
    const sideH = { horiz: true, members: hs, avail: Math.min(...hs.map((m) => availOf(m, true))) };
    const sideV = { horiz: false, members: vs, avail: Math.min(...vs.map((m) => availOf(m, false))) };
    // порядок кандидатов: меньше членов → раньше; при равенстве горизонталь первой
    const sides = vs.length < hs.length ? [sideV, sideH] : [sideH, sideV];
    const push = (side: typeof sideH, jrEff: number) => {
      for (const m of side.members) {
        const axis = axisOf(m, side.horiz);
        // Безопасно: result инициализирована по всем ids; m.id ∈ ids (см. axisOf)
        result.get(m.id)!.push(side.horiz ? { x: meanX, y: axis, jr: jrEff } : { x: axis, y: meanY, jr: jrEff });
      }
    };
    if (sides[0].avail >= jr) push(sides[0], jr);
    else if (sides[1].avail >= jr) push(sides[1], jr);
    else {
      // деградация: сторона с бОльшим запасом, радиус — сколько влезает
      const s = sides[0].avail >= sides[1].avail ? sides[0] : sides[1];
      const jrEff = Math.min(jr, s.avail - 0.25);
      if (jrEff >= JR_MIN) push(s, jrEff);
      // jrEff < JR_MIN: крест в зоне скруглений обоих рёбер — дуге негде стоять
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
