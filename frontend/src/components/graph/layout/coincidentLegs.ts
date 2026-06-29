// Детект СОВПАВШИХ ПЛЕЧ стрелок (эпик стрелок, фаза A4 — основа R4). Чистая геометрия.
//
// Зачем: две стрелки РАЗНЫХ пар могут идти какое-то расстояние по одной линии (вышли из
// общего хэндла, коллинеарны до чьего-то излома). На таком общем плече подпись неоднозначна —
// непонятно, к какой стрелке она относится (R4). Этот модуль находит на каждом ребре участки,
// совпавшие хотя бы с одним ДРУГИМ ребром, и возвращает их в координатах arc-length (доля
// длины от начала ломаной) — там, где плашки запрещены. Дополнение (уникальные участки, куда
// плашку ставить МОЖНО) даёт subtractIntervals. См. ARROWS_ROUTING_ANALYSIS.md §4 (R4), §6 (A4).
//
// Важно: совпадение — это КОЛЛИНЕАРНОЕ перекрытие (один axis, перекрытие проекций). Перпенди-
// кулярное пересечение «крестиком» — это НЕ совпадение (его обрабатывают мостики, edgeJumps).
import type { EdgePoint } from "../../../types";
import { cleanup, type SegOrient } from "../edgePath";

const EPS = 0.5;

// Интервал в координатах arc-length одной ломаной: [s, e], s ≤ e (px от начала пути).
export interface Interval {
  s: number;
  e: number;
}

// Сегмент ломаной с привязкой к arc-length. axis — постоянная координата (y для «h», x для «v»),
// a/b — меняющаяся координата в начале/конце сегмента (по направлению пути), arc0 — arc-length
// в начале сегмента. Точка с меняющейся координатой c имеет arc = arc0 + |c − a|.
interface ArcSeg {
  orient: SegOrient;
  axis: number;
  a: number;
  b: number;
  arc0: number;
}

// Ортогональные сегменты ломаной с накопленной arc-length. Путь предварительно чистится
// (cleanup убирает дубликаты и коллинеарные изломы), поэтому каждый сегмент строго H или V.
function arcSegments(pts: EdgePoint[]): ArcSeg[] {
  const c = cleanup(pts);
  const out: ArcSeg[] = [];
  let arc = 0;
  for (let i = 0; i < c.length - 1; i++) {
    const p = c[i], q = c[i + 1];
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.abs(dx) + Math.abs(dy); // ортогонально: манхэттен = евклидова длина
    if (len <= EPS) continue;
    const orient: SegOrient = Math.abs(dy) <= Math.abs(dx) ? "h" : "v";
    if (orient === "h") out.push({ orient, axis: p.y, a: p.x, b: q.x, arc0: arc });
    else out.push({ orient, axis: p.x, a: p.y, b: q.y, arc0: arc });
    arc += len;
  }
  return out;
}

// Перекрытие двух коллинеарных сегментов → совпавшие arc-интервалы на каждом из них
// (первый — на sa, второй — на sb). null, если ориентации/оси разные или лишь касание.
function overlapShared(sa: ArcSeg, sb: ArcSeg): [Interval, Interval] | null {
  if (sa.orient !== sb.orient) return null;          // перпендикуляр — крестик, не совпадение
  if (Math.abs(sa.axis - sb.axis) > EPS) return null; // параллельны на разных линиях
  const loA = Math.min(sa.a, sa.b), hiA = Math.max(sa.a, sa.b);
  const loB = Math.min(sb.a, sb.b), hiB = Math.max(sb.a, sb.b);
  const lo = Math.max(loA, loB), hi = Math.min(hiA, hiB);
  if (hi - lo <= EPS) return null; // нет перекрытия по проекции (или только касание концами)
  const arcA1 = sa.arc0 + Math.abs(lo - sa.a), arcA2 = sa.arc0 + Math.abs(hi - sa.a);
  const arcB1 = sb.arc0 + Math.abs(lo - sb.a), arcB2 = sb.arc0 + Math.abs(hi - sb.a);
  return [
    { s: Math.min(arcA1, arcA2), e: Math.max(arcA1, arcA2) },
    { s: Math.min(arcB1, arcB2), e: Math.max(arcB1, arcB2) },
  ];
}

// Слияние перекрывающихся/смежных (зазор ≤ EPS) интервалов в максимальные. Чистая функция.
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.s - b.s);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let k = 1; k < sorted.length; k++) {
    const cur = sorted[k];
    const last = out[out.length - 1];
    if (cur.s <= last.e + EPS) last.e = Math.max(last.e, cur.e);
    else out.push({ ...cur });
  }
  return out;
}

// Дополнение: участки `whole`, не покрытые ни одной «дырой» (holes). Для A5 — уникальные
// участки ребра = subtractIntervals([0, total], совпавшие плечи). Возвращает интервалы
// длиннее EPS в порядке возрастания.
export function subtractIntervals(whole: Interval, holes: Interval[]): Interval[] {
  const clipped = holes
    .map((h) => ({ s: Math.max(h.s, whole.s), e: Math.min(h.e, whole.e) }))
    .filter((h) => h.e - h.s > EPS);
  const merged = mergeIntervals(clipped);
  const out: Interval[] = [];
  let cursor = whole.s;
  for (const h of merged) {
    if (h.s - cursor > EPS) out.push({ s: cursor, e: h.s });
    cursor = Math.max(cursor, h.e);
  }
  if (whole.e - cursor > EPS) out.push({ s: cursor, e: whole.e });
  return out;
}

// Полная arc-length ортогональной ломаной, px.
export function edgeArcLength(pts: EdgePoint[]): number {
  const c = cleanup(pts);
  let arc = 0;
  for (let i = 0; i < c.length - 1; i++) {
    arc += Math.abs(c[i + 1].x - c[i].x) + Math.abs(c[i + 1].y - c[i].y);
  }
  return arc;
}

// По набору маршрутов (id ребра → ломаная) возвращает для каждого ребра совпавшие с ДРУГИМИ
// рёбрами участки в arc-length, слитые в максимальные интервалы. Пустой список = ребро нигде
// не совпадает (всё плечо уникально). Совпадение симметрично: если A совпал с B на участке,
// он попадёт и в shared[A], и в shared[B] (на своих arc-координатах).
export function coincidentLegs(polys: Map<string, EdgePoint[]>): Map<string, Interval[]> {
  const ids = [...polys.keys()];
  const segs = new Map(ids.map((id) => [id, arcSegments(polys.get(id)!)]));
  const shared = new Map<string, Interval[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const sa of segs.get(ids[i])!) {
        for (const sb of segs.get(ids[j])!) {
          const ov = overlapShared(sa, sb);
          if (!ov) continue;
          shared.get(ids[i])!.push(ov[0]);
          shared.get(ids[j])!.push(ov[1]);
        }
      }
    }
  }
  for (const id of ids) shared.set(id, mergeIntervals(shared.get(id)!));
  return shared;
}
