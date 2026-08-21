// ВЕРСИЯ РОУТЕРА И СТОРОЖ ЕГО КОНСТАНТ (Ф2 эпика «глубокая оптимизация роутера»,
// спека perf.md P11).
//
// ЗАЧЕМ. Персистный кэш маршрутов вида (routeCacheStore.ts) отдаёт готовую геометрию
// при совпадении routeSig. Но routeSig описывает только ВХОДЫ сцены (позиции, габариты,
// состав рёбер, рамки) — она НЕ видит КОНСТАНТ АЛГОРИТМА. Поменяли штраф креста,
// порог гистерезиса или ширину плашки — тот же вход обязан дать ДРУГИЕ маршруты, а
// кэш, записанный до правки, молча отдавал бы старые: «протухший кэш» — риск R2 плана.
//
// КАК ЗАКРЫТО. Не дисциплиной («не забудь бампнуть»), а МЕХАНИКОЙ:
//   1. collectRouterConstants() собирает ВСЕ значения, влияющие на геометрию маршрутов
//      и плашек (роутер, набор, сварка, мост домена, нуджинг, джоги, рамочная плашка,
//      модель габаритов подписи);
//   2. hashRouterConstants() сворачивает их в хэш;
//   3. CONSTANTS_HASH_BY_VERSION хранит ИСТОРИЮ пар «версия → хэш»;
//   4. routerVersion.test.ts сверяет живой хэш с зарегистрированным для ROUTER_VERSION
//      и падает при расхождении.
// Запись кэша штампуется ROUTER_VERSION, чтение отвергает чужую версию — записи,
// сделанные прежним роутером, не читаются никогда.
//
// ДВА СЛОЯ СТОРОЖА (Ф4-I, 2026-08-21). Хэш констант ловит правку ЗНАЧЕНИЙ, но геометрия
// умеет измениться и БЕЗ единой правки константы — алгоритмически (сегодняшний случай:
// живой спан вето нуджинга E33 и плашки рамок в moveDock E11: маршруты поехали, реестр
// не дрогнул, сторож остался зелёным). Поэтому слоёв два:
//   1. МЕХАНИКА — к каноническому тексту реестра тест-сторож дописывает ПОВЕДЕНЧЕСКИЙ
//      ДОВЕСОК: хэш СОДЕРЖИМОГО __tests__/golden/routerFuzz.json. Любая правка, которая
//      реально сдвинула маршруты роутерного ядра, обязана перегенерировать golden — а
//      значит меняет и объединённый хэш, без всякой дисциплины.
//      ОХВАТ ДОВЕСКА, ЧЕСТНО: golden считается по ПУТИ buildAutoRoutes (порты, A*,
//      rip-up, слоты, сварка, штрафы рамок/плашек). Полигон НЕ гоняет канальный нуджинг,
//      спрямление джогов и размещение плашек — правки ЭТИХ стадий довесок не увидит.
//   2. ПРОТОКОЛ — для них ручная ревизия ROUTER_ALGO_REV (ниже). Слой честно ручной:
//      механики на него в эпике не нашлось.
// ФАЙЛ GOLDEN ЧИТАЕТ ТОЛЬКО ТЕСТ: routerVersion.ts едет в бандл ВОРКЕРА, и fs/чтение
// мегабайтного фикстура там недопустимы. Модуль даёт канонический текст реестра
// (canonicalRouterConstants), довесок и объединённый хэш считает тест.
//
// ПРОТОКОЛ ПРАВКИ КОНСТАНТЫ (он же — текст падения теста):
//   изменил значение → бампни ROUTER_VERSION на 1 → добавь в CONTRACT_HASH_BY_VERSION
//   пару «новая версия → новый хэш» (старые пары НЕ трогай — это история).
// Добавил НОВУЮ константу геометрии → внеси её в реестр ниже и пройди тот же протокол.
// ИЗМЕНИЛ ГЕОМЕТРИЮ МАРШРУТОВ БЕЗ ПРАВКИ КОНСТАНТ (алгоритм, порядок, условие вето) →
//   бампни ROUTER_ALGO_REV и пройди тот же протокол (ROUTER_VERSION + пара в истории).
//   Если правка задела роутерное ядро, golden всё равно перегенерируется и уронит тест
//   сам — ROUTER_ALGO_REV страхует стадии, которых полигон не видит.
import {
  DEFAULT_MARGIN as ORTHO_DEFAULT_MARGIN,
  DEFAULT_BEND_PENALTY as ORTHO_BEND_PENALTY,
  EPS as ORTHO_EPS,
} from "./orthoRoute";
import {
  DEFAULT_CROSS_COST, OVERLAP_COST, ROUTE_STICKINESS, PORT_CONFLICT_COST,
  JOG_MAX, JOG_CLEAR, LINE_CLEAR,
} from "./routeAll";
import {
  MERGE_GAIN, WELD_STRETCH, WELD_STRETCH_SLACK, WELD_K, WELD_ITER_CAP, WELD_EPS,
} from "./weldTrunks";
import { FRAME_CROSS_COST, LABEL_CROSS_COST } from "./autoRoutes";
import { ROUTE_SCOPE_PAD, SCOPE_FULL_RECALC_SHARE } from "./incrementalScope";
import {
  NUDGE_GAP, NUDGE_GAP_LADDER, NUDGE_CLEAR, EPS as NUDGE_EPS,
  OVERLAP_MIN as NUDGE_OVERLAP_MIN, NEAR_OVERLAP_MIN as NUDGE_NEAR_OVERLAP_MIN,
  MAX_EVICT as NUDGE_MAX_EVICT,
} from "./channelNudge";
import {
  FRAME_PLAQUE_INSET_X, FRAME_PLAQUE_BOTTOM, FRAME_PLAQUE_H,
  FRAME_PLAQUE_BASE_W, FRAME_PLAQUE_CHAR_W,
} from "./frames";
import {
  LABEL_FONT_PX, LABEL_CHAR_PX, LABEL_CHROME_X, LABEL_CHROME_Y, metaLabelBox,
} from "./labelBox";
import { EDGE_STUB, NODE_W, NODE_H } from "../constants";

