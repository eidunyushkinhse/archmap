// Глобальная маршрутизация НАБОРА стрелок с минимизацией пересечений (эпик стрелок, фаза
// A3a — R3). Чистая функция: прокладывает рёбра по очереди через routeOrthogonal, но каждое
// следующее ребро платит ШТРАФ за каждый «крестик» с уже проложенными — A* предпочитает
// маршрут с меньшим числом пересечений (R3) при равной прочей цене (R1-длина — целевая
// функция, обход узлов — жёсткий). Это «sequential routing with crossing penalty» (упрощение
// глобального nudging из libavoid): хватает для нашего масштаба десятков рёбер на уровне.
//
// Порядок прокладки детерминирован (длинные рёбра первыми: им дороже объезжать, пусть берут
// чистый маршрут, короткие виляют вокруг), поэтому результат НЕ зависит от порядка входа.
// Расталкивание случайно-параллельных плеч разных стрелок — отдельная фаза A3b (vpsc).
//
// СВОЯ ЛИНИЯ У КАЖДОЙ СВЯЗИ (Ф2 эпика «стрелки без жёстких хэндлов», docs/plan-arrows-
// ports.md): с портом на связь (ports.ts) общих точек стыковки нет по построению, поэтому
// общих плеч («стволов» вееров из одного хэндла) тоже нет — любая коллинеарная езда по
// чужому сегменту платит OVERLAP_COST без льгот. Стволовой контекст оценки (E25 v2), сварка
// (E78/E79) и портовый штраф парковки в чужой порт сняты вместе с их причиной.
import type { EdgePoint } from "../../../types";
import { cleanup, pathCrossesRects, segments, type NodeRect, type Segment } from "../edgePath";
import { routePorts, __routeCounters, type PortCandidate, type RouteGridCache, type RouteOptions } from "./orthoRoute";
import type { RouteBudget } from "./routeBudget";

const EPS = 0.5;
export const DEFAULT_CROSS_COST = 200; // px-эквивалент штрафа за одно пересечение (R3 > R1)
// Штраф за КОЛЛИНЕАРНУЮ езду по чужому сегменту (shared-path penalty, канон libavoid),
// за каждый px перекрытия. Без него езда по чужой линии БЕСПЛАТНА (и «крестиков» нет) —
// A* сознательно седлал чужие маршруты: складки-заезды, сотни px слитых линий и парковка
// в чужой хэндл. Короткие совпадения почти не штрафуются, длинная езда — дороже пересечения.
export const OVERLAP_COST = 1;
// ГИСТЕРЕЗИС МАРШРУТОВ (2026-07-09): валидный маршрут прошлого прогона сохраняется,
// если он не хуже свежего A* больше, чем на этот порог. Без гистерезиса любой чих
// (сдвиг постороннего узла двигал грид-линии/инварианты толкали соседей на пиксели)
// перекладывал стрелки, которых никто не трогал. Порог ДОЛЖЕН быть меньше цены
// пересечения (200) и перехода рамки (150): реальную деградацию (новый крест, разрез
// рамки) гистерезис не маскирует; поглощает ничьи, лишний излом и микро-удлинения.
export const ROUTE_STICKINESS = 100;

