// Авто-центрирование страничных схем (fitOnLoad/fitOnExpand). Вынесено из LevelGraph
// (аудит F-1) тем же эффектом, на том же месте в порядке хуков.
//
// Раскладка двухфазная (фолбэк-габариты → замер → пере-прогон), поэтому фитим НЕ на
// первом проходе, а по оседании: дебаунс на смене layout/sizesVersion ловит последний
// прогон в окне.
//  - Загрузка (fitOnLoad): одноразово (didLoadFitRef), после первого замера
//    (sizesVersion ≥ 1), БЕЗ анимации — правит «спозание» декларативного fitView,
//    который сгорает на первом проходе и оставляет схему «вверху и мелко».
//  - Раскрытие/сворачивание/«Переразложить» (fitOnExpand): по запросу autoFitRef
//    (взводят commitExpanded и эффект relayoutToken), С анимацией
//    (duration = ANIM_MOVE_MS) — по оседании переезда узлов.
// Оба — через SCHEMA_FIT_OPTIONS (== кнопка «Центрировать»). Не fitOnLoad/Expand
// (редактор-карта) — эффект no-op, центрирование редактора не меняется.
import { useEffect } from "react";
import type { useReactFlow } from "@xyflow/react";
import { ANIM_MOVE_MS } from "./layoutAnimation";
import type { LayoutResult } from "../layout/pipeline";

// Параметры центрирования страничных схем (fitOnLoad/fitOnExpand и «Центрировать»
// встроенных блоков): единый источник, чтобы авто-фит и ручное центрирование давали
// идентичный вид. maxZoom 1.0 — не раздувать разреженные схемы (1–2 узла) крупнее
// натурального размера, но и не мельчить (прежние 0.85 оставляли схемы «мелко»).
export const SCHEMA_FIT_OPTIONS = { padding: 0.1, maxZoom: 1.0 };
// Тихое окно авто-центрирования: фит стартует, когда после последнего RF-коммита
// прошло не меньше FIT_QUIET_MS (анимация не бьётся о коммиты), но не дольше
// FIT_ATTEMPTS попыток по 140ms (не откладываем вечно при непрерывных изменениях).
const FIT_QUIET_MS = 300;
const FIT_ATTEMPTS = 10;
// Срок годности запроса на анимированное центрирование (autoFitRef). Обычный путь
// «взвели → пришёл свежий прогон → анимация осела → фит» укладывается в ~2–3с даже
// на нагруженной схеме. Потолок нужен там, где ожидаемого прогона НЕ будет:
// «Переразложить» на уже авто-разложенной схеме раскладку не меняет (скип по
// layoutSig), эффект не перезапускается — и протухший запрос иначе сработал бы на
// следующей смене раскладки (например, после драга), дёрнув схему без причины.
const AUTO_FIT_TTL_MS = 8_000;

export function useLevelAutoFit({
  layout, sizesVersion, hasGraphContent, fitOnLoad, fitOnExpand, fitView, animActive,
  lastRfCommitRef, didLoadFitRef, autoFitRef,
}: {
  // Применённая раскладка: её смена (и смена замеров) перезапускает отсчёт тихого окна.
  layout: LayoutResult | null;
  sizesVersion: number;
  hasGraphContent: boolean;
  fitOnLoad: boolean;
  fitOnExpand: boolean;
  fitView: ReturnType<typeof useReactFlow>["fitView"];
  // Окно анимации раскрытия/сворачивания/переезда: фит по запросу ждёт её оседания.
  animActive: boolean;
  lastRfCommitRef: { current: number };
  didLoadFitRef: { current: boolean };
  autoFitRef: { current: number | null };
}): void {
  useEffect(() => {
    if ((!fitOnLoad && !fitOnExpand) || !hasGraphContent) return;
    let cancelled = false;
    let timer = 0;
    const attempt = (n: number) => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        // ТИХОЕ ОКНО: фит стартует, только когда после последнего RF-коммита
        // (apply/drawIn/маски) прошло FIT_QUIET_MS — иначе анимация центрирования
        // начинается внутри тяжёлого коммита (первые кадры задержаны) и бьётся о
        // последующие (фризы посреди анимации; трейс 2026-08-06). Не тихо и лимит
        // попыток не исчерпан — ждём дальше; исчерпан — фитим как есть (лучше
        // поздно и чуть дёргано, чем никогда).
        if (performance.now() - lastRfCommitRef.current < FIT_QUIET_MS && n < FIT_ATTEMPTS) {
          attempt(n + 1);
          return;
        }
        if (!didLoadFitRef.current && fitOnLoad && sizesVersion >= 1) {
          didLoadFitRef.current = true;
          fitView(SCHEMA_FIT_OPTIONS);
          return;
        }
        // Фит по запросу — только когда анимация ОСЕЛА (!animActive). Иначе при
        // сворачивании fitView ловит промежуточную фазу схлопывания (потомки ещё
        // стягиваются в точку) и считает viewport по ним, а не по итоговому
        // свёрнутому составу — схема «уезжает в угол». По оседании (animActive=false)
        // эффект перезапускается и фит считается по финальным узлам — одинаково для
        // раскрытия, сворачивания и переразкладки. Протухший запрос (AUTO_FIT_TTL_MS)
        // гасим молча: ожидавшегося прогона не случилось, центрировать нечего.
        if (autoFitRef.current !== null && fitOnExpand && !animActive) {
          const stale = performance.now() - autoFitRef.current > AUTO_FIT_TTL_MS;
          autoFitRef.current = null;
          if (!stale) fitView({ ...SCHEMA_FIT_OPTIONS, duration: ANIM_MOVE_MS });
        }
      }, 140);
    };
    attempt(0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // relayoutToken в зависимостях НЕТ намеренно: запрос взводится в момент сброса, а
    // фитить надо по ПРИШЕДШЕЙ раскладке (layout) — перезапуск по токену стартовал бы
    // отсчёт до рефетча и центрировал старую геометрию.
  }, [layout, sizesVersion, hasGraphContent, fitOnLoad, fitOnExpand, fitView, animActive,
    lastRfCommitRef, didLoadFitRef, autoFitRef]);
}
