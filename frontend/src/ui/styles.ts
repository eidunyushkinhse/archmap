import type { CSSProperties } from "react";

/**
 * Общий словарь стилей модалок («китчен»). Сюда вынесено только то, что
 * повторялось в ≥2 модальных окнах: подпись поля, текстовый инпут и набор кнопок.
 * Специфика одной модалки (теги, дерево, дропдауны, превью) остаётся по месту.
 *
 * Палитра — единый синий акцент (#2563eb) + slate-нейтрали. Новые цвета не
 * изобретаем. Focus-кольцо и hover задаются CSS-каскадом в ui/modal.css (инлайн-
 * стилями псевдоклассы недоступны) — он накрывает все инпуты/кнопки внутри .app-modal.
 *
 * Окна, переведённые на новый язык (редизайн, ui/ds.css), словарём не пользуются: подпись
 * поля и текстовое поле остались у одного окна прежнего вида (FixVersionDialog).
 */

// Подпись поля формы окна прежнего вида (FixVersionDialog)
export const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#475569",
  marginBottom: 6,
};

// Текстовое поле окна прежнего вида (FixVersionDialog)
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
  // cursor ЗДЕСЬ НЕ ЗАДАЁМ намеренно: инлайн-стиль перебил бы not-allowed у
  // неактивной кнопки. Курсор и состояние :disabled — глобальным CSS (index.css).
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.1,
  border: "1px solid transparent",
};

// Главная кнопка окон прежнего вида (PlacementDialog, FixVersionDialog), страничных
// отказов (ErrorBoundary, LoadError), плашки обновления (UpdateNotice) и оболочки проекта
// (ProjectShell, DeploymentPage). Окна документации объекта ушли на ds-btn (фаза 9е).
export const primaryBtn: CSSProperties = {
  ...btnBase,
  background: "#2563eb",
  color: "#fff",
};

// Вторичная кнопка тех же мест (без плашки обновления и DeploymentPage).
export const secondaryBtn: CSSProperties = {
  ...btnBase,
  background: "#f1f5f9",
  color: "#475569",
  border: "1px solid #e2e8f0",
};

// Текст ошибки под полями окна прежнего вида (PlacementDialog, SitesDialog, FixVersionDialog).
export const errText: CSSProperties = { color: "#dc2626", fontSize: 13, margin: "8px 0 0" };
