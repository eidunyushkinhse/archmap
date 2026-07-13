// Глобальная маршрутизация НАБОРА стрелок с минимизацией пересечений (эпик стрелок, фаза
// A3a — R3). Чистая функция: прокладывает рёбра по очереди через routeOrthogonal, но каждое
// следующее ребро платит ШТРАФ за каждый «крестик» с уже проложенными — A* предпочитает
// маршрут с меньшим числом пересечений (R3) при равной прочей цене (R1-длина — целевая
// функция, обход узлов — жёсткий). Это «sequential routing with crossing penalty» (упрощение
// глобального nudging из libavoid): хватает для нашего масштаба десятков рёбер на уровне.
//
// Порядок прокладки детерминирован (длинные рёбра первыми: им дороже объезжать, пусть берут
// чистый маршрут, короткие виляют вокруг), поэтому результат НЕ зависит от порядка входа.
// Расталкивание случайно-параллельных плеч разных стрелок — отдельная фаза A3b (vpsc); общие
// плечи родственных стрелок (из общего хэндла) остаются слитыми (R4=4a). См. ANALYSIS §4, §6.
import type { EdgePoint } from "../../../types";
import { cleanup, pathCrossesRects, segments, type NodeRect, type Segment } from "../edgePath";
import { routePorts, type PortCandidate, type RouteOptions } from "./orthoRoute";

const EPS = 0.5;
const DEFAULT_CROSS_COST = 200; // px-эквивалент штрафа за одно пересечение (R3 > R1)
// Штраф за КОЛЛИНЕАРНУЮ езду по чужому сегменту (shared-path penalty, канон libavoid),
// за каждый px перекрытия. Без него езда по чужой линии БЕСПЛАТНА (и «крестиков» нет) —
// A* сознательно седлал чужие маршруты: складки-заезды, сотни px слитых линий и парковка
// в чужой хэндл (нарушение Т4). Короткие совпадения (стыковка веера у общего дока ~10-25px)
// почти не штрафуются, длинная езда — дороже пересечения.
const OVERLAP_COST = 1;
// ГИСТЕРЕЗИС МАРШРУТОВ (2026-07-09): валидный маршрут прошлого прогона сохраняется,
// если он не хуже свежего A* больше, чем на этот порог. Без гистерезиса любой чих
// (сдвиг постороннего узла двигал грид-линии/инварианты толкали соседей на пиксели)
// перекладывал стрелки, которых никто не трогал. Порог ДОЛЖЕН быть меньше цены
// пересечения (200) и перехода рамки (150): реальную деградацию (новый крест, разрез
// рамки) гистерезис не маскирует; поглощает ничьи, лишний излом и микро-удлинения.
const ROUTE_STICKINESS = 100;

// Терминал ребра для глобального роутера: концы (на хэндлах) и СВОИ препятствия — тела
// чужих узлов БЕЗ узлов-концов этого ребра (инвариант routeOrthogonal).
export interface EdgeTerminal {
  id: string;
  // Основные концы: порядок прокладки и fallback, когда порты не заданы или путь не найден.
  start: EdgePoint;
  end: EdgePoint;
  obstacles: NodeRect[];
  // Порты-кандидаты источника/цели (V2.2, замена A8-пробы): ОДИН multi-source/multi-target
  // A* сразу со всеми разрешёнными портами — сторона выбирается ВНУТРИ поиска с реальными
  // штрафами (длина + изломы + пересечения), а не отдельной пробой по чистой геометрии.
  // Порт со стороной даёт направленную видимость (стаб по построению, V2.1). Не задано —
  // единственный порт start/end без стороны (старое поведение).
  startPorts?: PortCandidate[];
  endPorts?: PortCandidate[];
  // ПЕР-РЁБЕРНЫЙ доп. штраф хода (V2.4): у каждого ребра своя среда — например, границы
  // ЧУЖИХ рамок штрафуются, а рамки со своим концом бесплатны (переход туда неизбежен).
  // Приоритетнее общего opts.extraMoveCost.
  extraMoveCost?: (x1: number, y1: number, x2: number, y2: number) => number;
  // ВАЛИДИРОВАННЫЙ маршрут прошлого прогона (гистерезис): вызывающий уже проверил, что
  // концы сидят на текущих хэндлах и тела/плашки не режутся. Сохраняется, если его
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
}

