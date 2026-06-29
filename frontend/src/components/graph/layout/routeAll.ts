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
import { segments, type NodeRect, type Segment } from "../edgePath";
import { routeOrthogonal, type RouteOptions } from "./orthoRoute";

const EPS = 0.5;
const DEFAULT_CROSS_COST = 200; // px-эквивалент штрафа за одно пересечение (R3 > R1)

// Терминал ребра для глобального роутера: концы (на хэндлах) и СВОИ препятствия — тела
// чужих узлов БЕЗ узлов-концов этого ребра (инвариант routeOrthogonal).
export interface EdgeTerminal {
  id: string;
  start: EdgePoint;
  end: EdgePoint;
  obstacles: NodeRect[];
}

export interface RouteAllOptions {
  margin?: number;
  bendPenalty?: number;
  crossCost?: number; // штраф за каждое пересечение с уже проложенной стрелкой
}

// Сколько уже проложенных сегментов пересёк бы ход (x1,y1)→(x2,y2) «крестиком» —
// перпендикулярно и строго внутри чужого сегмента. Ход всегда осевой (по грид-сетке).
//
// Тонкость решётки: общая координатная сетка ставит вершину РОВНО на линии любой чужой
// стрелки, поэтому пересечение приходится на вершину = на стык двух ходов. Чтобы сквозной
// проход через такую вершину засчитался РОВНО один раз (а не ноль, как при строго-середин-
// ном тесте, и не два), считаем пересечение по точке на ходе с правилом «конец включаем,
// начало исключаем»: его засчитает тот ход, который в эту вершину ВХОДИТ. Общий старт-хэндл
// (вершина = начало первого хода) при этом не штрафуется. Касание концом чужого сегмента
// (строго-внутри по чужому не выполняется) тоже не штраф.
function crossingCount(x1: number, y1: number, x2: number, y2: number, segs: Segment[]): number {
  const moveHoriz = Math.abs(y1 - y2) <= EPS;
  const mConst = moveHoriz ? y1 : x1;             // постоянная координата хода
  const mStart = moveHoriz ? x1 : y1;             // варьируемая в начале хода
  const mEnd = moveHoriz ? x2 : y2;               // варьируемая в конце хода
  const mLo = Math.min(mStart, mEnd), mHi = Math.max(mStart, mEnd);
  let n = 0;
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
    n++;
  }
  return n;
}

// Детерминированный порядок прокладки: по убыванию манхэттенова размаха концов, тай-брейк
// по id. Длинные/«дорогие в объезде» рёбра берут чистый маршрут первыми.
function routingOrder(edges: EdgeTerminal[]): EdgeTerminal[] {
  const span = (e: EdgeTerminal): number =>
    Math.abs(e.end.x - e.start.x) + Math.abs(e.end.y - e.start.y);
  return [...edges].sort((a, b) => span(b) - span(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Прокладывает все рёбра, минимизируя взаимные пересечения. Возвращает id → ломаная.
export function routeAll(edges: EdgeTerminal[], opts?: RouteAllOptions): Map<string, EdgePoint[]> {
  const crossCost = opts?.crossCost ?? DEFAULT_CROSS_COST;
  // Общая координатная решётка набора: концы всех рёбер — чтобы любому ребру было куда
  // свернуть в объезд чужой стрелки (иначе сетка ребра ограничена его собственными концами).
  const extraXs: number[] = [];
  const extraYs: number[] = [];
  for (const e of edges) {
    extraXs.push(e.start.x, e.end.x);
    extraYs.push(e.start.y, e.end.y);
  }
  const baseOpts: RouteOptions = {
    margin: opts?.margin, bendPenalty: opts?.bendPenalty, extraXs, extraYs,
  };
  const placed = new Map<string, EdgePoint[]>();
  const placedSegs: Segment[] = []; // сегменты всех уже проложенных рёбер
  for (const e of routingOrder(edges)) {
    const moveCost =
      crossCost > 0 && placedSegs.length > 0
        ? (x1: number, y1: number, x2: number, y2: number): number =>
            crossCost * crossingCount(x1, y1, x2, y2, placedSegs)
        : undefined;
    const route = routeOrthogonal(e.start, e.end, e.obstacles, { ...baseOpts, moveCost });
    placed.set(e.id, route);
    for (const s of segments(route)) placedSegs.push(s);
  }
  return placed;
}
