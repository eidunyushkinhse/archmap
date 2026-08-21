// Метрики КАЧЕСТВА набора маршрутов (Ф0 эпика «глубокая оптимизация роутера»,
// docs/plan-router-deep-opt.md § «Метрики качества»).
//
// Зачем модуль: правки классов Б и В меняют геометрию маршрутов, поэтому гейт
// «байт-в-байт» для них не работает — нужен ЧИСЛОВОЙ гейт. Здесь чистые функции,
// считающие по дампу маршрутов те же величины, которыми оперируют спека связи
// (docs/specs/edge.md) и штрафная математика роутера (routeAll.movePenalty):
// кресты E23, коллинеарная езда с кредитом легальных стволов E25, изломы и длина,
// проход сквозь тела E19 (обязано быть 0), проход сквозь чужие плашки (остаток T4),
// портовые конфликты E12, развороты и шпильки (узкие развороты, E15).
//
// Модуль НИЧЕГО не знает о роутере и не зависит от его внутренних структур: вход —
// плоский дамп (см. RouteDump), совместимый с реплей-скриптом атрибуции. Семантику
// легальности стволов НЕ переписываем — импортируем trunks.ts (единственный
// нормативный источник E25).
//
// ⚠️ СЫРАЯ геометрия против ОТРИСОВАННОЙ. Здесь меряются ЛОМАНЫЕ РОУТЕРА, а
// scripts/arrow-metrics.mjs — путь `d` из DOM (после скругления углов
// EDGE_CORNER_RADIUS = 12 и мостиков). Скругление съедает короткие звенья, поэтому
// «шпилька» с перемычкой ≤ ~24px в отрисованном пути невидима, а здесь считается.
// Замер фазз-полигона (60 синтетических сцен, 2026-08-21): 57 шпилек, медиана
// перемычки 12px = DEFAULT_MARGIN — это штатный рисунок «стаб 20 наружу, затем
// прижим к клиренс-линии узла». ПОДТВЕРЖДЕНО НА РЕАЛЬНЫХ СЦЕНАХ (базлайн Ф0:
// Zabbix-корень 3, level-сцены 2 и 1; разобраны руками) — это П-образные объезды В
// СЕРЕДИНЕ ломаной с перемычками 12/20/25px, легальная геометрия. Поэтому шпильки
// НЕ входят в MUST_BE_ZERO (см. там же); сравнение «до/после» одной и той же природы
// (сырое против сырого) корректно всегда.
//
// ИЗВЕСТНАЯ НАХОДКА Ф0 (базлайн, не регрессия): на живой сцене Zabbix-корня метрика
// показывает 1 проход маршрута в чужое ТЕЛО — ребро f36d0019… («history syncer →
// service manager»), осевой сегмент входит ~8.5px в тело 8beff94e…; prevRoutes во
// входе НЕТ (не гистерезис), маршруты байт-в-байт совпадают с продом до эпика.
// Метрика оставлена СТРОГОЙ (E19 — абсолютное препятствие), а дефект — кандидат на
// разбор в Ф1/Ф4. Именно из-за него гейт сравнения флажит только НОВЫЕ нарушения
// (after > before), иначе он был бы вечно красным от известной находки.
import type { EdgePoint } from "../../../types";
import { cleanup } from "../edgePath";
import { commonPrefix, commonSuffix, pieceLen } from "./trunks";

// Допуск совпадения координат — тот же, что у роутера (routeAll.EPS / edge.md).
const EPS = 0.5;
// Квант ключа точки (дедуп крестов, сравнение портов): 0.5px, как в movePenalty.
const QUANT = 2;
// Глубина проникновения в ТЕЛО узла, начиная с которой это нарушение E19: касание
// грани и скольжение по ней — легальны (стабы стартуют ровно на грани своего узла).
// Семантика segCutsRect из scripts/arrow-metrics.mjs.
const BODY_EPS = 1.5;
// Плашка — мягкое препятствие (E22): нарушением считаем любое реальное проникновение.
const LABEL_EPS = 0.5;
// Разворот со средним сегментом не длиннее — «шпилька» (arrow-metrics.mjs, E15).
const HAIRPIN_JOG = 30;

