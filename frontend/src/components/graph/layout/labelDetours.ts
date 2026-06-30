// Альтернативный маршрут грузного ребра ради инлайн-места под плашку (эпик стрелок A12).
//
// ПОСЛЕДНЕЕ СРЕДСТВО. Когда плашка ребра не лезет инлайн ДАЖЕ после рельсов (A11) и
// раздвижки (A10) — коридор между соседними узлами зажат их габаритами (для горизонтального
// плеча не хватает ВЫСОТЫ под текст, для вертикального — ШИРИНЫ, т.к. текст всегда
// горизонтальный) — ведём ЭТО ребро по минимальному детуру в чистую полосу (lane) рядом с
// рядом узлов, где у длинного прямого плеча есть простор под плашку. Плашка ложится инлайн на
// lane. Если ни один детур не вмещает текст в пределах кэпа длины — null (вызывающий оставит
// leader). Это записанное предпочтение архитектора «двигаем маршрут, а не узлы» (decision 3),
// поставленное ПЕРЕД leader.
//
// Чистая функция; двигает ТОЛЬКО маршрут (не узлы → own-on-first-render цел) и детерминирована
// (lane из габаритов узлов этого ребра, без оглядки на чужие маршруты → стабильность A7.4).
//
// Ось детура зависит от плеча: горизонтальное плечо (|dx|≥|dy|) → детур вверх/вниз; вертикальное
// → влево/вправо. Из двух перпендикулярных направлений берётся МИНИМАЛЬНОЕ по добавленной длине.

import type { EdgePoint } from "../../../types";
import { cleanup, pathCrossesRects, pointAtFraction, type EdgeSide, type NodeRect } from "../edgePath";
import { edgeArcLength } from "./coincidentLegs";
import { labelCandidates } from "./labelIntervals";
import type { Size } from "./labelBox";

const EPS = 0.5;

export interface LabelDetour {
  route: EdgePoint[]; // ортоломаная детура (концы — центры выбранных сторон узлов)
  sSide: EdgeSide;    // сторона выхода из источника (для хэндла)
  tSide: EdgeSide;    // сторона входа в цель
  preferredT: number; // arc-доля середины lane — желаемое место плашки (для placeLabels)
  center: EdgePoint;  // центр плашки на lane (информативно/для проверки)
}

const cx = (r: NodeRect): number => r.x + r.w / 2;
const cy = (r: NodeRect): number => r.y + r.h / 2;

// центр стороны узла (idx=1).
function sideCenter(r: NodeRect, side: EdgeSide): EdgePoint {
  switch (side) {
    case "top":    return { x: cx(r), y: r.y };
    case "bottom": return { x: cx(r), y: r.y + r.h };
    case "left":   return { x: r.x, y: cy(r) };
    default:       return { x: r.x + r.w, y: cy(r) };
  }
}

function pathLength(pts: EdgePoint[]): number {
  let n = 0;
  for (let i = 0; i < pts.length - 1; i++) n += Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
  return n;
}

// Завершает кандидат: проверяет, что плашка реально вмещается на lane (есть допустимый
// arc-интервал длиной не меньше протяжённости плашки вдоль линии), и возвращает preferredT
// (середина этого интервала) + центр. allNodes — ВСЕ узлы (вкл. концы) для зон под узлами (R2).
function finishCandidate(
  route: EdgePoint[], allNodes: NodeRect[], box: Size, alongExtent: number,
  sSide: EdgeSide, tSide: EdgeSide,
): LabelDetour | null {
  const cands = labelCandidates(route, [], allNodes, box);
  // самый длинный допустимый интервал, вмещающий плашку целиком вдоль линии
  let best: { s: number; e: number } | null = null;
  for (const iv of cands) {
    if (iv.e - iv.s >= alongExtent - EPS && (!best || iv.e - iv.s > best.e - best.s)) best = iv;
  }
  if (!best) return null;
  const total = edgeArcLength(route);
  if (total <= EPS) return null;
  const midArc = (best.s + best.e) / 2;
  const t = midArc / total;
  return { route, sSide, tSide, preferredT: t, center: pointAtFraction(route, t) };
}

