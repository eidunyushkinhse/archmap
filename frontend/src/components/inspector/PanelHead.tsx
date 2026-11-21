// Заголовок правой панели редактора-карты — общий у панелей объекта, связи и объекта с
// другого уровня: значок формы, название (текстом или полем у редактора), справа
// кнопки-значки «Открыть страницу объекта» (если страница есть) и «Закрыть».
import type { ReactNode } from "react";
import { CloseIcon } from "../../ui/icons";
import "./panel.css";

// «Открыть страницу объекта»: лист со стрелкой наружу.
function OpenPageIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: "block" }}>
      <path d="M13 4 H6 a2 2 0 0 0-2 2 V18 a2 2 0 0 0 2 2 H18 a2 2 0 0 0 2-2 V11" />
      <path d="M15 3 H21 V9 M21 3 L11 13" />
    </svg>
  );
}

export default function PanelHead({ glyph, title, onOpenPage, onClose }: {
  glyph?: ReactNode;
  title: ReactNode;
  // Нет — у объекта нет страницы («Пользователь») или это связь.
  onOpenPage?: () => void;
  onClose: () => void;
}) {
  return (
    <div className="ip-head">
      {glyph && <span className="ip-glyph">{glyph}</span>}
      <div className="ip-title-cell">{title}</div>
      {onOpenPage && (
        <button type="button" className="ip-icon" title="Открыть страницу объекта" aria-label="Открыть страницу объекта" onClick={onOpenPage}>
          <OpenPageIcon />
        </button>
      )}
      <button type="button" className="ip-icon" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
        <CloseIcon size={15} />
      </button>
    </div>
  );
}
