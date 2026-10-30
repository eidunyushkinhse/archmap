// Строка меты «терм → значение» правой панели редактора и модалки связи страницы
// объекта: иконка и подпись терма слева, значение справа. dd — нейтральная ячейка; само
// значение несёт класс .insp-value (его передаёт вызывающий — текст у наблюдателя / поле
// у архитектора).
import type { CSSProperties, ReactNode } from "react";

// Раскладка ячейки значения: строкой (поле или текст), блоком (пикер конца связи) или
// столбцом (поле с подсказкой под ним).
type Layout = "row" | "block" | "column";

const DD: Record<Layout, CSSProperties> = {
  row: { margin: 0, flex: 1, minWidth: 0, display: "flex" },
  block: { margin: 0, flex: 1, minWidth: 0 },
  column: { margin: 0, flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
};

export default function MetaRow({ icon, label, help, top = false, layout = "row", children }: {
  icon: ReactNode;
  label: string;
  // Справка «?» сразу за подписью терма (ui/InfoPopover) — у полей с неочевидным смыслом.
  help?: ReactNode;
  // Терм по верхнему краю — у высоких значений (пикер с выпадашкой).
  top?: boolean;
  layout?: Layout;
  children: ReactNode;
}) {
  return (
    <div className={"insp-row" + (top ? " insp-row--top" : "")}>
      <dt className="insp-term">
        <span className="insp-term-ico">{icon}</span>
        {label}
        {help}
      </dt>
      <dd style={DD[layout]}>{children}</dd>
    </div>
  );
}