// Сколько РАЗЛИЧНЫХ ТОЧЕК уже проложенных стрелок пересёк бы ход (x1,y1)→(x2,y2)
// «крестиком» — перпендикулярно и строго внутри чужого сегмента. Ход всегда осевой.
//
// Тонкость решётки: общая координатная сетка ставит вершину РОВНО на линии любой чужой
// стрелки, поэтому пересечение приходится на вершину = на стык двух ходов. Чтобы сквозной
// проход через такую вершину засчитался РОВНО один раз (а не ноль, как при строго-середин-
// ном тесте, и не два), считаем пересечение по точке на ходе с правилом «конец включаем,
// начало исключаем»: его засчитает тот ход, который в эту вершину ВХОДИТ. Общий старт-хэндл
// (вершина = начало первого хода) при этом не штрафуется. Касание концом чужого сегмента
// (строго-внутри по чужому не выполняется) тоже не штраф.
//
// ДЕДУПЛИКАЦИЯ ПО ТОЧКЕ (2026-07-09): совпадающие плечи пучка (стволы из одного хэндла,
// Т4) — это k сегментов на одной линии, и по-сегментный счёт брал за их пересечение k
// штрафов. «Стена стоимости» k·200 заставляла A* наматывать бессмысленные обходы (жалоба:
// ребро обёрнуто вокруг Zabbix Core, лишь бы не пересечь ствол трёх стрелок). Визуально
// же пересечение ствола — ОДНА дуга-мостик (edgeJumps решает по точке). Считаем различ-
// ные точки пересечения: совпадающие сегменты дают одну точку → один штраф.
// Сегмент уже проложенного маршрута + КОНЦЫ его ломаной (порты стыковки владельца):
// нужны исключению стволов — езда по чужому сегменту бесплатна, когда это общий порт
// той же роли (см. movePenalty). Экспорт — для юнит-тестов straightenJogs.
export interface PlacedSeg {
  seg: Segment;
  p0: EdgePoint; // первая точка маршрута-владельца (его source-порт)
  pN: EdgePoint; // последняя точка (его target-порт)
}

function pushPlaced(list: PlacedSeg[], route: EdgePoint[]): void {
  if (route.length < 2) return;
  const p0 = route[0], pN = route[route.length - 1];
  for (const seg of segments(route)) list.push({ seg, p0, pN });
}

// Порты текущего ребра для исключения стволов (роль важна: source против target).
interface OwnPorts {
  starts: EdgePoint[];
  ends: EdgePoint[];
}

const nearPt = (a: EdgePoint, bx: number, by: number): boolean =>
  Math.abs(a.x - bx) <= EPS && Math.abs(a.y - by) <= EPS;

