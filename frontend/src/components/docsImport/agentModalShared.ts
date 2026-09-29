// Общие НЕ-компонентные части BYOA-модалок (DocsAgentModal — схемы логики,
// SpecAgentPanel — OpenAPI-спека): бейджи действий превью, подсчёт действий и
// inline-стили двухколоночного макета (чипы файлов, редактор, подвал). Стили
// переиспользуются как есть — окна визуально едины. Компоненты отчёта
// (ItemList/NoteList) — в agentModalReport.tsx (требование react-refresh:
// файл экспортирует только компоненты).
import { useState } from "react";
import type { CSSProperties } from "react";

// Бейдж действия превью/применения (action из отчёта бэка)
export const ACTION_LABEL: Record<string, string> = {
  create: "новая",
  // Заполнение ЗАГЛУШКИ разведки (пустая схема): безопасно и галки не требует —
  // отличать от настоящей перезаписи пользователь обязан с одного взгляда.
  fill: "заполнит заглушку",
  overwrite: "перезапись",
  skip: "пропуск (занято)",
  unchanged: "без изменений",
};

// Подсчёт строк отчёта с данным действием (для итоговых строк и доступности кнопок)
export function countAction(arr: { action: string }[], action: string): number {
  return arr.filter((a) => a.action === action).length;
}

// ── проверка схем настоящим mermaid-парсером ──────────────────────────
// Кап замечаний о непарсящихся схемах: замечания уезжают агенту ОДНИМ списком, и
// тридцать строк одного класса вытеснят все остальные (кап-паттерн бэковых проверок).
export const MAX_MERMAID_REMARKS = 10;

export interface MermaidCheck {
  // Ошибка на каждую схему пакета в порядке отчёта (null — схема парсится).
  errs: (string | null)[];
  // Замечания для агента: «файл: mermaid не парсится — <первая строка парсера>».
  remarks: string[];
}

/** Прогнать схемы пакета через парсер и собрать замечания к непарсящимся.
 *
 * Парсер ВНЕДРЯЕТСЯ (в проде — validateMermaid, за которым ленивый чанк mermaid):
 * так проверка тестируется без тяжёлого чанка, а модалка не тянет mermaid, пока
 * пакета нет. Замечание называет ФАЙЛ, а не имя схемы: чинит агент файлы, и
 * «01-create-order.mmd» он у себя найдёт сразу, а «схему "Приём заказа"» — нет.
 * Первой строки сообщения парсера достаточно: в ней номер строки и указатель на
 * позицию (урок починки YAML-классов — точная координата закрывает класс за заход).
 */
export async function checkMermaid(
  rows: { source: string; mermaid: string }[],
  validate: (text: string) => Promise<string | null>,
): Promise<MermaidCheck> {
  const errs = await Promise.all(rows.map((r) => validate(r.mermaid)));
  const remarks: string[] = [];
  let hidden = 0;
  rows.forEach((row, i) => {
    const err = errs[i];
    if (!err) return;
    if (remarks.length >= MAX_MERMAID_REMARKS) {
      hidden += 1;
      return;
    }
    remarks.push(`${row.source}: mermaid не парсится — ${err.split("\n")[0].trim()}`);
  });
  if (hidden > 0) remarks.push(`…ещё ${hidden} схем не парсятся`);
  return { errs, remarks };
}

// ── гвард «вход не изменился между заходами» ──────────────────────────
// Полевая приёмка (Zabbix): агент пользователя в трёх кругах замечаний подряд
// отчитывался «Исправление: добавлена связь…», НЕ тронув файл, — пользователь трижды
// перетаскивал байт-в-байт тот же документ, а валидатор честно повторял то же самое
// замечание. Отличить новый вход от старого машина умеет точно, и молчать об этом
// значит оставлять пользователя гадать, кто из двоих ошибся.

export const UNCHANGED_INPUT_NOTE =
  "Содержимое не изменилось с прошлой проверки — агент мог отчитаться об исправлении, " +
  "не внеся его. Проверьте файл, который он отдал.";

/** Точный отпечаток входа окна: имена и содержимое файлов (у документов панели
 * импорта имён нет — только тексты). Разделители — служебные символы, которых не
 * бывает ни в YAML, ни в mermaid: склейка «a»+«b» не должна совпасть с «ab». */
