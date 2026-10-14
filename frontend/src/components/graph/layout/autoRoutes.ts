// Посадка глобального роутера (эпик стрелок; V2.1–V2.2, см. ARROWS_V2_ANALYSIS.md) в
// раскладку уровня.
//
// Зачем модуль: routeAll — чистый роутер набора рёбер, но он оперирует абстрактными
// портами. Здесь мост от доменной модели (группы рёбер + позиции) к портам и обратно к
// картам маршрутов и выбранных хэндлов.
//
// ПОРТ НА СВЯЗЬ (Ф1 эпика «стрелки без жёстких хэндлов», docs/archive/plan-arrows-ports.md):
// точку стыковки каждого конца выбирает ДО прокладки модуль ports.ts — сторона по оси
// потока (R2), порядок на стороне по дальнему концу (R3), равный шаг с полями у узла и
// проекция с зазором у рамки (R4). Роутер получает по одному порту на конец и ищет
// маршрут между ними; общих точек стыковки нет по построению. Прежние механики — 12
// слотов × A*-выбор стороны (V2.2), рельсы встречных пар (A11), раздача слотов
// (V2.4c), портовый штраф — сняты вместе с их причиной (общие слоты).
//
// Наружу сторона отдаётся хэндлом центра стороны (`hid(node, side, 1)`): React Flow
// нужен существующий хэндл, чтобы нарисовать ребро, а концы линии рендер берёт из
// самого маршрута (edges.tsx, точка роутера главная).
//
// Общих плеч (стволов вееров, E25 v2) и их сварки (E78/E79) здесь больше нет: с портом
// на связь общих точек стыковки не бывает, и каждая связь едет своей линией (Ф2).
//
// СВОЯ ДОРОЖКА (Ф2, R5): связи с портами на противоположных сторонах одной оси сначала
// получают канонический Z-маршрут с упорядоченными дорожками канала (zRoutes.ts). Он
// детерминирован и не зависит от prev, поэтому считается для ВСЕХ групп с геометрией,
// включая нероутируемые скоупом (их дорожки сдвигаются вместе с составом канала —
// «пересад» R9). Связи без чистого Z идут в A* (routeAll): Z-маршруты — их
// предпроложенный контекст, свободные дорожки каналов — грид-подсказки. Нероутируемая
// связь без Z оставляет prev-маршрут, пересаженный на текущие порты (R9); пересад не
// удался — честный A*.
//
// Стабы наружу входят в маршрут ПО ПОСТРОЕНИЮ (V2.1, направленные порты роутера) — прежний
// пост-патч ensureOutwardStubs здесь умер: он приклеивал развороты на 180° («шпильки»),
// когда A*-маршрут выходил из хэндла не по нормали. Геометрия, по которой размещаются
// плашки (R2), совпадает с рисуемой в edges.tsx (там ensureOutwardStubs остался только как
// no-op страховка живого драга).
import type { EdgePoint } from "../../../types";
import { cleanup, pathCrossesRects, type EdgeSide, type NodeRect } from "../edgePath";
import { NODE_W, NODE_H, hid } from "../constants";
import type { EdgeGroup } from "../types";
import { routeAll, type EdgeTerminal } from "./routeAll";
import { assignPorts, type PortPair } from "./ports";
import { zRoutes } from "./zRoutes";
import type { RouteBudget } from "./routeBudget";

const EPS = 0.5;

// Сторона из id хэндла `${nodeId}--${side}--${idx}` (см. hid): прежние стороны пары идут
// в гистерезис выбора стороны (R2) и прежнюю ось потока. Слот (idx) смысла не имеет.
function parseSide(handle: string | undefined): EdgeSide | null {
  if (!handle) return null;
  const side = handle.split("--")[1];
  return side === "top" || side === "right" || side === "bottom" || side === "left" ? side : null;
}

const near = (a: EdgePoint, b: EdgePoint): boolean => Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

