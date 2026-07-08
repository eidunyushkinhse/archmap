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
// Считается от РЕАЛЬНОГО прямоугольника узла (V2.2b): RF позиционирует хэндлы в долях
// реального DOM-бокса, и порт роутера обязан совпасть с живым хэндлом — иначе edges.tsx
// при переснятии концов получает перпендикулярный сдвиг и «шпильку» на шве.
function handlePoint(r: NodeRect, side: EdgeSide, idx: number): EdgePoint {
  const off = SIDE_OFFSETS[idx] ?? 0.5;
  switch (side) {
    case "left":   return { x: r.x,              y: r.y + r.h * off };
    case "right":  return { x: r.x + r.w,        y: r.y + r.h * off };
    case "top":    return { x: r.x + r.w * off,  y: r.y };
    default:       return { x: r.x + r.w * off,  y: r.y + r.h };
  }
}

const near = (a: EdgePoint, b: EdgePoint): boolean => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

// Штраф за пересечение ГРАНИЦЫ раскрытой рамки (V2.4, container-aware): меньше цены
// пересечения стрелок (200), но 2 перехода (сквозь рамку насквозь) дороже разумного
// обхода. Чужое ребро обходит рамку, внутреннее не выскакивает наружу, ребро
// «внутрь» платит ровно один переход в любом маршруте — «ворота» выбирает A*.
const FRAME_CROSS_COST = 150;