/** Прямоугольник тела узла в дампе (id нужен только для отчёта). */
export interface DumpRect { id: string; x: number; y: number; w: number; h: number }
/** Прямоугольник плашки подписи. */
export interface LabelRect { x: number; y: number; w: number; h: number }

/**
 * Дамп сцены для измерения. ФОРМАТ СОГЛАСОВАН с реплей-скриптом атрибуции
 * (docs/plan-router-deep-opt.md, Ф0) — менять нельзя: массивы пар вместо Map,
 * чтобы дамп сериализовался обычным JSON.stringify.
 */
export interface RouteDump {
  routes: Array<[string, EdgePoint[]]>;      // groupId → ломаная (со стабами)
  rects: DumpRect[];                          // тела узлов сцены
  labels: Array<[string, LabelRect]>;         // groupId → плашка его подписи
}

/** Метрики качества сцены. Все — «меньше лучше». */
export interface QualityMetrics {
  /** Пересечения-«крестики» разных маршрутов, дедуп по точке (E23). */
  crosses: number;
  /** Суммарная длина коллинеарных наложений пар РАЗНЫХ маршрутов, px. */
  overlapPx: number;
  /** То же за вычетом легальных стволов E25 (общий префикс/суффикс), px. */
  illegalOverlapPx: number;
  /** Суммарное число изломов по всем маршрутам. */
  bends: number;
  /** Суммарная манхэттенова длина, px. */
  totalLen: number;
  /** Пары (маршрут, тело узла) с проходом СТРОГО внутри тела — E19, обязано быть 0. */
  throughBodies: number;
  /** Пары (маршрут, ЧУЖАЯ плашка) с проникновением в плашку — остаток T4. */
  throughLabels: number;
  /** Пары «конец-выход одного маршрута = конец-вход другого» — E12. */
  portConflicts: number;
  /** Антипараллельные сегменты i и i+2 одного маршрута. */
  reversals: number;
  /**
   * Развороты со средним сегментом ≤ 30px. НЕ инвариант «обязано 0»: П-объезд с
   * короткой перемычкой легален (E15 запрещает разворот-на-месте, а не объезд),
   * в отрисованном пути его сглаживает скругление 12px. Метрика «меньше лучше».
   */
  hairpins: number;
}

/**
 * Метрики, ненулевое значение которых — поломка ИНВАРИАНТА спеки, а не «стало хуже».
 * Здесь только E19 (тело узла — абсолютное препятствие при любых штрафах).
 *
 * Шпилек тут НЕТ осознанно: E15 запрещает разворот-на-месте ПО ПОСТРОЕНИЮ состояния
 * A* (ход назад не генерируется), а П-образный объезд с короткой перемычкой —
 * легальная геометрия, и в отрисованном пути скругление 12px делает его гладким.
 * На сырых ломаных такие объезды считаются (базлайн Ф0 на реальных сценах: 3/2/1),
 * поэтому hairpins живёт в отчёте и в сравнении как обычная метрика «меньше лучше»
 * (флаг worse), но гейтом «обязано 0» не является — см. шапку модуля.
 */
export const MUST_BE_ZERO: ReadonlyArray<keyof QualityMetrics> = ["throughBodies"];

/** Порядок строк в отчётах (единый для CLI и сравнения). */
export const METRIC_ORDER: ReadonlyArray<keyof QualityMetrics> = [
  "crosses", "overlapPx", "illegalOverlapPx", "bends", "totalLen",
  "throughBodies", "throughLabels", "portConflicts", "reversals", "hairpins",
];

