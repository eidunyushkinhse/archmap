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
// (центр стороны), чтобы RF состыковал стрелку именно там. Рельсы встречных пар
// (A11) — единственный порт на крайнем слоте своей стороны. Ручной фиксации хэндлов
// больше нет (ручной слой стрелок удалён 2026-07-09).
//
// Стабы наружу входят в маршрут ПО ПОСТРОЕНИЮ (V2.1, направленные порты роутера) — прежний
// пост-патч ensureOutwardStubs здесь умер: он приклеивал развороты на 180° («шпильки»),
// когда A*-маршрут выходил из хэндла не по нормали. Геометрия, по которой размещаются
// плашки (R2), совпадает с рисуемой в edges.tsx (там ensureOutwardStubs остался только как
// no-op страховка живого драга).
import type { EdgePoint } from "../../../types";
import { pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";
import { NODE_W, NODE_H, hid } from "../constants";
import type { EdgeGroup } from "../types";
import { routeAll, type EdgeTerminal } from "./routeAll";
import { railAssignments } from "./railPairs";
import { weldTrunks } from "./weldTrunks";

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

// поточечное равенство ломаных (детект «гистерезис удержал прежний маршрут»)
const sameRoute = (a: EdgePoint[], b: EdgePoint[]): boolean =>
  a.length === b.length && a.every((p, i) => near(p, b[i]));

// Штраф за пересечение ГРАНИЦЫ раскрытой рамки (V2.4, container-aware): меньше цены
// пересечения стрелок (200), но 2 перехода (сквозь рамку насквозь) дороже разумного
// обхода. Чужое ребро обходит рамку, внутреннее не выскакивает наружу, ребро
// «внутрь» платит ровно один переход в любом маршруте — «ворота» выбирает A*.
const FRAME_CROSS_COST = 150;
// Штраф за пересечение ЧУЖОЙ плашки подписи (T4 эпика «читаемые пучки»): линия сквозь
// текст нечитаема. Не жёсткое препятствие (в тесноте лучше линия под плашкой, чем
// огород на пол-экрана), но дороже пары изломов; выше ROUTE_STICKINESS=100 — гистерезис
// грязный маршрут не удержит.
const LABEL_CROSS_COST = 150;

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
  routableIds: Set<string>;   // id групп с позиционированными концами (их и роутим)
  positions: ReadonlyMap<string, { x: number; y: number }>;
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
    id?: string;
    rect: { x: number; y: number; w: number; h: number };
    plaque: { x: number; y: number; w: number; h: number };
    memberIds: ReadonlySet<string>;
  }>;
  // КОНЦЫ-РАМКИ (2026-08-11): id рамки → её прямоугольник. Связь, чей конец — раскрытый
  // контейнер, стыкуется с ГРАНИЦЕЙ рамки: порты раздаются по этому прямоугольнику так
  // же, как по телу узла. В препятствия рамка при этом не попадает (внутри неё живут её
  // же узлы — жёсткое тело заперло бы их связи): она остаётся мягкой границей со штрафом
  // перехода, а для СВОЕГО ребра штраф снимается (стыковка снаружи, границу не режем).
  frameEndpoints?: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>;
  // ГИСТЕРЕЗИС (2026-07-09): финальные маршруты и хэндлы ПРОШЛОГО прогона. Валидный
  // прежний маршрут (концы сидят на текущих точках своих хэндлов — узлы-концы не
  // двигались; тела/плашки не режутся) идёт в routeAll кандидатом: сохраняется, пока
  // не хуже свежего на ROUTE_STICKINESS. Так стрелки, чьё окружение фактически не
  // изменилось, не перекладываются от чужих микро-сдвигов (грид-линии, инварианты).
  prev?: {
    routes: ReadonlyMap<string, EdgePoint[]>;
    handles: ReadonlyMap<string, { sourceHandle: string; targetHandle: string }>;
  };
  // ПЛАШКИ ПОДПИСЕЙ как штраф маршрута (T4 «читаемые пучки», мини-проход после
  // размещения): groupId → прямоугольник его плашки. Ребро платит LABEL_CROSS_COST за
  // каждый переход границы ЧУЖОЙ плашки (своя не отталкивает — online-плашка лежит на
  // собственной линии по построению).
  labelObstacles?: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>;
  // СВАРКА СТВОЛОВ (Ф2, E78): по умолчанию включена; живой драг передаёт false —
  // сварка не гоняется живьём (E62), доворот на отпускании прячет drawIn (E64).
  weld?: boolean;
}): AutoRoutesResult {
  const { groups, routableIds, positions, displayIds, sizes, frames, frameEndpoints, prev, labelObstacles, weld } = params;
  // тела всех отображаемых узлов — препятствия
  const rects = new Map<string, NodeRect>();
  for (const id of displayIds) {
    const p = positions.get(id);
    if (!p) continue;
    const s = sizes?.get(id);
    rects.set(id, { x: p.x, y: p.y, w: s?.w ?? NODE_W, h: s?.h ?? NODE_H });
  }
  // Тела стыковки: узлы + рамки-концы. Рамка живёт ТОЛЬКО здесь и не попадает ни в
  // `rects` (препятствия), ни в nodeRects конвейера — иначе связи её собственных детей
  // оказались бы заперты внутри жёсткого прямоугольника.
  const dockRects = new Map<string, NodeRect>(rects);
  if (frameEndpoints) for (const [id, r] of frameEndpoints) dockRects.set(id, { ...r });

  // Рельсы встречных пар (A11): два ребра между одной парой узлов в противоположных
  // направлениях разводим на крайние слоты хэндлов обращённых сторон, чтобы их плечи не
  // совпадали (иначе R4 загоняет обе плашки в leader). Чистое назначение сторон+слотов.
  const rails = railAssignments(groups, routableIds, positions);

  // Порты-кандидаты по каждому ребру (для обратного сопоставления концов маршрута со
  // стороной/слотом → хэндлом).
  const portsById = new Map<string, { s: PortSpec[]; t: PortSpec[] }>();
  // тела узлов + плашки раскрытых рамок — общий набор препятствий терминалов и сварки
  const obstacleBodies = [...rects.values(), ...(frames ?? []).map((f) => f.plaque)];
  // пер-рёберный штраф среды — сварка оценивает кандидатов той же средой, что роутер
  const extraById = new Map<string, (x1: number, y1: number, x2: number, y2: number) => number>();
  // валидированные прежние маршруты (гистерезис) + их распарсенные хэндлы
  const prevValid = new Map<string, {
    route: EdgePoint[];
    s: { side: EdgeSide; idx: number };
    t: { side: EdgeSide; idx: number };
  }>();
  const terminals: EdgeTerminal[] = [];
  for (const g of groups) {
    if (!routableIds.has(g.id)) continue;
    const sr = dockRects.get(g.source), tr = dockRects.get(g.target);
    if (!sr || !tr) continue;
    // ВАЛИДАЦИЯ прежнего маршрута: концы обязаны сидеть на ТЕКУЩИХ точках прежних
    // хэндлов (узел двигался/рос → точка уехала → маршрут невалиден, честный пере-
    // роутинг), тело чужого узла или плашка рамки не режутся (раздутие 2px — терпим
    // легально-тесные маршруты margin-лестницы (3px), но узел, надвинувшийся на
    // линию, инвалидирует).
    {
      const pr = prev?.routes.get(g.id);
      const ph = prev?.handles.get(g.id);
      const ps = parseHandle(ph?.sourceHandle);
      const pt = parseHandle(ph?.targetHandle);
      if (pr && pr.length >= 2 && ps && pt) {
        const spNow = handlePoint(sr, ps.side, ps.idx);
        const tpNow = handlePoint(tr, pt.side, pt.idx);
        const endpointsOk = near(pr[0], spNow) && near(pr[pr.length - 1], tpNow);
        if (endpointsOk) {
          const GROW = 2;
          const bodies = [
            ...[...rects.entries()]
              .filter(([id]) => id !== g.source && id !== g.target)
              .map(([, r]) => r),
            ...(frames ?? []).map((f) => f.plaque),
          ].map((r) => ({ x: r.x - GROW, y: r.y - GROW, w: r.w + 2 * GROW, h: r.h + 2 * GROW }));
          if (!pathCrossesRects(pr, bodies)) {
            prevValid.set(g.id, { route: pr.map((p) => ({ x: p.x, y: p.y })), s: ps, t: pt });
          }
        }
      }
    }
    const rail = rails.get(g.id);
    let sPorts: PortSpec[], tPorts: PortSpec[];
    if (rail) {
      // встречная пара — единственный порт: обращённая сторона на своём слоте-рельсе
      // (idx разводит плечи направлений на параллельные рельсы)
      sPorts = [{ side: rail.sSide, idx: rail.sIdx, point: handlePoint(sr, rail.sSide, rail.sIdx) }];
      tPorts = [{ side: rail.tSide, idx: rail.tIdx, point: handlePoint(tr, rail.tSide, rail.tIdx) }];
    } else {
      // свободное ребро: порты на всех четырёх сторонах И ВСЕХ слотах (T1 эпика «читаемые
      // пучки», V2.2 давал только центры): веер сам расползается по свободным слотам
      // (езда по чужому штрафуется, ствол в общем слоте бесплатен), in/out разводятся
      // прямо в поиске — пост-хок distributeSlots остаётся фолбэком. Центр (idx 1)
      // первым — детерминированный тай-брейк и прежний фолбэк ports[0].
      const SLOT_ORDER = [1, 0, 2];
      sPorts = ALL_SIDES.flatMap((side) =>
        SLOT_ORDER.map((idx) => ({ side, idx, point: handlePoint(sr, side, idx) })));
      tPorts = ALL_SIDES.flatMap((side) =>
        SLOT_ORDER.map((idx) => ({ side, idx, point: handlePoint(tr, side, idx) })));
    }
    portsById.set(g.id, { s: sPorts, t: tPorts });
    // Границы ЧУЖИХ рамок (ни один конец не член) — штраф за переход: чужое ребро
    // обходит рамку, а не режет насквозь. Свои рамки бесплатны (переход неизбежен),
    // место перехода — «ворота» — A* выбирает по остальной стоимости.
    // Рамка, которая САМА конец этого ребра, чужой не считается: стрелка стыкуется с её
    // границей снаружи и границу не пересекает — штраф лишь заставлял бы её виться.
    const foreignRects = (frames ?? [])
      .filter((f) => !f.memberIds.has(g.source) && !f.memberIds.has(g.target)
        && f.id !== g.source && f.id !== g.target)
      .map((f) => f.rect);
    // чужие плашки подписей (T4) — штраф за переход границы; своя не отталкивает
    const foreignLabels: { x: number; y: number; w: number; h: number }[] = [];
    if (labelObstacles) {
      for (const [gid, r] of labelObstacles) {
        if (gid !== g.id) foreignLabels.push(r);
      }
    }
    const extraMoveCost =
      foreignRects.length > 0 || foreignLabels.length > 0
        ? (x1: number, y1: number, x2: number, y2: number): number => {
            let n = 0;
            for (const r of foreignRects) n += borderCrossings(x1, y1, x2, y2, r) * FRAME_CROSS_COST;
            for (const r of foreignLabels) n += borderCrossings(x1, y1, x2, y2, r) * LABEL_CROSS_COST;
            return n;
          }
        : undefined;
    if (extraMoveCost) extraById.set(g.id, extraMoveCost);
    terminals.push({
      id: g.id,
      // основные концы — для детерминированного порядка прокладки и fallback
      start: sPorts[0].point, end: tPorts[0].point,
      startPorts: sPorts.map((p) => ({ point: p.point, side: p.side })),
      endPorts: tPorts.map((p) => ({ point: p.point, side: p.side })),
      // тела узлов + плашки подписей раскрытых рамок — жёсткие препятствия
      obstacles: obstacleBodies,
      extraMoveCost,
      prev: prevValid.get(g.id)?.route,
    });
  }

  // Маршруты рёбер ВНЕ routableIds (живой драг: жест их не касается) — предпроложенный
  // контекст: scoped-роутер видит их линии в штрафах пересечений/наложений, как финал.
  const preplaced: EdgePoint[][] = [];
  if (prev) {
    for (const g of groups) {
      if (routableIds.has(g.id)) continue;
      const pr = prev.routes.get(g.id);
      if (pr && pr.length >= 2) preplaced.push(pr.map((p) => ({ x: p.x, y: p.y })));
    }
  }
  const raw = routeAll(terminals, preplaced.length > 0 ? { preplaced } : undefined);
  const routes = new Map<string, EdgePoint[]>();
  const handles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  const docks: Dock[] = [];
  for (const g of groups) {
    const route = raw.get(g.id);
    if (!route || route.length < 2) continue;
    routes.set(g.id, route.map((p) => ({ x: p.x, y: p.y })));
    // Гистерезис сохранил прежний маршрут? Тогда хэндлы — прежние (их слоты могли быть
    // не-центровыми после прошлой раздачи; порты-кандидаты их не знают), и стыковки
    // ПИННЕМ (free=false): distributeSlots не должен латерально таскать удержанный
    // маршрут — иначе стабильность, ради которой он удержан, тут же ломается.
    const kept = prevValid.get(g.id);
    const keptApplied = !!kept && sameRoute(route, kept.route);
    if (keptApplied) {
      docks.push({ edgeId: g.id, nodeId: g.source, side: kept.s.side, idx: kept.s.idx, end: "s", free: false });
      docks.push({ edgeId: g.id, nodeId: g.target, side: kept.t.side, idx: kept.t.idx, end: "t", free: false });
      continue;
    }
    // какие порты выбраны — по совпадению концов маршрута с точками стыковки
    const ports = portsById.get(g.id);
    if (!ports) continue; // portsById заполнен для всех groups — недостижимо
    const sPort = ports.s.find((p) => near(route[0], p.point)) ?? ports.s[0];
    const tPort = ports.t.find((p) => near(route[route.length - 1], p.point)) ?? ports.t[0];
    const free = !rails.get(g.id);
    docks.push({ edgeId: g.id, nodeId: g.source, side: sPort.side, idx: sPort.idx, end: "s", free });
    docks.push({ edgeId: g.id, nodeId: g.target, side: tPort.side, idx: tPort.idx, end: "t", free });
  }

  // V2.4c: раздача слотов портов — вход и выход не делят точку стыковки (Т4 уточнено:
  // общий хэндл легитимен только В ОДНОМ направлении).
  distributeSlots(docks, routes, rects, dockRects);

  // выбранную сторону+слот отдаём как хэндл; idx важен для рельс (A11) и раздачи
  // слотов: RF стыкует на своём слоте.
  const dockOf = new Map<string, { s?: Dock; t?: Dock }>();
  for (const d of docks) {
    let rec = dockOf.get(d.edgeId);
    if (!rec) { rec = {}; dockOf.set(d.edgeId, rec); }
    if (d.end === "s") rec.s = d; else rec.t = d;
  }
  for (const g of groups) {
    const rec = dockOf.get(g.id);
    if (!rec?.s || !rec.t) continue;
    handles.set(g.id, {
      sourceHandle: hid(g.source, rec.s.side, rec.s.idx),
      targetHandle: hid(g.target, rec.t.side, rec.t.idx),
    });
  }

  // СВАРКА СТВОЛОВ (Ф2 префиксы E78 + Ф3 суффиксы E79): followers вееров перенимают
  // префиксы/суффиксы собратьев через изломы, где это строго выигрывает по «чернилам
  // с бонусом слияния» без новой грязи. После раздачи слотов: доки финальны, их
  // стороны — направленный финиш хвостов.
  if (weld !== false) {
    weldTrunks({
      routes,
      routableIds,
      preplaced,
      obstacles: obstacleBodies,
      extraOf: (id) => extraById.get(id),
      endSideOf: (id) => dockOf.get(id)?.t?.side,
      startSideOf: (id) => dockOf.get(id)?.s?.side,
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
// `rects` — тела-ПРЕПЯТСТВИЯ (только узлы), `dockRects` — тела СТЫКОВКИ (узлы + рамки-концы):
// у рамки слоты раздаются по её прямоугольнику, но сама она чужому плечу не мешает.
function distributeSlots(
  docks: Dock[],
  routes: Map<string, EdgePoint[]>,
  rects: Map<string, NodeRect>,
  dockRects: Map<string, NodeRect>,
): void {
  const byNodeSide = new Map<string, Dock[]>();
  for (const d of docks) {
    const k = `${d.nodeId}|${d.side}`;
    let arr = byNodeSide.get(k);
    if (!arr) { arr = []; byNodeSide.set(k, arr); }
    arr.push(d);
  }
  for (const [k, group] of [...byNodeSide.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dirs = new Set(group.map((d) => d.end));
    if (dirs.size < 2) continue; // одно направление — общий слот легитимен
    const nodeId = k.slice(0, k.indexOf("|"));
    const r = dockRects.get(nodeId);
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
    // filter + flatMap: TypeScript сужает тип без non-null assertion
    const taken = new Set(groupsByDir.flatMap((g) => g.pinned != null ? [g.pinned] : []));
    const pool = [1, 0, 2].filter((s) => !taken.has(s));
    for (const g of groupsByDir) {
      const slot = g.pinned ?? pool.shift();
      if (slot == null) continue;
      for (const d of g.docks) {
        if (!d.free || d.idx === slot) continue;
        if (moveDock(d, slot, routes, rects, dockRects)) d.idx = slot;
      }
    }
  }
}

// Латеральный перенос стыковки на новый слот. true — применено.
function moveDock(
  d: Dock,
  slot: number,
  routes: Map<string, EdgePoint[]>,
  rects: Map<string, NodeRect>,
  dockRects: Map<string, NodeRect>,
): boolean {
  const pts = routes.get(d.edgeId);
  const r = dockRects.get(d.nodeId);
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
