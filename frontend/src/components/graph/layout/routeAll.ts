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
import { routePorts, type PortCandidate, type RouteGridCache, type RouteOptions } from "./orthoRoute";
import { commonPrefix, commonSuffix, pieceLen } from "./trunks";

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
// ШТРАФ ПАРКОВКИ В ЗАНЯТЫЙ ПОРТ ПРОТИВОПОЛОЖНОЙ РОЛИ (регрессия 2026-07-15: вход
// садился в точку чужого ВЫХОДА — встречные стрелки сливались концевыми плечами,
// нуджинг бессилен: оба конца пришпилены к одному хэндлу). Нарушение Т4 грубее
// пересечения (3 креста), но НЕ бесконечное: при полной блокаде всех слотов маршрут
// возможен ценой нарушения (деградация вместо отказа). Одноимённая роль (веер
// out-out / in-in в общем доке) — легальна и не штрафуется.
const PORT_CONFLICT_COST = 600;
// Бонуса слияния в оценке готовых ломаных НЕТ (решение Ф1 по полигон-эксперименту):
// добавленный в routeCost «−gain·слитая длина» протёк в сравнения rip-up и спрямления
// джогов и ПОКУПАЛ объезды/лишние изломы (метрики: +2 разворота, +8 изломов на живой
// «Ярмарке»). Выигрыш слияния учитывает только принятие сварки стволов (Ф2) со своей
// ступенью «грязь не хуже»; сварке не нужен и prev-перевес — она детерминированно
// пересоздаёт стволы каждый прогон.

// Терминал ребра для глобального роутера: концы (на хэндлах) и СВОИ препятствия — тела
// ВСЕХ узлов, включая узлы-концы этого ребра (V2.2: порты-стабы лежат снаружи тел,
// поэтому собственное тело — обычное препятствие; см. шапку orthoRoute.ts).
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

// Публичный конструктор PlacedSeg[] из ломаной — для внешних вызовов straightenJogs
// (пост-нуджинг-полировка в pipeline).
export function toPlacedSegs(route: EdgePoint[]): PlacedSeg[] {
  const list: PlacedSeg[] = [];
  pushPlaced(list, route);
  return list;
}

// Порты текущего ребра для исключения стволов (роль важна: source против target).
interface OwnPorts {
  starts: EdgePoint[];
  ends: EdgePoint[];
}

const nearPt = (a: EdgePoint, bx: number, by: number): boolean =>
  Math.abs(a.x - bx) <= EPS && Math.abs(a.y - by) <= EPS;

// СТВОЛОВОЙ КОНТЕКСТ оценки ГОТОВОЙ ломаной (эпик «общие плечи v2», Ф1; E25 v2).
// Собратья — маршруты, делящие с оцениваемой ломаной ФАКТИЧЕСКИЙ конец своей роли
// (p0↔p0 — исходящий веер, pN↔pN — входящий); prefLen/sufLen — длина общего
// префикса/суффикса с этим собратом. Наложение на собрата бесплатно в пределах
// куска: дуга наложения в arc-length оцениваемой ломаной обязана лежать в
// [0, prefLen] (префикс) либо [total − sufLen, total] (суффикс) — по построению
// куска геометрия там совпадает, а повторное схождение после расхождения (дуга
// вне куска) честно платит OVERLAP_COST. Кредит действует ОБЪЕДИНЕНИЕМ с
// кандидатным правилом крайнего сегмента (см. movePenalty): статус-кво сцен без
// сваренных стволов не меняется (полигон-паритет Ф1), куски за первым изломом
// (сварка, Ф2) получают легальность.
interface TrunkEvalCtx {
  total: number; // манхэттенова длина оцениваемой ломаной
  fellows: Array<{ p0: EdgePoint; pN: EdgePoint; prefLen: number; sufLen: number }>;
}

