import type { CSSProperties } from "react";

// Каркас рабочих экранов проекта и тост списочных экранов. Были копиями в четырёх страницах
// (аудит F-28); здесь одна версия на вид экрана, своё страница добавляет спредом.

// ── Рабочие экраны проекта (оболочка ProjectShell, редактор-карта): колонка во
// всю высоту окна, шапка сверху (каркас ds-head в ui/ds.css), тело — строка панелей.
// Гарнитура — шрифт интерфейса (ui/tokens.css); холст внутри закреплён на прежней.
export const workPage: CSSProperties = { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "var(--font-ui)", overflow: "hidden" };
export const workBodyRow: CSSProperties = { flex: 1, display: "flex", minHeight: 0, overflow: "hidden" };

// ── Тост списочных экранов («Проекты», «Пользователи») и «Развёртывания»: прежнего вида,
// у места вызова с классом legacy-root (прежние метрики текста внутри области .ds). Шапка
// и колонка списков — каркас нового языка (ui/ds.css, ds-head; pages/listPages.css).
export const listToast: CSSProperties = {
  position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
  background: "#0f172a", color: "#fff", padding: "10px 18px", borderRadius: 10,
  fontSize: 14, boxShadow: "0 12px 30px rgba(15,23,42,.28)", zIndex: 50,
  pointerEvents: "none", // информативный снекбар не должен глотать клики под собой
};
