// Посадка глобального роутера (эпик стрелок; V2.1–V2.2, см. ARROWS_V2_ANALYSIS.md) в
// раскладку уровня.
//
// Зачем модуль: routeAll — чистый роутер набора рёбер, но он оперирует абстрактными
// портами. Здесь мост от доменной модели (группы рёбер + позиции + хэндлы) к портам-
// кандидатам и обратно к картам маршрутов и выбранных хэндлов.
//
// Выбор стороны (V2.2, замена A8-пробы): свободное ребро получает порты на ВСЕХ четырёх
// сторонах обоих концов — какой парой стыковаться, решает сам A* routeAll с полной
// стоимостью (длина + изломы + пересечения). Выбранную сторону отдаём наружу как хэндл
// (центр стороны), чтобы RF состыковал стрелку именно там. Зафиксированный пользователем
// хэндл уважаем: единственный порт — его точная точка стыковки. Рельсы встречных пар
// (A11) — единственный порт на крайнем слоте своей стороны.
//
// Стабы наружу входят в маршрут ПО ПОСТРОЕНИЮ (V2.1, направленные порты роутера) — прежний
// пост-патч ensureOutwardStubs здесь умер: он приклеивал развороты на 180° («шпильки»),
// когда A*-маршрут выходил из хэндла не по нормали. Геометрия, по которой размещаются
// плашки (R2), совпадает с рисуемой в edges.tsx (там ensureOutwardStubs остался только как
// no-op страховка живого драга).
import type { EdgePoint } from "../../../types";
import { type EdgeSide, type NodeRect } from "../edgePath";
import { NODE_W, NODE_H, hid } from "../constants";
import type { EdgeGroup } from "../types";
import { routeAll, type EdgeTerminal } from "./routeAll";
import { railAssignments } from "./railPairs";

// Порт стыковки ребра на узле: сторона, слот хэндла (idx 1 — центр; рельсы встречной
// пары — крайние idx 0/2) и готовая точка.
type PortSpec = { side: EdgeSide; idx: number; point: EdgePoint };

const EPS = 0.5;
const SIDE_OFFSETS = [0.25, 0.5, 0.75]; // позиции хэндлов вдоль стороны (как SIDE_HANDLES)
const ALL_SIDES: EdgeSide[] = ["left", "right", "top", "bottom"];

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

const near = (a: EdgePoint, b: EdgePoint): boolean => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

export interface AutoRoutesResult {
  routes: Map<string, EdgePoint[]>;                                   // groupId → ломаная (со стабами)
  handles: Map<string, { sourceHandle: string; targetHandle: string }>; // выбранные роутером хэндлы (свободные рёбра)
}

export function buildAutoRoutes(params: {
  groups: EdgeGroup[];
  routableIds: Set<string>;   // id групп, которые роутим (не waypoint-customized/context)
  pairableIds: Set<string>;   // рёбра уровня в раскладке (авто + ручные) — для поиска рельс-пар
  lockedIds: Set<string>;     // из них: пользователь зафиксировал хэндл → сторону НЕ выбираем
  positions: ReadonlyMap<string, { x: number; y: number }>;
  edgeHandles: ReadonlyMap<string, { sourceHandle: string; targetHandle: string }>;
  displayIds: string[];       // все отображаемые id (локальные узлы + сущности)
}): AutoRoutesResult {
  const { groups, routableIds, pairableIds, lockedIds, positions, edgeHandles, displayIds } = params;
  // тела всех отображаемых узлов — препятствия
  const rects = new Map<string, NodeRect>();
  for (const id of displayIds) {
    const p = positions.get(id);
    if (p) rects.set(id, { x: p.x, y: p.y, w: NODE_W, h: NODE_H });
  }

  // Рельсы встречных пар (A11): два ребра между одной парой узлов в противоположных
  // направлениях разводим на крайние слоты хэндлов обращённых сторон, чтобы их плечи не
  // совпадали (иначе R4 загоняет обе плашки в leader). Чистое назначение сторон+слотов.
  const rails = railAssignments(groups, pairableIds, positions);

  // Порты-кандидаты по каждому ребру (для обратного сопоставления концов маршрута со
  // стороной/слотом → хэндлом).
  const portsById = new Map<string, { s: PortSpec[]; t: PortSpec[] }>();
  const terminals: EdgeTerminal[] = [];
  for (const g of groups) {
    if (!routableIds.has(g.id)) continue;
    const sp = positions.get(g.source), tp = positions.get(g.target);
    if (!sp || !tp) continue;
    const rail = rails.get(g.id);
    let sPorts: PortSpec[], tPorts: PortSpec[];
    if (lockedIds.has(g.id)) {
      // зафиксированный хэндл — единственный порт, точная точка стыковки
      const h = edgeHandles.get(g.id);
      const ps = parseHandle(h?.sourceHandle), pt = parseHandle(h?.targetHandle);
      const sSide = ps?.side ?? (tp.x >= sp.x ? "right" : "left");
      const tSide = pt?.side ?? (tp.x >= sp.x ? "left" : "right");
      const sIdx = ps?.idx ?? 1, tIdx = pt?.idx ?? 1;
      sPorts = [{ side: sSide, idx: sIdx, point: handlePoint(sp, sSide, sIdx) }];
      tPorts = [{ side: tSide, idx: tIdx, point: handlePoint(tp, tSide, tIdx) }];
    } else if (rail) {
      // встречная пара — единственный порт: обращённая сторона на своём слоте-рельсе
      // (idx разводит плечи направлений на параллельные рельсы)
      sPorts = [{ side: rail.sSide, idx: rail.sIdx, point: handlePoint(sp, rail.sSide, rail.sIdx) }];
      tPorts = [{ side: rail.tSide, idx: rail.tIdx, point: handlePoint(tp, rail.tSide, rail.tIdx) }];
    } else {
      // свободное ребро: порты на всех четырёх сторонах, выбирает A* (V2.2)
      sPorts = ALL_SIDES.map((side) => ({ side, idx: 1, point: handlePoint(sp, side, 1) }));
      tPorts = ALL_SIDES.map((side) => ({ side, idx: 1, point: handlePoint(tp, side, 1) }));
    }
    portsById.set(g.id, { s: sPorts, t: tPorts });
    terminals.push({
      id: g.id,
      // основные концы — для детерминированного порядка прокладки и fallback
      start: sPorts[0].point, end: tPorts[0].point,
      startPorts: sPorts.map((p) => ({ point: p.point, side: p.side })),
      endPorts: tPorts.map((p) => ({ point: p.point, side: p.side })),
      obstacles: [...rects.values()],
    });
  }

  const raw = routeAll(terminals);
  const routes = new Map<string, EdgePoint[]>();
  const handles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  for (const g of groups) {
    const route = raw.get(g.id);
    if (!route || route.length < 2) continue;
    routes.set(g.id, route);
    // какие порты выбраны — по совпадению концов маршрута с точками стыковки
    const ports = portsById.get(g.id)!;
    const sPort = ports.s.find((p) => near(route[0], p.point)) ?? ports.s[0];
    const tPort = ports.t.find((p) => near(route[route.length - 1], p.point)) ?? ports.t[0];
    // выбранную сторону+слот отдаём как хэндл только для свободных рёбер (у locked хэндл
    // уже стоит). idx важен для рельсов встречной пары (A11): RF стыкует на крайнем слоте.
    if (!lockedIds.has(g.id)) {
      handles.set(g.id, {
        sourceHandle: hid(g.source, sPort.side, sPort.idx),
        targetHandle: hid(g.target, tPort.side, tPort.idx),
      });
    }
  }
  return { routes, handles };
}