function movePenalty(
  x1: number, y1: number, x2: number, y2: number,
  placed: PlacedSeg[], crossCost: number, own?: OwnPorts,
): number {
  const moveHoriz = Math.abs(y1 - y2) <= EPS;
  const mConst = moveHoriz ? y1 : x1;             // постоянная координата хода
  const mStart = moveHoriz ? x1 : y1;             // варьируемая в начале хода
  const mEnd = moveHoriz ? x2 : y2;               // варьируемая в конце хода
  const mLo = Math.min(mStart, mEnd), mHi = Math.max(mStart, mEnd);
  const pts = new Set<number>();
  let overlap = 0; // суммарная длина коллинеарной езды хода по чужим сегментам
  for (const ps of placed) {
    const s = ps.seg;
    const segHoriz = s.orient === "h";
    const pConst = segHoriz ? s.y1 : s.x1;        // постоянная координата чужого сегмента
    const pLo = Math.min(segHoriz ? s.x1 : s.y1, segHoriz ? s.x2 : s.y2);
    const pHi = Math.max(segHoriz ? s.x1 : s.y1, segHoriz ? s.x2 : s.y2);
    if (segHoriz === moveHoriz) {
      // параллельны: на ОДНОЙ линии → перекрытие проекций = езда по чужому сегменту
      if (Math.abs(pConst - mConst) > EPS) continue;
      const lo = Math.max(mLo, pLo), hi = Math.min(mHi, pHi);
      if (hi - lo <= EPS) continue;
      // ИСКЛЮЧЕНИЕ СТВОЛА (Т4: «один хэндл И одно направление» — легитимно): бесплатна езда
      // по КРАЙНЕМУ сегменту владельца (примыкает к его порту p0/pN), когда та же точка есть
      // среди НАШИХ портов той же роли (source↔source, target↔target) — это слитый веер из
      // общего дока. Разные роли (наш target = его source) НЕ исключаются: парковка входа в
      // чужой выход — то самое нарушение Т4. Сегменты владельца после его первого излома —
      // обычная чужая линия, штраф.
      if (own) {
        const segHasP0 = nearPt(ps.p0, s.x1, s.y1) || nearPt(ps.p0, s.x2, s.y2);
        if (segHasP0 && own.starts.some((p) => nearPt(p, ps.p0.x, ps.p0.y))) continue;
        const segHasPN = nearPt(ps.pN, s.x1, s.y1) || nearPt(ps.pN, s.x2, s.y2);
        if (segHasPN && own.ends.some((p) => nearPt(p, ps.pN.x, ps.pN.y))) continue;
      }
      overlap += hi - lo;
      continue;
    }
    // точка пересечения: вдоль чужого сегмента = mConst, вдоль хода = pConst
    if (!(pLo + EPS < mConst && mConst < pHi - EPS)) continue; // строго внутри чужого
    if (pConst < mLo - EPS || pConst > mHi + EPS) continue;    // вне протяжённости хода
    if (Math.abs(pConst - mStart) <= EPS) continue;           // начало хода — посчитает прошлый ход
    pts.add(Math.round(pConst * 2)); // позиция точки вдоль хода (mConst у всех одна)
  }
  return crossCost * pts.size + OVERLAP_COST * overlap;
}

// Чистый штраф ГОТОВОЙ ломаной (пересечения+наложения с чужими сегментами), без длины и
// изломов. 0 — маршрут «чистый»: второй проход его не трогает.
function pathPenalty(pts: EdgePoint[], placed: PlacedSeg[], crossCost: number, own?: OwnPorts): number {
  if (placed.length === 0) return 0;
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (Math.abs(b.x - a.x) + Math.abs(b.y - a.y) <= EPS) continue;
    n += movePenalty(a.x, a.y, b.x, b.y, placed, crossCost, own);
  }
  return n;
}

// Джог короче этого порога — кандидат на спрямление (перескок «дрожи», не структура).
const JOG_MAX = 24;
// Клиренс пост-спрямления: кандидат не должен ПРИЖИМАТЬ линию к чужому телу (A* держит
// зазор раздутыми препятствиями — пост-проход обязан его уважать, иначе «стрелка по грани
// узла» возвращается). Меньше маршрутного margin=12: легально-тесные проходы (лестница
// 12→6→3) не блокируют спрямление там, где ТЕКУЩИЙ маршрут уже тесный.
const JOG_CLEAR = 8;

/**
 * ПОСТ-СПРЯМЛЕНИЕ ДЖОГОВ (T3 эпика «читаемые пучки», канон path simplification).
 * Джог — короткий (≤ JOG_MAX) перпендикулярный перескок между двумя СОНАПРАВЛЕННЫМИ
 * сегментами: A→B, B→C (перескок), C→D. A*-решётка и инкрементальные штрафы плодят
 * такие «ступеньки» там, где взгляд ждёт прямую. Спрямляем переносом перескока в
 * соседний излом (вперёд к D либо назад к A) — длина маршрута НЕ меняется, изломов
 * на 2 меньше; вариант принимается, только если не режет тела и полная стоимость
 * (длина+изломы+кресты+езда+рамки) строго меньше — джог, который уворачивался от
 * реальной езды/креста, остаётся. Концы (доки) не двигаются. Чистая функция.
 */
