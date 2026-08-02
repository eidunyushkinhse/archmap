// СВАРКА СТВОЛОВ (эпик «общие плечи v2», Ф2 исходящие + Ф3 входящие;
// docs/archive/plan-arrow-trunks.md, E78/E79).
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
// Кандидат сварки не может удлинить маршрут больше чем в WELD_STRETCH раз (+люфт на
// мелкие рёбра): при MERGE_GAIN → 1 езда по стволу почти бесплатна, и без капа бонус
// оплачивал крюки через весь уровень (мутант «вправо 885, чтобы вернуться влево 2200»,
// журнал плана — донастройка жадности).
const WELD_STRETCH = 1.25;
const WELD_STRETCH_SLACK = 40;
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set() выше гарантировал наличие ключа
        (buckets.get(k) ?? buckets.set(k, []).get(k)!).push({ id, pts });
      };
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- id из routes.keys(), ключ заведомо есть
      for (const id of [...routes.keys()].sort()) push(id, orient(routes.get(id)!));
      preplaced.forEach((r) => push(null, orient(r)));

      for (const key of [...buckets.keys()].sort()) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- key из buckets.keys(), ключ заведомо есть
        const bucket = buckets.get(key)!;
        if (bucket.length < 2) continue;
        for (const member of bucket) {
          if (member.id === null || !routableIds.has(member.id)) continue;
          const follower = member.id;
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- follower из routes.keys() (push выше)
          const curReal = routes.get(follower)!;
          if (curReal.length < 2) continue;
          const cur = orient(curReal);
          const ctx = contextOf(follower);
          // Фактические порты follower-а: «грязный» всадник на собрате — связь,
          // не делящая с follower-ом НИ источника, НИ цели (см. границу тройника).
          const fStartKey = portKey(curReal[0]);
          const fEndKey = portKey(curReal[curReal.length - 1]);
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
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- mate.id из routes.keys() (push выше)
            const matePts = mate.id !== null ? orient(routes.get(mate.id)!) : mate.pts;
            if (matePts.length < 2) continue;
            const diverge = pieceLen(commonPrefix(cur, matePts));
            const verts = vertsWithArc(cleanup(matePts.map((p) => ({ x: p.x, y: p.y }))));
            const totalMate = verts[verts.length - 1]?.arc ?? 0;
            // ГРАНИЦА ТРОЙНИКА (E25 v2): перенятый кусок не должен заходить в зону,
            // где по собрату едет связь, НЕ делящая с follower-ом ни источника, ни
            // цели. Иначе сварка строит нелегальный тройник: F едет с M, M едет с O,
            // но F и O общего плеча иметь не могут (общее плечо — только попарно, от
            // общего порта одной роли). Граница — начало ближайшей по дуге собрата
            // «грязной зоны» (коллинеарное перекрытие собрата с таким O, допуск оси
            // E28); кандидаты за ней отметаются, сама она — дополнительный кандидат
            // (максимально длинный легальный кусок). in-проход зеркалится ориентацией.
            let limit = Infinity;
            for (let j = 1; j < verts.length; j++) {
              const a = verts[j - 1], b = verts[j];
              const horiz = Math.abs(b.p.y - a.p.y) <= EPS;
              const vertical = Math.abs(b.p.x - a.p.x) <= EPS;
              if (horiz === vertical) continue; // диагональ — не ствол
              const cM = horiz ? a.p.y : a.p.x;
              const startM = horiz ? a.p.x : a.p.y; // варь-координата в начале (arc0)
              const loM = horiz ? Math.min(a.p.x, b.p.x) : Math.min(a.p.y, b.p.y);
              const hiM = horiz ? Math.max(a.p.x, b.p.x) : Math.max(a.p.y, b.p.y);
              for (const ps of ctx.segs) {
                const s = ps.seg;
                const oH = Math.abs(s.y1 - s.y2) <= EPS;
                const oV = Math.abs(s.x1 - s.x2) <= EPS;
                if (oH === oV || horiz !== oH) continue;
                if (Math.abs((horiz ? s.y1 : s.x1) - cM) > 0.75) continue;
                const loO = horiz ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2);
                const hiO = horiz ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2);
                const lo = Math.max(loM, loO), hi = Math.min(hiM, hiO);
                if (hi - lo <= EPS) continue;
                // всадник легален относительно follower-а, если делит с ним порт
                // (свой префикс/суффикс пары покроет перекрытие) — иначе грязь
                if (portKey(ps.p0) === fStartKey || portKey(ps.pN) === fEndKey) continue;
                // начало зоны ПО ХОДУ собрата: ближайший к старту сегмента конец
                // интервала (сегмент может быть направлен в отрицательную сторону)
                const arcStart = a.arc + Math.min(Math.abs(lo - startM), Math.abs(hi - startM));
                if (arcStart < limit) limit = arcStart;
              }
            }
            if (limit < diverge) limit = diverge; // зона до расхождения — места нет
            // Кандидаты точки расставания за точкой расхождения, первые WELD_K по дуге:
            //  • изломы собрата (интерьерные вершины) — классика E78; семя хвоста по
            //    ходу ствола (разворот на шве запрещён сидом);
            //  • проекции свободного дока ВНУТРЬ осевых сегментов собрата — расставание
            //    «напротив дока», где хвост минимален (mid-segment divergence, E79:
            //    у длинного прямого ствола изломов нет, а отвернуть надо посреди).
            //    Семя — ПЕРПЕНДИКУЛЯР к стволу в сторону дока: расставание = поворот;
            //    семя по ходу ствола здесь продавливало стаб вдоль ствола → «поднырок»
            //    у дока и качели взаимной миграции (журнал плана, донастройка жадности).
            const cands: Array<{ p: EdgePoint; prev: EdgePoint; arc: number; side?: EdgeSide }> = [];
            for (let j = 1; j < verts.length; j++) {
              const a = verts[j - 1], b = verts[j];
              if (j < verts.length - 1 && b.arc > diverge + EPS)
                cands.push({ p: b.p, prev: a.p, arc: b.arc });
              const horiz = Math.abs(b.p.y - a.p.y) <= EPS;
              const vertical = Math.abs(b.p.x - a.p.x) <= EPS;
              if (horiz === vertical) continue; // диагональ — не ствол
              const lo = horiz ? Math.min(a.p.x, b.p.x) : Math.min(a.p.y, b.p.y);
              const hi = horiz ? Math.max(a.p.x, b.p.x) : Math.max(a.p.y, b.p.y);
              const c = horiz ? dock.x : dock.y;
              // у самого конца сегмента проекция дублирует излом — пропускаем
              if (c <= lo + 2 * EPS || c >= hi - 2 * EPS) continue;
              // док на оси ствола — дегенерат (некуда поворачивать), кроют изломы
              const perp = horiz ? dock.y - a.p.y : dock.x - a.p.x;
              if (Math.abs(perp) <= EPS) continue;
              const side: EdgeSide = horiz
                ? (perp > 0 ? "bottom" : "top")
                : (perp > 0 ? "right" : "left");
              const p = horiz ? { x: c, y: a.p.y } : { x: a.p.x, y: c };
              const arc = a.arc + Math.abs(c - (horiz ? a.p.x : a.p.y));
              if (arc > diverge + EPS) cands.push({ p, prev: a.p, arc, side });
            }
            cands.sort((u, v) => u.arc - v.arc);
            // Граница тройника: кандидаты за началом грязной зоны нелегальны.
            // Точная точка границы — дополнительный кандидат (максимальный кусок).
            const picked = cands.filter((q) => q.arc <= limit + EPS).slice(0, WELD_K);
            if (
              limit > diverge + EPS && limit < totalMate - EPS &&
              !picked.some((q) => Math.abs(q.arc - limit) <= EPS)
            ) {
              let k = 1;
              while (k < verts.length - 1 && verts[k].arc < limit - EPS) k++;
              const a = verts[k - 1], b = verts[k];
              const horiz = Math.abs(b.p.y - a.p.y) <= EPS;
              const vertical = Math.abs(b.p.x - a.p.x) <= EPS;
              if (horiz !== vertical) {
                const t = (limit - a.arc) / Math.max(b.arc - a.arc, EPS);
                const p = horiz
                  ? { x: a.p.x + (b.p.x - a.p.x) * t, y: a.p.y }
                  : { x: a.p.x, y: a.p.y + (b.p.y - a.p.y) * t };
                // семя хвоста — ПЕРПЕНДИКУЛЯРНО стволу в сторону дока (как у
                // проекционного кандидата): семя по ходу ствола погнало бы хвост
                // вдоль собрата — прямо в грязную зону, от которой отсекаемся
                const perp = horiz ? dock.y - a.p.y : dock.x - a.p.x;
                const side: EdgeSide | undefined = Math.abs(perp) > EPS
                  ? (horiz ? (perp > 0 ? "bottom" : "top") : (perp > 0 ? "right" : "left"))
                  : undefined;
                picked.push({ p, prev: a.p, arc: limit, side });
              }
            }
            for (const q of picked) {
              const arrSide = q.side ?? sideAlong(q.prev, q.p);
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
              // вершины ствола строго до точки расставания (дуга после cleanup растёт
              // строго); для проекции хвост стартует с q.p — сегмент-хозяин доклеится
              const adopted = verts
                .filter((v) => v.arc < q.arc - EPS)
                .map((v) => ({ x: v.p.x, y: v.p.y }));
              const fullOriented = cleanup([...adopted, ...tail.pts]);
              if (fullOriented.length < 2) continue;
              // НОЛЬ нелегальной езды на ПЕРЕНЯТОМ КУСКЕ (страховка границы тройника:
              // случайный коллинеарный всадник, не учтённый грязными зонами). Хвост
              // остаётся на мягкой ступени 1 («грязь не хуже текущего»). Кусок — в
              // РЕАЛЬНОЙ ориентации: ролевое правило кандидата и кредит стволов
              // (own-порты, prefLen/sufLen) опознают общий порт своей роли.
              const piecePts = orient(cleanup([...adopted, { x: q.p.x, y: q.p.y }]));
              if (
                piecePts.length >= 2 &&
                evalRouteParts(piecePts, ctx.segs, { fellowRoutes: ctx.routes }).overlap > EPS
              ) continue;
              const full = orient(fullOriented); // orient — инволюция
              const candParts = evalRouteParts(full, ctx.segs, { extra, fellowRoutes: ctx.routes });
              // ступень 1: грязь не хуже покомпонентно (допуски — числовой шум);
              // + кап удлинения: слияние не покупает крюки (см. WELD_STRETCH)
              if (
                candParts.crosses > curParts.crosses ||
                candParts.overlap > curParts.overlap + EPS ||
                candParts.extra > curParts.extra + 1e-6 ||
                candParts.len > curParts.len * WELD_STRETCH + WELD_STRETCH_SLACK
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
