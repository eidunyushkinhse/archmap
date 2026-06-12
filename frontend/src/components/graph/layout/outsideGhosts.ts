// Дефолтная раскладка ГОСТЕЙ, не входящих в общую с уровнем рамку (основная схема).
//
// Зачем модуль существует: ELK кладёт гостей в общий поток вместе с локальными
// узлами, из-за чего гость без сохранённой позиции мог оказаться ВНУТРИ рамки
// локальных узлов, упереться в неё или налезть на узлы. Здесь таких гостей выносим на
// периметр («кольцо») внешней рамки — boundary labeling. Каждого гостя ставим на одну
// из ЧЕТЫРЁХ сторон возле проекции его якоря (среднего центра связанных локальных
// узлов): базовая ось — горизонталь (поток C4 слева-направо, ближний край по среднему
// X; направление связи — запасной критерий), а верх/низ берём, лишь когда горизонталь
// увела бы стрелку сквозь тела других узлов, а вертикаль — нет. Несколько гостей на
// одной стороне раздвигаются вдоль неё симметрично (PAV). После переноса пересчитываем
// хэндлы рёбер от новых позиций — это убирает «сумбур» в их назначении.
//
// Гости С общей рамкой (лежат внутри своей рамки по дизайну) и гости с ручной
// позицией (levelPositions) не трогаются — КРОМЕ случая, когда внутреннего гостя ELK
// отбросил вбок за пределы кластера локальных узлов (свежий контейнер-предок —
// одинокий приёмник межуровневой стрелки улетает на правый край схемы). Такого
// «улетевшего» тоже выносим в колонку рядом со связью. Возвращённый результат
// (placedOutside + bbox рамки + пересчитанные хэндлы) потребляет шаг дефолтных обводов
// (detours.ts): блоки исторически вложены, поэтому контракт передаётся явно.
import { NODE_W, NODE_H, BOUNDARY_PAD, BOUNDARY_STEP } from "../constants";
import type { DisplayExternal } from "../types";
import type { Edge as AppEdge, AncestorRef } from "../../../types";
import { assignEdgeHandles } from "./level";
import { spread1D } from "./pav";
import { cleanup, orthogonalPointsForHandles, pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";

export interface OutsideGhostsResult {
  /** id вынесенных за рамку гостей */
  placedOutside: Set<string>;
  /** bbox рамки = локальные узлы + «внутренние» гости (члены breadcrumb-рамок) */
  frame: { minX: number; minY: number; maxX: number; maxY: number };
  /** хэндлы рёбер, пересчитанные после переноса гостей (autoHandles по новым позициям) */
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
}

/**
 * Выносит внешних гостей в колонки за рамку уровня. `positions` МУТИРУЕТСЯ: новым
 * гостям проставляются координаты колонок (как было в исходной раскладке).
 * Возвращает null, если выносить нечего: пустой уровень (нет локальных узлов),
 * нет outside-гостей без сохранённой позиции, либо у рамки нет валидного bbox —
 * в этих случаях вызывающий код оставляет хэндлы из baseLayout без изменений.
 */
export function placeOutsideGhosts(params: {
  nodes: { id: string }[];
  entities: DisplayExternal[];
  stableAncestorIds: string[];
  levelPositions: Record<string, { pos_x: number; pos_y: number }>;
  layoutEdges: AppEdge[];
  positions: Map<string, { x: number; y: number }>;
}): OutsideGhostsResult | null {
  const { nodes, entities, stableAncestorIds, levelPositions, layoutEdges, positions } = params;
  if (nodes.length === 0) return null;

  const bcSet = new Set(stableAncestorIds);
  const entAncestors = (ent: DisplayExternal): AncestorRef[] =>
    ent.kind === "leaf" ? (ent.ghost.ancestors ?? []) : (ent.ancestors ?? []);
  const isOutside = (ent: DisplayExternal): boolean =>
    !entAncestors(ent).some((a) => bcSet.has(a.id));
  const localIds = new Set(nodes.map((n) => n.id));

  // X-границы кластера локальных узлов — по ним ловим «улетевших» гостей. ELK
  // раскладывает поток слева-направо (RIGHT), поэтому одинокий приёмник межуровневой
  // стрелки без других связей улетает на правый край схемы. Внутренний гость, чей
  // X-диапазон ЦЕЛИКОМ вне кластера, считается улетевшим и тоже выносится в колонку
  // (вертикально гости законно стопкуются под кластером — по Y «улёт» не ловим).
  let lMinX = Infinity, lMaxX = -Infinity;
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    lMinX = Math.min(lMinX, p.x); lMaxX = Math.max(lMaxX, p.x + NODE_W);
  }
  const isFlung = (ent: DisplayExternal): boolean => {
    const p = positions.get(ent.id);
    if (!p || !isFinite(lMinX)) return false;
    return p.x + NODE_W <= lMinX + 1 || p.x >= lMaxX - 1;
  };

  // Выносим: внешних гостей (нет общей рамки) + внутренних, которых ELK отбросил вбок
  // от кластера. Гость с ручной позицией (levelPositions) не трогается в любом случае.
  const toPlace = entities.filter(
    (e) => !levelPositions[e.id] && (isOutside(e) || isFlung(e)),
  );
  if (toPlace.length === 0) return null;
  const toPlaceSet = new Set(toPlace.map((e) => e.id));

  // bbox рамки = локальные узлы + «внутренние» гости-члены рамки, КРОМЕ вынесенных
  // (их прежняя ELK-позиция мусорная — не должна растягивать рамку).
  let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
  const frameIds = [
    ...nodes.map((n) => n.id),
    ...entities.filter((e) => !isOutside(e) && !toPlaceSet.has(e.id)).map((e) => e.id),
  ];
  for (const id of frameIds) {
    const p = positions.get(id);
    if (!p) continue;
    fMinX = Math.min(fMinX, p.x); fMinY = Math.min(fMinY, p.y);
    fMaxX = Math.max(fMaxX, p.x + NODE_W); fMaxY = Math.max(fMaxY, p.y + NODE_H);
  }
  if (!isFinite(fMinX)) return null;

  // клиренс за внешнюю рамку: её паддинг растёт с глубиной вложенности; берём
  // breadcrumb-глубину + запас на один уровень (развёрнутый контейнер-рамка
  // может быть глубже) + зазор.
  const clearance = BOUNDARY_PAD + (stableAncestorIds.length + 1) * BOUNDARY_STEP + 48;
  // линии четырёх сторон кольца (координата ВЕРХНЕГО-ЛЕВОГО угла гостя, поставленного на
  // эту сторону): лево/право фиксируют X, верх/низ — Y.
  const leftX = fMinX - clearance - NODE_W;
  const rightX = fMaxX + clearance;
  const topY = fMinY - clearance - NODE_H;
  const botY = fMaxY + clearance;
  const frameCx = (fMinX + fMaxX) / 2;
  const frameCy = (fMinY + fMaxY) / 2;

  // прямоугольники локальных узлов — препятствия для пробных маршрутов при выборе стороны
  const localRects: { id: string; rect: NodeRect }[] = [];
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (p) localRects.push({ id: n.id, rect: { x: p.x, y: p.y, w: NODE_W, h: NODE_H } });
  }
  // центр выбранной стороны прямоугольника (для пробного ортогонального маршрута)
  const sideCenter = (p: { x: number; y: number }, side: EdgeSide): { x: number; y: number } => {
    switch (side) {
      case "left":   return { x: p.x,              y: p.y + NODE_H / 2 };
      case "right":  return { x: p.x + NODE_W,     y: p.y + NODE_H / 2 };
      case "top":    return { x: p.x + NODE_W / 2, y: p.y };
      default:       return { x: p.x + NODE_W / 2, y: p.y + NODE_H };
    }
  };
  // сколько связей гостя, стоящего в gp, прошли бы СКВОЗЬ тела других локальных узлов:
  // пробный ортомаршрут к каждому связанному узлу (как в detours.ts) + счёт пересечений.
  const crossingsAt = (gp: { x: number; y: number }, connected: string[]): number => {
    let crossings = 0;
    for (const lid of connected) {
      const lp = positions.get(lid);
      if (!lp) continue;
      const dx = lp.x - gp.x, dy = lp.y - gp.y;
      let gSide: EdgeSide, lSide: EdgeSide;
      if (Math.abs(dx) >= Math.abs(dy)) {
        gSide = dx >= 0 ? "right" : "left"; lSide = dx >= 0 ? "left" : "right";
      } else {
        gSide = dy >= 0 ? "bottom" : "top"; lSide = dy >= 0 ? "top" : "bottom";
      }
      const gPt = sideCenter(gp, gSide), lPt = sideCenter(lp, lSide);
      const route = cleanup(orthogonalPointsForHandles(gPt.x, gPt.y, gSide, lPt.x, lPt.y, lSide));
      const obstacles = localRects.filter((r) => r.id !== lid).map((r) => r.rect);
      if (pathCrossesRects(route, obstacles)) crossings++;
    }
    return crossings;
  };

  // Сторона кольца для каждого гостя. Базовая ось — ГОРИЗОНТАЛЬ (поток C4 слева-направо):
  // ближний край рамки по среднему X связанных узлов, направление связи — запасной критерий
  // (источник слева, приёмник/ничья справа). ВЕРХ/НИЗ берём, лишь если горизонталь увела бы
  // стрелку СКВОЗЬ тела других узлов, а вертикаль — нет: читаемость потока сохраняется, а
  // «стрелки под узлами» лечатся уходом на свободную сторону. Желаемая координата вдоль
  // стороны — проекция якоря (средний центр связанных узлов).
  type Bucket = { id: string; along: number };
  const buckets: Record<EdgeSide, Bucket[]> = { left: [], right: [], top: [], bottom: [] };
  for (const ent of toPlace) {
    let leftVotes = 0, rightVotes = 0;
    const xs: number[] = [];
    const ys: number[] = [];
    const connected: string[] = [];
    for (const e of layoutEdges) {
      if (e.source_id === ent.id && localIds.has(e.target_id)) {
        leftVotes++; connected.push(e.target_id);
        const p = positions.get(e.target_id); if (p) { xs.push(p.x + NODE_W / 2); ys.push(p.y + NODE_H / 2); }
      } else if (e.target_id === ent.id && localIds.has(e.source_id)) {
        rightVotes++; connected.push(e.source_id);
        const p = positions.get(e.source_id); if (p) { xs.push(p.x + NODE_W / 2); ys.push(p.y + NODE_H / 2); }
      }
    }
    const anchorX = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : frameCx;
    const anchorY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : frameCy;
    const byDirection: EdgeSide = rightVotes >= leftVotes ? "right" : "left";
    const preferH: EdgeSide = anchorX < frameCx - 1 ? "left" : anchorX > frameCx + 1 ? "right" : byDirection;
    const otherH: EdgeSide = preferH === "left" ? "right" : "left";
    const nearV: EdgeSide = anchorY < frameCy ? "top" : "bottom";
    const farV: EdgeSide = nearV === "top" ? "bottom" : "top";
    // координата верхнего-левого угла гостя для каждой стороны (проекция якоря вдоль стороны)
    const cornerFor = (side: EdgeSide): { x: number; y: number } => {
      switch (side) {
        case "left":   return { x: leftX,  y: anchorY - NODE_H / 2 };
        case "right":  return { x: rightX, y: anchorY - NODE_H / 2 };
        case "top":    return { x: anchorX - NODE_W / 2, y: topY };
        default:       return { x: anchorX - NODE_W / 2, y: botY };
      }
    };
    // первая сторона в порядке приоритета с минимумом пересечений (строгое < сохраняет
    // приоритет при равенстве: горизонталь побеждает, верх/низ — лишь когда реально чище)
    let bestSide: EdgeSide = preferH, bestCross = Infinity;
    for (const side of [preferH, otherH, nearV, farV]) {
      const c = crossingsAt(cornerFor(side), connected);
      if (c < bestCross) { bestCross = c; bestSide = side; }
    }
    const corner = cornerFor(bestSide);
    const along = bestSide === "left" || bestSide === "right" ? corner.y : corner.x;
    buckets[bestSide].push({ id: ent.id, along });
  }

  // Раздвигание вдоль каждой стороны (PAV, де-наложение): лево/право — по Y (фикс X),
  // верх/низ — по X (фикс Y). Симметрично вокруг центра масс желаемых позиций.
  const placeVert = (bucket: Bucket[], x: number): void => {
    if (bucket.length === 0) return;
    const ys = spread1D(bucket.map((b) => b.along), NODE_H + 28);
    bucket.forEach((b, i) => positions.set(b.id, { x, y: ys[i] }));
  };
  const placeHoriz = (bucket: Bucket[], y: number): void => {
    if (bucket.length === 0) return;
    const xs = spread1D(bucket.map((b) => b.along), NODE_W + 28);
    bucket.forEach((b, i) => positions.set(b.id, { x: xs[i], y }));
  };
  placeVert(buckets.left, leftX);
  placeVert(buckets.right, rightX);
  placeHoriz(buckets.top, topY);
  placeHoriz(buckets.bottom, botY);

  // Перенос сменил взаимное положение → пересчитываем хэндлы (autoHandles по
  // новым позициям; сохранённые хэндлы assignEdgeHandles по-прежнему уважает).
  const displayedNodeList = [
    ...nodes.map((n) => ({ id: n.id })),
    ...entities.map((e) => ({ id: e.id })),
  ];
  const edgeHandles = assignEdgeHandles(displayedNodeList, layoutEdges, positions);

  return {
    placedOutside: toPlaceSet,
    frame: { minX: fMinX, minY: fMinY, maxX: fMaxX, maxY: fMaxY },
    edgeHandles,
  };
}