/**
 * Версия геометрического контракта роутера. Растёт на 1 при ЛЮБОЙ правке констант из
 * реестра ниже. Кэш маршрутов, записанный с другой версией, не читается (см.
 * routeCacheStore.load).
 */
export const ROUTER_VERSION = 4;

/**
 * РЕВИЗИЯ АЛГОРИТМА — ручной слой сторожа (см. шапку). Растёт на 1 при правке, которая
 * меняет ГЕОМЕТРИЮ маршрутов, не трогая ни одной константы реестра: условие вето, порядок
 * обхода, набор препятствий стадии. Значение само по себе ничего не означает — оно просто
 * входит в хэш контракта, и его бамп инвалидирует кэши прежних версий.
 * История: 1 — Ф4-I эпика «глубокая оптимизация роутера» (живой спан вето нуджинга E33 +
 * плашки раскрытых рамок в проверке переноса стыковки E11); 2 — Ф4-II того же эпика
 * (Б3б «сначала подвинь плашку», E40 v2: конфликт «маршрут режет плашку» сначала чинится
 * пере-размещением ПЛАШКИ, состав перепрокладываемых рёбер и позиции плашек меняются).
 * Правка целиком лежит ВНЕ охвата фазз-полигона (он не гоняет размещение плашек и зовёт
 * buildAutoRoutes напрямую, минуя pipeline) — золото не дрогнуло, сторожит ручной слой.
 */
export const ROUTER_ALGO_REV = 2;

// Зонды формул, у которых нет отдельной именованной константы: изменение ЛЮБОГО их
// внутреннего параметра (высота строки, ширина переноса wrapLabel, модель мастера)
// меняет число здесь. Тексты синтетические и фиксированные — зонд обязан быть
// детерминированным и не зависеть от данных проекта.
const LABEL_PROBE_TEXT = "abcdefghij klmnopqrst uvwxyz0123";
function labelBoxProbe(lines: number): { w: number; h: number } {
  return metaLabelBox({ text: LABEL_PROBE_TEXT, lines });
}

/**
 * Реестр констант, влияющих на ГЕОМЕТРИЮ маршрутов и плашек. Ключи — стабильные имена
 * (их видно в диффе теста-сторожа), значения — сами константы или зонды формул.
 */
