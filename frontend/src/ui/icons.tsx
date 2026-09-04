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
export const ExportIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M12 3 V14" /><path d="M8 10 L12 14 L16 10" /><path d="M4 17 V20 H20 V17" /></svg>);
// «Обновить из репозитория» — ТОТ ЖЕ лоток, что у ExportIcon, но стрелка наружу:
// кнопки стоят рядом в шапке и обязаны читаться парой «отдать / принять». Круговых
// стрелок здесь быть не может: в шапке редактора соседствует «Переразложить
// уровень», и два круглых знака подряд читались бы как одно действие.
export const RepoSyncIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M12 14 V3" /><path d="M8 7 L12 3 L16 7" />
    <path d="M4 17 V20 H20 V17" /></svg>);
// «Переразложить уровень» — круговые стрелки (сброс к авто-раскладке).
export const RelayoutIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M20 11 a8 8 0 0 0-14-4 M4 5 V8 H7" />
    <path d="M4 13 a8 8 0 0 0 14 4 M20 19 V16 H17" /></svg>);
// «Действия со схемой» — кебаб-меню шапки (SchemaActions): пункты словами.
export const KebabIcon = ({ size = 17 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ display: "block" }} aria-hidden>
    <circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" /></svg>);
// «Подписи связей» — тумблер холста (canvas.md CV32): плашка подписи, сидящая на
// линии связи. Вариант off (подписи скрыты) перечёркнут диагональю.
export const EdgeLabelsIcon = ({ size = 17, off = false }: IcoProps & { off?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M2 12 H6" /><path d="M18 12 H22" />
    <rect x="6" y="8.5" width="12" height="7" rx="2" />
    <path d="M9 12 H15" />
    {off && <path d="M4 20 L20 4" />}
  </svg>);
export const ChevronIcon = ({ size = 13 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} aria-hidden>
    <path d="M9 6 L15 12 L9 18" /></svg>);
// Шеврон «вниз» для раскрывающихся групп (группы доков на странице объекта, разделы
// базы в секции «Структура»). Поворот задаёт вызывающий — см. .np-doc-group-chev.
export const ChevronDownIcon = ({ size = 12 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={2.2} aria-hidden
    style={{ marginLeft: 2 }}>
    <path d="M6 9 L12 15 L18 9" /></svg>);
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

// Знак вопроса в круге — ⓘ-кнопка пояснения у поля с неинтуитивной механикой
// (ui/InfoPopover.tsx; заведена под поле «Якорь»). Круг тонкий, глиф внутри —
// того же линейного семейства, что и остальные иконки хрома.
export const QuestionCircleIcon = ({ size = 15 }: IcoProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...base} strokeWidth={1.8} aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.4 9.2a2.7 2.7 0 1 1 3.4 3.2c-.6.2-.9.7-.9 1.3v.5" />
    <path d="M12 17.2v.2" strokeWidth={2.4} /></svg>);

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
