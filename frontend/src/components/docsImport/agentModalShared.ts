// Общие НЕ-компонентные части BYOA-модалок (DocsAgentModal — схемы логики,
// SpecAgentModal — OpenAPI-спека): бейджи действий превью, подсчёт действий и
// inline-стили двухколоночного макета (чипы файлов, редактор, подвал). Стили
// переиспользуются как есть — окна визуально едины. Компоненты отчёта
// (ItemList/NoteList) — в agentModalReport.tsx (требование react-refresh:
// файл экспортирует только компоненты).
import type { CSSProperties } from "react";

// Бейдж действия превью/применения (action из отчёта бэка)
export const ACTION_LABEL: Record<string, string> = {
  create: "новая",
  overwrite: "перезапись",
  skip: "пропуск (занято)",
  unchanged: "без изменений",
};

// Подсчёт строк отчёта с данным действием (для итоговых строк и доступности кнопок)
export function countAction(arr: { action: string }[], action: string): number {
  return arr.filter((a) => a.action === action).length;
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
export const dropHint: CSSProperties = {
  height: 200, boxSizing: "border-box", border: "1.5px dashed #cbd5e1", borderRadius: 10,
  display: "grid", placeItems: "center", padding: 20, textAlign: "center",
  fontSize: 12.5, color: "#94a3b8", lineHeight: 1.6,
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