// Терминал ребра для глобального роутера: концы (порты) и СВОИ препятствия — тела
// ВСЕХ узлов, включая узлы-концы этого ребра (V2.2: порты-стабы лежат снаружи тел,
// поэтому собственное тело — обычное препятствие; см. шапку orthoRoute.ts).
export interface EdgeTerminal {
  id: string;
  // Основные концы: порядок прокладки и fallback, когда порты не заданы или путь не найден.
  start: EdgePoint;
  end: EdgePoint;
  obstacles: NodeRect[];
  // Порты-кандидаты источника/цели (V2.2): ОДИН multi-source/multi-target A* сразу со
  // всеми разрешёнными портами. С портом на связь (Ф1) вызывающий даёт по одному
  // направленному порту на конец — сторона и точка выбраны заранее; интерфейс остаётся
  // множественным ради полигонов и тестов. Порт со стороной даёт направленную видимость
  // (стаб по построению, V2.1). Не задано — единственный порт start/end без стороны.
  startPorts?: PortCandidate[];
  endPorts?: PortCandidate[];
  // ПЕР-РЁБЕРНЫЙ доп. штраф хода (V2.4): у каждого ребра своя среда — например, границы
  // ЧУЖИХ рамок штрафуются, а рамки со своим концом бесплатны (переход туда неизбежен).
  // Приоритетнее общего opts.extraMoveCost.
  extraMoveCost?: (x1: number, y1: number, x2: number, y2: number) => number;
  // ВАЛИДИРОВАННЫЙ маршрут прошлого прогона (гистерезис): вызывающий уже проверил, что
  // концы сидят на текущих портах и тела/плашки не режутся. Сохраняется, если его
  // полная стоимость (длина + изломы + пересечения с уже проложенными + extraMoveCost)
  // не хуже свежей больше, чем на ROUTE_STICKINESS.
  prev?: EdgePoint[];
}

export interface RouteAllOptions {
  margin?: number;
  bendPenalty?: number;
  crossCost?: number; // штраф за каждое пересечение с уже проложенной стрелкой
  // Доп. стоимость хода (V2.4): вызывающий кодирует сюда штрафы среды — например,
  // пересечение ГРАНИЦЫ раскрытой рамки (container-aware обходы). Композируется со
  // штрафом за пересечения стрелок. Только положительная (допустимость эвристики A*).
  extraMoveCost?: (x1: number, y1: number, x2: number, y2: number) => number;
  // ПРЕДПРОЛОЖЕННЫЕ маршруты вне набора (живой драг: рёбра, которых жест не касается) —
  // контекст пересечений/наложений с первого же ребра. Без него scoped-вызов слеп к
  // чужим линиям: живой маршрут седлал их и расходился с финалом.
  preplaced?: EdgePoint[][];
  // ЭКСПЕРИМЕНТ г1 (эпик «глубокая оптимизация роутера», Ф4-II): ДОБАВОЧНЫЕ грид-подсказки
  // сверх портов набора. Скоупенный вызов (T4-мини-проход, драг) роутит подмножество, и
  // общая решётка беднее, чем у полного прохода: свернуть в объезд можно только на линии
  // портов СВОИХ рёбер. Сюда вызывающий кладёт координаты портов ВСЕХ рёбер сцены.
  // Пусто/не задано — поведение прежнее байт-в-байт.
  gridHints?: { xs: number[]; ys: number[] };
  // БЮДЖЕТ РАБОТ (Ф5 эпика router-opt, спека perf.md P12/P13). Ездит ПАРАМЕТРОМ, не
  // синглтоном. Даёт две вещи: потолок экспансий одного A* (в опции routePorts) и
  // РЕШЕНИЕ ступени «пропустить rip-up» на её естественной границе — перед фикспойнтом.
  // Не задан — бюджета нет, поведение прежнее байт-в-байт (полигоны, драг, тесты).
  budget?: RouteBudget;
}

// Сколько РАЗЛИЧНЫХ ТОЧЕК уже проложенных стрелок пересёк бы ход (x1,y1)→(x2,y2)
// «крестиком» — перпендикулярно и строго внутри чужого сегмента. Ход всегда осевой.
//
// Тонкость решётки: общая координатная сетка ставит вершину РОВНО на линии любой чужой
// стрелки, поэтому пересечение приходится на вершину = на стык двух ходов. Чтобы сквозной
// проход через такую вершину засчитался РОВНО один раз (а не ноль, как при строго-середин-
// ном тесте, и не два), считаем пересечение по точке на ходе с правилом «конец включаем,
// начало исключаем»: его засчитает тот ход, который в эту вершину ВХОДИТ. Касание концом
// чужого сегмента (строго-внутри по чужому не выполняется) тоже не штраф.
//
// ДЕДУПЛИКАЦИЯ ПО ТОЧКЕ (2026-07-09): несколько чужих сегментов на одной линии — это одна
// точка пересечения и одна дуга-мостик (edgeJumps решает по точке), поэтому и штраф один.
// Сегмент уже проложенного маршрута. Экспорт — для юнит-тестов straightenJogs.
export interface PlacedSeg {
  seg: Segment;
}

