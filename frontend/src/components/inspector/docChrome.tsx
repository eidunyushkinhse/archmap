// Обвязка окна документации (DocOverlay), общая для схемы логики и спецификации: шапка,
// меню «Изменить» («Вручную» | «Через ИИ-агента»), «Показать код» и двухшаговое удаление.
// Классы — docOverlay.css; всё на новом языке (ui/ds.css): шапка и меню — редизайн, фаза
// 7а, удаление — фаза 7б. Стадия «Через ИИ-агента» рисует своё малое окно (DocAgentStage).
//
// Компоненты объявлены на верхнем уровне модуля: объявленный внутри другого
// ремаунтится каждый рендер (ловушка проекта).
import { useState } from "react";
import type { ReactNode } from "react";
import AddDocsMenu from "../AddDocsMenu";
import { CloseIcon } from "../../ui/icons";
import "../../ui/ds.css";
import "./docOverlay.css";

// Хвост названия в стадии чтения: эндпоинт операции моноширинным («POST /orders») или
// тихое слово «воркер».
export interface DocHeadTail {
  text: string;
  mono: boolean;
}

// Шапка окна в одну строку: имя объекта тихим цветом, название заголовком окна, хвост,
// справа действия стадии и крестик. Значка, пилюль вида и формата и точки между именем
// объекта и названием нет. Длинные имена — многоточием: первым сжимается имя объекта,
// название последним (доли сжатия в docOverlay.css); полный текст — в title.
// notice — строкой предупреждения под шапкой, для чтения: схемы не загрузились, конфликт с
// другой сессией. Отказы при правке окно пишет над кнопками подвала.
export function DocHead({ objectName, title, tail, notice, actions, onClose }: {
  objectName: string;
  title: string;
  tail?: DocHeadTail | null;
  notice?: string | null;
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <div className="doc-head">
        <div className="doc-headname">
          <span className="doc-headobj" title={objectName}>{objectName}</span>
          <span className="doc-headmain">
            <h2 className="ds-win-title doc-headtitle" title={title}>{title}</h2>
            {tail && (
              <span className={"doc-headtail" + (tail.mono ? " doc-headtail--mono" : "")} title={tail.text}>
                {tail.text}
              </span>
            )}
          </span>
        </div>
        <div className="doc-headacts">
          {actions}
          <button type="button" className="ds-icon-btn" onClick={onClose} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>
      </div>
      {notice && <p className="ds-warn doc-notice" role="status">{notice}</p>}
    </>
  );
}

// Меню правки: тот же список, что «+ Добавить» на странице объекта (AddDocsMenu), —
// способ правки везде выглядит одинаково. «Изменить» в шапке — вторичная кнопка,
// «Описать» у неописанной схемы — главная.
export function EditMenu({ label, variant = "button", align = "right", onManual, onAgent }: {
  label: string;
  variant?: "button" | "primary";
  align?: "right" | "center";
  onManual: () => void;
  onAgent: () => void;
}) {
  return (
    <AddDocsMenu
      variant={variant}
      align={align}
      label={label}
      groups={[
        [{ label: "Вручную", onSelect: onManual }],
        [{ label: "Через ИИ-агента", onSelect: onAgent }],
      ]}
    />
  );
}

// «Показать код» / «Скрыть код» читателя: колонка кода только для чтения.
export function CodeToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="ds-btn" onClick={onToggle}>
      {shown ? "Скрыть код" : "Показать код"}
    </button>
  );
}

// Двухшаговое удаление вместо вложенной модалки подтверждения: <dialog> внутри
// <dialog> нельзя (cancel бубблит — ui/Modal). Второй клик по той же кнопке
// подтверждает, увод фокуса — отменяет. Вторая ступень спрашивает тем же действием:
// «Удалить схему» → «Удалить схему?» (решение Р7 ревизии текстов). Вид — тихая
// кнопка-текст цветом опасного действия у правого края подвала.
export function TwoStepDeleteButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={"doc-delbtn" + (armed ? " doc-delbtn--armed" : "")}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? `${label}?` : label}
    </button>
  );
}
