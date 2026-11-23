import type { CSSProperties } from "react";

// Каркас рабочих экранов проекта. Был копиями в четырёх страницах (аудит F-28); здесь одна
// версия, своё страница добавляет спредом.

// ── Рабочие экраны проекта (оболочка ProjectShell, редактор-карта): колонка во
// всю высоту окна, шапка сверху (каркас ds-head в ui/ds.css), тело — строка панелей.
// Гарнитура — шрифт интерфейса (ui/tokens.css); холст внутри закреплён на прежней.
export const workPage: CSSProperties = { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "var(--font-ui)", overflow: "hidden" };
export const workBodyRow: CSSProperties = { flex: 1, display: "flex", minHeight: 0, overflow: "hidden" };
