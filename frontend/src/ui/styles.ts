import type { CSSProperties } from "react";

/**
 * Общий словарь стилей модалок. Сюда вынесено только то, что повторялось в ≥2
 * модальных окнах: подпись поля, текстовый инпут и набор кнопок. Специфика
 * одной модалки (теги, дерево, дропдауны, превью) остаётся по месту.
 */

// Подпись поля формы (она же fieldLabel в EdgeDetailModal)
export const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  marginBottom: 4,
};

export const input: CSSProperties = {
  display: "block",
  width: "100%",
  marginBottom: 10,
  padding: "7px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
};

export const primaryBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};

export const secondaryBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#f3f4f6",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};

// Сплошная красная кнопка удаления (NodeModal, NodeDeleteConfirm)
export const dangerBtn: CSSProperties = {
  padding: "8px 18px",
  background: "#dc2626",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};

// Мягкая красная кнопка удаления (EdgeDetailModal)
export const dangerBtnSoft: CSSProperties = {
  padding: "8px 18px",
  background: "#fee2e2",
  color: "#dc2626",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
};