export function collectRouterConstants(): Record<string, unknown> {
  return {
    // --- A* одного ребра (orthoRoute) ---
    "orthoRoute.DEFAULT_MARGIN": ORTHO_DEFAULT_MARGIN,
    "orthoRoute.DEFAULT_BEND_PENALTY": ORTHO_BEND_PENALTY,
    "orthoRoute.EPS": ORTHO_EPS,
    // --- набор и пост-стадии (routeAll) ---
    "routeAll.DEFAULT_CROSS_COST": DEFAULT_CROSS_COST,
    "routeAll.OVERLAP_COST": OVERLAP_COST,
    "routeAll.ROUTE_STICKINESS": ROUTE_STICKINESS,
    "routeAll.PORT_CONFLICT_COST": PORT_CONFLICT_COST,
    "routeAll.JOG_MAX": JOG_MAX,
    "routeAll.JOG_CLEAR": JOG_CLEAR,
    "routeAll.LINE_CLEAR": LINE_CLEAR,
    // --- сварка стволов вееров (weldTrunks) ---
    "weldTrunks.MERGE_GAIN": MERGE_GAIN,
    "weldTrunks.WELD_STRETCH": WELD_STRETCH,
    "weldTrunks.WELD_STRETCH_SLACK": WELD_STRETCH_SLACK,
    "weldTrunks.WELD_K": WELD_K,
    "weldTrunks.WELD_ITER_CAP": WELD_ITER_CAP,
    "weldTrunks.WELD_EPS": WELD_EPS,
    // --- мост домена (autoRoutes) ---
    "autoRoutes.FRAME_CROSS_COST": FRAME_CROSS_COST,
    "autoRoutes.LABEL_CROSS_COST": LABEL_CROSS_COST,
    // --- инкрементальный скоуп (Ф3, E84): решает, КАКИЕ рёбра перепрокладываются, а
    // какие остаются замороженным prev-контекстом. Геометрию сцены это меняет так же
    // прямо, как штраф или зазор, — потому и здесь.
    "incrementalScope.ROUTE_SCOPE_PAD": ROUTE_SCOPE_PAD,
    "incrementalScope.SCOPE_FULL_RECALC_SHARE": SCOPE_FULL_RECALC_SHARE,
    // --- канальный нуджинг (channelNudge) ---
    "channelNudge.NUDGE_GAP": NUDGE_GAP,
    "channelNudge.NUDGE_GAP_LADDER": [...NUDGE_GAP_LADDER],
    "channelNudge.NUDGE_CLEAR": NUDGE_CLEAR,
    "channelNudge.EPS": NUDGE_EPS,
    "channelNudge.OVERLAP_MIN": NUDGE_OVERLAP_MIN,
    "channelNudge.NEAR_OVERLAP_MIN": NUDGE_NEAR_OVERLAP_MIN,
    "channelNudge.MAX_EVICT": NUDGE_MAX_EVICT,
    // --- плашка подписи РАМКИ: жёсткое препятствие роутера (E21) ---
    "frames.FRAME_PLAQUE_INSET_X": FRAME_PLAQUE_INSET_X,
    "frames.FRAME_PLAQUE_BOTTOM": FRAME_PLAQUE_BOTTOM,
    "frames.FRAME_PLAQUE_H": FRAME_PLAQUE_H,
    "frames.FRAME_PLAQUE_BASE_W": FRAME_PLAQUE_BASE_W,
    "frames.FRAME_PLAQUE_CHAR_W": FRAME_PLAQUE_CHAR_W,
    // --- модель габаритов плашки ПОДПИСИ РЕБРА (T4 делает их препятствиями) ---
    "labelBox.LABEL_FONT_PX": LABEL_FONT_PX,
    "labelBox.LABEL_CHAR_PX": LABEL_CHAR_PX,
    "labelBox.LABEL_CHROME_X": LABEL_CHROME_X,
    "labelBox.LABEL_CHROME_Y": LABEL_CHROME_Y,
    "labelBox.probe(1)": labelBoxProbe(1),
    "labelBox.probe(3)": labelBoxProbe(3),
    // --- РЕВИЗИЯ АЛГОРИТМА: ручной слой (правки геометрии без правки констант) ---
    "routerVersion.ROUTER_ALGO_REV": ROUTER_ALGO_REV,
    // --- геометрия узла и стаба (тела-препятствия и фолбэк габаритов) ---
    "constants.EDGE_STUB": EDGE_STUB,
    "constants.NODE_W": NODE_W,
    "constants.NODE_H": NODE_H,
  };
}

