// СВАРКА СТВОЛОВ (эпик «общие плечи v2», Ф2 — исходящие; docs/plan-arrow-trunks.md).
//
// Пост-проход после distributeSlots: follower веера (общий ФАКТИЧЕСКИЙ p0) пробует
// перенять префикс собрата до его j-го излома (j ≤ WELD_K за попытку), хвост от точки
// перенятия до СВОЕГО целевого дока докладывает обычный routePorts (доки не двигаются —
// сварка меняет форму, не хэндлы). Семя хвоста направлено ПО ходу ствола (разворот
// на шве невозможен физически), финиш — против нормали дока.
//
// Принятие ДВУХСТУПЕНЧАТОЕ (E78):
//  (1) «грязь» не хуже ПОКОМПОНЕНТНО: кресты, нелегальная езда, штрафы среды
//      кандидата ≤ текущего — бонус слияния не может купить новую грязь (E24);
//  (2) «чернила» строго лучше: len + bends·BP − MERGE_GAIN·(легально слитая длина).
//      MERGE_GAIN отражает выигрыш читаемости слияния (две параллельные линии → одна);
//      без него слияние стоит ровно столько же, сколько параллель в 14px рядом.
//
// Стволы переживают поколения БЕЗ prev-перевеса: сварка детерминирована и пересоздаёт
// их каждый прогон (welded-маршрут к тому же валидный prev следующего поколения).
// Живой драг сварку НЕ гоняет (E62) — доворот на отпускании прячет drawIn (E64).
import type { EdgePoint } from "../../../types";
import { cleanup, type EdgeSide, type NodeRect } from "../edgePath";
import { routePorts } from "./orthoRoute";
import { evalRouteParts, makeMoveCost, toPlacedSegs, type PlacedSeg, type RouteParts } from "./routeAll";
import { commonPrefix, commonSuffix, pieceLen } from "./trunks";

// Бонус слияния, px-эквивалент за px легально слитой длины. ТОЛЬКО здесь, в принятии
// сварки (ступень 2): добавленный в routeCost он протекал в сравнения rip-up/джогов
// и покупал объезды (полигон-эксперимент Ф1, журнал плана).
export const MERGE_GAIN = 0.5;
// Изломов собрата перенимается за одну попытку; итерации до фикспойнта добирают глубже.
const WELD_K = 3;
const WELD_ITER_CAP = 3;
// Порог строгого выигрыша чернил: ничьи не перекраивают маршрут (идемпотентность).
const WELD_EPS = 0.5;
const EPS = 0.5;

const portKey = (p: EdgePoint): string => `${Math.round(p.x * 2)}|${Math.round(p.y * 2)}`;

// Сторона, чья внешняя нормаль совпадает с направлением осевого сегмента p→q
// (для направленного семени хвоста «уже идущим по стволу»). Диагональ → null.
function sideAlong(p: EdgePoint, q: EdgePoint): EdgeSide | null {
  const dx = q.x - p.x, dy = q.y - p.y;
  if (Math.abs(dy) <= EPS) return dx > 0 ? "right" : "left";
  if (Math.abs(dx) <= EPS) return dy > 0 ? "bottom" : "top";
  return null;
}

// Вершины ломаной с кумулятивной дугой (манхэттен).
function vertsWithArc(pts: EdgePoint[]): Array<{ p: EdgePoint; arc: number }> {
  const out: Array<{ p: EdgePoint; arc: number }> = [];
  let arc = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) arc += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    out.push({ p: pts[i], arc });
  }
  return out;
}

// Легально слитая длина ломаной против собратьев по фактическим концам (E25 v2):
// |[0, maxPref] ∪ [total − maxSuf, total]| — каждый px один раз.
function sharedLegal(pts: EdgePoint[], fellows: EdgePoint[][]): number {
  if (pts.length < 2) return 0;
  const a0 = pts[0], aN = pts[pts.length - 1];
  const near = (a: EdgePoint, b: EdgePoint): boolean =>
    Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;
  let maxPref = 0, maxSuf = 0;
  for (const f of fellows) {
    if (f.length < 2 || f === pts) continue;
    if (near(f[0], a0)) maxPref = Math.max(maxPref, pieceLen(commonPrefix(pts, f)));
    if (near(f[f.length - 1], aN)) maxSuf = Math.max(maxSuf, pieceLen(commonSuffix(pts, f)));
  }
  return Math.min(pieceLen(pts), maxPref + maxSuf);
}

export interface WeldParams {
  routes: Map<string, EdgePoint[]>;   // мутируется: welded-маршруты заменяются на месте
  routableIds: ReadonlySet<string>;   // кого можно переписывать (лидером может быть любой)
  preplaced?: EdgePoint[][];          // контекст вне набора (мини-проход T4: prev-маршруты)
  obstacles: NodeRect[];              // тела узлов + плашки рамок (общие для всех рёбер)
  // пер-рёберный штраф среды (границы чужих рамок / чужие плашки), как у терминалов
  extraOf?: (id: string) => ((x1: number, y1: number, x2: number, y2: number) => number) | undefined;
  // сторона целевого дока follower-а (направленный финиш хвоста); undefined — без стороны
  endSideOf?: (id: string) => EdgeSide | undefined;
  crossCost?: number;
  bendPenalty?: number;
}

