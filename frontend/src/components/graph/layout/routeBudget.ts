// ДЕТЕРМИНИРОВАННЫЙ БЮДЖЕТ РАБОТ РОУТЕРА И СТУПЕНИ ДЕГРАДАЦИИ
// (Ф5 эпика «глубокая оптимизация роутера», кандидат В1 плана; спека perf.md P12/P13).
//
// ЗАЧЕМ. Константные оптимизации (Ф1–Ф4) сняли −34…−36% времени, но ПОТОЛКА не дают:
// патологическая сцена найдётся всегда, а P2 обещает холодному прогону ≤10с. Бюджет —
// страховка хвоста: он не ускоряет типовые сцены, он не даёт редкой уродливой сцене
// вешаться на минуты.
//
// ЕДИНИЦА — РАБОТА, НЕ ВРЕМЯ. Бюджет считается в ЭКСПАНСИЯХ A* (__routeCounters.
// expansions), а не в миллисекундах. Причина принципиальная: E17 (тот же вход → тот же
// результат) — святыня движка, а бюджет по часам сделал бы геометрию функцией нагрузки
// машины: у одного пользователя ступень сработала, у другого нет, «у нас не
// воспроизводится». Date.now/Math.random в конвейере запрещены; performance.now живёт
// только в счётчиках-диагностике (prepMs/floodMs) и ни на одно РЕШЕНИЕ не влияет.
//
// ДВА КОНТУРА (переработка по ревью 6.2 — «отключить сварку при исчерпании»
// неисполнимо: сварка отрабатывает ВНУТРИ прохода-1, а больше половины работ горит
// позже, в T4):
//   • РЕАКТИВНЫЙ — ступени на естественных границах конвейера В ПОРЯДКЕ ИСПОЛНЕНИЯ:
//     потолок на вызов A* (внутри прохода-1, orthoRoute.CALL_EXPANSION_CAP) → пропуск
//     rip-up (граница внутри routeAll) → пропуск сварки (граница перед weldTrunks) →
//     пропуск T4 (граница перед мини-проходом). Ступень, неосуществимая в своей точке,
//     в реестр не входит (P13).
//   • АПРИОРНЫЙ — прогноз работ по размеру сцены ДО старта стадий: заведомо неподъёмная
//     сцена включает ступени с самого начала, не сжигая бюджет до первой границы.
//
// КАЛИБРОВКА ДЕФОЛТА — СТРАХОВОЧНАЯ, НЕ ЖЁСТКАЯ. Пороги заведомо выше эталонов:
// эталонные сцены НЕ деградируют ни одной ступенью (гейт фазы — дампы байт-в-байт).
// Жёсткая калибровка «под холодный ≤10с» — отдельное решение пользователя на приёмке:
// она означает СОЗНАТЕЛЬНУЮ жертву качества на живых сценах, а жертвы качества втихую
// в этом движке запрещены (правило эпика).
import { __routeCounters, CALL_EXPANSION_CAP } from "./orthoRoute";
import { OVERLOAD_NODES, OVERLOAD_EDGES } from "../constants";

/** Класс сцены по P1 (считается по ОТОБРАЖАЕМОМУ: локалы+гости против мастер-рёбер). */
export type SceneClass = "typical" | "limit" | "overload";

// Границы «типовой» сцены (P1: ≤50 узлов И ≤100 рёбер). Верхняя граница «предельной» —
// OVERLOAD_NODES/OVERLOAD_EDGES из graph/constants (там же живёт классификация P8).
export const TYPICAL_NODES = 50;
export const TYPICAL_EDGES = 100;

export function classifyScene(nodes: number, edges: number): SceneClass {
  if (nodes <= TYPICAL_NODES && edges <= TYPICAL_EDGES) return "typical";
  if (nodes <= OVERLOAD_NODES && edges <= OVERLOAD_EDGES) return "limit";
  return "overload";
}

/**
 * ЛИМИТ ЭКСПАНСИЙ НА ПОЛНЫЙ ПРОГОН СТАДИЙ КАЧЕСТВА, по классу сцены.
 *
 * ОБОСНОВАНИЕ ЧИСЕЛ (реплей на тихой машине, HEAD Ф4-II, счётчики __routeCounters):
 *   zabbix-root         36/85  — 13.53M экспансий (типовая, худшая из эталонов)
 *   sentry-root         51/128 — 15.79M           (предельная)
 *   level-zabbix-server 29/60  —  4.53M
 *   level-sentry-level  31/68  —  1.82M
 * Дефолты взяты ~2…2.5× от худшего эталона своего класса: 30M против 13.5M (типовая),
 * 40M против 15.8M (предельная), 50M сверх того. Это СТРАХОВКА ХВОСТА: на эталонах
 * бюджет не срабатывает и не может сработать — запас больше, чем разброс между
 * эталонами одного размера (см. комментарий к forecastExpansions: две level-сцены
 * почти одного размера отличаются по работам в 2.5 раза).
 */
