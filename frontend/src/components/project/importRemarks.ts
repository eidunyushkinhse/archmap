// Что панель ввоза говорит о замечаниях: состояние строки статуса (§2 ТЗ, Р7),
// первая ошибка с её входом-виновником и отбор ПОКАЗЫВАЕМЫХ строк (Р3).
//
// Чистые функции без React: правила здесь ровно те, что видит пользователь, и
// проверяются они без рендера. Одно правило на экран и на копию для агента —
// копируется то, что показано.
import type { ImportPreviewOut } from "../../types";
import { splitErrorLine } from "./remainder";
import type { StatusError } from "./remainder";

/**
 * Состояние статуса. «Есть вопросы» — не беда, а работа: разбор не обязателен, и
 * кнопка окна активна в обоих зелёных состояниях. Красное — только отказ разбора.
 * Принимает сам флаг, а не сводку: у догрузки к живому проекту форма превью своя,
 * а правило статуса общее для обоих окон ввоза.
 */
export function statusState(ok: boolean, asks: number): "ok" | "ask" | "bad" {
  if (!ok) return "bad";
  return asks > 0 ? "ask" : "ok";
}

/**
 * Первая ошибка для строки под красным статусом. Виновник — первый вход с
 * непустой корзиной ошибок: чинить надо его, а искать глазами по чипам
 * пользователю незачем. Ошибки слитой схемы («входы не имеют общих корней»)
 * файла-виновника не имеют — они показываются без чипа и без ссылки.
 *
 * chip отдаёт подпись входа по его НОМЕРУ в сводке (нумерация сплошная: сначала
 * непустые YAML в порядке чипов, затем архивы) либо null, если такого чипа нет.
 */
export function firstError(
  summary: ImportPreviewOut,
  chip: (inputNo: number) => string | null,
): StatusError | undefined {
  const плохой = summary.file_remarks.find((f) => f.errors.length > 0);
  if (плохой !== undefined) {
    const label = chip(плохой.file);
    return {
      chipLabel: label,
      // Индекс входа 0-based: обратно в номер его переводит сама панель.
      chipIndex: label === null ? null : плохой.file - 1,
      ...splitErrorLine(плохой.errors[0]),
    };
  }
  const общая = summary.schema_errors[0] ?? summary.errors[0];
  if (общая === undefined) return undefined;
  return { chipLabel: null, chipIndex: null, ...splitErrorLine(общая) };
}

/**
 * Строки, ставшие вопросами разбора, с экрана уходят (Р3): иначе одно и то же
 * пользователь читает дважды — вопросом и замечанием, причём замечание советует
 * «поправьте после импорта вручную», хотя вопрос закрывает это здесь же.
 */
export const withoutConverted = (items: string[], converted: string[]): string[] =>
  converted.length === 0 ? items : items.filter((s) => !converted.includes(s));
