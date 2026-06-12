// Дефолтные ОБВОДЫ гостевых стрелок (основная схема).
//
// Зачем модуль существует: вынесенный на кольцо гость (см. ringPlacement.ts) может
// быть связан с несколькими узлами — к ближнему стрелка ложится чисто, а к дальнему
// прямой маршрут идёт сквозь середину рамки: рисуется под чужими узлами и теряется.
// Для таких рёбер (один конец — вынесенный гость, другой — локальный узел, и прямой
// маршрут пересекает чужие узлы) строим путь В ОБХОД рамки: концы переназначаем на
// верх/низ-центр, а высоту огибания clearY кладём в detours (её рисует edges.tsx).
// Рёбра, которые пользователь уже правил вручную (waypoints или сохранённый хэндл
// гостевого конца), не трогаем.
//
// Чистая функция: ничего не мутирует, возвращает карты handles+detours для слияния
// вызывающим кодом (по id мастер-ребра).
import { cleanup, orthogonalPointsForHandles, pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";
import { NODE_W, NODE_H, hid } from "../constants";
import type { EdgeGroup } from "../types";
import type { EdgePoint } from "../../../types";

const DETOUR_MARGIN = 44; // зазор обвода от крайнего узла
const DETOUR_STEP = 30;   // разнос параллельных обводов одной стороны (кольца)

export function computeDetours(params: {
  groupArr: EdgeGroup[];
  placedOutside: Set<string>;          // из RingPlacementResult
  frame: { minX: number; minY: number; maxX: number; maxY: number };
  localIds: Set<string>;
  displayIds: string[];                // все отображаемые id (локальные + entities)
  positions: ReadonlyMap<string, { x: number; y: number }>;
  levelEdgeWaypoints: Record<string, EdgePoint[]>;
  levelEdgeHandles: Record<string, string[]>;
}): {
  handles: Map<string, { sourceHandle: string; targetHandle: string }>;
  detours: Map<string, { clearY: number }>;
} {
  const { groupArr, placedOutside, frame, localIds, displayIds, positions, levelEdgeWaypoints, levelEdgeHandles } = params;
  const handles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  const detours = new Map<string, { clearY: number }>();

  // вертикальный диапазон содержимого с учётом вынесенных гостей — база для clearY
  let oMinY = frame.minY, oMaxY = frame.maxY;
  for (const id of placedOutside) {
    const p = positions.get(id);
    if (p) { oMinY = Math.min(oMinY, p.y); oMaxY = Math.max(oMaxY, p.y + NODE_H); }
  }
  const topBase = oMinY - DETOUR_MARGIN;
  const botBase = oMaxY + DETOUR_MARGIN;
  const frameMid = (frame.minY + frame.maxY) / 2;
  let topRing = 0, botRing = 0;
  // центр выбранной стороны узла в координатах графа (для пробного маршрута)
  const sideCenter = (id: string, side: EdgeSide): EdgePoint => {
    const p = positions.get(id)!;
    switch (side) {
      case "left":   return { x: p.x,            y: p.y + NODE_H / 2 };
      case "right":  return { x: p.x + NODE_W,   y: p.y + NODE_H / 2 };
      case "top":    return { x: p.x + NODE_W / 2, y: p.y };
      default:       return { x: p.x + NODE_W / 2, y: p.y + NODE_H };
    }
  };
  for (const g of groupArr) {
    const a = g.source, b = g.target;
    const oneGhost =
      (placedOutside.has(a) && localIds.has(b)) ||
      (placedOutside.has(b) && localIds.has(a));
    if (!oneGhost) continue;
    // пользователь уже правил это ребро вручную — не навязываем обвод
    const customized = g.members.some(
      (m) =>
        (levelEdgeWaypoints[m.id]?.length ?? 0) > 0 ||
        (m.waypoints?.length ?? 0) > 0 ||
        (levelEdgeHandles[m.id]?.length ?? 0) > 0,
    );
    if (customized) continue;
    const sp = positions.get(a), tp = positions.get(b);
    if (!sp || !tp) continue;
    // пробный прямой маршрут по доминирующей оси (как autoHandles)
    const dx = tp.x - sp.x, dy = tp.y - sp.y;
    let sSide: EdgeSide, tSide: EdgeSide;
    if (Math.abs(dx) >= Math.abs(dy)) {
      sSide = dx >= 0 ? "right" : "left"; tSide = dx >= 0 ? "left" : "right";
    } else {
      sSide = dy >= 0 ? "bottom" : "top"; tSide = dy >= 0 ? "top" : "bottom";
    }
    const sPt = sideCenter(a, sSide), tPt = sideCenter(b, tSide);
    const route = cleanup(
      orthogonalPointsForHandles(sPt.x, sPt.y, sSide, tPt.x, tPt.y, tSide),
    );
    const obstacles: NodeRect[] = displayIds
      .filter((id) => id !== a && id !== b)
      .map((id) => {
        const p = positions.get(id);
        return p ? { x: p.x, y: p.y, w: NODE_W, h: NODE_H } : null;
      })
      .filter((r): r is NodeRect => r != null);
    if (!pathCrossesRects(route, obstacles)) continue; // прямой путь чист — не трогаем
    // обвод нужен: сторону выбираем по локальному концу (к ближнему свободному краю)
    const localId = localIds.has(a) ? a : b;
    const lp = positions.get(localId)!;
    const goTop = lp.y + NODE_H / 2 <= frameMid;
    const side: EdgeSide = goTop ? "top" : "bottom";
    const clearY = goTop
      ? topBase - topRing++ * DETOUR_STEP
      : botBase + botRing++ * DETOUR_STEP;
    // оба конца — вертикальный центр выбранной стороны → стрелка выходит/входит вертикально
    handles.set(g.id, {
      sourceHandle: hid(a, side, 1),
      targetHandle: hid(b, side, 1),
    });
    detours.set(g.id, { clearY });
  }

  return { handles, detours };
}
