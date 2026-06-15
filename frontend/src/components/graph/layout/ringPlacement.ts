// Дефолтная раскладка ГОСТЕЙ на схеме уровня как boundary labeling на кольце keep-out.
//
// Идея (ответ Fable): задача «куда ставить гостя» — не 2D. У каждого гостя ровно ОДНА
// связывающая запретная родная рамка F_{memberDepth+1} (концентричность нативных рамок:
// очистив её, очищаем все глубже). Кратчайшая стрелка при якоре ВНУТРИ рамки достигается
// на ГРАНИЦЕ раздутой рамки, поэтому оптимальные позиции живут на 1D-периметре («кольце»)
// этой рамки. Ставим гостя на одну из ЧЕТЫРЁХ сторон кольца возле проекции его якоря
// (среднего центра связанных локальных узлов); сторону выбираем по числу пересечений
// тел узлов (пробный ортомаршрут), а коллизии на стороне разводим изотонически (PAV).
//
// Кольцо берётся по НАРИСОВАННОЙ рамке F_{memberDepth+1} (тот же rect + KEEPOUT_GAP, что и
// в keepGhostsOut) → инвариант keep-out выполняется ПО ПОСТРОЕНИЮ. Рамки концентрически
// вложены и растут за уже размещёнными более глубокими гостями, поэтому кольца решаем
// ИЗНУТРИ НАРУЖУ (по убыванию memberDepth), пересчитывая рамки между слоями. Раскрытый
// гость-контейнер (гостевая рамка) двигается жёсткой группой — «супер-узлом» своего bbox.
//
// enforceFramesKeepOut остаётся страховочной сеткой (ручные позиции, рост рамки за ручным
// гостем); на авто-гостях после этого прохода он обязан быть no-op.
import { NODE_W, NODE_H, KEEPOUT_GAP } from "../constants";
import { computeFrames } from "./frames";
import { nativeByDepth, memberDepth } from "./keepGhostsOut";
import { assignEdgeHandles } from "./level";
import { spread1DSized } from "./pav";
import { cleanup, orthogonalPointsForHandles, pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";
import type { DisplayExternal } from "../types";
import type { Edge as AppEdge, AncestorRef } from "../../../types";

const SHELF_GAP = 28; // зазор между соседними гостями вдоль стороны кольца

export interface RingPlacementResult {
  /** id гостей, поставленных на кольцо (для дефолтных обводов detours.ts) */
  placedOutside: Set<string>;
  /** bbox содержимого уровня (локальные узлы + гости с ручной позицией) — база detours */
  frame: { minX: number; minY: number; maxX: number; maxY: number };
  /** хэндлы рёбер, пересчитанные по финальным позициям */
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
}

type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type XY = { x: number; y: number };

/**
 * Расставляет авто-гостей (без ручной позиции) на кольца их запретных рамок. `positions`
 * МУТИРУЕТСЯ. Возвращает null, если ставить некого/нет родных рамок/нет валидного bbox.
 */
export function placeGhostsOnRings(params: {
  nodes: { id: string }[];
  entities: DisplayExternal[];
  ancestorIds: string[];
  levelPositions: Record<string, { pos_x: number; pos_y: number }>;
  layoutEdges: AppEdge[];
  positions: Map<string, XY>;
}): RingPlacementResult | null {
  const { nodes, entities, ancestorIds, levelPositions, layoutEdges, positions } = params;
  if (nodes.length === 0 || ancestorIds.length === 0) return null;

  const localIds = nodes.map((n) => n.id);
  const localIdSet = new Set(localIds);
  const entAncestors = (e: DisplayExternal): AncestorRef[] =>
    e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors;
  const externals = entities.map((e) => ({ id: e.id, ancestors: entAncestors(e) }));
  const pos = (id: string) => positions.get(id);
  const framesNow = () =>
    computeFrames({ localIds, externals, pos, ancestorIds, ancestorNames: ancestorIds });

  // авто-гости (без ручной позиции) — кандидаты на кольца
  const autoIds = new Set(entities.filter((e) => !levelPositions[e.id]).map((e) => e.id));
  if (autoIds.size === 0) return null;

  // --- ГРУППЫ (жёсткие): авто-гость → внешняя (min depth) гостевая рамка, что его содержит,
  // либо одиночка. Если в гостевой рамке есть хоть один НЕ-авто (ручной) гость — всю группу
  // не трогаем (ручная позиция якорит рамку; нарушения добирает enforceFramesKeepOut).
  const frames0 = framesNow();
  if (frames0.length === 0) return null;
  const native0 = nativeByDepth(frames0);
  const guestFrames0 = frames0.filter((f) => !f.native);
  const groupKey = (id: string): string => {
    let bestId = id, bestDepth = Infinity;
    for (const gf of guestFrames0) {
      if (gf.memberIds.has(id) && gf.depth < bestDepth) { bestDepth = gf.depth; bestId = gf.id; }
    }
    return bestId;
  };
  interface Group { key: string; ids: string[]; fd: number; auto: boolean }
  const groupMap = new Map<string, Group>();
  for (const e of entities) {
    const key = groupKey(e.id);
    let g = groupMap.get(key);
    if (!g) {
      // fd = memberDepth(репрезентанта)+1 — одинаков у всех членов (общий префикс предков)
      g = { key, ids: [], fd: memberDepth(native0, e.id) + 1, auto: true };
      groupMap.set(key, g);
    }
    g.ids.push(e.id);
    if (!autoIds.has(e.id)) g.auto = false;
  }
  const groups = [...groupMap.values()].filter((g) => g.auto);
  if (groups.length === 0) return null;

  // bbox связанных локальных узлов гостя (для пробных маршрутов выбора стороны)
  const localRects: { id: string; rect: NodeRect }[] = [];
  for (const id of localIds) {
    const p = positions.get(id);
    if (p) localRects.push({ id, rect: { x: p.x, y: p.y, w: NODE_W, h: NODE_H } });
  }
  const sideCenterOf = (r: Rect, side: EdgeSide): XY => {
    const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
    switch (side) {
      case "left":   return { x: r.minX, y: cy };
      case "right":  return { x: r.maxX, y: cy };
      case "top":    return { x: cx, y: r.minY };
      default:       return { x: cx, y: r.maxY };
    }
  };
  // сколько связей группы, стоящей bbox-ом gb, прошли бы СКВОЗЬ тела других локальных узлов
  const crossingsAt = (gb: Rect, connected: string[]): number => {
    let crossings = 0;
    for (const lid of connected) {
      const lp = positions.get(lid);
      if (!lp) continue;
      const lr: Rect = { minX: lp.x, minY: lp.y, maxX: lp.x + NODE_W, maxY: lp.y + NODE_H };
      const gc = { x: (gb.minX + gb.maxX) / 2, y: (gb.minY + gb.maxY) / 2 };
      const lc = { x: lp.x + NODE_W / 2, y: lp.y + NODE_H / 2 };
      const dx = lc.x - gc.x, dy = lc.y - gc.y;
      let gSide: EdgeSide, lSide: EdgeSide;
      if (Math.abs(dx) >= Math.abs(dy)) {
        gSide = dx >= 0 ? "right" : "left"; lSide = dx >= 0 ? "left" : "right";
      } else {
        gSide = dy >= 0 ? "bottom" : "top"; lSide = dy >= 0 ? "top" : "bottom";
      }
      const gPt = sideCenterOf(gb, gSide), lPt = sideCenterOf(lr, lSide);
      const route = cleanup(orthogonalPointsForHandles(gPt.x, gPt.y, gSide, lPt.x, lPt.y, lSide));
      const obstacles = localRects.filter((r) => r.id !== lid).map((r) => r.rect);
      if (pathCrossesRects(route, obstacles)) crossings++;
    }
    return crossings;
  };

  const placedOutside = new Set<string>();

  // bbox группы по текущим позициям её членов (null, если ни у кого нет позиции)
  const groupBbox = (ids: string[]): Rect | null => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = positions.get(id);
      if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  };
  const connectedLocal = (ids: string[]): string[] => {
    const set = new Set<string>();
    const idset = new Set(ids);
    for (const e of layoutEdges) {
      if (idset.has(e.source_id) && localIdSet.has(e.target_id)) set.add(e.target_id);
      else if (idset.has(e.target_id) && localIdSet.has(e.source_id)) set.add(e.source_id);
    }
    return [...set];
  };
  // направление потока группы: источник (→ лево) vs приёмник (→ право), запасной критерий
  const flowSide = (ids: string[]): EdgeSide => {
    let left = 0, right = 0;
    const idset = new Set(ids);
    for (const e of layoutEdges) {
      if (idset.has(e.source_id) && localIdSet.has(e.target_id)) left++;
      else if (idset.has(e.target_id) && localIdSet.has(e.source_id)) right++;
    }
    return right >= left ? "right" : "left";
  };

  // --- КАСКАД: слои одинакового fd, изнутри наружу (fd убывает). Между слоями рамки
  // пересчитываются — мелкая рамка вырастает за уже размещёнными глубокими гостями.
  groups.sort((a, b) => b.fd - a.fd || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let gi = 0;
  while (gi < groups.length) {
    const fd = groups[gi].fd;
    const layer: Group[] = [];
    while (gi < groups.length && groups[gi].fd === fd) { layer.push(groups[gi]); gi++; }

    const frames = framesNow();
    const native = nativeByDepth(frames);
    // нарисованные rect гостевых рамок по id: группу-рамку ставим на кольцо ИМЕННО рамкой
    // (так её толкает enforceFramesKeepOut), а не голым узлом — иначе паддинг рамки залезал
    // бы в буфер и страховочный проход НЕ был бы no-op.
    const gfRect = new Map<string, Rect>();
    for (const f of frames) if (!f.native) {
      gfRect.set(f.id, { minX: f.rect.x, minY: f.rect.y, maxX: f.rect.x + f.rect.w, maxY: f.rect.y + f.rect.h });
    }
    const forbidden = native[fd];
    if (!forbidden) continue; // нет запретной рамки (глубже текущего контейнера) — пропуск
    const ring: Rect = {
      minX: forbidden.rect.x - KEEPOUT_GAP,
      minY: forbidden.rect.y - KEEPOUT_GAP,
      maxX: forbidden.rect.x + forbidden.rect.w + KEEPOUT_GAP,
      maxY: forbidden.rect.y + forbidden.rect.h + KEEPOUT_GAP,
    };
    const ringCx = (ring.minX + ring.maxX) / 2, ringCy = (ring.minY + ring.maxY) / 2;

    // выбор стороны для каждой группы слоя + желаемый центр вдоль стороны
    interface Placed { g: Group; bbox: Rect; side: EdgeSide; along: number }
    const buckets: Record<EdgeSide, Placed[]> = { left: [], right: [], top: [], bottom: [] };
    for (const g of layer) {
      // внешний прямоугольник группы: гостевая рамка (если группа — рамка) либо bbox узлов
      const bbox = gfRect.get(g.key) ?? groupBbox(g.ids);
      if (!bbox) continue;
      const bw = bbox.maxX - bbox.minX, bh = bbox.maxY - bbox.minY;
      const connected = connectedLocal(g.ids);
      let ax = 0, ay = 0, cnt = 0;
      for (const lid of connected) {
        const p = positions.get(lid);
        if (p) { ax += p.x + NODE_W / 2; ay += p.y + NODE_H / 2; cnt++; }
      }
      const anchorX = cnt ? ax / cnt : ringCx;
      const anchorY = cnt ? ay / cnt : ringCy;
      const byDir = flowSide(g.ids);
      const preferH: EdgeSide = anchorX < ringCx - 1 ? "left" : anchorX > ringCx + 1 ? "right" : byDir;
      const otherH: EdgeSide = preferH === "left" ? "right" : "left";
      const nearV: EdgeSide = anchorY < ringCy ? "top" : "bottom";
      const farV: EdgeSide = nearV === "top" ? "bottom" : "top";
      // bbox группы, поставленной на сторону с центром вдоль = проекция якоря
      const bboxOnSide = (side: EdgeSide): Rect => {
        switch (side) {
          case "left":   return { minX: ring.minX - bw, minY: anchorY - bh / 2, maxX: ring.minX, maxY: anchorY + bh / 2 };
          case "right":  return { minX: ring.maxX, minY: anchorY - bh / 2, maxX: ring.maxX + bw, maxY: anchorY + bh / 2 };
          case "top":    return { minX: anchorX - bw / 2, minY: ring.minY - bh, maxX: anchorX + bw / 2, maxY: ring.minY };
          default:       return { minX: anchorX - bw / 2, minY: ring.maxY, maxX: anchorX + bw / 2, maxY: ring.maxY + bh };
        }
      };
      let bestSide: EdgeSide = preferH, bestCross = Infinity;
      for (const side of [preferH, otherH, nearV, farV]) {
        const c = crossingsAt(bboxOnSide(side), connected);
        if (c < bestCross) { bestCross = c; bestSide = side; }
      }
      const along = bestSide === "left" || bestSide === "right" ? anchorY : anchorX;
      buckets[bestSide].push({ g, bbox, side: bestSide, along });
    }

    // Внутренняя раскладка детей раскрытой гостевой рамки (D1): вместо жёсткого переноса
    // группы расставляем её детей ОДНОЙ полкой вдоль стороны рамки, обращённой к кольцу,
    // в порядке проекции их якорей (центроидов связанных локалов) на ось полки. Перетасовка
    // входных ELK-позиций детей на результат НЕ влияет — порядок задаёт только якорь.
    // Мутирует positions; возвращает новый bbox ГОСТЕВОЙ РАМКИ (дети + паддинг), которым
    // группа затем садится на кольцо (так keep-out остаётся no-op по построению).
    const layoutGuestChildrenShelf = (it: Placed, axis: "x" | "y"): Rect | null => {
      const ids = it.g.ids;
      const oldCB = groupBbox(ids);
      const oldFR = gfRect.get(it.g.key);
      if (!oldCB || !oldFR) return null;
      // паддинг рамки (симметричный по бокам/сверху) + полку под подпись снизу выводим из
      // старого frame-rect, чтобы воссоздать рамку по новой раскладке детей без computeFrames
      const pad = oldCB.minX - oldFR.minX;
      const labelPad = oldFR.maxY - oldFR.minY - (oldCB.maxY - oldCB.minY) - 2 * pad;
      const half = axis === "y" ? NODE_H / 2 : NODE_W / 2;
      // проекция якоря ребёнка на ось полки (центроид связанных локалов); без связей — в хвост
      const proj = new Map<string, number>();
      let lastAnchor = -Infinity;
      for (const id of ids) {
        let s = 0, c = 0;
        for (const lid of connectedLocal([id])) {
          const p = positions.get(lid);
          if (p) { s += axis === "y" ? p.y + NODE_H / 2 : p.x + NODE_W / 2; c++; }
        }
        const v = c ? s / c : Infinity;
        proj.set(id, v);
        if (isFinite(v)) lastAnchor = Math.max(lastAnchor, v);
      }
      // порядок: по проекции якоря; бесхвостые (без связей) — в конец, стабильно по id
      const order = [...ids].sort((p, q) =>
        (proj.get(p)! - proj.get(q)!) || (p < q ? -1 : p > q ? 1 : 0));
      // желаемые координаты вдоль оси = проекция якоря; хвост без якоря — за последним якорем
      if (!isFinite(lastAnchor)) lastAnchor = axis === "y" ? (ring.minY + ring.maxY) / 2 : (ring.minX + ring.maxX) / 2;
      const desired = order.map((id) => (isFinite(proj.get(id)!) ? proj.get(id)! : lastAnchor));
      const centers = spread1DSized(desired, order.map(() => half), SHELF_GAP);
      // одна колонка (cross = 0), вдоль оси — по центрам; абсолют задаст перенос рамки ниже
      order.forEach((id, i) => {
        if (axis === "y") positions.set(id, { x: 0, y: centers[i] - NODE_H / 2 });
        else positions.set(id, { x: centers[i] - NODE_W / 2, y: 0 });
      });
      const newCB = groupBbox(ids)!;
      return { minX: newCB.minX - pad, minY: newCB.minY - pad, maxX: newCB.maxX + pad, maxY: newCB.maxY + pad + labelPad };
    };

    // де-наложение вдоль стороны (PAV с учётом размеров групп) + перенос группы целиком
    const settle = (items: Placed[], axis: "x" | "y"): void => {
      if (items.length === 0) return;
      // сначала внутренняя раскладка детей многодетных гостевых рамок (D1) — обновляет их bbox
      for (const it of items) {
        if (it.g.ids.length > 1 && gfRect.has(it.g.key)) {
          const nb = layoutGuestChildrenShelf(it, axis);
          if (nb) it.bbox = nb;
        }
      }
      const half = items.map((it) =>
        axis === "y" ? (it.bbox.maxY - it.bbox.minY) / 2 : (it.bbox.maxX - it.bbox.minX) / 2);
      const centers = spread1DSized(items.map((it) => it.along), half, SHELF_GAP);
      items.forEach((it, i) => {
        const bw = it.bbox.maxX - it.bbox.minX, bh = it.bbox.maxY - it.bbox.minY;
        // целевой верхний-левый угол bbox: фикс по стороне кольца, центр по оси раздвижки
        let targetMinX: number, targetMinY: number;
        if (it.side === "left")        { targetMinX = ring.minX - bw; targetMinY = centers[i] - bh / 2; }
        else if (it.side === "right")  { targetMinX = ring.maxX;      targetMinY = centers[i] - bh / 2; }
        else if (it.side === "top")    { targetMinX = centers[i] - bw / 2; targetMinY = ring.minY - bh; }
        else                            { targetMinX = centers[i] - bw / 2; targetMinY = ring.maxY; }
        const dx = targetMinX - it.bbox.minX, dy = targetMinY - it.bbox.minY;
        for (const id of it.g.ids) {
          const p = positions.get(id);
          if (p) positions.set(id, { x: p.x + dx, y: p.y + dy });
          placedOutside.add(id);
        }
      });
    };
    settle(buckets.left, "y");
    settle(buckets.right, "y");
    settle(buckets.top, "x");
    settle(buckets.bottom, "x");
  }

  if (placedOutside.size === 0) return null;

  // bbox содержимого уровня = локальные узлы + гости с ручной позицией (НЕ на кольце) —
  // база для дефолтных обводов (detours.ts), которые сами расширят его за вынесенных
  let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
  const frameIds = [...localIds, ...entities.filter((e) => !placedOutside.has(e.id)).map((e) => e.id)];
  for (const id of frameIds) {
    const p = positions.get(id);
    if (!p) continue;
    fMinX = Math.min(fMinX, p.x); fMinY = Math.min(fMinY, p.y);
    fMaxX = Math.max(fMaxX, p.x + NODE_W); fMaxY = Math.max(fMaxY, p.y + NODE_H);
  }
  const frame = isFinite(fMinX)
    ? { minX: fMinX, minY: fMinY, maxX: fMaxX, maxY: fMaxY }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const displayed = [...localIds.map((id) => ({ id })), ...entities.map((e) => ({ id: e.id }))];
  return { placedOutside, frame, edgeHandles: assignEdgeHandles(displayed, layoutEdges, positions) };
}
