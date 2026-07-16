import type { CSSProperties } from "react";

/**
 * Общий словарь стилей модалок («китчен»). Сюда вынесено только то, что
 * повторялось в ≥2 модальных окнах: подпись поля, текстовый инпут и набор кнопок.
 * Специфика одной модалки (теги, дерево, дропдауны, превью) остаётся по месту.
 *
 * Палитра — единый синий акцент (#2563eb) + slate-нейтрали. Новые цвета не
 * изобретаем. Focus-кольцо и hover задаются CSS-каскадом в ui/modal.css (инлайн-
 * стилями псевдоклассы недоступны) — он накрывает все инпуты/кнопки внутри .app-modal.
 */

// Подпись поля формы (EdgeQuickCreate, диалоги проектов)
export const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#475569",
  marginBottom: 6,
};

export const input: CSSProperties = {
  display: "block",
  width: "100%",
  marginBottom: 10,
  padding: "9px 11px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 14,
  boxSizing: "border-box",
  color: "#0f172a",
  background: "#fff",
};

// Общая геометрия всех кнопок: единая высота, радиус 8, плотная типографика.
const btnBase: CSSProperties = {
  padding: "9px 18px",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.1,
  border: "1px solid transparent",
};

export const primaryBtn: CSSProperties = {
  ...btnBase,
  background: "#2563eb",
  color: "#fff",
};

export const secondaryBtn: CSSProperties = {
  ...btnBase,
  background: "#f1f5f9",
  color: "#475569",
  border: "1px solid #e2e8f0",
};

// Сплошная красная кнопка удаления (NodeModal, NodeDeleteConfirm)
export const dangerBtn: CSSProperties = {
  ...btnBase,
  background: "#dc2626",
  color: "#fff",
};