function pushPlaced(list: PlacedSeg[], route: EdgePoint[]): void {
  if (route.length < 2) return;
  for (const seg of segments(route)) list.push({ seg });
}

// Публичный конструктор PlacedSeg[] из ломаной — для внешних вызовов straightenJogs
// (пост-нуджинг-полировка в pipeline).
export function toPlacedSegs(route: EdgePoint[]): PlacedSeg[] {
  const list: PlacedSeg[] = [];
  pushPlaced(list, route);
  return list;
}

// ИНДЕКС проложенных сегментов (оптимизация 2026-07: movePenalty — самый горячий цикл
// конвейера, он вызывается на КАЖДЫЙ шаг A* каждого ребра). Вместо скана всех сегментов
// набора сегменты разложены по ориентации и отсортированы по постоянной координате:
// кандидаты на езду (та же линия) и на крест (линия внутри протяжённости хода) достаются
// двоичным поиском диапазона. Математика штрафа не меняется — только отсев кандидатов.
interface IndexedSeg {
  c: number;      // постоянная координата сегмента (y у горизонтального, x у вертикального)
  lo: number;     // протяжённость вдоль своей оси
  hi: number;
  ps: PlacedSeg;
}
export interface PlacedIndex {
  h: IndexedSeg[]; // горизонтальные, отсортированы по c
  v: IndexedSeg[]; // вертикальные, отсортированы по c
  count: number;
}

const byC = (a: IndexedSeg, b: IndexedSeg): number => a.c - b.c;

export function buildPlacedIndex(placed: PlacedSeg[]): PlacedIndex {
  const h: IndexedSeg[] = [];
  const v: IndexedSeg[] = [];
  for (const ps of placed) {
    const s = ps.seg;
    if (s.orient === "h") {
      h.push({ c: s.y1, lo: Math.min(s.x1, s.x2), hi: Math.max(s.x1, s.x2), ps });
    } else {
      v.push({ c: s.x1, lo: Math.min(s.y1, s.y2), hi: Math.max(s.y1, s.y2), ps });
    }
  }
  h.sort(byC);
  v.sort(byC);
  return { h, v, count: placed.length };
}

// Первый индекс с c >= val (нижняя граница диапазона кандидатов).
function lowerBound(arr: IndexedSeg[], val: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].c < val) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function movePenalty(
  x1: number, y1: number, x2: number, y2: number,
  placed: PlacedIndex, crossCost: number,
): number {
  const moveHoriz = Math.abs(y1 - y2) <= EPS;
  const mConst = moveHoriz ? y1 : x1;             // постоянная координата хода
  const mStart = moveHoriz ? x1 : y1;             // варьируемая в начале хода
  const mEnd = moveHoriz ? x2 : y2;               // варьируемая в конце хода
  const mLo = Math.min(mStart, mEnd), mHi = Math.max(mStart, mEnd);

  // ЕЗДА: параллельные сегменты на ОДНОЙ линии (|c - mConst| <= EPS) → перекрытие проекций
  let overlap = 0; // суммарная длина коллинеарной езды хода по чужим сегментам
  const par = moveHoriz ? placed.h : placed.v;
  for (let k = lowerBound(par, mConst - EPS); k < par.length && par[k].c <= mConst + EPS; k++) {
    const e = par[k];
    const lo = Math.max(mLo, e.lo), hi = Math.min(mHi, e.hi);
    if (hi - lo <= EPS) continue;
    overlap += hi - lo;
  }

  // КРЕСТЫ: перпендикулярные сегменты, чья линия (c) лежит в протяжённости хода.
  // Кандидаты идут по возрастанию c → дедуп различных точек пересечения (см. шапку) —
  // сравнением соседних округлённых ключей, без Set.
  let crosses = 0;
  let lastKey = NaN;
  const perp = moveHoriz ? placed.v : placed.h;
  for (let k = lowerBound(perp, mLo - EPS); k < perp.length && perp[k].c <= mHi + EPS; k++) {
    const e = perp[k];
    // точка пересечения: вдоль чужого сегмента = mConst, вдоль хода = c
    if (!(e.lo + EPS < mConst && mConst < e.hi - EPS)) continue; // строго внутри чужого
    if (Math.abs(e.c - mStart) <= EPS) continue;                 // начало хода — посчитает прошлый ход
    const key = Math.round(e.c * 2); // позиция точки вдоль хода (mConst у всех одна)
    if (key === lastKey) continue;
    lastKey = key;
    crosses++;
  }
  return crossCost * crosses + OVERLAP_COST * overlap;
}