/** Канонический текст реестра: ключи по алфавиту, значения — JSON. */
export function canonicalRouterConstants(): string {
  const reg = collectRouterConstants();
  return Object.keys(reg)
    .sort()
    .map((k) => `${k}=${JSON.stringify(reg[k])}`)
    .join("\n");
}

// Хэш — FNV-1a ⧺ djb2 (16 hex): вдвое шире 32 бит, случайная коллизия исключена.
// Функции ПРОДУБЛИРОВАНЫ здесь осознанно: одноимённые живут в __tests__/routerFuzz.ts,
// но это тестовый модуль — импорт из прод-кода утащил бы фазз-полигон в бандл.
// Дублирование безопасно: сторож сравнивает вычисленный хэш с ЛИТЕРАЛОМ истории, а не
// с чужим вычислением, поэтому расхождение реализаций невозможно по построению.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Хэш живого реестра констант роутера. */
export function hashRouterConstants(): string {
  const s = canonicalRouterConstants();
  return fnv1a(s) + djb2(s);
}

/**
 * ИСТОРИЯ «версия → хэш КОНТРАКТА». Пары НЕПРИКОСНОВЕННЫ: старая пара документирует,
 * с каким контрактом жили записи кэша той версии. Новая правка = новая версия + новая
 * пара (см. протокол в шапке файла).
 * ВНИМАНИЕ: у v1/v2 хэш считался ТОЛЬКО по реестру констант; с v3 он объединённый —
 * реестр ⧺ поведенческий довесок (хэш golden фазз-полигона), см. routerVersion.test.ts.
 * Сравнивать пары РАЗНЫХ эпох между собой бессмысленно, их дело — быть различными.
 */
export const CONTRACT_HASH_BY_VERSION: Record<number, string> = {
  // v1 — состояние на конец Ф1 эпика router-opt (правки А1/А3а/А4/А2.1 были
  // байт-в-байт и ни одной константы не тронули).
  1: "046fda3d91037385",
  // v2 — Ф3 того же эпика: в реестр вошли константы инкрементального скоупа
  // (ROUTE_SCOPE_PAD, SCOPE_FULL_RECALC_SHARE). Сами маршруты ПОЛНОГО прогона не
  // изменились ни на пиксель (дампы 4 сцен и фазз-полигон байт-в-байт), но записи
  // кэша v1 честно инвалидируются: реестр вырос, а значит контракт роутера — другой.
  2: "fb30729cfe5da8c2",
  // v3 — Ф4-I того же эпика (заход «корректность»). Впервые хэш ОБЪЕДИНЁННЫЙ: реестр
  // (в нём появился ROUTER_ALGO_REV) ⧺ хэш golden фазз-полигона. Маршруты изменились
  // по делу: плашки раскрытых рамок в проверке переноса стыковки (E11×E21, 6 сидов
  // полигона) и живой спан вето канального нуджинга (E33, ребро f36d0019… Zabbix-корня
  // перестало входить в чужое тело). Записи кэша v2 несут ДОФИКСОВУЮ геометрию — их
  // инвалидация и есть смысл бампа.
  3: "1fd57805cfa66209",
  // v4 — Ф4-II того же эпика (заход «T4-пересмотр», кандидат Б3б). Маршруты и плашки
  // изменились: конфликт «линия сквозь чужой текст» сначала чинится пере-размещением
  // ПЛАШКИ (E40 v2), а состав грязных рёбер мини-прохода из-за этого другой. Правка
  // живёт в pipeline/placeLabels — вне охвата поведенческого довеска, поэтому версию
  // двигает ручной слой ROUTER_ALGO_REV (1 → 2). Записи кэша v3 несут дофиксовую
  // геометрию — их инвалидация и есть смысл бампа.
  4: "f458a408d3eafe4a",
};
