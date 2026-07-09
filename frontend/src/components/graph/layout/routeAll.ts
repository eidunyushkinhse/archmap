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
import { cleanup, segments, type NodeRect, type Segment } from "../edgePath";
import { routePorts, type PortCandidate, type RouteOptions } from "./orthoRoute";

const EPS = 0.5;
const DEFAULT_CROSS_COST = 200; // px-эквивалент штрафа за одно пересечение (R3 > R1)

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
}

export interface RouteAllOptions {
  margin?: number;
  bendPenalty?: number;
  crossCost?: number; // штраф за каждое пересечение с уже проложенной стрелкой
  // Доп. стоимость хода (V2.4): вызывающий кодирует сюда штрафы среды — например,
  // пересечение ГРАНИЦЫ раскрытой рамки (container-aware обходы). Композируется со
  // штрафом за пересечения стрелок. Только положительная (допустимость эвристики A*).
  extraMoveCost?: (x1: number, y1: number, x2: number, y2: number) => number;
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
function crossingCount(x1: number, y1: number, x2: number, y2: number, segs: Segment[]): number {
  const moveHoriz = Math.abs(y1 - y2) <= EPS;
  const mConst = moveHoriz ? y1 : x1;             // постоянная координата хода
  const mStart = moveHoriz ? x1 : y1;             // варьируемая в начале хода
  const mEnd = moveHoriz ? x2 : y2;               // варьируемая в конце хода
  const mLo = Math.min(mStart, mEnd), mHi = Math.max(mStart, mEnd);
  const pts = new Set<number>();
  for (const s of segs) {
    const segHoriz = s.orient === "h";
    if (segHoriz === moveHoriz) continue;         // параллельны — не крестик
    const pConst = segHoriz ? s.y1 : s.x1;        // постоянная координата чужого сегмента
    const pLo = Math.min(segHoriz ? s.x1 : s.y1, segHoriz ? s.x2 : s.y2);
    const pHi = Math.max(segHoriz ? s.x1 : s.y1, segHoriz ? s.x2 : s.y2);
    // точка пересечения: вдоль чужого сегмента = mConst, вдоль хода = pConst
    if (!(pLo + EPS < mConst && mConst < pHi - EPS)) continue; // строго внутри чужого
    if (pConst < mLo - EPS || pConst > mHi + EPS) continue;    // вне протяжённости хода
    if (Math.abs(pConst - mStart) <= EPS) continue;           // начало хода — посчитает прошлый ход
    pts.add(Math.round(pConst * 2)); // позиция точки вдоль хода (mConst у всех одна)
  }
  return pts.size;
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
  const placed = new Map<string, EdgePoint[]>();
  const placedSegs: Segment[] = []; // сегменты всех уже проложенных рёбер
  for (const e of routingOrder(edges)) {
    const extra = e.extraMoveCost ?? opts?.extraMoveCost;
    const wantCross = crossCost > 0 && placedSegs.length > 0;
    const moveCost =
      wantCross || extra
        ? (x1: number, y1: number, x2: number, y2: number): number =>
            (wantCross ? crossCost * crossingCount(x1, y1, x2, y2, placedSegs) : 0) +
            (extra ? extra(x1, y1, x2, y2) : 0)
        : undefined;
    const [starts, ends] = portsOf(e);
    const r = routePorts(starts, ends, e.obstacles, { ...baseOpts, moveCost });
    // Пути нет даже с margin=0 (порт заперт) — прямой отрезок-fallback, как раньше.
    const route = r?.pts ?? cleanup([{ ...e.start }, { ...e.end }]);
    placed.set(e.id, route);
    for (const s of segments(route)) placedSegs.push(s);
  }
  return placed;
}
