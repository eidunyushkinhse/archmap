// Что панель ввоза говорит о замечаниях: состояние строки статуса (§2 ТЗ, Р7),
// ошибки отказа с их входами-виновниками и отбор ПОКАЗЫВАЕМЫХ строк (Р3).
//
// Чистые функции без React: правила здесь ровно те, что видит пользователь, и
// проверяются они без рендера.
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
 * ВСЕ ошибки отказа для красного статуса (правка Ф2г: карточки ошибок у файла
 * больше нет — статус единственное место, где их видно). Порядок: входы по
 * номеру, внутри входа — порядок бэка; затем ошибки слитой схемы («входы не
 * имеют общих корней»), у которых файла-виновника нет — они без чипа и ссылки.
 * Пусто в корзинах (сводка отказа без разметки, например отказ самой проверки) —
 * плоский список ошибок сводки.
 *
 * chip отдаёт подпись входа по его НОМЕРУ в сводке (нумерация сплошная: сначала
 * непустые YAML в порядке чипов, затем архивы) либо null, если такого чипа нет.
 */
export function allErrors(
  summary: ImportPreviewOut,
  chip: (inputNo: number) => string | null,
): StatusError[] {
  const пофайловые = summary.file_remarks.flatMap((f) => {
    const label = chip(f.file);
    return f.errors.map((e) => ({
      chipLabel: label,
      // Индекс входа 0-based: обратно в номер его переводит сама панель.
      chipIndex: label === null ? null : f.file - 1,
      ...splitErrorLine(e),
    }));
  });
  const общие = (summary.schema_errors.length > 0 || пофайловые.length > 0
    ? summary.schema_errors
    : summary.errors
  ).map((e) => ({ chipLabel: null, chipIndex: null, ...splitErrorLine(e) }));
  return [...пофайловые, ...общие];
}

/**
 * Строки, ставшие вопросами разбора, с экрана уходят (Р3): иначе одно и то же
 * пользователь читает дважды — вопросом и замечанием, причём замечание советует
 * «поправьте после импорта вручную», хотя вопрос закрывает это здесь же.
 */
export const withoutConverted = (items: string[], converted: string[]): string[] =>
  converted.length === 0 ? items : items.filter((s) => !converted.includes(s));
