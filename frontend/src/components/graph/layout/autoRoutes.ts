// Посадка глобального роутера (эпик стрелок, фаза A7.1 — R1+R3) в раскладку уровня.
//
// Зачем модуль: routeAll (A3a) — чистый роутер набора рёбер, но он оперирует абстрактными
// терминалами (точка-старт, точка-конец, препятствия). Здесь мост от доменной модели
// (группы рёбер + позиции узлов + хэндлы) к этим терминалам и обратно к карте маршрутов.
//
// Что роутим: все ОТОБРАЖАЕМЫЕ группы уровня, КРОМЕ исключённых вызывающим (ручные правки —
// waypoints/хэндлы; гостевые обводы computeDetours; контекст-схема со своей моделью). Концы
// берём из центра выбранной стороны узла: сторона — из сохранённого/расчётного хэндла, иначе
// доминантная ось (как autoHandles). Препятствия ребра — тела ВСЕХ прочих узлов (свои концы
// исключаем: инвариант routeOrthogonal). Маршруты — производные (не персистятся): каждая
// раскладка считает заново. Чистая функция. См. ARROWS_ANALYSIS §8 (D1, D4, D7).
import type { EdgePoint } from "../../../types";
import type { EdgeSide, NodeRect } from "../edgePath";
import { NODE_W, NODE_H } from "../constants";
import type { EdgeGroup } from "../types";
import { routeAll, type EdgeTerminal } from "./routeAll";

// Сторона из id хэндла `${nodeId}--${side}--${idx}` (см. hid). Невалидный/пустой → null.
function sideFromHandle(handle: string | undefined): EdgeSide | null {
  if (!handle) return null;
  const side = handle.split("--")[1];
  return side === "top" || side === "right" || side === "bottom" || side === "left" ? side : null;
}

// Центр выбранной стороны узла в координатах графа (точка стыковки стрелки).
function sideCenter(p: { x: number; y: number }, side: EdgeSide): EdgePoint {
  switch (side) {
    case "left":   return { x: p.x,              y: p.y + NODE_H / 2 };
    case "right":  return { x: p.x + NODE_W,     y: p.y + NODE_H / 2 };
    case "top":    return { x: p.x + NODE_W / 2, y: p.y };
    default:       return { x: p.x + NODE_W / 2, y: p.y + NODE_H };
  }
}

// Доминантная ось как fallback, когда у группы нет заданного хэндла (как autoHandles).
function autoSides(
  sp: { x: number; y: number }, tp: { x: number; y: number },
): [EdgeSide, EdgeSide] {
  const dx = tp.x - sp.x, dy = tp.y - sp.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export function buildAutoRoutes(params: {
  groups: EdgeGroup[];
  routableIds: Set<string>;   // id групп, которые роутим (не customized/detour/context)
  positions: ReadonlyMap<string, { x: number; y: number }>;
  edgeHandles: ReadonlyMap<string, { sourceHandle: string; targetHandle: string }>;
  displayIds: string[];       // все отображаемые id (локальные узлы + сущности)
}): Map<string, EdgePoint[]> {
  const { groups, routableIds, positions, edgeHandles, displayIds } = params;
  // тела всех отображаемых узлов — препятствия (свои концы ребро исключит само)
  const rects = new Map<string, NodeRect>();
  for (const id of displayIds) {
    const p = positions.get(id);
    if (p) rects.set(id, { x: p.x, y: p.y, w: NODE_W, h: NODE_H });
  }
  const terminals: EdgeTerminal[] = [];
  for (const g of groups) {
    if (!routableIds.has(g.id)) continue;
    const sp = positions.get(g.source), tp = positions.get(g.target);
    if (!sp || !tp) continue;
    const h = edgeHandles.get(g.id);
    let sSide = sideFromHandle(h?.sourceHandle);
    let tSide = sideFromHandle(h?.targetHandle);
    if (!sSide || !tSide) {
      const [a, b] = autoSides(sp, tp);
      sSide = sSide ?? a;
      tSide = tSide ?? b;
    }
    const obstacles: NodeRect[] = [];
    for (const [id, r] of rects) if (id !== g.source && id !== g.target) obstacles.push(r);
    terminals.push({ id: g.id, start: sideCenter(sp, sSide), end: sideCenter(tp, tSide), obstacles });
  }
  return routeAll(terminals);
}