/** Человекочитаемые подписи метрик (CLI). */
export const METRIC_LABELS: Readonly<Record<keyof QualityMetrics, string>> = {
  crosses: "кресты (E23)",
  overlapPx: "езда по чужой линии, px",
  illegalOverlapPx: "  из них НЕлегальной (E25), px",
  bends: "изломы",
  totalLen: "длина (манхэттен), px",
  throughBodies: "сквозь тела (E19, обязано 0)",
  throughLabels: "сквозь чужие плашки (T4)",
  portConflicts: "конфликты портов (E12)",
  reversals: "развороты",
  hairpins: "шпильки (перемычка ≤30px)",
};

// ── внутренняя геометрия ─────────────────────────────────────────────────────

// Осевой сегмент маршрута с его положением на дуге ломаной: нужен и для крестов
// (перпендикуляры), и для езды (коллинеарность), и для кредита стволов (arc-length).
interface AxisSeg {
  route: number;   // индекс маршрута в наборе
  horiz: boolean;  // горизонтальный
  c: number;       // постоянная координата (y у горизонтального, x у вертикального)
  lo: number;      // протяжённость вдоль своей оси
  hi: number;
  from: number;    // варьируемая координата НАЧАЛА сегмента (в порядке хода)
  arc0: number;    // arc-length начала сегмента от начала ломаной
}

// Направленное звено (для разворотов/шпилек): семантика segs() из arrow-metrics.mjs —
// ось по доминанте, соседние однонаправленные сливаются.
interface DirSeg { dx: number; dy: number; len: number }

interface PreparedRoute {
  id: string;
  pts: EdgePoint[];
  total: number;   // манхэттенова длина
  segs: AxisSeg[];
  dirs: DirSeg[];
  bends: number;
}

const keyOf = (v: number): number => Math.round(v * QUANT);
const samePt = (a: EdgePoint, b: EdgePoint): boolean =>
  Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

function prepare(id: string, raw: EdgePoint[], index: number): PreparedRoute {
  const pts = cleanup(raw.map((p) => ({ x: p.x, y: p.y })));
  const segs: AxisSeg[] = [];
  const dirs: DirSeg[] = [];
  let total = 0;
  let bends = 0;
  let prevHoriz: boolean | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.abs(dx) + Math.abs(dy);
    if (len <= EPS) continue;
    // ориентация по доминанте (диагональ-фолбэк E18 тоже получает ось — как в
    // arrow-metrics; в геометрические тесты крестов/езды она при этом не идёт)
    const horiz = Math.abs(dy) <= Math.abs(dx);
    if (prevHoriz !== null && horiz !== prevHoriz) bends++;
    prevHoriz = horiz;
    // осевой сегмент (строго H или V) — участник крестов/езды
    const axial = horiz ? Math.abs(dy) <= EPS : Math.abs(dx) <= EPS;
    if (axial) {
      segs.push({
        route: index,
        horiz,
        c: horiz ? a.y : a.x,
        lo: horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
        hi: horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y),
        from: horiz ? a.x : a.y,
        arc0: total,
      });
    }
    const s: DirSeg = {
      dx: Math.abs(dx) > Math.abs(dy) ? Math.sign(dx) : 0,
      dy: Math.abs(dy) >= Math.abs(dx) ? Math.sign(dy) : 0,
      len,
    };
    const last = dirs[dirs.length - 1];
    if (last && last.dx === s.dx && last.dy === s.dy) last.len += s.len;
    else dirs.push(s);
    total += len;
  }
  return { id, pts, total, segs, dirs, bends };
}

// Пересекает ли ОСЕВОЙ отрезок внутренность прямоугольника глубже eps (семантика
// segCutsRect из scripts/arrow-metrics.mjs: касание грани и ход вдоль грани — нет).
function segCutsRect(a: EdgePoint, b: EdgePoint, r: LabelRect, eps: number): boolean {
  const loX = Math.min(a.x, b.x), hiX = Math.max(a.x, b.x);
  const loY = Math.min(a.y, b.y), hiY = Math.max(a.y, b.y);
  return loX < r.x + r.w - eps && hiX > r.x + eps && loY < r.y + r.h - eps && hiY > r.y + eps;
}

// ── метрики ──────────────────────────────────────────────────────────────────

