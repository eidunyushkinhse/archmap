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
// интервалам, отсортированы к желаемому label_t) и leader (отступы у якоря по 8 направлениям ×
// рост магнитуды). Рёбра обрабатываем от самых стеснённых (меньше online-кандидатов) к свободным.
//
// ВЫНОСКА (A15, качество): якорь выноски ставим в ЦЕНТР самого длинного уникального плеча ребра
// (опознавательный отрезок), а позицию плашки выбираем с учётом ЧУЖИХ плеч стрелок как препятствий
// (не только узлов) + минимума пересечений поводка с чужими стрелками. Так плашка не ложится на
// соседнее плечо, а пунктир ведёт в середину «своего» отрезка и не прячется под плашкой (его конец
// обрезается до края плашки в edges.tsx). См. ARROWS_ANALYSIS §5, §6 (A6) + arrows-routing-epic A15.
import type { EdgePoint } from "../../../types";
import { pointAtFraction, type NodeRect, type Segment } from "../edgePath";
import { rectFromCenter, rectsOverlap } from "./arrowMetrics";
import { edgeArcLength, subtractIntervals, type Interval } from "./coincidentLegs";
import { erodeIntervals } from "./labelIntervals";
import type { Size } from "./labelBox";

const EPS = 0.5;
const LEG_T = 4; // полутолщина плеча стрелки как препятствия (px) — плашка должна явно отойти
// Направления отступа выноски: оси первыми (ближе к перпендикуляру плеча), затем диагонали —
// чтобы в тесноте плашка нашла открытое место, не залезая на узлы/чужие плечи.
const LEADER_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1],
];

export interface LabelInput {
  id: string;
  path: EdgePoint[];
  candidates: Interval[]; // допустимые arc-интервалы для ПЛАШКИ (из labelCandidates / A5): без
                          // слитых плеч (R4) и без зон под узлами (R2)
  box: Size;
  preferredT?: number;    // желаемая доля arc-length 0..1 (ручной label_t); по умолч. 0.5
  shared?: Interval[];    // слитые с другими рёбрами плечи (R4) — куда ЯКОРЬ выноски ставить
                          // нельзя (иначе поводок указывает в коллинеарность, стрелку не отличить)
}

// arc-середина самого ДЛИННОГО уникального (не слитого) участка ребра — самый заметный отрезок,
// принадлежащий только этой стрелке; на него и указывает поводок. null — уникальных участков нет.
function longestUniqueArc(unique: Interval[]): number | null {
  let best: Interval | null = null;
  for (const iv of unique) if (!best || iv.e - iv.s > best.e - best.s) best = iv;
  return best ? (best.s + best.e) / 2 : null;
}

export interface Placement {
  id: string;
  mode: "online" | "leader";
  center: EdgePoint; // центр плашки
  anchor: EdgePoint; // точка на линии, к которой плашка относится (для поводка-выноски);
                     // для online совпадает с center (поводок не рисуется)
  box: Size;         // габариты плашки
  leaderEnd: EdgePoint; // конец поводка у КРАЯ плашки (anchor→leaderEnd; не прячется под плашкой).
                        // для online == center (поводок не рисуется)
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

// Кандидаты-выноски: центр плашки отступает от якоря по 8 направлениям × рост магнитуды (ближние
// первыми). Ось пути заранее не знаем — перебор направлений покрывает и перпендикуляр, и обход
// узловой «стены», когда плашка не влезает рядом с коротким уникальным плечом.
function leaderCands(anchor: EdgePoint, box: Size): Cand[] {
  const out: Cand[] = [];
  const base = Math.max(box.h, 16) + 6;
  for (const mag of [base, base + 24, base + 48, base + 72, base + 96, base + 120]) {
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

// Тонкие прямоугольники-препятствия из сегментов ломаной (плечи стрелки). Толщина 2·LEG_T.
function legRects(segs: Segment[]): NodeRect[] {
  return segs.map((s) => {
    const xlo = Math.min(s.x1, s.x2), xhi = Math.max(s.x1, s.x2);
    const ylo = Math.min(s.y1, s.y2), yhi = Math.max(s.y1, s.y2);
    return { x: xlo - LEG_T, y: ylo - LEG_T, w: xhi - xlo + 2 * LEG_T, h: yhi - ylo + 2 * LEG_T };
  });
}

// Параметр t∈[0,1] на отрезке a→b, где он ВХОДИТ в прямоугольник с центром c и габаритами box
// (Лианг-Барски). <0 — отрезок не входит в прямоугольник (или a уже внутри). Нужен, чтобы обрезать
// поводок до края плашки: рисуем a→(точка при t).
function boxEntryParam(a: EdgePoint, c: EdgePoint, box: Size): number {
  const dx = c.x - a.x, dy = c.y - a.y;
  const hw = box.w / 2, hh = box.h / 2;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - (c.x - hw), (c.x + hw) - a.x, a.y - (c.y - hh), (c.y + hh) - a.y];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) { if (q[i] < 0) return -1; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return -1; if (r > t0) t0 = r; }
    else { if (r < t0) return -1; if (r < t1) t1 = r; }
  }
  return t0;
}

