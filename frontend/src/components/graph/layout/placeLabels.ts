// Размещение плашек подписей без взаимных наложений (эпик стрелок, фаза A6 — R2-критичное)
// + выноска-leader как fallback. Чистая функция.
//
// Вход: по каждому ребру маршрут, допустимые arc-интервалы из A5 (где плашку ставить МОЖНО —
// уже без совпавших плеч R4 и зон под узлами R2-узлы) и габариты плашки. Выход: для каждой
// плашки выбранная позиция центра и режим — online (на линии) либо leader (вынесена сбоку,
// когда на линии чисто не встаёт). Гарантия по построению: online-плашка ставится ТОЛЬКО на
// место без наложений на уже размещённые плашки и узлы (R2); если такого места нет — выноска.
//
// Алгоритм: жадный best-fit. Для каждой плашки генерим кандидатов — online (выборка точек по
// интервалам, отсортированы к желаемому label_t) и leader (перпендикулярные отступы у якоря).
// Рёбра обрабатываем от самых стеснённых (меньше online-кандидатов) к свободным; каждой плашке
// берём кандидата с минимумом наложений (при равенстве — сначала online, затем ближе к
// желаемому). Узлы — статические препятствия. Детерминированно. См. ARROWS_ANALYSIS §5, §6 (A6).
import type { EdgePoint } from "../../../types";
import { pointAtFraction, type NodeRect } from "../edgePath";
import { rectFromCenter, rectsOverlap } from "./arrowMetrics";
import { edgeArcLength, type Interval } from "./coincidentLegs";
import { erodeIntervals } from "./labelIntervals";
import type { Size } from "./labelBox";

const EPS = 0.5;
// Перпендикулярные направления и магнитуды отступа выноски (px) — пробуем ближние первыми.
const LEADER_DIRS: ReadonlyArray<readonly [number, number]> = [[0, -1], [0, 1], [1, 0], [-1, 0]];

export interface LabelInput {
  id: string;
  path: EdgePoint[];
  candidates: Interval[]; // допустимые arc-интервалы (из labelCandidates / A5)
  box: Size;
  preferredT?: number;    // желаемая доля arc-length 0..1 (ручной label_t); по умолч. 0.5
}

export interface Placement {
  id: string;
  mode: "online" | "leader";
  center: EdgePoint; // центр плашки
  anchor: EdgePoint; // точка на линии, к которой плашка относится (для поводка-выноски);
                     // для online совпадает с center (поводок не рисуется)
  box: Size;
}

interface Cand {
  center: EdgePoint;
  leader: boolean;
}

// Точки-кандидаты вдоль интервалов: кламп желаемого, середина и концы каждого интервала,
// плюс шаги через step. Дедуп и сортировка по близости к желаемой arc-позиции.
function sampleArcs(intervals: Interval[], preferredArc: number, step: number): number[] {
  const arcs: number[] = [];
  for (const iv of intervals) {
    arcs.push(Math.max(iv.s, Math.min(preferredArc, iv.e)), (iv.s + iv.e) / 2, iv.s, iv.e);
    for (let a = iv.s; a <= iv.e; a += step) arcs.push(a);
  }
  const uniq: number[] = [];
  for (const a of [...arcs].sort((x, y) => x - y)) {
    if (uniq.length === 0 || Math.abs(uniq[uniq.length - 1] - a) > EPS) uniq.push(a);
  }
  return uniq.sort((x, y) => Math.abs(x - preferredArc) - Math.abs(y - preferredArc));
}

// Кандидаты-выноски: центр плашки отступает от якоря перпендикулярно (пробуем 4 оси × рост
// магнитуды). Ось пути заранее не знаем — перебор всех направлений покрывает нужное.
function leaderCands(anchor: EdgePoint, box: Size): Cand[] {
  const out: Cand[] = [];
  const base = Math.max(box.h, 16) + 6;
  for (const mag of [base, base + 22, base + 44, base + 66]) {
    for (const [dx, dy] of LEADER_DIRS) {
      out.push({ center: { x: anchor.x + dx * mag, y: anchor.y + dy * mag }, leader: true });
    }
  }
  return out;
}

// Сколько прямоугольников из others задевает плашка box с центром center.
function overlapCount(center: EdgePoint, box: Size, others: NodeRect[]): number {
  const r = rectFromCenter(center.x, center.y, box.w, box.h);
  let n = 0;
  for (const o of others) if (rectsOverlap(r, o)) n++;
  return n;
}

export function placeLabels(labels: LabelInput[], nodes: NodeRect[] = []): Placement[] {
  // подготовка кандидатов по каждому ребру
  const prepared = labels.map((l) => {
    const total = edgeArcLength(l.path);
    const prefT = Math.max(0, Math.min(1, l.preferredT ?? 0.5));
    const preferredArc = prefT * total;
    // сжимаем интервалы на пол-плашки вдоль линии — чтобы плашка целиком лежала в уникальной
    // зоне (консервативно по ширине; на вертикальном плече это с запасом, что безопасно для R4)
    const eroded = erodeIntervals(l.candidates, l.box.w / 2);
    const onlineArcs = sampleArcs(eroded, preferredArc, Math.max(l.box.w, 24));
    const toPt = (a: number): EdgePoint => pointAtFraction(l.path, total > 0 ? a / total : 0);
    const online: Cand[] = onlineArcs.map((a) => ({ center: toPt(a), leader: false }));
    const anchor = toPt(preferredArc);
    const cands: Cand[] = [...online, ...leaderCands(anchor, l.box)];
    return { id: l.id, box: l.box, cands, onlineCount: online.length, anchor };
  });

  // самые стеснённые (мало online-кандидатов) — первыми; тай-брейк по id для детерминизма
  const order = [...prepared].sort(
    (a, b) => a.onlineCount - b.onlineCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const placedRects: NodeRect[] = [...nodes]; // узлы — статические препятствия
  const chosen = new Map<string, Placement>();
  for (const L of order) {
    let best = 0;
    let bestKey: [number, number, number] = [Infinity, Infinity, Infinity];
    for (let k = 0; k < L.cands.length; k++) {
      const c = L.cands[k];
      const ov = overlapCount(c.center, L.box, placedRects);
      const key: [number, number, number] = [ov, c.leader ? 1 : 0, k];
      if (
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] &&
          (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))
      ) {
        bestKey = key;
        best = k;
      }
    }
    const c = L.cands[best];
    placedRects.push(rectFromCenter(c.center.x, c.center.y, L.box.w, L.box.h));
    // online: плашка на линии, якорь = её центр (поводок не нужен). leader: плашка вынесена
    // сбоку, якорь = желаемая точка на линии (от неё рисуем поводок в edges.tsx).
    chosen.set(L.id, {
      id: L.id, mode: c.leader ? "leader" : "online",
      center: c.center, anchor: c.leader ? L.anchor : c.center, box: L.box,
    });
  }

  return labels.map((l) => chosen.get(l.id)!);
}
