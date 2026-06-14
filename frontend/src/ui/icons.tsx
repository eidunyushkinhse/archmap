// Иконки «хрома» приложения (шапка, тулбары, панель). Линейные, наследуют
// currentColor — цвет задаётся родителем (кнопкой/строкой). SVG взяты из
// дизайн-референса 1:1. Текстовые глифы (↶ ↷ ↑ ⤓ ▸ «) больше не используем.
type IcoProps = { size?: number };
const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  display: "block" as const,
};

export const UndoIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M9 7 L4 12 L9 17" /><path d="M4 12 H14 a5 5 0 0 1 0 10 H11" /></svg>);
export const RedoIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M15 7 L20 12 L15 17" /><path d="M20 12 H10 a5 5 0 0 0 0 10 H13" /></svg>);
export const UpIcon = ({ size = 16 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M12 19 V5" /><path d="M6 11 L12 5 L18 11" /></svg>);
export const ExportIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M12 3 V14" /><path d="M8 10 L12 14 L16 10" /><path d="M4 17 V20 H20 V17" /></svg>);
export const ChevronIcon = ({ size = 13 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M9 6 L15 12 L9 18" /></svg>);
export const LogoutIcon = ({ size = 16 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M15 4 H19 a1 1 0 0 1 1 1 V19 a1 1 0 0 1-1 1 H15" />
    <path d="M10 17 L15 12 L10 7" /><path d="M15 12 H3" /></svg>);
// Крестик закрытия модалки — линейный SVG (две скрещённые линии), не текстовый ✕.
export const CloseIcon = ({ size = 18 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M6 6 L18 18" /><path d="M18 6 L6 18" /></svg>);

// Двойной шеврон сворачивания панели (влево — свернуть, вправо — развернуть).
export const CollapseIcon = ({ size = 13, dir = "left" }: IcoProps & { dir?: "left" | "right" }) => {
  const d = dir === "left" ? ["M11 17 L6 12 L11 7", "M17 17 L12 12 L17 7"]
                           : ["M13 17 L18 12 L13 7", "M7 17 L12 12 L7 7"];
  return (<svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d={d[0]} /><path d={d[1]} /></svg>);
};

// Иконки секций для свёрнутого рейла.
export const TreeIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={1.7} aria-hidden>
    <rect x="9" y="3" width="6" height="4.5" rx="1" /><rect x="3" y="16.5" width="6" height="4.5" rx="1" />
    <rect x="15" y="16.5" width="6" height="4.5" rx="1" /><path d="M12 7.5 V11 M6 16.5 V13 H18 V16.5" /></svg>);
export const PlusIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={1.8} aria-hidden>
    <path d="M12 5 V19 M5 12 H19" /></svg>);
export const FlowIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={1.7} aria-hidden>
    <circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="12" r="2.4" /><circle cx="6" cy="18" r="2.4" />
    <path d="M8.4 6 H13 a2.6 2.6 0 0 1 2.6 2.6 V9.6 M8.4 18 H13 a2.6 2.6 0 0 0 2.6-2.6 V14.4" /></svg>);

// Логомарк: синяя плитка с мини-графом (узел + объект-контейнер + ребро).
export function LogoMark({ size = 30 }: IcoProps) {
  return (
    <span style={{ width: size, height: size, borderRadius: 9, background: "#2563eb",
      display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none",
      boxShadow: "0 1px 2px rgba(37,99,235,.35)" }} aria-hidden>
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none"
        stroke="#fff" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6.5" cy="7" r="2.6" fill="#fff" stroke="none" />
        <rect x="13" y="13.5" width="6.5" height="6" rx="1.5" fill="#fff" stroke="none" />
        <path d="M8 8.8 L14.5 14.2" stroke="#bcd2fb" /></svg>
    </span>);
}
