// Строка меты «терм → значение» окна связи на странице объекта (EdgeEditModal, прежний
// язык до фазы окон): иконка и подпись терма слева, значение справа. dd — нейтральная
// ячейка; само значение несёт класс .insp-value (его передаёт вызывающий).
import type { CSSProperties, ReactNode } from "react";

// Раскладка ячейки значения: строкой (поле) или блоком (пикер конца связи).
type Layout = "row" | "block";

const DD: Record<Layout, CSSProperties> = {
  row: { margin: 0, flex: 1, minWidth: 0, display: "flex" },
  block: { margin: 0, flex: 1, minWidth: 0 },
};

export default function MetaRow({ icon, label, top = false, layout = "row", children }: {
  icon: ReactNode;
  label: string;
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
      </dt>
      <dd style={DD[layout]}>{children}</dd>
    </div>
  );
}