// Штраф за пересечение ГРАНИЦЫ раскрытой рамки (V2.4, container-aware): меньше цены
// пересечения стрелок (200), но 2 перехода (сквозь рамку насквозь) дороже разумного
// обхода. Чужое ребро обходит рамку, внутреннее не выскакивает наружу, ребро
// «внутрь» платит ровно один переход в любом маршруте — «ворота» выбирает A*.
export const FRAME_CROSS_COST = 150;
// Штраф за пересечение ЧУЖОЙ плашки подписи (T4 эпика «читаемые пучки»): линия сквозь
// текст нечитаема. Не жёсткое препятствие (в тесноте лучше линия под плашкой, чем
// огород на пол-экрана), но дороже пары изломов; выше ROUTE_STICKINESS=100 — гистерезис
// грязный маршрут не удержит.
export const LABEL_CROSS_COST = 150;

// ЭКСПЕРИМЕНТ г1 (Ф4-II эпика «глубокая оптимизация роутера»): отдавать ли
// T4-мини-проходу грид-подсказки от портов ВСЕХ рёбер сцены (gridHintGroups ниже), а
// не только перепрокладываемых. Мотив (Ф0): T4 роутит на БЕДНОЙ сетке и тратит 12.3
// маргин-ретрая на ребро против 10.9 у полного прохода. ВЫКЛЮЧЕН ПО ЗАМЕРУ: сетка
// плотнее → шаг дороже, время T4 растёт, а качество не выигрывает (числа — в журнале
// Ф4-II, docs/plan-router-deep-opt.md). Флаг оставлен в дереве, чтобы эксперимент
// воспроизводился одной правкой, а не археологией.
// ЖИВЁТ ЗДЕСЬ, А НЕ В pipeline.ts (где его читают, — находка Н2 внешнего аудита): его
// включение МЕНЯЕТ ГЕОМЕТРИЮ (другое пространство поиска), значит он обязан входить в
// реестр сторожа контракта (routerVersion.ts), а тот собирает константы только из
// ЛЁГКИХ модулей роутера — импорт pipeline.ts утащил бы весь конвейер в главный бандл
// через routeCacheStore.
export const T4_FULL_GRID_HINTS: boolean = false;

// ПЕРЕПРОКЛАДКА В T4 (п.3 финальной приёмки эпика «глубокая оптимизация роутера»,
// решение пользователя 2026-09-01; спека edge.md E40 v3).
//   false — ДЕФОЛТ: T4-мини-проход чинит ТОЛЬКО СЛОЙ ПЛАШЕК (уступка Б3б, E40 v2).
//     Рёбра не перепрокладываются вовсе, а вместе с перепрокладкой уходят доводка
//     нуджинга, пере-размещение плашек по новой геометрии и финальная починка поверх
//     него. Конфликт «линия сквозь плашку», который плашка снять не смогла, ОСТАЁТСЯ
//     на экране — осознанная цена, её видно метрикой throughLabels (route-quality.ts).
//   true — ПРЕЖНЕЕ ПОВЕДЕНИЕ ЦЕЛИКОМ (перепрокладка грязных рёбер по штрафному
//     ландшафту чужих плашек + доводка нуджинга + финальная починка).
// МОТИВ (замер Ф4-II, журнал в docs/plan-router-deep-opt.md): перепрокладка держит
// около половины цены конвейера, а покупает единицы рёбер — дешёвый слой плашек даёт
// больше. Флаг оставлен в дереве до вырезания: им сравнивают режимы и откатываются.
// ЖИВЁТ ЗДЕСЬ ПО ТОЙ ЖЕ ПРИЧИНЕ, ЧТО T4_FULL_GRID_HINTS ВЫШЕ: включение МЕНЯЕТ
// ГЕОМЕТРИЮ, значит флаг обязан входить в реестр сторожа контракта (routerVersion.ts),
// а тот собирает константы только из ЛЁГКИХ модулей роутера — импорт pipeline.ts
// утащил бы весь конвейер в главный бандл через routeCacheStore.
export const T4_REROUTE: boolean = false;

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

