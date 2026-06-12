// Дефолтная раскладка ГОСТЕЙ, не входящих в общую с уровнем рамку (основная схема).
//
// Зачем модуль существует: ELK кладёт гостей в общий поток вместе с локальными
// узлами, из-за чего гость без сохранённой позиции мог оказаться ВНУТРИ рамки
// локальных узлов, упереться в неё или налезть на узлы. Здесь таких гостей выносим
// в аккуратные колонки за внешнюю рамку: источник связи в уровень — слева, приёмник —
// справа (несколько на сторону — стопкой сверху вниз). После переноса пересчитываем
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
  const leftX = fMinX - clearance - NODE_W;
  const rightX = fMaxX + clearance;
  const midY = (fMinY + fMaxY) / 2;

  // Сторона колонки по направлению связей гостя; желаемый Y — у связанных узлов
  // (чтобы стрелка была короткой). Ничьи/только приём → справа.
  type Placed = { id: string; desiredY: number };
  const leftCol: Placed[] = [];
  const rightCol: Placed[] = [];
  for (const ent of toPlace) {
    let leftVotes = 0, rightVotes = 0;
    const ys: number[] = [];
    for (const e of layoutEdges) {
      if (e.source_id === ent.id && localIds.has(e.target_id)) {
        leftVotes++;
        const p = positions.get(e.target_id); if (p) ys.push(p.y + NODE_H / 2);
      } else if (e.target_id === ent.id && localIds.has(e.source_id)) {
        rightVotes++;
        const p = positions.get(e.source_id); if (p) ys.push(p.y + NODE_H / 2);
      }
    }
    const desiredY =
      (ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : midY) - NODE_H / 2;
    (rightVotes >= leftVotes ? rightCol : leftCol).push({ id: ent.id, desiredY });
  }
  // В каждой колонке раскладываем сверху вниз с минимальным зазором (де-наложение).
  const placeCol = (col: Placed[], x: number): void => {
    col.sort((a, b) => a.desiredY - b.desiredY);
    let lastY = -Infinity;
    for (const it of col) {
      const y = Math.max(it.desiredY, lastY + NODE_H + 28);
      positions.set(it.id, { x, y });
      lastY = y;
    }
  };
  placeCol(leftCol, leftX);
  placeCol(rightCol, rightX);

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