export const ROUTE_BUDGET_BY_CLASS: Record<SceneClass, number> = {
  typical: 30_000_000,
  limit: 40_000_000,
  overload: 50_000_000,
};

// ДОЛИ БЮДЖЕТА, НА КОТОРЫХ ВКЛЮЧАЮТСЯ СТУПЕНИ. Порядок долей = порядок конвейера:
// чем позже точка, тем позже она сдаётся. Смысл: rip-up — самая дорогая стадия
// (51–64% экспансий эталонов) и самая «улучшающая, но не обязательная», поэтому она
// уступает первой; сварка косметична (E78/E79 — слитые стволы); T4 — читаемость
// подписей, последнее, чем платим, потому что его цена уже почти вся впереди.
export const BUDGET_SKIP_RIPUP_SHARE = 0.5;
export const BUDGET_SKIP_WELD_SHARE = 0.7;
export const BUDGET_SKIP_T4_SHARE = 0.85;

// АПРИОРНОЕ УЖЕСТОЧЕНИЕ ПОТОЛКА ВЫЗОВА: сцена, чей прогноз не влезает в лимит класса,
// получает вдвое более тесный потолок одного поиска — единичный сверхтяжёлый A* на ней
// заведомо не окупается.
export const BUDGET_APRIORI_CAP_DIVISOR = 2;

// КОЭФФИЦИЕНТЫ ПРОГНОЗА (априорный контур). ЧЕСТНО: это НЕ подгонка модели, а ВЕРХНЯЯ
// ОГИБАЮЩАЯ. Подгонка невозможна и вредна — работы определяются ГЕОМЕТРИЕЙ сцены, а не
// её размером: level-sentry-level (31/68) стоит 1.82M, а level-zabbix-server (29/60) —
// почти та же по размеру — 4.53M, в 2.5 раза дороже. Любая модель «от узлов и рёбер»
// несёт эту ошибку в себе, поэтому прогноз калиброван так, чтобы:
//   (1) НИ ОДИН эталон не был пере-оценён до срабатывания ступеней: прогноз эталона не
//       выше 70% лимита своего класса (проверено тестом), то есть априорный контур
//       включится лишь на сцене примерно в полтора раза крупнее эталонной;
//   (2) внутри «типовой» сцены (≤50/≤100) прогноз НИКОГДА не превышал 30M — класс,
//       которому P2 обещает бюджет, априорных ступеней не получает по построению;
//   (3) сцена, вылезшая за эталонную огибающую кратно, ступени всё же получила.
// EXP_PER_EDGE — худшая удельная цена ребра среди эталонов (zabbix-root: 13.53M/85 ≈
// 159K) с запасом ~13%. EXP_PER_NODE — вторичный член ПЛОТНОСТИ СЕТКИ: каждое тело даёт
// 4 грид-линии, и пространство состояний A* (NX·NY·5) растёт от узлов даже при
// неизменном числе рёбер; взят втрое меньше рёберного.
export const EXP_PER_EDGE = 180_000;
export const EXP_PER_NODE = 60_000;

/** Прогноз работ полного прогона стадий качества (экспансии A*), априорный контур. */
export function forecastExpansions(
  nodes: number, edges: number, cfg: RouteBudgetConfig = DEFAULT_ROUTE_BUDGET,
): number {
  return cfg.expPerEdge * edges + cfg.expPerNode * nodes;
}

/**
 * Конфиг бюджета. В ПРОДЕ НЕ ПЕРЕОПРЕДЕЛЯЕТСЯ — дефолт-константы и есть контракт (они
 * входят в реестр ROUTER_VERSION). Параметризован ради ТЕСТОВ и полигонов: форс-бюджет
 * с крошечными лимитами гоняет ступени на обычной сцене, не выдумывая патологическую.
 * Ровно тот же приём, что у PipelineInput.edgeQuality (пер-прогонная ручка поведения),
 * и сознательно НЕ глобальный мутабельный синглтон: тот сделал бы тесты
 * порядкозависимыми, а конвейер — нереентерабельным.
 */
export interface RouteBudgetConfig {
  byClass: Record<SceneClass, number>;
  callCap: number;
  skipRipupShare: number;
  skipWeldShare: number;
  skipT4Share: number;
  aprioriCapDivisor: number;
  expPerEdge: number;
  expPerNode: number;
}

