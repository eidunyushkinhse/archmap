// СВАРКА СТВОЛОВ (эпик «общие плечи v2», Ф2 исходящие + Ф3 входящие;
// docs/plan-arrow-trunks.md, E78/E79).
//
// Пост-проход после distributeSlots: follower веера (общий ФАКТИЧЕСКИЙ порт одной
// роли) пробует перенять ПРЕФИКС (исходящие) либо СУФФИКС (входящие) собрата до его
// j-го излома (j ≤ WELD_K за попытку), хвост от точки перенятия до СВОЕГО свободного
// дока докладывает обычный routePorts (доки не двигаются — сварка меняет форму, не
// хэндлы). Семя хвоста направлено ПО ходу ствола (разворот на шве невозможен
// физически), финиш — против нормали дока. Входящие свариваются тем же алгоритмом
// на развёрнутых ломаных (задача зеркальна), слился → до хэндла вместе по построению.
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
  // стороны доков follower-а: целевого (свободный конец out-прохода) и исходного
  // (свободный конец in-прохода); undefined — финиш хвоста без стороны
  endSideOf?: (id: string) => EdgeSide | undefined;
  startSideOf?: (id: string) => EdgeSide | undefined;
  crossCost?: number;
  bendPenalty?: number;
}

// Возвращает id перекроенных рёбер. Детерминирован (порядок: ключ порта → id follower-а
// → id собрата → дуга излома); повторный вызов на результате — no-op.
export function weldTrunks(params: WeldParams): Set<string> {
  const { routes, routableIds, obstacles, extraOf, endSideOf, startSideOf } = params;
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
    // Два прохода: "out" — веера по порту-источнику (перенимаются ПРЕФИКСЫ, E78);
    // "in" — по порту-цели (СУФФИКСЫ, E79). На РАЗВЁРНУТЫХ ломаных in-задача
    // тождественна out-проходу: общий порт становится [0], семя хвоста по ходу
    // развёрнутого ствола запрещает разворот на шве в обе стороны (T-подход сбоку
    // легален), свободный конец — исходный док. Результат разворачивается обратно,
    // оценка всегда в реальном пространстве.
    for (const kind of ["out", "in"] as const) {
      const orient = (pts: EdgePoint[]): EdgePoint[] =>
        kind === "out" ? pts : [...pts].reverse();
      // routable — кандидаты в followers, preplaced — только лидеры (не переписываем)
      const buckets = new Map<string, Array<{ id: string | null; pts: EdgePoint[] }>>();
      const push = (id: string | null, pts: EdgePoint[]): void => {
        if (pts.length < 2) return;
        const k = portKey(pts[0]);
        (buckets.get(k) ?? buckets.set(k, []).get(k)!).push({ id, pts });
      };
      for (const id of [...routes.keys()].sort()) push(id, orient(routes.get(id)!));
      preplaced.forEach((r) => push(null, orient(r)));

      for (const key of [...buckets.keys()].sort()) {
        const bucket = buckets.get(key)!;
        if (bucket.length < 2) continue;
        for (const member of bucket) {
          if (member.id === null || !routableIds.has(member.id)) continue;
          const follower = member.id;
          const curReal = routes.get(follower)!;
          if (curReal.length < 2) continue;
          const cur = orient(curReal);
          const ctx = contextOf(follower);
          const extra = extraOf?.(follower);
          const curParts = evalRouteParts(curReal, ctx.segs, { extra, fellowRoutes: ctx.routes });
          const curInk = ink(curParts, sharedLegal(curReal, ctx.routes));
          // свободный конец ориентированной ломаной: out → целевой док, in → исходный
          const dock = cur[cur.length - 1];
          const dockSide = kind === "out" ? endSideOf?.(follower) : startSideOf?.(follower);
          let best: EdgePoint[] | null = null;
          let bestInk = curInk - WELD_EPS;
          for (const mate of bucket) {
            if (mate === member) continue;
            // живой маршрут собрата (мог быть переварен ранее в этой же итерации)
            const matePts = mate.id !== null ? orient(routes.get(mate.id)!) : mate.pts;
            if (matePts.length < 2) continue;
            const diverge = pieceLen(commonPrefix(cur, matePts));
            const verts = vertsWithArc(cleanup(matePts.map((p) => ({ x: p.x, y: p.y }))));
            // изломы собрата ЗА точкой расхождения (интерьерные вершины), первые WELD_K
            const qs = verts.slice(1, -1).filter((v) => v.arc > diverge + EPS).slice(0, WELD_K);
            for (const q of qs) {
              const qi = verts.indexOf(q);
              const arrSide = sideAlong(verts[qi - 1].p, q.p);
              if (!arrSide) continue; // диагональный подход — не ствол
              // хвост: от излома собрата до свободного дока. Стаб дефолтный (E9):
              // у дока — полноценный выход из хэндла, у Q — поворот не раньше стаба
              // за изломом собрата (лесенки вплотную к шву не строим); в тесноте
              // clampStub укоротит сам.
              const tailMove = makeMoveCost(ctx.segs, crossCost, {
                starts: kind === "in" ? [dock] : [],
                ends: kind === "out" ? [dock] : [],
              });
              const tail = routePorts(
                [{ point: { x: q.p.x, y: q.p.y }, side: arrSide }],
                [{ point: { x: dock.x, y: dock.y }, side: dockSide }],
                obstacles,
                {
                  bendPenalty: bp,
                  moveCost: extra
                    ? (x1, y1, x2, y2): number => tailMove(x1, y1, x2, y2) + extra(x1, y1, x2, y2)
                    : tailMove,
                },
              );
              if (!tail || tail.pts.length < 2) continue;
              const adopted = verts.slice(0, qi).map((v) => ({ x: v.p.x, y: v.p.y }));
              const fullOriented = cleanup([...adopted, ...tail.pts]);
              if (fullOriented.length < 2) continue;
              const full = orient(fullOriented); // orient — инволюция
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
    }
    if (!changed) break;
  }
  return welded;
}