export function inputFingerprint(
  files: readonly (string | { name: string; content: string })[],
): string {
  return files
    .map((f) => (typeof f === "string" ? f : `${f.name}\u0000${f.content}`))
    .join("\u0001");
}

/** true — окно получило ТОТ ЖЕ вход, что проверяло в прошлый заход.
 *
 * Заходом считается новый массив входа (перетащили, вставили, поправили текст,
 * убрали файл): сравнение ПО ССЫЛКЕ отделяет действие пользователя от повторного
 * рендера и от переключения тумблеров превью — на них отпечаток тоже не меняется, но
 * обвинять агента там не в чем. Пустой вход (панель очистили) заходом не считается и
 * историю сбрасывает — так же ведут себя соседние гварды диффа попыток.
 */
export function useRepeatedInput(input: readonly unknown[], fingerprint: string): boolean {
  // Переставляем ПРИ РЕНДЕРЕ по смене ссылки входа (React-паттерн «adjusting state
  // when props change», как у диффа попыток), а не зеркалящим эффектом: setState в
  // useEffect запрещён линтом и дал бы лишний кадр со старым вердиктом.
  const [seen, setSeen] = useState<{ from: readonly unknown[] | null; fp: string; repeat: boolean }>(
    { from: null, fp: "", repeat: false },
  );
  if (seen.from !== input) {
    setSeen({ from: input, fp: fingerprint, repeat: fingerprint !== "" && fingerprint === seen.fp });
  }
  return seen.repeat;
}

// ── inline-стили, общие для обеих модалок ─────────────────────────────

export const head: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 };
export const sub: CSSProperties = { margin: "0 0 12px", fontSize: 12.5, color: "#64748b", lineHeight: 1.5 };
export const cols: CSSProperties = { display: "flex", gap: 18, alignItems: "stretch" };
export const leftCol: CSSProperties = { width: 300, flex: "none", display: "flex", flexDirection: "column" };
export const rightCol: CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" };
export const radioRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#334155",
  cursor: "pointer", userSelect: "none",
};
export const hintsArea: CSSProperties = {
  width: "100%", height: 74, boxSizing: "border-box", resize: "vertical", marginBottom: 8,
  padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13,
  color: "#0f172a", fontFamily: "inherit",
};
export const leftNote: CSSProperties = { margin: "10px 0 0", fontSize: 11.5, color: "#94a3b8", lineHeight: 1.5 };
export const chipsRow: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8 };
export const chip: CSSProperties = {
  display: "inline-flex", alignItems: "center", border: "1px solid #e2e8f0",
  borderRadius: 8, background: "#f8fafc", color: "#475569", maxWidth: 220,
};
export const chipOn: CSSProperties = { ...chip, border: "1px solid #2563eb", background: "#eff6ff", color: "#1e3a8a" };
export const chipBtn: CSSProperties = {
  border: "none", background: "none", cursor: "pointer", font: "inherit", fontSize: 12.5,
  fontWeight: 600, color: "inherit", padding: "3px 2px 3px 10px", minWidth: 0,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
export const chipX: CSSProperties = {
  border: "none", background: "none", cursor: "pointer", color: "#94a3b8",
  fontSize: 14, lineHeight: 1, padding: "3px 8px 3px 4px",
};
export const fileArea: CSSProperties = {
  width: "100%", height: 200, boxSizing: "border-box", resize: "none",
  padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12.5, lineHeight: 1.5, color: "#0f172a", background: "#fff",
};
// Пустая зона приёма файлов. Это КНОПКА (открывает тот же диалог выбора, что и
// «Загрузить файлы…»): зона своим видом обещает взаимодействие, и клик по ней —
// первое, что пробует пользователь; заодно с клавиатуры она доступна даром.
export const dropHint: CSSProperties = {
  width: "100%", height: 200, boxSizing: "border-box", background: "none",
  border: "1.5px dashed #cbd5e1", borderRadius: 10,
  display: "grid", placeItems: "center", padding: 20, textAlign: "center",
  font: "inherit", fontSize: 12.5, color: "#94a3b8", lineHeight: 1.6,
};
export const grayLine: CSSProperties = { fontSize: 12.5, color: "#94a3b8" };
export const badge: CSSProperties = {
  flex: "none", fontSize: 10.5, fontWeight: 700, color: "#475569", background: "#f1f5f9",
  border: "1px solid #e2e8f0", borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap",
};
export const footRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 12,
  borderTop: "1px solid #eef0f2",
};