// Сколько раз осевой ход (x1,y1)→(x2,y2) пересекает границу прямоугольника.
// Горизонтальный ход считает переходы через вертикальные грани (когда y строго внутри
// y-створа), вертикальный — через горизонтальные. Касание грани концом не считается.
function borderCrossings(x1: number, y1: number, x2: number, y2: number, r: { x: number; y: number; w: number; h: number }): number {
  const horiz = Math.abs(y1 - y2) <= EPS;
  let n = 0;
  if (horiz) {
    if (!(y1 > r.y + EPS && y1 < r.y + r.h - EPS)) return 0;
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
    if (lo < r.x - EPS && hi > r.x + EPS) n++;
    if (lo < r.x + r.w - EPS && hi > r.x + r.w + EPS) n++;
  } else {
    if (!(x1 > r.x + EPS && x1 < r.x + r.w - EPS)) return 0;
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    if (lo < r.y - EPS && hi > r.y + EPS) n++;
    if (lo < r.y + r.h - EPS && hi > r.y + r.h + EPS) n++;
  }
  return n;
}

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
  // РЕАЛЬНЫЕ габариты узлов из DOM (node.measured, V2.2b): узлы автоматически растут по
  // контенту, и роутер обязан видеть их настоящие тела — иначе маршрут «легально» идёт
  // мимо предполагаемого бокса NODE_W×NODE_H, а визуально по грани/поверх узла (канон:
  // libavoid маршрутизирует от реальных shape bounds). Нет замера — фолбэк NODE_W×NODE_H.
  sizes?: ReadonlyMap<string, { w: number; h: number }>;
  // РАСКРЫТЫЕ рамки (V2.4, container-aware): rect — граница (переход ЧУЖОЙ рамки
  // штрафуется; рамка, содержащая конец ребра — memberIds, — бесплатна: переход туда
  // неизбежен, штраф лишь заставлял бы виться), plaque — плашка подписи (жёсткое
  // препятствие, сквозь текст не ходим).
  frames?: Array<{
    rect: { x: number; y: number; w: number; h: number };
    plaque: { x: number; y: number; w: number; h: number };
    memberIds: ReadonlySet<string>;
  }>;
}): AutoRoutesResult {
  const { groups, routableIds, pairableIds, lockedIds, positions, edgeHandles, displayIds, sizes, frames } = params;
  // тела всех отображаемых узлов — препятствия
  const rects = new Map<string, NodeRect>();
  for (const id of displayIds) {
    const p = positions.get(id);
    if (!p) continue;
    const s = sizes?.get(id);
    rects.set(id, { x: p.x, y: p.y, w: s?.w ?? NODE_W, h: s?.h ?? NODE_H });
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
    const sr = rects.get(g.source), tr = rects.get(g.target);
    if (!sr || !tr) continue;
    const rail = rails.get(g.id);
    let sPorts: PortSpec[], tPorts: PortSpec[];
    if (lockedIds.has(g.id)) {
      // зафиксированный хэндл — единственный порт, точная точка стыковки
      const h = edgeHandles.get(g.id);
      const ps = parseHandle(h?.sourceHandle), pt = parseHandle(h?.targetHandle);
      const sSide = ps?.side ?? (tr.x >= sr.x ? "right" : "left");
      const tSide = pt?.side ?? (tr.x >= sr.x ? "left" : "right");
      const sIdx = ps?.idx ?? 1, tIdx = pt?.idx ?? 1;
      sPorts = [{ side: sSide, idx: sIdx, point: handlePoint(sr, sSide, sIdx) }];
      tPorts = [{ side: tSide, idx: tIdx, point: handlePoint(tr, tSide, tIdx) }];
    } else if (rail) {
      // встречная пара — единственный порт: обращённая сторона на своём слоте-рельсе
      // (idx разводит плечи направлений на параллельные рельсы)
      sPorts = [{ side: rail.sSide, idx: rail.sIdx, point: handlePoint(sr, rail.sSide, rail.sIdx) }];
      tPorts = [{ side: rail.tSide, idx: rail.tIdx, point: handlePoint(tr, rail.tSide, rail.tIdx) }];
    } else {
      // свободное ребро: порты на всех четырёх сторонах, выбирает A* (V2.2)
      sPorts = ALL_SIDES.map((side) => ({ side, idx: 1, point: handlePoint(sr, side, 1) }));
      tPorts = ALL_SIDES.map((side) => ({ side, idx: 1, point: handlePoint(tr, side, 1) }));
    }
    portsById.set(g.id, { s: sPorts, t: tPorts });
    // Границы ЧУЖИХ рамок (ни один конец не член) — штраф за переход: чужое ребро
    // обходит рамку, а не режет насквозь. Свои рамки бесплатны (переход неизбежен),
    // место перехода — «ворота» — A* выбирает по остальной стоимости.
    const foreignRects = (frames ?? [])
      .filter((f) => !f.memberIds.has(g.source) && !f.memberIds.has(g.target))
      .map((f) => f.rect);
    terminals.push({
      id: g.id,
      // основные концы — для детерминированного порядка прокладки и fallback
      start: sPorts[0].point, end: tPorts[0].point,
      startPorts: sPorts.map((p) => ({ point: p.point, side: p.side })),
      endPorts: tPorts.map((p) => ({ point: p.point, side: p.side })),
      // тела узлов + плашки подписей раскрытых рамок — жёсткие препятствия
      obstacles: [...rects.values(), ...(frames ?? []).map((f) => f.plaque)],
      extraMoveCost:
        foreignRects.length > 0
          ? (x1, y1, x2, y2): number => {
              let n = 0;
              for (const r of foreignRects) n += borderCrossings(x1, y1, x2, y2, r);
              return n * FRAME_CROSS_COST;
            }
          : undefined,
    });
  }

  const raw = routeAll(terminals);
  const routes = new Map<string, EdgePoint[]>();
  const handles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  const docks: Dock[] = [];
  for (const g of groups) {
    const route = raw.get(g.id);
    if (!route || route.length < 2) continue;
    routes.set(g.id, route.map((p) => ({ x: p.x, y: p.y })));
    // какие порты выбраны — по совпадению концов маршрута с точками стыковки
    const ports = portsById.get(g.id)!;
    const sPort = ports.s.find((p) => near(route[0], p.point)) ?? ports.s[0];
    const tPort = ports.t.find((p) => near(route[route.length - 1], p.point)) ?? ports.t[0];
    const free = !lockedIds.has(g.id) && !rails.get(g.id);
    docks.push({ edgeId: g.id, nodeId: g.source, side: sPort.side, idx: sPort.idx, end: "s", free });
    docks.push({ edgeId: g.id, nodeId: g.target, side: tPort.side, idx: tPort.idx, end: "t", free });
  }

  // V2.4c: раздача слотов портов — вход и выход не делят точку стыковки (Т4 уточнено:
  // общий хэндл легитимен только В ОДНОМ направлении).
  distributeSlots(docks, routes, rects);

  // выбранную сторону+слот отдаём как хэндл только для свободных рёбер (у locked хэндл
  // уже стоит). idx важен для рельс (A11) и раздачи слотов: RF стыкует на своём слоте.
  const dockOf = new Map<string, { s?: Dock; t?: Dock }>();
  for (const d of docks) {
    const rec = dockOf.get(d.edgeId) ?? dockOf.set(d.edgeId, {}).get(d.edgeId)!;
    if (d.end === "s") rec.s = d; else rec.t = d;
  }
  for (const g of groups) {
    const rec = dockOf.get(g.id);
    if (!rec?.s || !rec.t || lockedIds.has(g.id)) continue;
    handles.set(g.id, {
      sourceHandle: hid(g.source, rec.s.side, rec.s.idx),
      targetHandle: hid(g.target, rec.t.side, rec.t.idx),
    });
  }
  return { routes, handles };
}

// Стыковка конца ребра на стороне узла (для раздачи слотов V2.4c).
interface Dock {
  edgeId: string;
  nodeId: string;
  side: EdgeSide;
  idx: number;        // слот (0/1/2 = SIDE_OFFSETS)
  end: "s" | "t";     // s = исходящее (source), t = входящее (target)
  free: boolean;      // слот можно менять (не locked, не рельса)
}