// ИНДЕКС ГРАНЕЙ ПЛАШЕК (А1 эпика «глубокая оптимизация роутера», 2026-08-21). В T4-мини-
// проходе чужими плашками ребру служит вся сцена (85–128 прямоугольников), и линейный
// скан по ним крутился на КАЖДОМ ходе A* — половина цены стадии. Здесь те же
// прямоугольники разложены по ГРАНЯМ (каждая грань считается независимо — ровно как в
// borderCrossings: ход насквозь = 2 перехода) и отсортированы по своей координате: ход
// платит только за грани своего диапазона, диапазон достаётся двоичным поиском (та же
// механика, что PlacedIndex в routeAll). Математика штрафа не меняется — сумма целых
// переходов не зависит от порядка слагаемых, — поэтому маршруты байт-в-байт.
interface LabelFace {
  g: number;    // координата грани (x у вертикальной, y у горизонтальной)
  lo: number;   // створ прямоугольника поперёк грани (y-створ у вертикальной)
  hi: number;
  gid: string;  // владелец плашки: своя плашка ребра не отталкивает
}
interface LabelFaceIndex {
  v: LabelFace[]; // вертикальные грани (x = g) — их режет ГОРИЗОНТАЛЬНЫЙ ход
  h: LabelFace[]; // горизонтальные грани (y = g) — их режет ВЕРТИКАЛЬНЫЙ ход
}

function buildLabelFaceIndex(
  labels: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>,
): LabelFaceIndex {
  const v: LabelFace[] = [];
  const h: LabelFace[] = [];
  for (const [gid, r] of labels) {
    v.push({ g: r.x, lo: r.y, hi: r.y + r.h, gid });
    v.push({ g: r.x + r.w, lo: r.y, hi: r.y + r.h, gid });
    h.push({ g: r.y, lo: r.x, hi: r.x + r.w, gid });
    h.push({ g: r.y + r.h, lo: r.x, hi: r.x + r.w, gid });
  }
  const byG = (a: LabelFace, b: LabelFace): number => a.g - b.g;
  v.sort(byG);
  h.sort(byG);
  return { v, h };
}

// Первая грань с g >= val (нижняя граница диапазона кандидатов).
function lowerBoundFaces(arr: LabelFace[], val: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].g < val) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Сколько граней ЧУЖИХ плашек пересекает осевой ход — тождественно сумме borderCrossings
// по всем плашкам, кроме своей (пороги EPS взяты оттуда слово в слово).
function countLabelCrossings(
  idx: LabelFaceIndex, ownGid: string,
  x1: number, y1: number, x2: number, y2: number,
): number {
  const horiz = Math.abs(y1 - y2) <= EPS;
  const c = horiz ? y1 : x1;                                 // постоянная координата хода
  const lo = horiz ? Math.min(x1, x2) : Math.min(y1, y2);    // протяжённость хода
  const hi = horiz ? Math.max(x1, x2) : Math.max(y1, y2);
  const faces = horiz ? idx.v : idx.h;
  let n = 0;
  for (let k = lowerBoundFaces(faces, lo - EPS); k < faces.length && faces[k].g <= hi + EPS; k++) {
    const f = faces[k];
    if (!(c > f.lo + EPS && c < f.hi - EPS)) continue;  // ход обязан идти строго внутри створа
    if (!(lo < f.g - EPS && hi > f.g + EPS)) continue;  // касание грани концом не считается
    if (f.gid === ownGid) continue;                    // своя плашка лежит на своей же линии
    n++;
  }
  return n;
}

