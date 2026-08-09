// Легальные стволы стрелок (эпик «общие плечи v2», docs/archive/plan-arrow-trunks.md, Ф0).
// Чистая геометрия без знания о стоимостях.
//
// Правило (E25 v2): двум связям МОЖНО делить плечи только как общему НЕПРЕРЫВНОМУ
// куску от общего порта одной роли — общий ПРЕФИКС маршрутов у исходящих из одного
// порта (расходиться можно один раз, в любом месте, в том числе в середине сегмента),
// общий СУФФИКС у входящих в один порт (слились → идут вместе до самого хэндла;
// совместные изломы внутри куска легальны). Любое другое коллинеарное перекрытие —
// в том числе повторное схождение после расхождения — нелегально.
//
// Потребители: оценка готовых ломаных в routeAll (кредит легального слияния, Ф1),
// сварка стволов weldTrunks (Ф2/Ф3), группы-стволы канальной разводки (Ф4),
// хит-тест общего плеча для модалки двойного клика (Ф5).
import type { EdgePoint } from "../../../types";
import { cleanup } from "../edgePath";

const EPS = 0.5;

const near = (a: EdgePoint, b: EdgePoint): boolean =>
  Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

// Осевое направление сегмента p→q. Диагональ (fallback-отрезок E18) осью не является —
// ствол на ней не продолжается (walk останавливается перед ней).
interface AxisDir {
  axis: "h" | "v" | null;
  sign: number; // −1/+1 вдоль оси
  len: number;  // манхэттен (для осевого сегмента = точная длина)
}

function dirOf(p: EdgePoint, q: EdgePoint): AxisDir {
  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.abs(dx) + Math.abs(dy);
  if (Math.abs(dy) <= EPS) return { axis: "h", sign: Math.sign(dx), len };
  if (Math.abs(dx) <= EPS) return { axis: "v", sign: Math.sign(dy), len };
  return { axis: null, sign: 0, len };
}

// Манхэттенова длина ломаной (соглашение arc-length как в coincidentLegs).
export function pieceLen(pts: EdgePoint[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    n += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
  }
  return n;
}

// Общий префикс двух ПОЧИЩЕННЫХ ломаных с общей стартовой точкой. Идём параллельно
// по сегментам, пока направления совпадают; кто-то повернул в интерьере сегмента
// другого (или направления разошлись на общем углу) — конец куска в этой точке.
// Кусок содержит точку расхождения последней вершиной. Пустой массив — общего нет.
function prefixWalk(pa: EdgePoint[], pb: EdgePoint[]): EdgePoint[] {
  if (pa.length < 2 || pb.length < 2 || !near(pa[0], pb[0])) return [];
  const piece: EdgePoint[] = [{ x: pa[0].x, y: pa[0].y }];
  let ia = 0, ib = 0;
  // текущая общая точка хода; для B держим СВОЮ копию, чтобы EPS-дрейф не копился
  let posA: EdgePoint = pa[0];
  let posB: EdgePoint = pb[0];
  while (ia < pa.length - 1 && ib < pb.length - 1) {
    const da = dirOf(posA, pa[ia + 1]);
    const db = dirOf(posB, pb[ib + 1]);
    if (da.axis === null || db.axis === null) break;             // диагональ — не ствол
    if (da.axis !== db.axis || da.sign !== db.sign) break;       // разошлись на углу
    const run = Math.min(da.len, db.len);
    if (run <= EPS) break;                                        // вырожденный остаток
    const step = da.axis === "h"
      ? { x: posA.x + da.sign * run, y: posA.y }
      : { x: posA.x, y: posA.y + da.sign * run };
    piece.push(step);
    const aEnds = da.len - run <= EPS;
    const bEnds = db.len - run <= EPS;
    if (aEnds !== bEnds) break; // один повернул в интерьере сегмента другого — расхождение
    // оба дошли до своих углов — сравнение направлений на следующем витке
    ia++; ib++;
    posA = pa[ia];
    posB = pb[ib];
  }
  // слить коллинеарные стыки частичных пробегов; кусок из одной точки — пустой
  const clean = cleanup(piece);
  return clean.length >= 2 && pieceLen(clean) > EPS ? clean : [];
}