// Возвращает id перекроенных рёбер. Детерминирован (порядок: ключ порта → id follower-а
// → id собрата → дуга излома); повторный вызов на результате — no-op.
export function weldTrunks(params: WeldParams): Set<string> {
  const { routes, routableIds, obstacles, extraOf, endSideOf } = params;
  const preplaced = params.preplaced ?? [];
  const crossCost = params.crossCost ?? 200;
  const bp = params.bendPenalty ?? 40;
  const welded = new Set<string>();

  // контекст оценки follower-а: сегменты и ломаные ВСЕХ остальных (включая preplaced)
  const contextOf = (skipId: string): { segs: PlacedSeg[]; routes: EdgePoint[][] } => {
    const segs: PlacedSeg[] = [];
    const rts: EdgePoint[][] = [];
    for (const [id, r] of routes) {
      if (id === skipId || r.length < 2) continue;
      segs.push(...toPlacedSegs(r));
      rts.push(r);
    }
    for (const r of preplaced) {
      if (r.length < 2) continue;
      segs.push(...toPlacedSegs(r));
      rts.push(r);
    }
    return { segs, routes: rts };
  };
  const ink = (parts: RouteParts, shared: number): number =>
    parts.len + parts.bends * bp - MERGE_GAIN * shared;

  for (let iter = 0; iter < WELD_ITER_CAP; iter++) {
    let changed = false;
    // веера по фактическому порту-источнику: routable — кандидаты в followers,
    // preplaced — только лидеры (их не переписываем)
    const buckets = new Map<string, Array<{ id: string | null; pts: EdgePoint[] }>>();
    const push = (id: string | null, pts: EdgePoint[]): void => {
      if (pts.length < 2) return;
      const k = portKey(pts[0]);
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push({ id, pts });
    };
    for (const id of [...routes.keys()].sort()) push(id, routes.get(id)!);
    preplaced.forEach((r) => push(null, r));

    for (const key of [...buckets.keys()].sort()) {
      const bucket = buckets.get(key)!;
      if (bucket.length < 2) continue;
      for (const member of bucket) {
        if (member.id === null || !routableIds.has(member.id)) continue;
        const follower = member.id;
        const cur = routes.get(follower)!;
        if (cur.length < 2) continue;
        const ctx = contextOf(follower);
        const extra = extraOf?.(follower);
        const curParts = evalRouteParts(cur, ctx.segs, { extra, fellowRoutes: ctx.routes });
        const curInk = ink(curParts, sharedLegal(cur, ctx.routes));
        const dock = cur[cur.length - 1];
        let best: EdgePoint[] | null = null;
        let bestInk = curInk - WELD_EPS;
        for (const mate of bucket) {
          if (mate === member) continue;
          // живой маршрут собрата (мог быть переварен ранее в этой же итерации)
          const matePts = mate.id !== null ? routes.get(mate.id)! : mate.pts;
          if (matePts.length < 2) continue;
          const diverge = pieceLen(commonPrefix(cur, matePts));
          const verts = vertsWithArc(cleanup(matePts.map((p) => ({ x: p.x, y: p.y }))));
          // изломы собрата ЗА точкой расхождения (интерьерные вершины), первые WELD_K
          const qs = verts.slice(1, -1).filter((v) => v.arc > diverge + EPS).slice(0, WELD_K);
          for (const q of qs) {
            const qi = verts.indexOf(q);
            const arrSide = sideAlong(verts[qi - 1].p, q.p);
            if (!arrSide) continue; // диагональный подход — не ствол
            // хвост: от излома собрата (семя по ходу ствола, стаб минимальный — точка
            // поворота может лежать прямо за Q) до СВОЕГО дока
            const tailMove = makeMoveCost(ctx.segs, crossCost, { starts: [], ends: [dock] });
            const tail = routePorts(
              [{ point: { x: q.p.x, y: q.p.y }, side: arrSide }],
              [{ point: { x: dock.x, y: dock.y }, side: endSideOf?.(follower) }],
              obstacles,
              {
                bendPenalty: bp,
                stub: 2,
                moveCost: extra
                  ? (x1, y1, x2, y2): number => tailMove(x1, y1, x2, y2) + extra(x1, y1, x2, y2)
                  : tailMove,
              },
            );
            if (!tail || tail.pts.length < 2) continue;
            const adopted = verts.slice(0, qi).map((v) => ({ x: v.p.x, y: v.p.y }));
            const full = cleanup([...adopted, ...tail.pts]);
            if (full.length < 2) continue;
            const candParts = evalRouteParts(full, ctx.segs, { extra, fellowRoutes: ctx.routes });
            // ступень 1: грязь не хуже покомпонентно (допуски — числовой шум)
            if (
              candParts.crosses > curParts.crosses ||
              candParts.overlap > curParts.overlap + EPS ||
              candParts.extra > curParts.extra + 1e-6
            ) continue;
            // ступень 2: чернила с бонусом слияния строго лучше
            const candInk = ink(candParts, sharedLegal(full, ctx.routes));
            if (candInk < bestInk) {
              bestInk = candInk;
              best = full;
            }
          }
        }
        if (best) {
          routes.set(follower, best);
          welded.add(follower);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return welded;
}
