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
import { segments, type EdgeSide, type NodeRect, type Segment } from "../edgePath";
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
  // A8 (выбор сторон): альтернативные пары концов — кандидаты сторон источника/цели. Роутер
  // выберет вариант с минимумом (длина + изломы + пересечения). Если не задано — start/end.
  // start/end дублируют первый вариант (нужны для порядка прокладки и обратной совместимости).
  // sSide/tSide (V2.1) — стороны портов: маршрут выходит/входит вдоль нормали стороны со
  // стабом ПО ПОСТРОЕНИЮ (направленная видимость, шпильки исключены). Без сторон — как раньше.
  altTerminals?: Array<{ start: EdgePoint; end: EdgePoint; sSide?: EdgeSide; tSide?: EdgeSide }>;
}

export interface RouteAllOptions {
  margin?: number;
  bendPenalty?: number;
  crossCost?: number; // штраф за каждое пересечение с уже проложенной стрелкой
}

// Манхэттенова длина ломаной (сумма осевых сегментов).
function pathLength(pts: EdgePoint[]): number {
  let n = 0;
  for (let i = 0; i < pts.length - 1; i++) n += Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
  return n;
}

// Число изломов (смен ориентации) очищенной ломаной.
function bendCount(pts: EdgePoint[]): number {
  const segs = segments(pts);
  let n = 0;
  for (let i = 1; i < segs.length; i++) if (segs[i].orient !== segs[i - 1].orient) n++;
  return n;
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

// Прокладывает все рёбра, минимизируя взаимные пересечения. Если у ребра заданы altTerminals
// (кандидаты сторон, A8) — для каждого варианта прокладывает маршрут и выбирает с минимумом
// (длина + изломы + пересечения с уже проложенными). Возвращает id → ломаная.
export function routeAll(edges: EdgeTerminal[], opts?: RouteAllOptions): Map<string, EdgePoint[]> {
  const crossCost = opts?.crossCost ?? DEFAULT_CROSS_COST;
  const bendPenalty = opts?.bendPenalty ?? 40;
  // Общая координатная решётка набора: концы ВСЕХ вариантов всех рёбер — чтобы любому ребру
  // было куда свернуть в объезд чужой стрелки (иначе сетка ребра ограничена своими концами).
  const extraXs: number[] = [];
  const extraYs: number[] = [];
  const termsOf = (e: EdgeTerminal) => e.altTerminals ?? [{ start: e.start, end: e.end }];
  for (const e of edges) {
    for (const t of termsOf(e)) {
      extraXs.push(t.start.x, t.end.x);
      extraYs.push(t.start.y, t.end.y);
    }
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
    // Выбор стороны (A8) РАЗВЯЗАН от чужих стрелок (стабильность, A7.4): сторону берём по
    // ЧИСТОЙ геометрии ребра (длина + изломы вокруг узлов-препятствий), БЕЗ штрафа за
    // пересечения с уже проложенными. Так выбранная сторона = хэндл, отдаваемый наружу, —
    // чистая функция концов и узлов этого ребра: правка/добавление другого ребра её не
    // меняет, и стрелка не перескакивает на другой хэндл. Пересечения (R3) влияют только на
    // ФОРМУ финального маршрута выбранной стороны (ниже), не на точку стыковки.
    const variants = termsOf(e);
    let chosen = variants[0];
    if (variants.length > 1) {
      let bestCost = Infinity;
      for (const t of variants) {
        const probe = routeOrthogonal(t.start, t.end, e.obstacles, {
          ...baseOpts, startSide: t.sSide, endSide: t.tSide,
        }); // без moveCost
        const cost = pathLength(probe) + bendPenalty * bendCount(probe);
        if (cost < bestCost - EPS) { bestCost = cost; chosen = t; }
      }
    }
    // Финальный маршрут выбранной стороны — С учётом пересечений (R3 формирует изломы).
    const route = routeOrthogonal(chosen.start, chosen.end, e.obstacles, {
      ...baseOpts, moveCost, startSide: chosen.sSide, endSide: chosen.tSide,
    });
    placed.set(e.id, route);
    for (const s of segments(route)) placedSegs.push(s);
  }
  return placed;
}
