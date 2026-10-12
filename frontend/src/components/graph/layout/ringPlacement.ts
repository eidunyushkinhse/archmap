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
//
// КОЛЬЦО СЛЕДУЕТ ЗА ELK (Ф4б эпика «стрелки без жёстких хэндлов», шаг 2; решение
// пользователя 2026-10-12 — один движок с едиными правилами вместо compound-режима ELK
// рядом с кольцом). На СВЕЖЕЙ сцене (ни один локал не владеет позицией: первое открытие
// уровня, «Переразложить») координаты ELK и есть координаты экрана, а гости уже стоят в
// крайних слоях (guestLayers.ts) — за первым/последним рядом локалов, как вложенная
// коробка ELK. Кольцо тогда НЕ пересчитывает место с нуля по якорям: сторона и
// координата вдоль неё берутся из позиции ELK, а поперёк гость лишь ВЫДВИГАЕТСЯ на поле
// рамки, если ELK поставил его ближе зазора keep-out; стоящий снаружи не трогается (зазор
// под подписи между гостем и рядом локалов зарезервирован самой раскладкой). Гости разных
// слоёв ELK (цепочка гость→гость) стоят друг над другом и вдоль стороны не разводятся —
// раздвижка PAV идёт только внутри кластера, пересекающегося поперёк. На ВЛАДЕЕМОЙ сцене
// позиция ELK новичка — в системе координат, которой на экране нет: работает прежняя
// модель якорей (пробные маршруты по сторонам); единое правило сторон для новичка —
// шаг 5 плана.
import { NODE_W, NODE_H, KEEPOUT_GAP } from "../constants";
import { computeFrames } from "./frames";
import { nativeByDepth, memberDepth } from "./keepGhostsOut";
import { assignEdgeHandles } from "./level";
import { spread1DSized } from "./pav";
import { cleanup, orthogonalPointsForHandles, pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";
import type { DisplayExternal } from "../types";
import type { LayoutEdge, AncestorRef, LevelPos } from "../../../types";

const SHELF_GAP = 28; // зазор между соседними гостями вдоль стороны кольца
const COL_GAP = 24; // зазор между колонками перелива (поперёк полки, D6)

export interface RingPlacementResult {
  /** id гостей, поставленных на кольцо (их пропускает разведение separateGuests) */
  placedOutside: Set<string>;
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
  levelPositions: Record<string, LevelPos>;
  layoutEdges: LayoutEdge[];
  positions: Map<string, XY>;
  /** раскрытые контейнеры — их дети подчиняются модели офсетов от якоря (ТЗ D2-D4) */
  expanded: Set<string>;
  /** цепочки над детьми раскрытых ЛОКАЛОВ — модель рамок обязана видеть их кольца
      (иначе кольцо гостя не совпадает с нарисованной границей, см. enforceFramesKeepOut) */
  localFrames?: { id: string; ancestors: AncestorRef[] }[];
  /** Ф4б: свежая сцена — гости стоят в крайних слоях ELK, кольцо следует за их позициями
      (сторона и координата вдоль — из ELK, поперёк — выдвижение на поле рамки) */
  followElk?: boolean;
}): RingPlacementResult | null {
  const { nodes, entities, ancestorIds, levelPositions, layoutEdges, positions, expanded, localFrames, followElk } = params;
  if (nodes.length === 0 || ancestorIds.length === 0) return null;

  const localIds = nodes.map((n) => n.id);
  const localIdSet = new Set(localIds);
  const entAncestors = (e: DisplayExternal): AncestorRef[] =>
    e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors;
  const externals = entities.map((e) => ({ id: e.id, ancestors: entAncestors(e) }));
  const frameExternals = [...externals, ...(localFrames ?? [])];
  const pos = (id: string) => positions.get(id);
  const framesNow = () =>
    computeFrames({ localIds, externals: frameExternals, pos, ancestorIds, ancestorNames: ancestorIds });

  // авто-гости (без ручной позиции) — кандидаты на кольца
  const autoIds = new Set(entities.filter((e) => !levelPositions[e.id]).map((e) => e.id));

  // --- ГРУППЫ (жёсткие): гость → внешняя (min depth) гостевая рамка, что его содержит,
  // либо одиночка. Авто-группа (все члены без ручной позиции) расставляется кольцом/полкой;
  // владеемая гостевая группа восстанавливается офсетами (ниже); ручной одиночный гость не
  // трогается (его позиция якорит рамку, нарушения добирает enforceFramesKeepOut).
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

  const placedOutside = new Set<string>();

  // Владеемые дети раскрытой гостевой рамки (own-on-first-render): их абсолютную позицию уже
  // выставил savedPos-override в layoutLevel. Здесь лишь помечаем их placedOutside — они стоят
  // ВНЕ content-рамки уровня (как и авто-гости на кольце), чтобы рамка уровня и detours не
  // считали их содержимым уровня. Авто-детей (без сохранённой позиции) пометит ring-проход ниже.
  for (const g of groupMap.values()) {
    if (!expanded.has(g.key)) continue;                  // не дети раскрытой рамки
    for (const id of g.ids) {
      if (levelPositions[id]) placedOutside.add(id);      // владеемый ребёнок → вне content-рамки
    }
  }

  const groups = [...groupMap.values()].filter((g) => g.auto);

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
  // есть ли у группы хоть одна связь наружу (с локалом или другим гостем): позиция ELK
  // такой группы осмысленна; изолят ELK пакует отдельной компонентой — ему якорная модель
  const connectedAny = (ids: string[]): boolean => {
    const idset = new Set(ids);
    return layoutEdges.some((e) => idset.has(e.source_id) !== idset.has(e.target_id));
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

    // выбор стороны для каждой группы слоя + желаемый центр вдоль стороны; gap — зазор
    // поперёк между кольцом и группой (0 — группа садится на кольцо; >0 — её поставил
    // ELK дальше, и позицию поперёк сохраняем, Ф4б)
    interface Placed { g: Group; bbox: Rect; side: EdgeSide; along: number; gap: number }
    const buckets: Record<EdgeSide, Placed[]> = { left: [], right: [], top: [], bottom: [] };
    for (const g of layer) {
      // внешний прямоугольник группы: гостевая рамка (если группа — рамка) либо bbox узлов
      const bbox = gfRect.get(g.key) ?? groupBbox(g.ids);
      if (!bbox) continue;
      const bw = bbox.maxX - bbox.minX, bh = bbox.maxY - bbox.minY;
      const connected = connectedLocal(g.ids);
      if (followElk && connectedAny(g.ids)) {
        // КОЛЬЦО СЛЕДУЕТ ЗА ELK: сторона — где группа уже снаружи кольца дальше всего
        // (или где выход наружу ближе всего, если ELK поставил её внутрь зазора),
        // вдоль стороны — координата ELK, поперёк — зазор ELK либо 0 (выдвижение)
        const gapOf: Record<EdgeSide, number> = {
          top: ring.minY - bbox.maxY, bottom: bbox.minY - ring.maxY,
          left: ring.minX - bbox.maxX, right: bbox.minX - ring.maxX,
        };
        const side = (["top", "bottom", "left", "right"] as const)
          .reduce<EdgeSide>((b, s) => (gapOf[s] > gapOf[b] ? s : b), "top");
        const along = side === "left" || side === "right" ? (bbox.minY + bbox.maxY) / 2 : (bbox.minX + bbox.maxX) / 2;
        buckets[side].push({ g, bbox, side, along, gap: Math.max(0, gapOf[side]) });
        continue;
      }
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
      buckets[bestSide].push({ g, bbox, side: bestSide, along, gap: 0 });
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
      // хвост без якоря — за последним якорем; эффективная проекция ребёнка вдоль оси
      if (!isFinite(lastAnchor)) lastAnchor = axis === "y" ? (ring.minY + ring.maxY) / 2 : (ring.minX + ring.maxX) / 2;
      // proj заполнена для всех ids циклом выше; ?? страхует от undefined
      const eff = (id: string) => { const v = proj.get(id); return v != null && isFinite(v) ? v : lastAnchor; };
      // ставит узел: along — центр вдоль оси полки, cross — координата поперёк (0 = к кольцу)
      const place = (id: string, along: number, cross: number): void => {
        if (axis === "y") positions.set(id, { x: cross, y: along - NODE_H / 2 });
        else positions.set(id, { x: along - NODE_W / 2, y: cross });
      };
      // D6: сколько детей влезает в одну колонку по пролёту кольца вдоль оси полки
      const span = axis === "y" ? ring.maxY - ring.minY : ring.maxX - ring.minX;
      const nodeAlong = axis === "y" ? NODE_H : NODE_W;
      const perCol = Math.max(1, Math.floor(span / (nodeAlong + SHELF_GAP)));

      if (ids.length <= perCol) {
        // одна колонка (cross = 0), вдоль оси — по якорю через PAV; перенос рамки ниже
        const order = [...ids].sort((p, q) =>
          (eff(p) - eff(q)) || (p < q ? -1 : p > q ? 1 : 0));
        const centers = spread1DSized(order.map(eff), order.map(() => half), SHELF_GAP);
        order.forEach((id, i) => place(id, centers[i], 0));
      } else {
        // D6/D7: перелив в несколько колонок. Назначение колонок по «тяготению к контенту»:
        // дети с бОльшей связностью и ближе к центру масс якорей — во ВНУТРЕННЮЮ колонку
        // (cross = 0, к кольцу), остальные выталкиваются наружу колонками по perCol штук.
        const com = ids.reduce((s, id) => s + eff(id), 0) / ids.length;
        const links = new Map<string, number>(ids.map((id) => [id, connectedLocal([id]).length]));
        // links построена по ids; ?? 0 страхует от undefined
        const byPull = [...ids].sort((p, q) =>
          ((links.get(q) ?? 0) - (links.get(p) ?? 0)) ||
          (Math.abs(eff(p) - com) - Math.abs(eff(q) - com)) ||
          (p < q ? -1 : p > q ? 1 : 0));
        const columns: string[][] = [];
        for (let i = 0; i < byPull.length; i += perCol) columns.push(byPull.slice(i, i + perCol));
        // наружу: left/top → к меньшим координатам, right/bottom → к бОльшим (внутр. колонка у кольца)
        const sign = it.side === "left" || it.side === "top" ? -1 : 1;
        const crossNode = axis === "y" ? NODE_W : NODE_H;
        const step = crossNode + COL_GAP;
        const pitch = nodeAlong + SHELF_GAP;
        columns.forEach((col, j) => {
          // внутри колонки — порядок по якорю, плотная стопка, центр по якорям колонки
          const sorted = [...col].sort((a, b) => (eff(a) - eff(b)) || (a < b ? -1 : a > b ? 1 : 0));
          const colCom = sorted.reduce((s, id) => s + eff(id), 0) / sorted.length;
          const start = colCom - ((sorted.length - 1) * pitch) / 2;
          sorted.forEach((id, k) => place(id, start + k * pitch, sign * j * step));
        });
      }
      // place() выставил позиции всем ids выше — bbox заведомо непустой
      const newCB = groupBbox(ids);
      if (!newCB) return null;
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
      // координата поперёк (minX для left/right, minY для top/bottom): кольцо + зазор ELK
      const crossMin = (it: Placed): number => {
        const bw = it.bbox.maxX - it.bbox.minX, bh = it.bbox.maxY - it.bbox.minY;
        switch (it.side) {
          case "left":   return ring.minX - it.gap - bw;
          case "right":  return ring.maxX + it.gap;
          case "top":    return ring.minY - it.gap - bh;
          default:       return ring.maxY + it.gap;
        }
      };
      const crossSize = (it: Placed): number =>
        axis === "y" ? it.bbox.maxX - it.bbox.minX : it.bbox.maxY - it.bbox.minY;
      // КЛАСТЕРЫ ПО ПЕРЕСЕЧЕНИЮ ПОПЕРЁК: раздвигаем вдоль стороны только тех, кто может
      // столкнуться. Без зазоров ELK (якорная модель) все на кольце — один кластер, как
      // прежде; гости разных слоёв ELK (цепочка гость→гость) стоят друг над другом и вдоль
      // стороны не разводятся.
      const byCross = [...items].sort((p, q) => crossMin(p) - crossMin(q));
      const clusters: Placed[][] = [];
      let clusterEnd = -Infinity;
      for (const it of byCross) {
        const lo = crossMin(it);
        if (clusters.length === 0 || lo >= clusterEnd - 1e-6) { clusters.push([it]); clusterEnd = lo + crossSize(it); }
        else { clusters[clusters.length - 1].push(it); clusterEnd = Math.max(clusterEnd, lo + crossSize(it)); }
      }
      for (const cluster of clusters) {
        // порядок вдоль стороны — по желаемой позиции (PAV требует монотонный вход)
        cluster.sort((p, q) => (p.along - q.along) || (p.g.key < q.g.key ? -1 : p.g.key > q.g.key ? 1 : 0));
        const half = cluster.map((it) =>
          axis === "y" ? (it.bbox.maxY - it.bbox.minY) / 2 : (it.bbox.maxX - it.bbox.minX) / 2);
        const centers = spread1DSized(cluster.map((it) => it.along), half, SHELF_GAP);
        cluster.forEach((it, i) => {
          const bw = it.bbox.maxX - it.bbox.minX, bh = it.bbox.maxY - it.bbox.minY;
          // целевой верхний-левый угол bbox: поперёк — кольцо (+ зазор ELK), вдоль — центр раздвижки
          const targetMinX = axis === "y" ? crossMin(it) : centers[i] - bw / 2;
          const targetMinY = axis === "y" ? centers[i] - bh / 2 : crossMin(it);
          const dx = targetMinX - it.bbox.minX, dy = targetMinY - it.bbox.minY;
          for (const id of it.g.ids) {
            const p = positions.get(id);
            if (p) positions.set(id, { x: p.x + dx, y: p.y + dy });
            placedOutside.add(id);
          }
        });
      }
    };
    settle(buckets.left, "y");
    settle(buckets.right, "y");
    settle(buckets.top, "x");
    settle(buckets.bottom, "x");
  }

  if (placedOutside.size === 0) return null;

  const displayed = [...localIds.map((id) => ({ id })), ...entities.map((e) => ({ id: e.id }))];
  return { placedOutside, edgeHandles: assignEdgeHandles(displayed, layoutEdges, positions) };
}

/**
 * Засев владения (own-on-first-render): сущности БЕЗ сохранённой позиции получают свою текущую
 * (после колец / enforce / разведения) как ПОСТОЯННУЮ — её надо персистнуть. Покрывает локалы
 * уровня (стабильность холста, V22), авто-гостей (сели на кольцо), новичков от вложенного
 * раскрытия и рамки раскрытий. Сущности с сохранённой строкой пропускаем.
 */
export function collectGhostSeeds(
  entities: { id: string }[],
  levelPositions: Record<string, LevelPos>,
  pos: (id: string) => XY | undefined,
): { id: string; pos_x: number; pos_y: number }[] {
  const seeds: { id: string; pos_x: number; pos_y: number }[] = [];
  for (const e of entities) {
    if (levelPositions[e.id]) continue; // уже владеется (есть сохранённая позиция)
    const p = pos(e.id);
    if (p) seeds.push({ id: e.id, pos_x: p.x, pos_y: p.y });
  }
  return seeds;
}
