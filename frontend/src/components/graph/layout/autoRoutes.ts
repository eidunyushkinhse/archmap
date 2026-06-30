// Посадка глобального роутера (эпик стрелок, фазы A7.1 + A8) в раскладку уровня.
//
// Зачем модуль: routeAll — чистый роутер набора рёбер с выбором сторон (A8), но он оперирует
// абстрактными терминалами. Здесь мост от доменной модели (группы рёбер + позиции + хэндлы) к
// терминалам и обратно к картам маршрутов и выбранных хэндлов.
//
// A8 (выбор сторон): для ребра без зафиксированного пользователем хэндла перебираем варианты
// стороны источника/цели (обращённые друг к другу) и отдаём в routeAll — он выберет вариант с
// минимумом изломов и пересечений (вместо слепой доминантной оси). Выбранную сторону отдаём
// наружу как хэндл (центр стороны), чтобы RF состыковал стрелку именно там. Зафиксированный
// пользователем хэндл уважаем: единственный вариант — его точная точка стыковки.
//
// Маршрут стабилизируем стабом наружу (ensureOutwardStubs) ПРЯМО ЗДЕСЬ — тогда геометрия,
// по которой размещаются плашки (R2), совпадает с рисуемой в edges.tsx (она лишь переснимает
// концы с живых хэндлов и повторяет идемпотентный стаб). См. ARROWS_ROUTING_ANALYSIS.md §8.
import type { EdgePoint } from "../../../types";
import { ensureOutwardStubs, type EdgeSide, type NodeRect } from "../edgePath";
import { NODE_W, NODE_H, hid } from "../constants";
import type { EdgeGroup } from "../types";
import { routeAll, type EdgeTerminal } from "./routeAll";
import { railAssignments } from "./railPairs";

// Комбинация сторон+слотов хэндлов для ребра: сторона источника/цели и индекс слота (idx 1 —
// центр; рельсы встречной пары — крайние idx 0/2) + готовые точки стыковки.
type SideCombo = { s: EdgeSide; t: EdgeSide; sIdx: number; tIdx: number; start: EdgePoint; end: EdgePoint };

const EPS = 0.5;
const SIDE_OFFSETS = [0.25, 0.5, 0.75]; // позиции хэндлов вдоль стороны (как SIDE_HANDLES)

// Сторона из id хэндла `${nodeId}--${side}--${idx}` (см. hid). Невалидный/пустой → null.
function parseHandle(handle: string | undefined): { side: EdgeSide; idx: number } | null {
  if (!handle) return null;
  const parts = handle.split("--");
  const side = parts[1];
  if (side !== "top" && side !== "right" && side !== "bottom" && side !== "left") return null;
  const idx = Number(parts[2]);
  return { side, idx: Number.isFinite(idx) ? idx : 1 };
}

// Точка стыковки на стороне узла с учётом позиции хэндла (idx → offset). idx=1 → центр.
function handlePoint(p: { x: number; y: number }, side: EdgeSide, idx: number): EdgePoint {
  const off = SIDE_OFFSETS[idx] ?? 0.5;
  switch (side) {
    case "left":   return { x: p.x,              y: p.y + NODE_H * off };
    case "right":  return { x: p.x + NODE_W,     y: p.y + NODE_H * off };
    case "top":    return { x: p.x + NODE_W * off, y: p.y };
    default:       return { x: p.x + NODE_W * off, y: p.y + NODE_H };
  }
}

// Центр стороны (idx=1) — то, что отдаём наружу как выбранный хэндл и используем в кандидатах.
const sideCenter = (p: { x: number; y: number }, side: EdgeSide): EdgePoint => handlePoint(p, side, 1);

// Кандидаты сторон для свободного ребра: по две обращённые друг к другу стороны источника и
// цели (по знаку смещения центров) → до 4 комбинаций. Среди них и доминантная ось (как было).
function freeCombos(
  sp: { x: number; y: number }, tp: { x: number; y: number },
): Array<{ s: EdgeSide; t: EdgeSide }> {
  const dx = tp.x - sp.x, dy = tp.y - sp.y;
  const srcSides: EdgeSide[] = [dx >= 0 ? "right" : "left", dy >= 0 ? "bottom" : "top"];
  const tgtSides: EdgeSide[] = [dx >= 0 ? "left" : "right", dy >= 0 ? "top" : "bottom"];
  const combos: Array<{ s: EdgeSide; t: EdgeSide }> = [];
  for (const s of srcSides) for (const t of tgtSides) {
    if (!combos.some((c) => c.s === s && c.t === t)) combos.push({ s, t });
  }
  return combos;
}

const near = (a: EdgePoint, b: EdgePoint): boolean => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

export interface AutoRoutesResult {
  routes: Map<string, EdgePoint[]>;                                   // groupId → ломаная (со стабами)
  handles: Map<string, { sourceHandle: string; targetHandle: string }>; // выбранные A8 хэндлы (свободные рёбра)
}

