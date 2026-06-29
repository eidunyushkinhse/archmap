// Допустимые интервалы для якоря плашки подписи (эпик стрелок, фаза A5 — R2-узлы + R4).
// Чистая геометрия. Для каждого ребра считает arc-участки, куда МОЖНО поставить плашку:
// весь путь минус совпавшие плечи (R4 — где подпись неоднозначна, из coincidentLegs/A4)
// минус зоны, где плашка задела бы узел (R2-часть про узлы; габариты плашки из labelBox/A1).
// Взаимные наложения плашек РАЗНЫХ рёбер тут не решаются — это размещение, фаза A6.
//
// Модель плашки: прямоугольник box, ЦЕНТРИРОВАННЫЙ на точке пути-якоре. Плашка не задевает
// узел ⇔ якорь вне прямоугольника узла, раздутого на пол-плашки (Минковский). См. ANALYSIS §5.
import type { EdgePoint } from "../../../types";
import { cleanup, type NodeRect } from "../edgePath";
import { mergeIntervals, subtractIntervals, edgeArcLength, type Interval } from "./coincidentLegs";
import type { Size } from "./labelBox";

const EPS = 0.5;

// arc-интервалы ломаной, где её точка лежит СТРОГО внутри прямоугольника rect.
// Путь ортогонален (после cleanup), идём по сегментам с накоплением arc-length.
function intervalsInsideRect(pts: EdgePoint[], rect: NodeRect): Interval[] {
  const c = cleanup(pts);
  const L = rect.x, R = rect.x + rect.w, T = rect.y, B = rect.y + rect.h;
  if (R - L <= EPS || B - T <= EPS) return [];
  const out: Interval[] = [];
  let arc = 0;
  for (let i = 0; i < c.length - 1; i++) {
    const p = c[i], q = c[i + 1];
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.abs(dx) + Math.abs(dy);
    if (len <= EPS) continue;
    const horiz = Math.abs(dy) <= Math.abs(dx);
    if (horiz && p.y > T + EPS && p.y < B - EPS) {
      // горизонтальный сегмент на высоте p.y внутри [T,B]: пересечение по x с [L,R]
      const lo = Math.max(Math.min(p.x, q.x), L), hi = Math.min(Math.max(p.x, q.x), R);
      if (hi - lo > EPS) {
        const a1 = arc + Math.abs(lo - p.x), a2 = arc + Math.abs(hi - p.x);
        out.push({ s: Math.min(a1, a2), e: Math.max(a1, a2) });
      }
    } else if (!horiz && p.x > L + EPS && p.x < R - EPS) {
      // вертикальный сегмент на абсциссе p.x внутри [L,R]: пересечение по y с [T,B]
      const lo = Math.max(Math.min(p.y, q.y), T), hi = Math.min(Math.max(p.y, q.y), B);
      if (hi - lo > EPS) {
        const a1 = arc + Math.abs(lo - p.y), a2 = arc + Math.abs(hi - p.y);
        out.push({ s: Math.min(a1, a2), e: Math.max(a1, a2) });
      }
    }
    arc += len;
  }
  return out;
}

// arc-интервалы вдоль пути, где плашка box (центр на точке пути) задела бы какой-либо узел.
// Узел раздувается на пол-плашки с каждой стороны; задетые участки сливаются.
export function nodeBlockedIntervals(pts: EdgePoint[], nodes: NodeRect[], box: Size): Interval[] {
  const blocks: Interval[] = [];
  for (const n of nodes) {
    const inflated: NodeRect = {
      x: n.x - box.w / 2, y: n.y - box.h / 2, w: n.w + box.w, h: n.h + box.h,
    };
    blocks.push(...intervalsInsideRect(pts, inflated));
  }
  return mergeIntervals(blocks);
}

// Сжимает каждый интервал на margin с обоих концов, выбрасывая ставшие короче EPS. Нужно
// A6: чтобы плашка целиком (а не только её центр) укладывалась в уникальный участок — концы
// допустимого интервала отступают на пол-протяжённости плашки вдоль линии. Чистая функция.
export function erodeIntervals(intervals: Interval[], margin: number): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    const s = iv.s + margin, e = iv.e - margin;
    if (e - s > EPS) out.push({ s, e });
  }
  return out;
}

// Допустимые arc-интервалы для якоря плашки ребра: [0, total] минус совпавшие плечи (R4)
// минус зоны под узлами с учётом габаритов плашки (R2-узлы). Пустой результат = поставить
// плашку на линии без нарушений нельзя (кандидат на выноску-leader в A6).
export function labelCandidates(
  pts: EdgePoint[],
  shared: Interval[],
  nodes: NodeRect[],
  box: Size,
): Interval[] {
  const total = edgeArcLength(pts);
  const blocked = mergeIntervals([...shared, ...nodeBlockedIntervals(pts, nodes, box)]);
  return subtractIntervals({ s: 0, e: total }, blocked);
}
