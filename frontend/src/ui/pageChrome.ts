import type { CSSProperties } from "react";

// Каркас экранов — шапка и тело страницы. Были копиями в четырёх страницах (аудит
// F-28); здесь одна версия на вид экрана, своё страница добавляет спредом.

// ── Рабочие экраны проекта (оболочка ProjectShell, редактор-карта): колонка во
// всю высоту окна, шапка с крошками слева и действиями справа, тело — строка панелей.
export const workPage: CSSProperties = { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui, -apple-system, sans-serif", overflow: "hidden" };
export const workTopBar: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 20px", borderBottom: "1px solid #e2e8f0", background: "#fff", flexShrink: 0, gap: 12, flexWrap: "wrap" };
export const workTopLeft: CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 14, flexWrap: "wrap", flex: 1, minWidth: 0 };
export const workDivider: CSSProperties = { width: 1, height: 22, background: "#e2e8f0", flex: "none", margin: "0 4px" };
export const workBodyRow: CSSProperties = { flex: 1, display: "flex", minHeight: 0, overflow: "hidden" };

// ── Списочные экраны («Проекты», «Пользователи»): прокручивается вся страница.
export const listPage: CSSProperties = { height: "100vh", overflowY: "auto", background: "#f8fafc" };
export const listTopBar: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 24px", background: "#fff", borderBottom: "1px solid #e2e8f0",
};
export const listTitle: CSSProperties = { margin: 0, fontSize: 26, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" };
export const listPrimaryBtn: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px",
  background: "#2563eb", color: "#fff", border: "none", borderRadius: 10,
  fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};
export const listToast: CSSProperties = {
  position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
  background: "#0f172a", color: "#fff", padding: "10px 18px", borderRadius: 10,
  fontSize: 14, boxShadow: "0 12px 30px rgba(15,23,42,.28)", zIndex: 50,
  pointerEvents: "none", // информативный снекбар не должен глотать клики под собой
};