export function buildAutoRoutes(params: {
  groups: EdgeGroup[];
  routableIds: Set<string>;   // id групп, которые роутим (не waypoint-customized/detour/context)
  lockedIds: Set<string>;     // из них: пользователь зафиксировал хэндл → сторону НЕ выбираем
  positions: ReadonlyMap<string, { x: number; y: number }>;
  edgeHandles: ReadonlyMap<string, { sourceHandle: string; targetHandle: string }>;
  displayIds: string[];       // все отображаемые id (локальные узлы + сущности)
}): AutoRoutesResult {
  const { groups, routableIds, lockedIds, positions, edgeHandles, displayIds } = params;
  // тела всех отображаемых узлов — препятствия (свои концы ребро исключит само)
  const rects = new Map<string, NodeRect>();
  for (const id of displayIds) {
    const p = positions.get(id);
    if (p) rects.set(id, { x: p.x, y: p.y, w: NODE_W, h: NODE_H });
  }

  // Рельсы встречных пар (A11): два ребра между одной парой узлов в противоположных
  // направлениях разводим на крайние слоты хэндлов обращённых сторон, чтобы их плечи не
  // совпадали (иначе R4 загоняет обе плашки в leader). Чистое назначение сторон+слотов.
  const rails = railAssignments(groups, routableIds, positions);

  // Готовим терминалы и запоминаем комбинации сторон по каждому ребру (для обратного
  // сопоставления выбранного маршрута со стороной → хэндлом).
  const combosById = new Map<string, SideCombo[]>();
  const terminals: EdgeTerminal[] = [];
  for (const g of groups) {
    if (!routableIds.has(g.id)) continue;
    const sp = positions.get(g.source), tp = positions.get(g.target);
    if (!sp || !tp) continue;
    const rail = rails.get(g.id);
    let combos: SideCombo[];
    if (lockedIds.has(g.id)) {
      // зафиксированный хэндл — единственный вариант, точная точка стыковки
      const h = edgeHandles.get(g.id);
      const ps = parseHandle(h?.sourceHandle), pt = parseHandle(h?.targetHandle);
      const sSide = ps?.side ?? (tp.x >= sp.x ? "right" : "left");
      const tSide = pt?.side ?? (tp.x >= sp.x ? "left" : "right");
      const sIdx = ps?.idx ?? 1, tIdx = pt?.idx ?? 1;
      combos = [{ s: sSide, t: tSide, sIdx, tIdx, start: handlePoint(sp, sSide, sIdx), end: handlePoint(tp, tSide, tIdx) }];
    } else if (rail) {
      // встречная пара — единственный вариант: обращённые стороны на своём слоте-рельсе (A8
      // не выбираем, сторона задана геометрией пары; idx разводит плечи на параллельные рельсы)
      combos = [{
        s: rail.sSide, t: rail.tSide, sIdx: rail.sIdx, tIdx: rail.tIdx,
        start: handlePoint(sp, rail.sSide, rail.sIdx), end: handlePoint(tp, rail.tSide, rail.tIdx),
      }];
    } else {
      combos = freeCombos(sp, tp).map((c) => ({ ...c, sIdx: 1, tIdx: 1, start: sideCenter(sp, c.s), end: sideCenter(tp, c.t) }));
    }
    combosById.set(g.id, combos);
    const obstacles: NodeRect[] = [];
    for (const [id, r] of rects) if (id !== g.source && id !== g.target) obstacles.push(r);
    terminals.push({
      id: g.id, start: combos[0].start, end: combos[0].end,
      altTerminals: combos.map((c) => ({ start: c.start, end: c.end })), obstacles,
    });
  }

  const raw = routeAll(terminals);
  const routes = new Map<string, EdgePoint[]>();
  const handles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  for (const g of groups) {
    const route = raw.get(g.id);
    if (!route || route.length < 2) continue;
    const combos = combosById.get(g.id)!;
    // какая комбинация выбрана: по совпадению концов маршрута с её точками стыковки
    const chosen =
      combos.find((c) => near(route[0], c.start) && near(route[route.length - 1], c.end)) ?? combos[0];
    const stubbed = ensureOutwardStubs(route, chosen.s, chosen.t);
    routes.set(g.id, stubbed);
    // выбранную сторону+слот отдаём как хэндл только для свободных рёбер (у locked хэндл уже
    // стоит). idx важен для рельсов встречной пары (A11): RF состыкует стрелку на крайнем слоте.
    if (!lockedIds.has(g.id)) {
      handles.set(g.id, { sourceHandle: hid(g.source, chosen.s, chosen.sIdx), targetHandle: hid(g.target, chosen.t, chosen.tIdx) });
    }
  }
  return { routes, handles };
}