// Точка обрезки поводка: вход отрезка anchor→center в прямоугольник плашки. Если вход некорректен
// (центр совпал/якорь внутри) — сам center (вырожденный поводок, edges.tsx нарисует короткий).
function leaderEndPoint(anchor: EdgePoint, center: EdgePoint, box: Size): EdgePoint {
  const t = boxEntryParam(anchor, center, box);
  if (t <= 0 || t >= 1) return center;
  return { x: anchor.x + (center.x - anchor.x) * t, y: anchor.y + (center.y - anchor.y) * t };
}

// Строго ли пересекаются отрезки ab и cd (без учёта простого касания концами).
function segsCross(a: EdgePoint, b: EdgePoint, c: EdgePoint, d: EdgePoint): boolean {
  const o = (p: EdgePoint, q: EdgePoint, r: EdgePoint) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

// Сколько ЧУЖИХ плеч пересёк бы поводок anchor→end. Меньше — чище читается выноска.
function connectorCrossings(anchor: EdgePoint, end: EdgePoint, segs: Segment[]): number {
  let n = 0;
  for (const s of segs) {
    if (segsCross(anchor, end, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 })) n++;
  }
  return n;
}

export function placeLabels(
  labels: LabelInput[],
  nodes: NodeRect[] = [],
  edgeSegs: ReadonlyMap<string, Segment[]> = new Map(),
): Placement[] {
  // плечи каждого ребра как препятствия + сырые сегменты для оценки пересечений поводка
  const legRectsById = new Map<string, NodeRect[]>();
  for (const [id, segs] of edgeSegs) legRectsById.set(id, legRects(segs));

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
    // Якорь выноски — в центр самого длинного УНИКАЛЬНОГО плеча (весь путь минус слитые плечи R4).
    // Узлы тут НЕ вычитаем: якорь — точка на линии, плашку от неё отводит отступ выноски.
    const unique = subtractIntervals({ s: 0, e: total }, l.shared ?? []);
    const anchorArc = longestUniqueArc(unique) ?? preferredArc;
    const anchor = toPt(anchorArc);
    const cands: Cand[] = [...online, ...leaderCands(anchor, l.box)];
    return { id: l.id, box: l.box, cands, onlineCount: online.length, anchor };
  });

  // самые стеснённые (мало online-кандидатов) — первыми; тай-брейк по id для детерминизма
  const order = [...prepared].sort(
    (a, b) => a.onlineCount - b.onlineCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const placedRects: NodeRect[] = [...nodes]; // узлы + уже размещённые плашки — препятствия
  const chosen = new Map<string, Placement>();
  for (const L of order) {
    // чужие плечи (все рёбра, кроме своего) — препятствия для ПЛАШКИ и помеха для поводка
    const otherLegRects: NodeRect[] = [];
    const otherSegs: Segment[] = [];
    for (const [id, segs] of edgeSegs) {
      if (id === L.id) continue;
      otherSegs.push(...segs);
      const rs = legRectsById.get(id);
      if (rs) otherLegRects.push(...rs);
    }
    // ключ выбора: [наложения плашки, online<leader, пересечения поводка, индекс-предпочтение]
    let best = 0;
    let bestKey: [number, number, number, number] = [Infinity, Infinity, Infinity, Infinity];
    for (let k = 0; k < L.cands.length; k++) {
      const c = L.cands[k];
      // online избегает узлов/плашек (как раньше); leader дополнительно избегает чужих плеч
      const obstacles = c.leader ? [...placedRects, ...otherLegRects] : placedRects;
      const ov = overlapCount(c.center, L.box, obstacles);
      const cross = c.leader
        ? connectorCrossings(L.anchor, leaderEndPoint(L.anchor, c.center, L.box), otherSegs)
        : 0;
      const key: [number, number, number, number] = [ov, c.leader ? 1 : 0, cross, k];
      for (let d = 0; d < 4; d++) {
        if (key[d] < bestKey[d]) { bestKey = key; best = k; break; }
        if (key[d] > bestKey[d]) break;
      }
    }
    const c = L.cands[best];
    placedRects.push(rectFromCenter(c.center.x, c.center.y, L.box.w, L.box.h));
    // online: плашка на линии, якорь = её центр (поводок не нужен). leader: плашка вынесена
    // сбоку, якорь = центр уникального плеча (от него рисуем поводок в edges.tsx).
    const anchor = c.leader ? L.anchor : c.center;
    chosen.set(L.id, {
      id: L.id, mode: c.leader ? "leader" : "online",
      center: c.center, anchor, box: L.box,
      leaderEnd: c.leader ? leaderEndPoint(anchor, c.center, L.box) : c.center,
    });
  }

  return labels.map((l) => chosen.get(l.id)!);
}