export const DEFAULT_ROUTE_BUDGET: RouteBudgetConfig = {
  byClass: ROUTE_BUDGET_BY_CLASS,
  callCap: CALL_EXPANSION_CAP,
  skipRipupShare: BUDGET_SKIP_RIPUP_SHARE,
  skipWeldShare: BUDGET_SKIP_WELD_SHARE,
  skipT4Share: BUDGET_SKIP_T4_SHARE,
  aprioriCapDivisor: BUDGET_APRIORI_CAP_DIVISOR,
  expPerEdge: EXP_PER_EDGE,
  expPerNode: EXP_PER_NODE,
};

/** Какие ступени реально сработали в прогоне (PipelineOutput.budgetDegraded). */
export interface BudgetDegraded {
  /** rip-up не гонялся (routeAll) */
  ripup: boolean;
  /** сварка стволов не гонялась (buildAutoRoutes) */
  weld: boolean;
  /** T4-мини-проход не гонялся (pipeline) */
  t4: boolean;
  /** сколько вызовов A* доигрывались гриди-фолбэком потолка */
  greedyCalls: number;
}

/**
 * Состояние бюджета ОДНОГО прогона стадий качества. Живёт по значению и ездит
 * ПАРАМЕТРОМ (buildAutoRoutes.budget → routeAll.budget): глобального состояния у
 * бюджета нет. Расход при этом читается из ГЛОБАЛЬНОГО счётчика __routeCounters —
 * это легально и не ломает реентерабельность: счётчик накопительный, бюджет держит
 * СВОЮ отметку старта и работает с дельтой.
 */
export interface RouteBudget {
  readonly sceneClass: SceneClass;
  readonly limit: number;
  /** потолок экспансий одного вызова A* (в опции routePorts) */
  readonly callCap: number;
  /** прогноз априорного контура (для диагностики/тестов) */
  readonly forecast: number;
  /** априорный контур сработал: ступени включены с самого старта */
  readonly apriori: boolean;
  /** израсходовано экспансий с момента создания бюджета */
  spent(): number;
  /** РЕШЕНИЕ ступени «пропустить rip-up» (оно же — фиксация факта) */
  takeRipup(): boolean;
  /** РЕШЕНИЕ ступени «пропустить сварку» */
  takeWeld(): boolean;
  /** РЕШЕНИЕ ступени «пропустить T4» */
  takeT4(): boolean;
  /** Итог прогона: null — ни одна ступень не срабатывала (обычный случай). */
  result(): BudgetDegraded | null;
}

/**
 * Бюджет прогона. Создаётся ОДИН раз, непосредственно перед стадиями качества: отметка
 * старта — текущее значение счётчика экспансий, всё, что натикает дальше, — расход.
 */
export function createRouteBudget(params: {
  nodes: number;
  edges: number;
  config?: RouteBudgetConfig;
}): RouteBudget {
  const cfg = params.config ?? DEFAULT_ROUTE_BUDGET;
  const sceneClass = classifyScene(params.nodes, params.edges);
  const limit = cfg.byClass[sceneClass];
  const forecast = forecastExpansions(params.nodes, params.edges, cfg);
  const apriori = forecast > limit;
  const callCap = apriori ? Math.max(1, Math.floor(cfg.callCap / cfg.aprioriCapDivisor)) : cfg.callCap;
  const expAtStart = __routeCounters.expansions;
  const greedyAtStart = __routeCounters.budgetGreedyCalls;
  const fired: { ripup: boolean; weld: boolean; t4: boolean } = { ripup: false, weld: false, t4: false };
  const spent = (): number => __routeCounters.expansions - expAtStart;
  // Априорный контур включает ступень безусловно; реактивный — по доле израсходованного.
  const over = (share: number): boolean => apriori || spent() > share * limit;
  return {
    sceneClass, limit, callCap, forecast, apriori,
    spent,
    // Возвращают РЕШЕНИЕ для СВОЕЙ точки, а отметку ставят ЛИПКО: buildAutoRoutes зовётся
    // за прогон дважды (проход 1 и T4-мини-проход), и второе решение не должно стирать
    // факт первой сработавшей ступени.
    takeRipup: () => { const v = over(cfg.skipRipupShare); if (v) fired.ripup = true; return v; },
    takeWeld: () => { const v = over(cfg.skipWeldShare); if (v) fired.weld = true; return v; },
    takeT4: () => { const v = over(cfg.skipT4Share); if (v) fired.t4 = true; return v; },
    result: () => {
      const greedyCalls = __routeCounters.budgetGreedyCalls - greedyAtStart;
      if (!fired.ripup && !fired.weld && !fired.t4 && greedyCalls === 0) return null;
      return { ...fired, greedyCalls };
    },
  };
}