/**
 * Полный набор метрик качества по дампу сцены. Чистая функция: результат зависит
 * только от содержимого дампа (маршруты нормализуются cleanup-ом, порядок сумм
 * фиксируется сортировкой по id — метрики не зависят от порядка в дампе).
 */
export function measureQuality(dump: RouteDump): QualityMetrics {
  const entries = [...(dump.routes ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const routes = entries.map(([id, pts], i) => prepare(id, pts, i));
  const rects = dump.rects ?? [];
  const labels = dump.labels ?? [];

  const m: QualityMetrics = {
    crosses: 0, overlapPx: 0, illegalOverlapPx: 0, bends: 0, totalLen: 0,
    throughBodies: 0, throughLabels: 0, portConflicts: 0, reversals: 0, hairpins: 0,
  };

  // длина, изломы, развороты и шпильки — по каждому маршруту отдельно
  for (const r of routes) {
    m.totalLen += r.total;
    m.bends += r.bends;
    for (let i = 0; i + 2 < r.dirs.length; i++) {
      const a = r.dirs[i], b = r.dirs[i + 1], c = r.dirs[i + 2];
      if (a.dx === -c.dx && a.dy === -c.dy && (a.dx !== 0 || a.dy !== 0)) {
        m.reversals++;
        if (b.len <= HAIRPIN_JOG) m.hairpins++;
      }
    }
  }

  // КРЕСТЫ (E23): перпендикулярные сегменты РАЗНЫХ маршрутов, точка строго внутри
  // обоих; дедуп по точке — совпадающие плечи пучка дают ОДИН крест (как movePenalty).
  const crossPts = new Set<string>();
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      for (const s of routes[i].segs) {
        for (const t of routes[j].segs) {
          if (s.horiz === t.horiz) continue;
          const h = s.horiz ? s : t;
          const v = s.horiz ? t : s;
          if (!(h.lo + EPS < v.c && v.c < h.hi - EPS)) continue; // строго внутри горизонтального
          if (!(v.lo + EPS < h.c && h.c < v.hi - EPS)) continue; // строго внутри вертикального
          crossPts.add(`${keyOf(v.c)}|${keyOf(h.c)}`);
        }
      }
    }
  }
  m.crosses = crossPts.size;

  // ЕЗДА (E23 OVERLAP) и её нелегальная часть (E25): пара РАЗНЫХ маршрутов —
  // коллинеарные сегменты на одной линии. Легален только общий НЕПРЕРЫВНЫЙ кусок
  // от общего порта одной роли: префикс при общем p0, суффикс при общем pN
  // (длины кусков считает trunks.ts — единственный источник семантики E25).
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const A = routes[i], B = routes[j];
      if (A.pts.length < 2 || B.pts.length < 2) continue;
      const a0 = A.pts[0], aN = A.pts[A.pts.length - 1];
      const b0 = B.pts[0], bN = B.pts[B.pts.length - 1];
      const prefLen = samePt(a0, b0) ? pieceLen(commonPrefix(A.pts, B.pts)) : 0;
      const sufLen = samePt(aN, bN) ? pieceLen(commonSuffix(A.pts, B.pts)) : 0;
      for (const s of A.segs) {
        for (const t of B.segs) {
          if (s.horiz !== t.horiz) continue;
          if (Math.abs(s.c - t.c) > EPS) continue;
          const lo = Math.max(s.lo, t.lo), hi = Math.min(s.hi, t.hi);
          const len = hi - lo;
          if (len <= EPS) continue;
          m.overlapPx += len;
          // дуга наложения в arc-length маршрута A (геометрия куска у пары общая,
          // поэтому кредит симметричен: то же окно у B)
          const d1 = Math.abs(lo - s.from), d2 = Math.abs(hi - s.from);
          const oa = s.arc0 + Math.min(d1, d2), ob = s.arc0 + Math.max(d1, d2);
          let free = 0;
          if (prefLen > EPS) free += Math.max(0, Math.min(ob, prefLen) - oa);
          if (sufLen > EPS) free += Math.max(0, ob - Math.max(oa, A.total - sufLen));
          m.illegalOverlapPx += Math.max(0, len - free);
        }
      }
    }
  }

  // ТЕЛА (E19): пара (маршрут, тело) — считаем один раз на тело, глубина > BODY_EPS.
  for (const r of routes) {
    for (const body of rects) {
      let hit = false;
      for (let i = 1; i < r.pts.length && !hit; i++) {
        if (segCutsRect(r.pts[i - 1], r.pts[i], body, BODY_EPS)) hit = true;
      }
      if (hit) m.throughBodies++;
    }
  }

  // ЧУЖИЕ ПЛАШКИ (остаток T4): своя плашка не нарушение — online лежит на своей линии.
  for (const r of routes) {
    for (const [gid, box] of labels) {
      if (gid === r.id) continue;
      let hit = false;
      for (let i = 1; i < r.pts.length && !hit; i++) {
        if (segCutsRect(r.pts[i - 1], r.pts[i], box, LABEL_EPS)) hit = true;
      }
      if (hit) m.throughLabels++;
    }
  }

  // ПОРТОВЫЕ КОНФЛИКТЫ (E12): конец-ВЫХОД одного маршрута стоит в точке конца-ВХОДА
  // чужого. Веер одной роли (out-out / in-in) легален и не считается.
  for (let i = 0; i < routes.length; i++) {
    for (let j = 0; j < routes.length; j++) {
      if (i === j) continue;
      const A = routes[i], B = routes[j];
      if (A.pts.length < 2 || B.pts.length < 2) continue;
      if (samePt(A.pts[0], B.pts[B.pts.length - 1])) m.portConflicts++;
    }
  }

  return m;
}