// Раздача слотов на стороне узла: рёбра группируются по НАПРАВЛЕНИЮ (in/out) — группы
// получают разные слоты, веер одного направления продолжает делить слот (легитимный
// ствол). Фиксированные стыковки (рельсы/ручные) пинят слот своей группы; свободные
// группы берут слоты в порядке [центр, 0.25, 0.75]. Сдвиг конца — латеральный перенос
// хэндла и стаб-точки; сосед-сегмент (латеральный) поглощает сдвиг. Отменяется, если
// перенос переломил бы соседа, упёрся в чужое тело или маршрут прямой (2 точки).
function distributeSlots(docks: Dock[], routes: Map<string, EdgePoint[]>, rects: Map<string, NodeRect>): void {
  const byNodeSide = new Map<string, Dock[]>();
  for (const d of docks) {
    const k = `${d.nodeId}|${d.side}`;
    (byNodeSide.get(k) ?? byNodeSide.set(k, []).get(k)!).push(d);
  }
  for (const [k, group] of [...byNodeSide.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dirs = new Set(group.map((d) => d.end));
    if (dirs.size < 2) continue; // одно направление — общий слот легитимен
    const nodeId = k.slice(0, k.indexOf("|"));
    const r = rects.get(nodeId);
    if (!r) continue;
    // направление → закреплённый слот (фиксированные стыковки пинят свой)
    const groupsByDir: Array<{ dir: "s" | "t"; docks: Dock[]; pinned: number | null }> = ["s", "t"]
      .map((dir) => {
        const ds = group.filter((d) => d.end === dir);
        const fixed = ds.find((d) => !d.free);
        return { dir: dir as "s" | "t", docks: ds, pinned: fixed ? fixed.idx : null };
      })
      .filter((g) => g.docks.length > 0)
      // большая группа первой — ей центр; тай-брейк: исходящие
      .sort((a, b) => b.docks.length - a.docks.length || (a.dir === "s" ? -1 : 1));
    const taken = new Set(groupsByDir.filter((g) => g.pinned != null).map((g) => g.pinned!));
    const pool = [1, 0, 2].filter((s) => !taken.has(s));
    for (const g of groupsByDir) {
      const slot = g.pinned ?? pool.shift();
      if (slot == null) continue;
      for (const d of g.docks) {
        if (!d.free || d.idx === slot) continue;
        if (moveDock(d, slot, routes, rects)) d.idx = slot;
      }
    }
  }
}

// Латеральный перенос стыковки на новый слот. true — применено.
function moveDock(d: Dock, slot: number, routes: Map<string, EdgePoint[]>, rects: Map<string, NodeRect>): boolean {
  const pts = routes.get(d.edgeId);
  const r = rects.get(d.nodeId);
  if (!pts || !r || pts.length < 3) return false; // прямой маршрут сдвиг не поглотит
  const vertical = d.side === "left" || d.side === "right"; // латеральная ось — Y
  const sideLen = vertical ? r.h : r.w;
  const delta = ((SIDE_OFFSETS[slot] ?? 0.5) - (SIDE_OFFSETS[d.idx] ?? 0.5)) * sideLen;
  if (Math.abs(delta) < 0.5) return true;
  const last = pts.length - 1;
  const i0 = d.end === "s" ? 0 : last;         // хэндл
  const i1 = d.end === "s" ? 1 : last - 1;     // стаб-точка
  const i2 = d.end === "s" ? 2 : last - 2;     // конец латерального соседа
  const lat = (p: EdgePoint): number => (vertical ? p.y : p.x);
  const setLat = (p: EdgePoint, v: number): void => { if (vertical) p.y = v; else p.x = v; };
  // сосед (латеральный сегмент i1→i2) не должен переломиться или выродиться
  const span = lat(pts[i2]) - lat(pts[i1]);
  const newSpan = lat(pts[i2]) - (lat(pts[i1]) + delta);
  if (Math.abs(span) > 0.5 && (Math.sign(newSpan) !== Math.sign(span) || Math.abs(newSpan) < 2)) return false;
  // сдвинутый стаб не должен лечь на чужое тело
  const nl = Math.min(lat(pts[i0]) + delta, lat(pts[i1]) + delta);
  const nh = Math.max(lat(pts[i0]) + delta, lat(pts[i1]) + delta);
  const al = Math.min(vertical ? pts[i0].x : pts[i0].y, vertical ? pts[i1].x : pts[i1].y);
  const ah = Math.max(vertical ? pts[i0].x : pts[i0].y, vertical ? pts[i1].x : pts[i1].y);
  for (const [id, b] of rects) {
    if (id === d.nodeId) continue;
    const bl = vertical ? b.y : b.x, bh = vertical ? b.y + b.h : b.x + b.w;
    const cl = vertical ? b.x : b.y, ch = vertical ? b.x + b.w : b.y + b.h;
    if (nl < bh - 2 && nh > bl + 2 && al < ch - 2 && ah > cl + 2) return false;
  }
  setLat(pts[i0], lat(pts[i0]) + delta);
  setLat(pts[i1], lat(pts[i1]) + delta);
  return true;
}