// Чистый штраф ГОТОВОЙ ломаной (пересечения+наложения с чужими сегментами), без длины и
// изломов. 0 — маршрут «чистый»: второй проход его не трогает.
function pathPenalty(pts: EdgePoint[], placed: PlacedIndex, crossCost: number): number {
  if (placed.count === 0) return 0;
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len > EPS) n += movePenalty(a.x, a.y, b.x, b.y, placed, crossCost);
  }
  return n;
}

// Джог короче этого порога — кандидат на спрямление (перескок «дрожи», не структура).
export const JOG_MAX = 24;
// Клиренс пост-спрямления: кандидат не должен ПРИЖИМАТЬ линию к чужому телу (A* держит
// зазор раздутыми препятствиями — пост-проход обязан его уважать, иначе «стрелка по грани
// узла» возвращается). Меньше маршрутного margin=12: легально-тесные проходы (лестница
// 12→6→3) не блокируют спрямление там, где ТЕКУЩИЙ маршрут уже тесный.
export const JOG_CLEAR = 8;
// Минимальный канал между ПАРАЛЛЕЛЬНЫМИ линиями (E29) — им же меряется «прижатость»
// кандидата спрямления к чужому плечу (см. lineProximity в straightenJogs). Объявлена
// на модульном уровне (Ф2 эпика router-opt): константа геометрии входит в реестр
// ROUTER_VERSION — сторож протухания кэша маршрутов вида.
export const LINE_CLEAR = 8;

/**
 * ПОСТ-СПРЯМЛЕНИЕ ДЖОГОВ (T3 эпика «читаемые пучки», канон path simplification).
 * Джог — короткий (≤ JOG_MAX) перпендикулярный перескок между двумя СОНАПРАВЛЕННЫМИ
 * сегментами: A→B, B→C (перескок), C→D. A*-решётка и инкрементальные штрафы плодят
 * такие «ступеньки» там, где взгляд ждёт прямую. Спрямляем переносом перескока в
 * соседний излом (вперёд к D либо назад к A) — длина маршрута НЕ меняется, изломов
 * на 2 меньше; вариант принимается, только если не режет тела и полная стоимость
 * (длина+изломы+кресты+езда+рамки) строго меньше — джог, который уворачивался от
 * реальной езды/креста, остаётся. Концы (порты) не двигаются. Чистая функция.
 */
