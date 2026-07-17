// Хит-тест ОБЩЕГО ПЛЕЧА для двойного клика (Ф5 эпика arrow-trunks, E80).
//
// По отрисованным орто-маршрутам и точке клика на кликнутом ребре определяет,
// лежит ли точка в ЛЕГАЛЬНОМ стволе (E25 v2) нескольких связей: общий префикс
// исходящего веера (kind "out") либо общий суффикс входящего (kind "in").
// Возвращает отрисованные группы-участники, чей кусок покрывает точку клика;
// null — точка на уникальной части маршрута (обычная детализация). Чистая геометрия.
import type { EdgePoint } from "../../types";
import { commonPrefix, commonSuffix, pieceLen } from "./layout/trunks";

const EPS = 0.5;

export interface TrunkEdgeIn {
  id: string;        // id отрисованного ребра (группа/мастер)
  pts: EdgePoint[];  // ортоломаная (data.autoRoute)
}

export interface TrunkHit {
  kind: "out" | "in";
  // отрисованные участники ствола, кликнутое ребро первым; порядок прочих — вход
  memberIds: string[];
}

// Проекция точки на ломаную: дуга ближайшей точки и расстояние до неё.
function projectOnto(pts: EdgePoint[], p: EdgePoint): { arc: number; dist: number } {
  let bestArc = 0;
  let bestDist = Infinity;
  let arc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.abs(dx) + Math.abs(dy);
    if (len <= EPS) continue;
    // параметр ближайшей точки сегмента (осевые сегменты — проекция покоординатная)
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    const qx = a.x + dx * t, qy = a.y + dy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestDist) {
      bestDist = d;
      bestArc = arc + len * t;
    }
    arc += len;
  }
  return { arc: bestArc, dist: bestDist };
}

const near = (a: EdgePoint, b: EdgePoint): boolean =>
  Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

/**
 * Ствол в точке клика: собратья кликнутого ребра по фактическим концам, чей общий
 * префикс (суффикс) покрывает дугу точки. ≥1 собрат → ствол; оба вида → больше
 * участников, при равенстве — исходящий. tol — допуск попадания клика на линию.
 */
export function trunkHitAt(
  edges: TrunkEdgeIn[],
  clickedId: string,
  p: EdgePoint,
  tol = 8,
): TrunkHit | null {
  const clicked = edges.find((e) => e.id === clickedId);
  if (!clicked || clicked.pts.length < 2) return null;
  const proj = projectOnto(clicked.pts, p);
  if (proj.dist > tol) return null;
  const total = pieceLen(clicked.pts);
  const outMembers: string[] = [];
  const inMembers: string[] = [];
  for (const f of edges) {
    if (f.id === clickedId || f.pts.length < 2) continue;
    if (near(f.pts[0], clicked.pts[0])) {
      const len = pieceLen(commonPrefix(clicked.pts, f.pts));
      if (len > EPS && proj.arc <= len + EPS) outMembers.push(f.id);
    }
    if (near(f.pts[f.pts.length - 1], clicked.pts[clicked.pts.length - 1])) {
      const len = pieceLen(commonSuffix(clicked.pts, f.pts));
      if (len > EPS && proj.arc >= total - len - EPS) inMembers.push(f.id);
    }
  }
  if (outMembers.length === 0 && inMembers.length === 0) return null;
  const kind = outMembers.length >= inMembers.length ? "out" : "in";
  return { kind, memberIds: [clickedId, ...(kind === "out" ? outMembers : inMembers)] };
}