/** Строка сравнения одной метрики. */
export interface QualityDiffRow {
  metric: keyof QualityMetrics;
  label: string;
  before: number;
  after: number;
  delta: number;          // after − before (знак сохранён: «+» = стало хуже)
  pct: number | null;     // относительная дельта, null при before = 0
  mustBeZero: boolean;    // метрика из MUST_BE_ZERO
  // НОВОЕ нарушение инварианта: mustBeZero и after > before. Известный дефект
  // базлайна (см. шапку) флага не поднимает — иначе гейт не различал бы регрессию.
  violated: boolean;
  worse: boolean;         // delta > 0
}

export interface QualityComparison {
  rows: QualityDiffRow[];
  /**
   * НОВЫЕ нарушения инвариантов «обязано быть 0» (метрика выросла относительно
   * базлайна). Пустой массив — гейт прошёл, даже если абсолютное значение метрики
   * ненулевое: известные дефекты базлайна перечислены в шапке модуля и разбираются
   * отдельно, а не роняют каждое сравнение.
   */
  violations: string[];
}

/**
 * Дифф двух замеров: знаковые дельты по всем метрикам плюс отдельный список НОВЫХ
 * нарушений инвариантов «обязано быть 0» (E19 тела) — гейт правок класса Б смотрит
 * сначала на него, потом на допуск по остальным метрикам. «Новое» = after > before:
 * известный дефект базлайна (шапка модуля) гейт не роняет, регрессию — роняет.
 */
export function compareQuality(a: QualityMetrics, b: QualityMetrics): QualityComparison {
  const rows: QualityDiffRow[] = METRIC_ORDER.map((metric) => {
    const before = a[metric], after = b[metric];
    const mustBeZero = MUST_BE_ZERO.includes(metric);
    return {
      metric,
      label: METRIC_LABELS[metric],
      before,
      after,
      delta: after - before,
      pct: before === 0 ? null : ((after - before) / before) * 100,
      mustBeZero,
      violated: mustBeZero && after > before,
      worse: after - before > 0,
    };
  });
  const violations = rows
    .filter((r) => r.violated)
    .map((r) => `${r.label}: было ${r.before}, стало ${r.after} (обязано быть 0)`);
  return { rows, violations };
}