export function straightenJogs(
  pts: EdgePoint[],
  obstacles: NodeRect[],
  others: PlacedSeg[],
  crossCost: number,
  bendPenalty: number,
  extra?: (x1: number, y1: number, x2: number, y2: number) => number,
): EdgePoint[] {
  let cur = cleanup(pts.map((p) => ({ x: p.x, y: p.y })));
  const othersIdx = buildPlacedIndex(others); // чужие фиксированы на весь вызов
  const evalCost = (p: EdgePoint[]): number => routeCost(p, othersIdx, crossCost, bendPenalty, extra);
  // тела, раздутые на клиренс: кандидат, влезающий в раздутое тело, к которому текущий
  // маршрут НЕ прижат, отвергается (не приклеивать линию к грани узла)
  const inflated = obstacles.map((r) => ({
    x: r.x - JOG_CLEAR, y: r.y - JOG_CLEAR, w: r.w + 2 * JOG_CLEAR, h: r.h + 2 * JOG_CLEAR,
  }));
  // ПРИЖАТОСТЬ К ЧУЖИМ ЛИНИЯМ (E34, фикс 2026-07-17 — найден гейтом Ф2): кандидат не
  // ложится ближе минимального канала (LINE_CLEAR = 8, E29) к чужому ПАРАЛЛЕЛЬНОМУ
  // сегменту с совместным пробегом, к которому текущий маршрут не прижат. Оценщик езды
  // видит наложение только при |Δ| ≤ EPS — схлоп джога в 1px-щель от чужой линии был
  // «бесплатен» (−2 излома → принят), а нуджинг после полировки уже не бежит: линии
  // визуально сливались (спор полировки с канальной разводкой). Точное слияние
  // (|Δ| ≤ EPS) — не сюда: его судит езда.
  const lineProximity = (p: EdgePoint[]): Set<IndexedSeg> => {
    const out = new Set<IndexedSeg>();
    for (let k = 1; k < p.length; k++) {
      const a = p[k - 1], b = p[k];
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (len <= EPS) continue;
      const horiz = Math.abs(b.y - a.y) <= Math.abs(b.x - a.x);
      const c = horiz ? a.y : a.x;
      const lo = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
      const hi = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
      const par = horiz ? othersIdx.h : othersIdx.v;
      for (let m = lowerBound(par, c - LINE_CLEAR); m < par.length && par[m].c <= c + LINE_CLEAR; m++) {
        const e = par[m];
        const d = Math.abs(e.c - c);
        if (d <= EPS || d >= LINE_CLEAR) continue;
        if (Math.min(hi, e.hi) - Math.max(lo, e.lo) <= 3) continue; // касание — не пробег
        out.add(e);
      }
    }
    return out;
  };
  let guard = 8; // страховка от зацикливания (каждый прогон убирает ≥1 джог)
  while (guard-- > 0) {
    let applied = false;
    const n = cur.length;
    // прижатости и стоимость ТЕКУЩЕГО маршрута фиксированы, пока он не заменён, —
    // считаем на итерацию while один раз (лениво: только если нашёлся джог-кандидат)
    let curHugs: boolean[] | null = null;
    let curProx: Set<IndexedSeg> | null = null;
    let curCost = NaN;
    for (let i = 0; i + 3 < n && !applied; i++) {
      const A = cur[i], B = cur[i + 1], C = cur[i + 2], D = cur[i + 3];
      const abH = Math.abs(B.y - A.y) <= EPS, cdH = Math.abs(D.y - C.y) <= EPS;
      if (abH !== cdH) continue;                    // внешние сегменты не параллельны
      const jog = abH ? Math.abs(C.y - B.y) : Math.abs(C.x - B.x);
      if (jog < EPS || jog > JOG_MAX) continue;     // не перескок (или структурный)
      const dirAB = abH ? Math.sign(B.x - A.x) : Math.sign(B.y - A.y);
      const dirCD = abH ? Math.sign(D.x - C.x) : Math.sign(D.y - C.y);
      if (dirAB === 0 || dirAB !== dirCD) continue; // встречные — это U, не джог
      if (Number.isNaN(curCost)) curCost = evalCost(cur);
      const candidates: EdgePoint[][] = [];
      // вперёд: весь пролёт на линии AB, перескок уезжает в излом за D (D не конец)
      if (i + 4 < n) {
        const Q = abH ? { x: D.x, y: A.y } : { x: A.x, y: D.y };
        candidates.push(cleanup([...cur.slice(0, i + 1), Q, ...cur.slice(i + 4)]));
      }
      // назад: весь пролёт на линии CD, перескок уезжает в излом перед A (A не конец)
      if (i > 0) {
        const Q = abH ? { x: A.x, y: D.y } : { x: D.x, y: A.y };
        candidates.push(cleanup([...cur.slice(0, i), Q, ...cur.slice(i + 3)]));
      }
      let best: EdgePoint[] | null = null;
      let bestCost = curCost - 1; // строго лучше текущего
      for (const cand of candidates) {
        if (cand.length < 2 || pathCrossesRects(cand, obstacles)) continue;
        // клиренс: не прижимать к телу, к которому текущий маршрут не прижат
        if (!curHugs) curHugs = inflated.map((r) => pathCrossesRects(cur, [r]));
        let hugs = false;
        for (let r = 0; r < inflated.length && !hugs; r++) {
          if (!curHugs[r] && pathCrossesRects(cand, [inflated[r]])) hugs = true;
        }
        if (hugs) continue;
        // не прижиматься к чужой линии (щель уже минимального канала), к которой
        // текущий маршрут не прижат
        if (!curProx) curProx = lineProximity(cur);
        let sticks = false;
        for (const e of lineProximity(cand)) {
          if (!curProx.has(e)) { sticks = true; break; }
        }
        if (sticks) continue;
        const c = evalCost(cand);
        if (c < bestCost) { bestCost = c; best = cand; }
      }
      if (best) { cur = best; applied = true; }
    }
    if (!applied) break;
  }
  return cur;
}