// Контекст оцениваемой ломаной pts против маршрутов-собратьев (вызывающий уже
// исключил маршрут самого ребра). undefined — собратьев нет, наложения без льгот.
function buildTrunkCtx(pts: EdgePoint[], fellowRoutes: Iterable<EdgePoint[]>): TrunkEvalCtx | undefined {
  if (pts.length < 2) return undefined;
  const a0 = pts[0], aN = pts[pts.length - 1];
  const fellows: TrunkEvalCtx["fellows"] = [];
  for (const f of fellowRoutes) {
    if (f.length < 2 || f === pts) continue;
    const sharesStart = nearPt(f[0], a0.x, a0.y);
    const sharesEnd = nearPt(f[f.length - 1], aN.x, aN.y);
    if (!sharesStart && !sharesEnd) continue;
    // общий и p0, и pN у пары одного направления невозможен (мастер-слияние E2)
    const prefLen = sharesStart ? pieceLen(commonPrefix(pts, f)) : 0;
    const sufLen = sharesEnd ? pieceLen(commonSuffix(pts, f)) : 0;
    if (prefLen <= EPS && sufLen <= EPS) continue;
    fellows.push({ p0: f[0], pN: f[f.length - 1], prefLen, sufLen });
  }
  if (fellows.length === 0) return undefined;
  return { total: pieceLen(pts), fellows };
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
interface PlacedIndex {
  h: IndexedSeg[]; // горизонтальные, отсортированы по c
  v: IndexedSeg[]; // вертикальные, отсортированы по c
  count: number;
}

const byC = (a: IndexedSeg, b: IndexedSeg): number => a.c - b.c;

function buildPlacedIndex(placed: PlacedSeg[]): PlacedIndex {
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
  placed: PlacedIndex, crossCost: number, own?: OwnPorts,
  trunk?: TrunkEvalCtx, moveArc0?: number,
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
    // ИСКЛЮЧЕНИЕ СТВОЛА, кандидатное правило (Т4: «один хэндл И одно направление» —
    // легитимно): бесплатна езда по КРАЙНЕМУ сегменту владельца (примыкает к его
    // порту p0/pN), когда та же точка есть среди НАШИХ портов той же роли
    // (source↔source, target↔target) — это слитый веер из общего дока. Разные роли
    // (наш target = его source) НЕ исключаются: парковка входа в чужой выход — то
    // самое нарушение Т4. В A*-поиске own — порты-кандидаты (свой маршрут ещё не
    // известен), в оценке готовой ломаной — её фактические концы.
    if (own) {
      const s = e.ps.seg;
      const segHasP0 = nearPt(e.ps.p0, s.x1, s.y1) || nearPt(e.ps.p0, s.x2, s.y2);
      if (segHasP0 && own.starts.some((p) => nearPt(p, e.ps.p0.x, e.ps.p0.y))) continue;
      const segHasPN = nearPt(e.ps.pN, s.x1, s.y1) || nearPt(e.ps.pN, s.x2, s.y2);
      if (segHasPN && own.ends.some((p) => nearPt(p, e.ps.pN.x, e.ps.pN.y))) continue;
    }
    // ЛЕГАЛЬНЫЙ СТВОЛ (E25 v2, только оценка ГОТОВОЙ ломаной): бесплатна часть
    // наложения на маршрут СОБРАТА (владелец опознаётся концами p0/pN), чья дуга в
    // arc-length оцениваемой ломаной лежит внутри общего префикса [0, prefLen] либо
    // суффикса [total − sufLen, total] — так стволы, сваренные ЧЕРЕЗ изломы (Ф2),
    // не считаются «грязью» и не дербанятся rip-up-ом. Повторное схождение после
    // расхождения — вне куска, платит как обычная чужая линия. Кредит — добавка к
    // кандидатному правилу выше (объединение льгот), не замена.
    if (trunk !== undefined && moveArc0 !== undefined) {
      const fel = trunk.fellows.find(
        (f) => nearPt(f.p0, e.ps.p0.x, e.ps.p0.y) && nearPt(f.pN, e.ps.pN.x, e.ps.pN.y),
      );
      let free = 0;
      if (fel) {
        // дуга наложения вдоль ХОДА (ход начинается на mStart с дуги moveArc0)
        const d1 = Math.abs(lo - mStart), d2 = Math.abs(hi - mStart);
        const oa = moveArc0 + Math.min(d1, d2), ob = moveArc0 + Math.max(d1, d2);
        if (fel.prefLen > EPS) free += Math.max(0, Math.min(ob, fel.prefLen) - oa);
        if (fel.sufLen > EPS) free += Math.max(0, ob - Math.max(oa, trunk.total - fel.sufLen));
      }
      overlap += Math.max(0, hi - lo - free);
      continue;
    }
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
// изломов. 0 — маршрут «чистый»: второй проход его не трогает. Легальные стволы (trunk)
// в штраф не входят — кредит держит сваренные стволы «чистыми» для rip-up.
function pathPenalty(
  pts: EdgePoint[], placed: PlacedIndex, crossCost: number,
  own?: OwnPorts, trunk?: TrunkEvalCtx,
): number {
  if (placed.count === 0) return 0;
  let n = 0;
  let arc = 0; // дуга начала текущего хода (для интервалов легальности)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len > EPS) n += movePenalty(a.x, a.y, b.x, b.y, placed, crossCost, own, trunk, arc);
    arc += len;
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
  // маршруты ОСТАЛЬНЫХ рёбер (без своего): стволовой контекст оценки — спрямление
  // джога может укоротить общий кусок, поэтому легальность пересчитывается на
  // каждого кандидата (E25 v2), а не передаётся снаружи константой
  fellowRoutes?: EdgePoint[][],
): EdgePoint[] {
  let cur = cleanup(pts.map((p) => ({ x: p.x, y: p.y })));
  const othersIdx = buildPlacedIndex(others); // чужие фиксированы на весь вызов
  const evalCost = (p: EdgePoint[]): number =>
    routeCost(p, othersIdx, crossCost, bendPenalty, extra, own, buildTrunkCtx(p, fellowRoutes ?? []));
  // тела, раздутые на клиренс: кандидат, влезающий в раздутое тело, к которому текущий
  // маршрут НЕ прижат, отвергается (не приклеивать линию к грани узла)
  const inflated = obstacles.map((r) => ({
    x: r.x - JOG_CLEAR, y: r.y - JOG_CLEAR, w: r.w + 2 * JOG_CLEAR, h: r.h + 2 * JOG_CLEAR,
  }));
  let guard = 8; // страховка от зацикливания (каждый прогон убирает ≥1 джог)
  while (guard-- > 0) {
    let applied = false;
    const n = cur.length;
    // прижатости и стоимость ТЕКУЩЕГО маршрута фиксированы, пока он не заменён, —
    // считаем на итерацию while один раз (лениво: только если нашёлся джог-кандидат)
    let curHugs: boolean[] | null = null;
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
// пересечения с уже проложенными (с кредитом легальных стволов) + доп. штраф среды.
// Для честного сравнения свежего маршрута с прошлогодним обе ломаные оцениваются
// ЭТОЙ функцией, каждая со СВОИМ стволовым контекстом (стабы включены в обе).
function routeCost(
  pts: EdgePoint[],
  placed: PlacedIndex,
  crossCost: number,
  bendPenalty: number,
  extra?: (x1: number, y1: number, x2: number, y2: number) => number,
  own?: OwnPorts,
  trunk?: TrunkEvalCtx,
): number {
  let cost = 0;
  let arc = 0; // дуга начала текущего хода
  let prevHoriz: boolean | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len > EPS) {
      const horiz = Math.abs(b.y - a.y) <= Math.abs(b.x - a.x);
      if (prevHoriz !== null && horiz !== prevHoriz) cost += bendPenalty;
      prevHoriz = horiz;
      cost += len;
      if (placed.count > 0) cost += movePenalty(a.x, a.y, b.x, b.y, placed, crossCost, own, trunk, arc);
      if (extra) cost += extra(a.x, a.y, b.x, b.y);
    }
    arc += len;
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
  // Кэш подготовленных сеток: pass 1 и итерации rip-up зовут routePorts для ОДНОГО
  // терминала (те же порты/препятствия/подсказки, меняется только moveCost) — сетка,
  // проходимость шагов и эвристика переиспользуются между попытками.
  const gridCache: RouteGridCache = new Map();
  const baseOpts: RouteOptions = {
    margin: opts?.margin, bendPenalty: opts?.bendPenalty, extraXs, extraYs, gridCache,
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

  // ЗАНЯТЫЕ ПОРТЫ по ролям (портовый штраф, 2026-07-15): p0/pN уже проложенных маршрутов.
  // Наш ВЫХОД конфликтует с чужим ВХОДОМ (pN) и наоборот; одноимённая роль — легальный
  // веер, не конфликт. Реестр живёт по edgeId (rip-up исключает само ребро и обновляет
  // запись при замене маршрута); preplaced-контекст (живой драг) — под синтетическими id.
  const portOf = new Map<string, { p0: EdgePoint; pN: EdgePoint }>();
  for (const p of opts?.preplaced ?? []) {
    if (p.length >= 2) portOf.set(`pre:${portOf.size}`, { p0: p[0], pN: p[p.length - 1] });
  }
  // Кандидаты с проставленным штрафом занятости (пересчёт на каждый вызов routePorts:
  // реестр растёт/меняется). Сетка грид-кэша от penalty не зависит (точки те же).
  const conflictPorts = (e: EdgeTerminal): [PortCandidate[], PortCandidate[]] => {
    const oppToStart: EdgePoint[] = []; // чужие ВХОДЫ — конфликт нашему выходу
    const oppToEnd: EdgePoint[] = [];   // чужие ВЫХОДЫ — конфликт нашему входу
    for (const [id, pp] of portOf) {
      if (id === e.id) continue;
      oppToStart.push(pp.pN);
      oppToEnd.push(pp.p0);
    }
    const mark = (cands: PortCandidate[], opp: EdgePoint[]): PortCandidate[] =>
      cands.map((c) => (opp.some((q) => nearPt(q, c.point.x, c.point.y))
        ? { ...c, penalty: (c.penalty ?? 0) + PORT_CONFLICT_COST }
        : c));
    const [starts, ends] = portsOf(e);
    return [mark(starts, oppToStart), mark(ends, oppToEnd)];
  };
  // Тот же штраф для ГОТОВОЙ ломаной (гистерезис/rip-up сравнивают маршруты внешней
  // routeCost — конфликт концов обязан быть виден и там, иначе прилипший prev вечно
  // выигрывает у чистой альтернативы).
  const portConflictCost = (edgeId: string, pts: EdgePoint[]): number => {
    if (pts.length < 2) return 0;
    const a = pts[0], b = pts[pts.length - 1];
    let cost = 0;
    for (const [id, pp] of portOf) {
      if (id === edgeId) continue;
      if (nearPt(pp.pN, a.x, a.y)) cost += PORT_CONFLICT_COST; // наш выход в чужом входе
      if (nearPt(pp.p0, b.x, b.y)) cost += PORT_CONFLICT_COST; // наш вход в чужом выходе
    }
    return cost;
  };

  const placed = new Map<string, EdgePoint[]>();
  const placedSegs: PlacedSeg[] = [...preplacedSegs]; // сегменты всех уже проложенных рёбер
  let placedIdx = buildPlacedIndex(placedSegs); // пересобирается после каждой прокладки
  const order = routingOrder(edges);
  for (const e of order) {
    const extra = e.extraMoveCost ?? opts?.extraMoveCost;
    const own = ownPortsOf(e);
    const wantPenalty = placedSegs.length > 0;
    const idx = placedIdx; // снимок для замыкания (переменная будет перезаписана)
    const moveCost =
      wantPenalty || extra
        ? (x1: number, y1: number, x2: number, y2: number): number =>
            (wantPenalty ? movePenalty(x1, y1, x2, y2, idx, crossCost, own) : 0) +
            (extra ? extra(x1, y1, x2, y2) : 0)
        : undefined;
    const [starts, ends] = conflictPorts(e);
    const r = routePorts(starts, ends, e.obstacles, { ...baseOpts, moveCost, cacheKey: e.id });
    // Пути нет даже с margin=0 (порт заперт) — прямой отрезок-fallback, как раньше.
    let route = r?.pts ?? cleanup([{ ...e.start }, { ...e.end }]);
    // Гистерезис: прежний валидный маршрут не хуже свежего больше, чем на порог, —
    // держим прежний (стрелка не перекладывается от чужих микро-сдвигов и ничьих).
    // Оценка точная (E25 v2): каждая ломаная — со своим стволовым контекстом против
    // уже проложенных + preplaced (сам e в placed ещё не записан).
    if (e.prev && e.prev.length >= 2) {
      const fellowRoutes = [...placed.values(), ...(opts?.preplaced ?? [])];
      const cNew = routeCost(route, idx, crossCost, bp, extra, own, buildTrunkCtx(route, fellowRoutes)) +
        portConflictCost(e.id, route);
      const cPrev = routeCost(e.prev, idx, crossCost, bp, extra, own, buildTrunkCtx(e.prev, fellowRoutes)) +
        portConflictCost(e.id, e.prev);
      if (cPrev <= cNew + ROUTE_STICKINESS) route = e.prev.map((p) => ({ x: p.x, y: p.y }));
    }
    placed.set(e.id, route);
    if (route.length >= 2) portOf.set(e.id, { p0: route[0], pN: route[route.length - 1] });
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
  // маршруты остальных как ломаные — стволовой контекст точной оценки (E25 v2)
  const othersRoutesOf = (skipId: string): EdgePoint[][] => {
    const arr: EdgePoint[][] = [...(opts?.preplaced ?? [])];
    for (const [id, r] of placed) if (id !== skipId) arr.push(r);
    return arr;
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
    if (route.length >= 2) portOf.set(id, { p0: route[0], pN: route[route.length - 1] });
    envVersion++;
  };
  const ripUp = (): boolean => {
    let improved = false;
    for (const e of order) {
      const cur = placed.get(e.id);
      if (!cur) continue;
      if (lastTried.get(e.id) === envVersion) continue; // окружение прежнее — результат тот же
      const others = buildPlacedIndex(othersOf(e.id));
      const own = ownPortsOf(e);
      const fellows = othersRoutesOf(e.id);
      const tCur = buildTrunkCtx(cur, fellows);
      // конфликт порта — тоже «грязь»: без него ребро с нелегальной парковкой считалось
      // бы чистым и никогда не перепрокладывалось; легальный ствол грязью не считается
      if (pathPenalty(cur, others, crossCost, own, tCur) + portConflictCost(e.id, cur) <= 0) continue;
      const extra = e.extraMoveCost ?? opts?.extraMoveCost;
      const moveCost = (x1: number, y1: number, x2: number, y2: number): number =>
        movePenalty(x1, y1, x2, y2, others, crossCost, own) + (extra ? extra(x1, y1, x2, y2) : 0);
      const [starts, ends] = conflictPorts(e);
      const r2 = routePorts(starts, ends, e.obstacles, { ...baseOpts, moveCost, cacheKey: e.id });
      if (!r2?.pts || r2.pts.length < 2) { lastTried.set(e.id, envVersion); continue; }
      const cCur = routeCost(cur, others, crossCost, bp, extra, own, tCur) + portConflictCost(e.id, cur);
      const cNew = routeCost(r2.pts, others, crossCost, bp, extra, own, buildTrunkCtx(r2.pts, fellows)) +
        portConflictCost(e.id, r2.pts);
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
      cur, e.obstacles, othersOf(e.id), crossCost, bp, extra, ownPortsOf(e), othersRoutesOf(e.id),
    );
    if (str.length !== cur.length) replace(e.id, str);
  }
  return placed;
}
