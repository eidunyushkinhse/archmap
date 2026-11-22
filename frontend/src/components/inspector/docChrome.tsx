// Обвязка окна документации (DocOverlay), общая для схемы логики и спецификации: шапка,
// меню «Изменить» («Вручную» | «Через ИИ-агента»), шаги левой колонки режима агента и
// двухшаговое удаление. Классы — docOverlay.css; шапка и меню на новом языке (ui/ds.css,
// редизайн, фаза 7а), шаги и удаление — прежнего вида (стадии правки переделывает
// следующая фаза).
//
// Компоненты объявлены на верхнем уровне модуля: объявленный внутри другого
// ремаунтится каждый рендер (ловушка проекта).
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { PromptVariant } from "../../types";
import AddDocsMenu from "../AddDocsMenu";
import PromptCopyButton from "../docsImport/PromptCopyButton";
import { CloseIcon } from "../../ui/icons";
import "../../ui/ds.css";

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
// notice — конфликт или отказ: строкой предупреждения под шапкой.
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

// Кнопки стадий правки в шапке — прежнего вида: их метрики (высота строки) держит
// legacy-root (ui/tokens.css), обёртка своей коробки не имеет.
export function LegacyActions({ children }: { children: ReactNode }) {
  return <span className="legacy-root doc-legacy">{children}</span>;
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

// Левая колонка режима «Через ИИ-агента»: три шага. target — адрес, на который
// нацелен промпт (у схемы логики); у спеки его нет.
export function DocAgentSteps({ target, service, copy }: {
  target?: string | null;
  service: string;
  copy: (variant: PromptVariant) => Promise<void>;
}) {
  return (
    <ol className="doc-steps">
      <li>
        <div>
          Скопируйте промпт.
          {target && <> Он уже нацелен на схему <span className="doc-target">{target}</span>.</>}
          <PromptCopyButton
            label="Скопировать промпт"
            copiedLabel="Скопировано ✓"
            kind="primary"
            buttonStyle={copyBtn}
            copy={copy}
          />
        </div>
      </li>
      <li><div>Запустите агента с этим промптом в репозитории «{service}».</div></li>
      <li><div>Перетащите файл, который вернёт агент, в поле справа.</div></li>
    </ol>
  );
}

// Двухшаговое удаление вместо вложенной модалки подтверждения: <dialog> внутри
// <dialog> нельзя (cancel бубблит — ui/Modal). Второй клик по той же кнопке
// подтверждает, увод фокуса — отменяет. Вторая ступень спрашивает тем же действием:
// «Удалить схему» → «Удалить схему?» (решение Р7 ревизии текстов).
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

// Кнопка промпта в шаге — по ширине подписи, а не на всю колонку.
const copyBtn: CSSProperties = { marginTop: 8, alignSelf: "flex-start" };