/**
 * Общий ПРЕФИКС двух маршрутов (легальный ствол исходящих из общего порта).
 * Возвращает подломаную от общего порта до точки расхождения (включительно);
 * пустой массив — старты не совпадают или расходятся сразу.
 */
export function commonPrefix(a: EdgePoint[], b: EdgePoint[]): EdgePoint[] {
  return prefixWalk(cleanup(a.map((p) => ({ x: p.x, y: p.y }))), cleanup(b.map((p) => ({ x: p.x, y: p.y }))));
}

/**
 * Общий СУФФИКС двух маршрутов (легальный ствол входящих в общий порт).
 * Возвращает подломаную В ПОРЯДКЕ ХОДА ПУТИ: от точки слияния до общего порта.
 */
export function commonSuffix(a: EdgePoint[], b: EdgePoint[]): EdgePoint[] {
  const ra = cleanup(a.map((p) => ({ x: p.x, y: p.y }))).reverse();
  const rb = cleanup(b.map((p) => ({ x: p.x, y: p.y }))).reverse();
  return prefixWalk(ra, rb).reverse();
}

// Кусок легального слияния маршрута edgeId с собратом mateId.
export interface TrunkMatePiece {
  mateId: string;
  kind: "out" | "in"; // out — общий префикс (порт-источник), in — общий суффикс (порт-цель)
  pts: EdgePoint[];   // общая подломаная в порядке хода пути
  len: number;        // манхэттенова длина куска
}

// Ключ-бакет точки порта: квант 0.5px. Точки одного веера совпадают точно (один
// handlePoint), квант лишь страхует от шумов сериализации.
const portKey = (p: EdgePoint): string => `${Math.round(p.x * 2)}|${Math.round(p.y * 2)}`;

/**
 * Все легальные куски набора маршрутов: собратья по РОЛИ определяются совпадением
 * точки конца (route[0] — порт-источник, route[последняя] — порт-цель; роль встроена
 * в конструкцию ломаной, source→target). Возвращает map: edgeId → куски с собратьями
 * (запись симметрична: кусок X↔Y лежит и у X, и у Y). Рёбра без стволов в map
 * отсутствуют.
 */
export function trunkPieces(routes: ReadonlyMap<string, EdgePoint[]>): Map<string, TrunkMatePiece[]> {
  const ids = [...routes.keys()].sort();
  const out = new Map<string, TrunkMatePiece[]>();
  const push = (id: string, rec: TrunkMatePiece): void => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set() выше гарантировал наличие ключа
    (out.get(id) ?? out.set(id, []).get(id)!).push(rec);
  };
  // бакеты по порту своей роли
  const byStart = new Map<string, string[]>();
  const byEnd = new Map<string, string[]>();
  for (const id of ids) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- ids из routes.keys(), ключ заведомо есть
    const pts = routes.get(id)!;
    if (pts.length < 2) continue;
    const ks = portKey(pts[0]);
    const ke = portKey(pts[pts.length - 1]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set() выше гарантировал наличие ключа
    (byStart.get(ks) ?? byStart.set(ks, []).get(ks)!).push(id);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set() выше гарантировал наличие ключа
    (byEnd.get(ke) ?? byEnd.set(ke, []).get(ke)!).push(id);
  }
  const collect = (buckets: Map<string, string[]>, kind: "out" | "in"): void => {
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bucket заполнен из routes.keys()
          const a = routes.get(bucket[i])!;
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bucket заполнен из routes.keys()
          const b = routes.get(bucket[j])!;
          const piece = kind === "out" ? commonPrefix(a, b) : commonSuffix(a, b);
          if (piece.length < 2) continue;
          const len = pieceLen(piece);
          push(bucket[i], { mateId: bucket[j], kind, pts: piece, len });
          push(bucket[j], { mateId: bucket[i], kind, pts: piece.map((p) => ({ x: p.x, y: p.y })), len });
        }
      }
    }
  };
  collect(byStart, "out");
  collect(byEnd, "in");
  return out;
}