export interface AutoRoutesResult {
  routes: Map<string, EdgePoint[]>;                                   // groupId → ломаная (со стабами)
  handles: Map<string, { sourceHandle: string; targetHandle: string }>; // хэндлы центра выбранных сторон
  // Геометрия, окончательная для пост-стадий (нуджинг держит пинами, полировка джогов
  // не трогает): Z-маршруты, пересаженные и удержанные prev нероутируемых связей.
  fixedIds: Set<string>;
  // Связи, проложенные A* в этом вызове (в т.ч. нероутируемые, чей prev не пересел).
  routedIds: Set<string>;
  // Якоря подписей Z-маршрутов (Ф3): точка слота, зарезервированного роутером под плашку.
  labelAnchors: Map<string, EdgePoint>;
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
  // контейнер, стыкуется с ГРАНИЦЕЙ рамки: порт раздаётся по этому прямоугольнику
  // (проекция дальнего конца с зазором, R4). В препятствия рамка при этом не попадает
  // (внутри неё живут её же узлы — жёсткое тело заперло бы их связи): она остаётся
  // мягкой границей со штрафом перехода, а для СВОЕГО ребра штраф снимается.
  frameEndpoints?: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>;
  // ГИСТЕРЕЗИС (2026-07-09): финальные маршруты и хэндлы ПРОШЛОГО прогона. Валидный
  // прежний маршрут (концы сидят на ТЕКУЩИХ портах — порты не сдвинулись; тела/плашки
  // не режутся) идёт в routeAll кандидатом: сохраняется, пока не хуже свежего на
  // ROUTE_STICKINESS. Прежние стороны пар держат гистерезис выбора стороны (R2).
  prev?: {
    routes: ReadonlyMap<string, EdgePoint[]>;
    handles: ReadonlyMap<string, { sourceHandle: string; targetHandle: string }>;
  };
  // ПЛАШКИ ПОДПИСЕЙ как штраф маршрута (T4 «читаемые пучки», мини-проход после
  // размещения): groupId → прямоугольник его плашки. Ребро платит LABEL_CROSS_COST за
  // каждый переход границы ЧУЖОЙ плашки (своя не отталкивает — online-плашка лежит на
  // собственной линии по построению).
  labelObstacles?: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>;
  // ГАБАРИТ ПЛАШКИ ПОДПИСИ связи (Ф3): дорожка-носитель в zRoutes резервирует под неё
  // толщину в канале, чтобы подпись не легла на соседнюю линию.
  labelBoxOf?: (groupId: string) => { w: number; h: number } | undefined;
  // ЭКСПЕРИМЕНТ г1 (Ф4-II эпика «глубокая оптимизация роутера»): набор групп, чьи порты
  // идут в решётку ДОПОЛНИТЕЛЬНО к портам роутируемых. Скоупенный вызов (T4-мини-проход)
  // иначе ищет на БЕДНОЙ сетке — свернуть можно только на линии своих портов, отсюда
  // лишние маргин-ретраи (Ф0: 12.3 ретрая на ребро против 10.9 у полного прохода).
  // ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО: не байт-в-байт (другое пространство поиска), решение о
  // включении — за замером (см. журнал Ф4-II в docs/plan-router-deep-opt.md).
  gridHintGroups?: EdgeGroup[];
  // БЮДЖЕТ РАБОТ (Ф5 эпика router-opt, спека perf.md P12/P13) — ПАРАМЕТРОМ, не
  // синглтоном. Едет в routeAll (потолок вызова A* + ступень «пропустить rip-up»).
  // Не задан — бюджета нет, поведение прежнее байт-в-байт (фазз-полигон, живой драг,
  // юнит-тесты).
  budget?: RouteBudget;
}): AutoRoutesResult {
  const { groups, routableIds, positions, displayIds, sizes, frames, frameEndpoints, prev, labelObstacles, gridHintGroups, budget, labelBoxOf } = params;
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
  const frameIds = new Set<string>();
  if (frameEndpoints) {
    for (const [id, r] of frameEndpoints) { dockRects.set(id, { ...r }); frameIds.add(id); }
  }

  // ПОРТЫ ВСЕХ групп с геометрией — и нероутируемых тоже: они занимают своё место на
  // стороне, иначе порты роутируемых легли бы поверх замороженных концов. Прежние
  // стороны пар — из хэндлов прошлого прогона (гистерезис R2, прежняя ось потока).
  const prevSides = new Map<string, { s: EdgeSide; t: EdgeSide }>();
  if (prev) {
    for (const [id, h] of prev.handles) {
      const s = parseSide(h.sourceHandle), t = parseSide(h.targetHandle);
      if (s && t) prevSides.set(id, { s, t });
    }
  }
  const groupById = new Map<string, EdgeGroup>(groups.map((g) => [g.id, g]));

  // тела узлов + плашки раскрытых рамок — препятствия терминалов
  const framePlaques = (frames ?? []).map((f) => f.plaque);
  const obstacleBodies = [...rects.values(), ...framePlaques];
  // Границы ЧУЖИХ рамок связи (ни один конец не член, рамка — не конец): A* платит за
  // переход FRAME_CROSS_COST, Z сквозь них не ходит вовсе.
  const foreignRectsOf = (g: EdgeGroup): NodeRect[] => (frames ?? [])
    .filter((f) => !f.memberIds.has(g.source) && !f.memberIds.has(g.target)
      && f.id !== g.source && f.id !== g.target)
    .map((f) => f.rect);

  // Чужие плашки подписей (T4-мини-проход): для A* — штраф LABEL_CROSS_COST, для Z —
  // запрет, как и границы чужих рамок: Z — только там, где он чист.
  const foreignLabelRectsOf = (gid: string): NodeRect[] => {
    if (!labelObstacles) return [];
    const out: NodeRect[] = [];
    for (const [id, r] of labelObstacles) if (id !== gid) out.push(r);
    return out;
  };
  // ПОРТЫ И Z-МАРШРУТЫ (R5) — для всех групп с портами, независимо от скоупа. Два
  // прохода: порты по R3 → Z; Z отдаёт ключи порядка концов, чья дорожка не в
  // соседнем канале (доводка E85) → порты заново → Z заново. Без ключей второй проход
  // не нужен (результат тот же).
  const hardOf = (gid: string): NodeRect[] => {
    const g = groupById.get(gid);
    return g ? foreignRectsOf(g) : [];
  };
  const softOf = (gid: string): NodeRect[] => foreignLabelRectsOf(gid);
  // Итерация до согласия ключей и портов (не больше трёх кругов): ключи считаются по
  // маршрутам ТЕКУЩИХ портов, а порты следующего круга могут изменить выбор варианта.
  // Ключи круга ЗАМЕНЯЮТ прежние: конец без ключа сортируется по умолчанию (центр
  // дальнего узла). Накопление ключей (заход 2) держало устаревший ключ колонны ZZ у
  // связи, давно ставшей Z, и ломало порядок стороны; качелей «ключ есть / ключа нет»
  // больше нет — длинный Z отдаёт липкий ключ по своему порту (zRoutes, E85).
  let keys = new Map<string, { s?: number; t?: number }>();
  let pr = assignPorts({ groups, rects: dockRects, frameIds, prevSides, labelBoxOf });
  let ports = pr.ports;
  let z = zRoutes({ groups, ports, shares: pr.shares, obstacles: obstacleBodies, rectOf: (id) => dockRects.get(id), hardOf, softOf, labelBoxOf });
  const sameKeys = (a: ReadonlyMap<string, { s?: number; t?: number }>, b: ReadonlyMap<string, { s?: number; t?: number }>): boolean => {
    if (a.size !== b.size) return false;
    for (const [id, k] of a) {
      const o = b.get(id);
      if (!o || o.s !== k.s || o.t !== k.t) return false;
    }
    return true;
  };
  for (let round = 0; round < 3; round++) {
    const next = new Map(z.portKeys);
    if (sameKeys(next, keys)) break;
    keys = next;
    pr = assignPorts({ groups, rects: dockRects, frameIds, prevSides, keys, labelBoxOf });
    ports = pr.ports;
    z = zRoutes({ groups, ports, shares: pr.shares, obstacles: obstacleBodies, rectOf: (id) => dockRects.get(id), hardOf, softOf, labelBoxOf });
  }
  const routes = new Map<string, EdgePoint[]>();
  const fixedIds = new Set<string>();
  const routedIds = new Set<string>();
  for (const [id, pts] of z.routes) { routes.set(id, pts); fixedIds.add(id); }

  // ИНДЕКС ГРАНЕЙ ПЛАШЕК — ОДИН на вызов, а не на ребро: своя плашка отсеивается по gid
  // прямо в счёте хода (А1). Без плашек (проход 1) индекса нет и путь прежний.
  const labelFaces = labelObstacles ? buildLabelFaceIndex(labelObstacles) : null;
  // ВАЛИДАЦИЯ prev-маршрута: концы на ТЕКУЩИХ портах, тела чужих узлов и плашки рамок
  // не режутся (раздутие 2px — терпим легально-тесные маршруты margin-лестницы (3px),
  // но узел, надвинувшийся на линию, инвалидирует).
  const GROW = 2;
  const grownBodiesOf = (g: EdgeGroup): NodeRect[] => [
    ...[...rects.entries()].filter(([id]) => id !== g.source && id !== g.target).map(([, r]) => r),
    ...framePlaques,
  ].map((r) => ({ x: r.x - GROW, y: r.y - GROW, w: r.w + 2 * GROW, h: r.h + 2 * GROW }));
  const prevValidOf = (g: EdgeGroup, pp: PortPair): EdgePoint[] | undefined => {
    const pr = prev?.routes.get(g.id);
    if (!pr || pr.length < 2) return undefined;
    if (!near(pr[0], pp.s.point) || !near(pr[pr.length - 1], pp.t.point)) return undefined;
    if (pathCrossesRects(pr, grownBodiesOf(g))) return undefined;
    return pr.map((p) => ({ x: p.x, y: p.y }));
  };

  const terminals: EdgeTerminal[] = [];
  // Нероутируемые связи без Z: prev удерживается (концы на портах) либо пересаживается на
  // уехавшие порты (R9); не вышло — связь идёт в A* вместе с роутируемыми.
  const needRoute = new Set<string>();
  for (const g of groups) {
    const pp = ports.get(g.id);
    if (!pp || z.routes.has(g.id)) continue;
    if (routableIds.has(g.id)) { needRoute.add(g.id); continue; }
    const pr = prev?.routes.get(g.id);
    const kept = prevValidOf(g, pp) ?? (pr && pr.length >= 2 ? reseatRoute(pr, pp, grownBodiesOf(g)) : null);
    if (kept) { routes.set(g.id, kept); fixedIds.add(g.id); }
    else if (pr && pr.length >= 2) needRoute.add(g.id);
    // prev нет вовсе (связь появилась вне скоупа) — конвейер проложит её своим скоупом
  }
  for (const g of groups) {
    if (!needRoute.has(g.id)) continue;
    const pp = ports.get(g.id);
    if (!pp) continue;
    const foreignRects = foreignRectsOf(g);
    // чужие плашки подписей (T4) — штраф за переход границы; своя не отталкивает.
    // Рамок 0–5 — их перебираем линейно; плашек вся сцена — их считает общий индекс
    // граней (А1). Индекс не нужен, когда чужих плашек нет (сцена из одной плашки).
    const ownGid = g.id;
    const foreignLabelCount = labelObstacles
      ? labelObstacles.size - (labelObstacles.has(ownGid) ? 1 : 0)
      : 0;
    const labelIdx = foreignLabelCount > 0 ? labelFaces : null;
    const extraMoveCost =
      foreignRects.length > 0 || foreignLabelCount > 0
        ? (x1: number, y1: number, x2: number, y2: number): number => {
            let n = 0;
            for (const r of foreignRects) n += borderCrossings(x1, y1, x2, y2, r) * FRAME_CROSS_COST;
            if (labelIdx) n += countLabelCrossings(labelIdx, ownGid, x1, y1, x2, y2) * LABEL_CROSS_COST;
            return n;
          }
        : undefined;
    terminals.push({
      id: g.id,
      start: pp.s.point, end: pp.t.point,
      // по одному направленному порту на конец: сторона и точка выбраны заранее
      startPorts: [{ point: pp.s.point, side: pp.s.side }],
      endPorts: [{ point: pp.t.point, side: pp.t.side }],
      // тела узлов + плашки подписей раскрытых рамок — жёсткие препятствия
      obstacles: obstacleBodies,
      extraMoveCost,
      prev: prevValidOf(g, pp),
    });
    routedIds.add(g.id);
  }

  // Предпроложенный контекст A*: Z-маршруты и удержанные/пересаженные prev — их линии
  // видны в штрафах пересечений/наложений с первого же ребра.
  const preplaced: EdgePoint[][] = [];
  for (const [, pts] of routes) preplaced.push(pts.map((p) => ({ x: p.x, y: p.y })));
  // Грид-подсказки: свободные дорожки каналов у стопок Z (связь без Z встаёт в соседнюю
  // дорожку, а не на пиксельный отступ) + г1 (порты всех рёбер сцены, выключен).
  const xs: number[] = [...z.gridHints.xs], ys: number[] = [...z.gridHints.ys];
  if (gridHintGroups && gridHintGroups.length > 0) {
    for (const g of gridHintGroups) {
      if (needRoute.has(g.id)) continue; // свои порты уже в решётке набора
      const pp = ports.get(g.id);
      if (!pp) continue;
      xs.push(pp.s.point.x, pp.t.point.x);
      ys.push(pp.s.point.y, pp.t.point.y);
    }
  }
  const gridHints = xs.length > 0 || ys.length > 0 ? { xs, ys } : undefined;
  const routeOpts = preplaced.length > 0 || gridHints || budget
    ? {
      ...(preplaced.length > 0 ? { preplaced } : {}),
      ...(gridHints ? { gridHints } : {}),
      ...(budget ? { budget } : {}),
    }
    : undefined;
  const raw = terminals.length > 0 ? routeAll(terminals, routeOpts) : new Map<string, EdgePoint[]>();
  for (const [id, route] of raw) {
    if (route.length >= 2) routes.set(id, route.map((p) => ({ x: p.x, y: p.y })));
  }
  const handles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  for (const g of groups) {
    const pp = ports.get(g.id);
    if (!pp || !routes.has(g.id)) continue;
    // выбранную сторону отдаём хэндлом её центра: RF нужен существующий хэндл, концы
    // линии рендер берёт из маршрута
    handles.set(g.id, {
      sourceHandle: hid(g.source, pp.s.side, 1),
      targetHandle: hid(g.target, pp.t.side, 1),
    });
  }
  const labelAnchors = new Map<string, EdgePoint>();
  for (const [id, pt] of z.labelAnchors) if (routes.has(id)) labelAnchors.set(id, pt);
  return { routes, handles, fixedIds, routedIds, labelAnchors };
}