export function straightenJogs(
  pts: EdgePoint[],
  obstacles: NodeRect[],
  others: PlacedSeg[],
  crossCost: number,
  bendPenalty: number,
  extra?: (x1: number, y1: number, x2: number, y2: number) => number,
  own?: OwnPorts,
): EdgePoint[] {
  let cur = cleanup(pts.map((p) => ({ x: p.x, y: p.y })));
  // тела, раздутые на клиренс: кандидат, влезающий в раздутое тело, к которому текущий
  // маршрут НЕ прижат, отвергается (не приклеивать линию к грани узла)
  const inflated = obstacles.map((r) => ({
    x: r.x - JOG_CLEAR, y: r.y - JOG_CLEAR, w: r.w + 2 * JOG_CLEAR, h: r.h + 2 * JOG_CLEAR,
  }));
  let guard = 8; // страховка от зацикливания (каждый прогон убирает ≥1 джог)
  while (guard-- > 0) {
    let applied = false;
    const n = cur.length;
    for (let i = 0; i + 3 < n && !applied; i++) {
      const A = cur[i], B = cur[i + 1], C = cur[i + 2], D = cur[i + 3];
      const abH = Math.abs(B.y - A.y) <= EPS, cdH = Math.abs(D.y - C.y) <= EPS;
      if (abH !== cdH) continue;                    // внешние сегменты не параллельны
      const jog = abH ? Math.abs(C.y - B.y) : Math.abs(C.x - B.x);
      if (jog < EPS || jog > JOG_MAX) continue;     // не перескок (или структурный)
      const dirAB = abH ? Math.sign(B.x - A.x) : Math.sign(B.y - A.y);
      const dirCD = abH ? Math.sign(D.x - C.x) : Math.sign(D.y - C.y);
      if (dirAB === 0 || dirAB !== dirCD) continue; // встречные — это U, не джог
      const curCost = routeCost(cur, others, crossCost, bendPenalty, extra, own);
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
        let hugs = false;
        for (let r = 0; r < inflated.length && !hugs; r++) {
          if (pathCrossesRects(cand, [inflated[r]]) && !pathCrossesRects(cur, [inflated[r]])) hugs = true;
        }
        if (hugs) continue;
        const c = routeCost(cand, others, crossCost, bendPenalty, extra, own);
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
  placedSegs: PlacedSeg[],
  crossCost: number,
  bendPenalty: number,
  extra?: (x1: number, y1: number, x2: number, y2: number) => number,
  own?: OwnPorts,
): number {
  let cost = 0;
  let prevHoriz: boolean | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len <= EPS) continue;
    const horiz = Math.abs(b.y - a.y) <= Math.abs(b.x - a.x);
    if (prevHoriz !== null && horiz !== prevHoriz) cost += bendPenalty;
    prevHoriz = horiz;
    cost += len;
    if (placedSegs.length > 0) cost += movePenalty(a.x, a.y, b.x, b.y, placedSegs, crossCost, own);
    if (extra) cost += extra(a.x, a.y, b.x, b.y);
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
// с уже проложенными): сторона стыковки — результат того же поиска, что и форма маршрута.
// Прежняя A8-проба «сторона по чистой геометрии, форма — со штрафами» давала расстыковку:
// проба выбирала сторону, финал по ней выкручивался огородами. Цена решения — сторона
// может смениться при правке соседних рёбер; санкция пользователя 2026-07-08 (читаемость
// Т0 важнее стабильности хэндлов). Возвращает id → ломаная.
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
  const baseOpts: RouteOptions = {
    margin: opts?.margin, bendPenalty: opts?.bendPenalty, extraXs, extraYs,
  };
  const bp = opts?.bendPenalty ?? 40;
  // порты ребра как точки (роль source/target раздельно) — для исключения стволов
  const ownPortsOf = (e: EdgeTerminal): OwnPorts => {
    const [starts, ends] = portsOf(e);
    return { starts: starts.map((p) => p.point), ends: ends.map((p) => p.point) };
  };
  // контекст вне набора (живой драг) — участвует в штрафах с первого ребра
  const preplacedSegs: PlacedSeg[] = [];
  for (const p of opts?.preplaced ?? []) pushPlaced(preplacedSegs, p);
  const placed = new Map<string, EdgePoint[]>();
  const placedSegs: PlacedSeg[] = [...preplacedSegs]; // сегменты всех уже проложенных рёбер
  const order = routingOrder(edges);
  for (const e of order) {
    const extra = e.extraMoveCost ?? opts?.extraMoveCost;
    const own = ownPortsOf(e);
    const wantPenalty = placedSegs.length > 0;
    const moveCost =
      wantPenalty || extra
        ? (x1: number, y1: number, x2: number, y2: number): number =>
            (wantPenalty ? movePenalty(x1, y1, x2, y2, placedSegs, crossCost, own) : 0) +
            (extra ? extra(x1, y1, x2, y2) : 0)
        : undefined;
    const [starts, ends] = portsOf(e);
    const r = routePorts(starts, ends, e.obstacles, { ...baseOpts, moveCost });
    // Пути нет даже с margin=0 (порт заперт) — прямой отрезок-fallback, как раньше.
    let route = r?.pts ?? cleanup([{ ...e.start }, { ...e.end }]);
    // Гистерезис: прежний валидный маршрут не хуже свежего больше, чем на порог, —
    // держим прежний (стрелка не перекладывается от чужих микро-сдвигов и ничьих).
    if (e.prev && e.prev.length >= 2) {
      const cNew = routeCost(route, placedSegs, crossCost, bp, extra, own);
      const cPrev = routeCost(e.prev, placedSegs, crossCost, bp, extra, own);
      if (cPrev <= cNew + ROUTE_STICKINESS) route = e.prev.map((p) => ({ x: p.x, y: p.y }));
    }
    placed.set(e.id, route);
    pushPlaced(placedSegs, route);
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
  const replace = (id: string, route: EdgePoint[]): void => {
    placed.set(id, route);
    const list: PlacedSeg[] = [];
    pushPlaced(list, route);
    placedById.set(id, list);
  };
  const ripUp = (): boolean => {
    let improved = false;
    for (const e of order) {
      const cur = placed.get(e.id);
      if (!cur) continue;
      const others = othersOf(e.id);
      const own = ownPortsOf(e);
      if (pathPenalty(cur, others, crossCost, own) <= 0) continue; // чистый — не трогаем
      const extra = e.extraMoveCost ?? opts?.extraMoveCost;
      const moveCost = (x1: number, y1: number, x2: number, y2: number): number =>
        movePenalty(x1, y1, x2, y2, others, crossCost, own) + (extra ? extra(x1, y1, x2, y2) : 0);
      const [starts, ends] = portsOf(e);
      const r2 = routePorts(starts, ends, e.obstacles, { ...baseOpts, moveCost });
      if (!r2?.pts || r2.pts.length < 2) continue;
      const cCur = routeCost(cur, others, crossCost, bp, extra, own);
      const cNew = routeCost(r2.pts, others, crossCost, bp, extra, own);
      if (cNew + ROUTE_STICKINESS < cCur) {
        replace(e.id, r2.pts);
        improved = true;
      }
    }
    return improved;
  };
  // T6: rip-up итерируется до фикспойнта (перепрокладка одного ребра открывает ходы
  // другим), с жёсткой крышкой — на практике сходится за 1-2 итерации.
  for (let iter = 0; iter < 3; iter++) {
    if (!ripUp()) break;
  }
  // T3: пост-спрямление джогов по ФИНАЛЬНОМУ контексту (длина та же, изломов меньше;
  // джог, уворачивавшийся от реальной езды/креста, остаётся — решает полная стоимость).
  for (const e of order) {
    const cur = placed.get(e.id);
    if (!cur || cur.length < 4) continue;
    const extra = e.extraMoveCost ?? opts?.extraMoveCost;
    const str = straightenJogs(
      cur, e.obstacles, othersOf(e.id), crossCost, bp, extra, ownPortsOf(e),
    );
    if (str.length !== cur.length) replace(e.id, str);
  }
  return placed;
}