// Один кандидат-детур в заданном перпендикулярном направлении (сторона выхода = sSide=tSide).
function buildCandidate(
  source: NodeRect, target: NodeRect, allNodes: NodeRect[], obstacles: NodeRect[],
  box: Size, margin: number, side: EdgeSide,
): LabelDetour | null {
  const sPt = sideCenter(source, side);
  const tPt = sideCenter(target, side);
  let route: EdgePoint[];
  let alongExtent: number;
  if (side === "bottom" || side === "top") {
    // горизонтальная lane по y: клиренс пол-плашки по высоте + margin от края блока узлов
    const half = box.h / 2 + margin;
    const xLo = Math.min(sPt.x, tPt.x), xHi = Math.max(sPt.x, tPt.x);
    let laneY: number;
    if (side === "bottom") {
      let maxB = Math.max(sPt.y, tPt.y);
      for (const n of allNodes) if (n.x + n.w > xLo + EPS && n.x < xHi - EPS) maxB = Math.max(maxB, n.y + n.h);
      laneY = maxB + half;
    } else {
      let minT = Math.min(sPt.y, tPt.y);
      for (const n of allNodes) if (n.x + n.w > xLo + EPS && n.x < xHi - EPS) minT = Math.min(minT, n.y);
      laneY = minT - half;
    }
    route = cleanup([sPt, { x: sPt.x, y: laneY }, { x: tPt.x, y: laneY }, tPt]);
    alongExtent = box.w; // плашка тянется вдоль горизонтальной lane своей шириной
  } else {
    // вертикальная lane по x: клиренс пол-плашки по ширине + margin
    const half = box.w / 2 + margin;
    const yLo = Math.min(sPt.y, tPt.y), yHi = Math.max(sPt.y, tPt.y);
    let laneX: number;
    if (side === "right") {
      let maxR = Math.max(sPt.x, tPt.x);
      for (const n of allNodes) if (n.y + n.h > yLo + EPS && n.y < yHi - EPS) maxR = Math.max(maxR, n.x + n.w);
      laneX = maxR + half;
    } else {
      let minL = Math.min(sPt.x, tPt.x);
      for (const n of allNodes) if (n.y + n.h > yLo + EPS && n.y < yHi - EPS) minL = Math.min(minL, n.x);
      laneX = minL - half;
    }
    route = cleanup([sPt, { x: laneX, y: sPt.y }, { x: laneX, y: tPt.y }, tPt]);
    alongExtent = box.h; // плашка тянется вдоль вертикальной lane своей высотой
  }
  // детур не должен резать тела ДРУГИХ узлов (концы исключены)
  if (pathCrossesRects(route, obstacles)) return null;
  return finishCandidate(route, allNodes, box, alongExtent, side, side);
}

/**
 * Минимальный детур грузного ребра, дающий инлайн-место под плашку, или null.
 * `obstacles` — тела ВСЕХ прочих узлов (без source/target). `box` — габариты плашки (labelBox).
 * `maxExtraLen` — кэп добавленной длины сверх прямого хода (дальше — отказ → leader у вызывающего).
 * Ось выбирается по плечу (гориз. → верх/низ, верт. → лево/право), из двух направлений берётся
 * меньшее по добавленной длине. Чистая функция: вход не мутируется, узлы не двигаются.
 */
export function labelDetour(params: {
  source: NodeRect;
  target: NodeRect;
  obstacles: NodeRect[];
  box: Size;
  margin: number;
  maxExtraLen: number;
}): LabelDetour | null {
  const { source, target, obstacles, box, margin, maxExtraLen } = params;
  const dx = cx(target) - cx(source);
  const dy = cy(target) - cy(source);
  const horizontal = Math.abs(dx) >= Math.abs(dy); // плечо горизонтальное → детур по вертикали
  const allNodes = [source, target, ...obstacles];
  const directLen = Math.abs(dx) + Math.abs(dy);
  const sides: EdgeSide[] = horizontal ? ["bottom", "top"] : ["right", "left"];

  let best: LabelDetour | null = null;
  let bestExtra = Infinity;
  for (const side of sides) {
    const cand = buildCandidate(source, target, allNodes, obstacles, box, margin, side);
    if (!cand) continue;
    const extra = pathLength(cand.route) - directLen;
    if (extra > maxExtraLen + EPS) continue;
    if (extra < bestExtra - EPS) { bestExtra = extra; best = cand; }
  }
  return best;
}