// ПЕРЕСАД prev-МАРШРУТА НА УЕХАВШИЕ ПОРТЫ (R9, E90). Равный шаг связывает все связи
// стороны: после правки соседа порт незатронутой связи сдвигается вдоль стороны, и её
// prev-маршрут повис бы концом мимо порта. Пересад двигает крайнюю точку в новый порт
// вместе со стабом (стаб вдоль нормали стороны переезжает поперёк), а второй сегмент
// укорачивается/удлиняется, не меняя направления. Условия: стаб действительно идёт вдоль
// нормали, порт сдвинулся только ВДОЛЬ стороны (не на другую сторону), второй сегмент не
// переламывается и не вырождается, ломаная не режет чужих тел. Иначе null — честный A*.
export function reseatRoute(prev: EdgePoint[], pp: PortPair, grownBodies: NodeRect[]): EdgePoint[] | null {
  const r = cleanup(prev.map((p) => ({ x: p.x, y: p.y })));
  if (r.length < 2) return null;
  const vertical = (side: EdgeSide): boolean => side === "top" || side === "bottom";
  // пересадить конец idx (0 или last) на порт pt; стаб — сегмент к соседу nb
  const seat = (idx: number, nb: number, next: number, pt: EdgePoint, side: EdgeSide): boolean => {
    if (near(r[idx], pt)) return true;
    if (r.length < 3) return false;                 // прямая: сдвиг конца дал бы диагональ
    const a = r[idx], b = r[nb], c = r[next];
    if (vertical(side)) {
      if (Math.abs(a.y - pt.y) > EPS || Math.abs(b.x - a.x) > EPS) return false; // не вдоль стороны / стаб не по нормали
      const dirBefore = Math.sign(c.x - b.x);
      const dirAfter = Math.sign(c.x - pt.x);
      if (dirBefore === 0 || dirAfter !== dirBefore || Math.abs(c.x - pt.x) <= EPS) return false;
      r[idx] = { x: pt.x, y: pt.y };
      r[nb] = { x: pt.x, y: b.y };
    } else {
      if (Math.abs(a.x - pt.x) > EPS || Math.abs(b.y - a.y) > EPS) return false;
      const dirBefore = Math.sign(c.y - b.y);
      const dirAfter = Math.sign(c.y - pt.y);
      if (dirBefore === 0 || dirAfter !== dirBefore || Math.abs(c.y - pt.y) <= EPS) return false;
      r[idx] = { x: pt.x, y: pt.y };
      r[nb] = { x: b.x, y: pt.y };
    }
    return true;
  };
  const last = r.length - 1;
  if (!seat(0, 1, 2, pp.s.point, pp.s.side)) return null;
  if (!seat(last, last - 1, last - 2, pp.t.point, pp.t.side)) return null;
  const out = cleanup(r);
  if (out.length < 2 || pathCrossesRects(out, grownBodies)) return null;
  return out;
}