// Полная стоимость ГОТОВОЙ ломаной в тех же единицах, что цена A*: длина + изломы +
// пересечения с уже проложенными + доп. штраф среды. Для честного сравнения свежего
// маршрута с прошлогодним обе ломаные оцениваются ЭТОЙ функцией (стабы включены в обе).
function routeCost(
  pts: EdgePoint[],
  placed: PlacedIndex,
  crossCost: number,
  bendPenalty: number,
  extra?: (x1: number, y1: number, x2: number, y2: number) => number,
): number {
  let cost = 0;
  let prevHoriz: boolean | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len > EPS) {
      const horiz = Math.abs(b.y - a.y) <= Math.abs(b.x - a.x);
      if (prevHoriz !== null && horiz !== prevHoriz) cost += bendPenalty;
      prevHoriz = horiz;
      cost += len;
      if (placed.count > 0) cost += movePenalty(a.x, a.y, b.x, b.y, placed, crossCost);
      if (extra) cost += extra(a.x, a.y, b.x, b.y);
    }
  }
  return cost;
}

// Детерминированный порядок прокладки: по убыванию манхэттенова размаха концов, тай-брейк
// по id. Длинные/«дорогие в объезде» рёбра берут чистый маршрут первыми.
function routingOrder(edges: EdgeTerminal[]): EdgeTerminal[] {
  const span = (e: EdgeTerminal): number =>
    Math.abs(e.end.x - e.start.x) + Math.abs(e.end.y - e.start.y);
  return [...edges].sort((a, b) => span(b) - span(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Прокладывает все рёбра, минимизируя взаимные пересечения. Порты-кандидаты (V2.2) идут
// в ОДИН multi-source/multi-target A* с полной стоимостью (длина + изломы + пересечения
// с уже проложенными). Возвращает id → ломаная.
export function routeAll(edges: EdgeTerminal[], opts?: RouteAllOptions): Map<string, EdgePoint[]> {
  const crossCost = opts?.crossCost ?? DEFAULT_CROSS_COST;
  // Общая координатная решётка набора: порты ВСЕХ рёбер — чтобы любому ребру было куда
  // свернуть в объезд чужой стрелки (иначе сетка ребра ограничена своими концами).
  const extraXs: number[] = [];
  const extraYs: number[] = [];
  const portsOf = (e: EdgeTerminal): [PortCandidate[], PortCandidate[]] => [
    e.startPorts ?? [{ point: e.start }],
    e.endPorts ?? [{ point: e.end }],
  ];
  for (const e of edges) {
    for (const ports of portsOf(e)) {
      for (const p of ports) { extraXs.push(p.point.x); extraYs.push(p.point.y); }
    }
  }
  // г1: подсказки сверх набора — ПОСЛЕ своих (порядок влияет только на eps-схлоп внутри
  // axisLines, а он сортирует; своих оставляем первыми ради стабильности прежних сцен).
  if (opts?.gridHints) {
    extraXs.push(...opts.gridHints.xs);
    extraYs.push(...opts.gridHints.ys);
  }
  // Кэш подготовленных сеток: pass 1 и итерации rip-up зовут routePorts для ОДНОГО
  // терминала (те же порты/препятствия/подсказки, меняется только moveCost) — сетка,
  // проходимость шагов и эвристика переиспользуются между попытками.
  const gridCache: RouteGridCache = new Map();
  const baseOpts: RouteOptions = {
    margin: opts?.margin, bendPenalty: opts?.bendPenalty, extraXs, extraYs, gridCache,
    // Потолок одного поиска: дефолт CALL_EXPANSION_CAP действует и без бюджета, а
    // априорный контур передаёт сюда ужесточённый (см. RouteBudget.callCap).
    expansionCap: opts?.budget?.callCap,
  };
  const bp = opts?.bendPenalty ?? 40;
  // контекст вне набора (живой драг) — участвует в штрафах с первого ребра
  const preplacedSegs: PlacedSeg[] = [];
  for (const p of opts?.preplaced ?? []) pushPlaced(preplacedSegs, p);

  const placed = new Map<string, EdgePoint[]>();
  const placedSegs: PlacedSeg[] = [...preplacedSegs]; // сегменты всех уже проложенных рёбер
  let placedIdx = buildPlacedIndex(placedSegs); // пересобирается после каждой прокладки
  const order = routingOrder(edges);
  for (const e of order) {
    const extra = e.extraMoveCost ?? opts?.extraMoveCost;
    const wantPenalty = placedSegs.length > 0;
    const idx = placedIdx; // снимок для замыкания (переменная будет перезаписана)
    const moveCost =
      wantPenalty || extra
        ? (x1: number, y1: number, x2: number, y2: number): number =>
            (wantPenalty ? movePenalty(x1, y1, x2, y2, idx, crossCost) : 0) +
            (extra ? extra(x1, y1, x2, y2) : 0)
        : undefined;
    const [starts, ends] = portsOf(e);
    const r = routePorts(starts, ends, e.obstacles, { ...baseOpts, moveCost, cacheKey: e.id });
    // Пути нет даже с margin=0 (порт заперт) — прямой отрезок-fallback, как раньше.
    let route = r?.pts ?? cleanup([{ ...e.start }, { ...e.end }]);
    // Гистерезис: прежний валидный маршрут не хуже свежего больше, чем на порог, —
    // держим прежний (стрелка не перекладывается от чужих микро-сдвигов и ничьих).
    // Обе ломаные оцениваются против уже проложенных + preplaced (сам e в placed ещё
    // не записан).
    if (e.prev && e.prev.length >= 2) {
      const cNew = routeCost(route, idx, crossCost, bp, extra);
      const cPrev = routeCost(e.prev, idx, crossCost, bp, extra);
      if (cPrev <= cNew + ROUTE_STICKINESS) route = e.prev.map((p) => ({ x: p.x, y: p.y }));
    }
    placed.set(e.id, route);
    pushPlaced(placedSegs, route);
    placedIdx = buildPlacedIndex(placedSegs);
  }

  // ВТОРОЙ ПРОХОД (rip-up & re-route, канон libavoid): первый проход последовательный —
  // ранние (длинные) рёбра прокладываются вслепую относительно ещё не проложенных, и
  // «жертва порядка» не может увернуться от пересечений/наложений, которых при её укладке
  // ещё не существовало. Теперь перепрокладываем каждое ребро в том же порядке против
  // ВСЕХ остальных финальных маршрутов; новый берём, только если он лучше текущего больше,
  // чем на ROUTE_STICKINESS (ничьи не перекладывают стрелку — стабильность). Чистые рёбра
  // (нет ни пересечений, ни наложений) пропускаем: экономия и нулевой чурн.
  const placedById = new Map<string, PlacedSeg[]>();
  for (const [id, r] of placed) {
    const list: PlacedSeg[] = [];
    pushPlaced(list, r);
    placedById.set(id, list);
  }
  const othersOf = (skipId: string): PlacedSeg[] => {
    const others: PlacedSeg[] = [...preplacedSegs];
    for (const [id, s] of placedById) if (id !== skipId) others.push(...s);
    return others;
  };
  // Версия окружения: растёт при каждой замене маршрута. Ребро перепрокладывается,
  // только если с его ПРОШЛОЙ попытки окружение изменилось: детерминированный A* при
  // тех же входах (чужие маршруты не менялись) вернул бы тот же результат — повторная
  // попытка была бы чистой тратой (легитимный крест держит pathPenalty > 0 вечно, и
  // без этого скипа такое ребро гонялось бы через A* в каждой итерации фикспойнта).
  let envVersion = 0;
  const lastTried = new Map<string, number>();
  const replace = (id: string, route: EdgePoint[]): void => {
    placed.set(id, route);
    const list: PlacedSeg[] = [];
    pushPlaced(list, route);
    placedById.set(id, list);
    envVersion++;
  };
  const ripUp = (): boolean => {
    let improved = false;
    for (const e of order) {
      const cur = placed.get(e.id);
      if (!cur) continue;
      if (lastTried.get(e.id) === envVersion) continue; // окружение прежнее — результат тот же
      const others = buildPlacedIndex(othersOf(e.id));
      if (pathPenalty(cur, others, crossCost) <= 0) continue; // чистое ребро — не трогаем
      const extra = e.extraMoveCost ?? opts?.extraMoveCost;
      const moveCost = (x1: number, y1: number, x2: number, y2: number): number =>
        movePenalty(x1, y1, x2, y2, others, crossCost) + (extra ? extra(x1, y1, x2, y2) : 0);
      const [starts, ends] = portsOf(e);
      const r2 = routePorts(starts, ends, e.obstacles, { ...baseOpts, moveCost, cacheKey: e.id });
      if (!r2?.pts || r2.pts.length < 2) { lastTried.set(e.id, envVersion); continue; }
      const cCur = routeCost(cur, others, crossCost, bp, extra);
      const cNew = routeCost(r2.pts, others, crossCost, bp, extra);
      if (cNew + ROUTE_STICKINESS < cCur) {
        replace(e.id, r2.pts);
        improved = true;
      }
      // фиксация ПОСЛЕ возможной замены: собственный бамп envVersion не считается
      // изменением окружения для самого ребра (его others не включают его же маршрут)
      lastTried.set(e.id, envVersion);
    }
    return improved;
  };
  // T6: rip-up итерируется до фикспойнта (перепрокладка одного ребра открывает ходы
  // другим), с жёсткой крышкой — на практике сходится за 1-2 итерации.
  // РАЗМЕТКА ФАЗ (Ф0 эпика глубокой оптимизации): дельты счётчиков вокруг фикспойнта —
  // по ним реплей отделяет rip-up от первичной прокладки прохода-1. Цена — два
  // int-вычитания на набор.
  const ripCallsBefore = __routeCounters.routePortsCalls;
  const ripExpBefore = __routeCounters.expansions;
  // СТУПЕНЬ ДЕГРАДАЦИИ «ПРОПУСК RIP-UP» (P13, ступень 2). Точка осуществимости — ровно
  // здесь: rip-up ещё не начинался, его пропуск оставляет набор в состоянии прохода-1,
  // которое ВАЛИДНО само по себе (все маршруты проложены, E18 не нарушен). Цена ступени —
  // «жертвы порядка» не чинятся: часть крестов и наложений, которые перепрокладка сняла
  // бы, остаётся. Это самая дорогая стадия набора (51–64% экспансий эталонов), поэтому
  // она уступает первой из двух.
  const skipRipup = opts?.budget?.takeRipup() ?? false;
  for (let iter = 0; !skipRipup && iter < 3; iter++) {
    if (!ripUp()) break;
  }
  __routeCounters.ripupCalls += __routeCounters.routePortsCalls - ripCallsBefore;
  __routeCounters.ripupExpansions += __routeCounters.expansions - ripExpBefore;
  // T3: пост-спрямление джогов по ФИНАЛЬНОМУ контексту (длина та же, изломов меньше;
  // джог, уворачивавшийся от реальной езды/креста, остаётся — решает полная стоимость).
  for (const e of order) {
    const cur = placed.get(e.id);
    if (!cur || cur.length < 4) continue;
    const extra = e.extraMoveCost ?? opts?.extraMoveCost;
    const str = straightenJogs(cur, e.obstacles, othersOf(e.id), crossCost, bp, extra);
    if (str.length !== cur.length) replace(e.id, str);
  }
  return placed;
}
