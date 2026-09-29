// Обвязка окна документации (DocOverlay), общая для схемы логики и спеки: шапка с
// местом под кнопки режима, меню «Изменить» («Вручную» | «Через ИИ-агента»), шаги
// левой колонки режима агента и двухшаговое удаление. Разметка и тон — по
// прототипу вьюера v2 (docs/tasks/doc-viewer-v2.md), классы — docOverlay.css.
//
// Компоненты объявлены на верхнем уровне модуля: объявленный внутри другого
// ремаунтится каждый рендер (ловушка проекта).
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { PromptVariant } from "../../types";
import AddDocsMenu from "../AddDocsMenu";
import PromptCopyButton from "../docsImport/PromptCopyButton";
import { CloseIcon } from "../../ui/icons";

// Шапка окна: глиф режима, заголовок, тег, плашка конфликта, кнопки режима, крестик.
export function DocHead({ glyph, title, tag, tagOas, notice, actions, onClose }: {
  glyph: ReactNode;
  title: ReactNode;
  tag: string;
  tagOas?: boolean; // тег спеки — свой цвет (зелёный), у схем — фиолетовый
  // Конфликт конкурентных сессий, пришедший от страницы (409 при записи спеки).
  notice?: string | null;
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="doc-head">
      <span className="doc-headglyph">{glyph}</span>
      <div className="doc-title">{title}</div>
      <span className={"doc-tag" + (tagOas ? " doc-tag--oas" : "")}>{tag}</span>
      {notice && <span className="doc-tag doc-tag--notice">{notice}</span>}
      {actions}
      <button type="button" className="doc-x" onClick={onClose} aria-label="Закрыть">
        <CloseIcon />
      </button>
    </div>
  );
}

// Меню правки: тот же список, что «+ Добавить» на странице объекта (AddDocsMenu), —
// способ правки везде выглядит одинаково. Подпись «Изменить» в шапке и «Описать»
// у неописанной схемы.
export function EditMenu({ label, align = "right", onManual, onAgent }: {
  label: string;
  align?: "right" | "center";
  onManual: () => void;
  onAgent: () => void;
}) {
  return (
    <AddDocsMenu
      variant="primary"
      align={align}
      label={label}
      icon={pencil}
      groups={[
        [{ label: "Вручную", onSelect: onManual }],
        [{ label: "Через ИИ-агента", onSelect: onAgent }],
      ]}
    />
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
        <span>
          Скопируйте промпт.
          {target && <> Он уже нацелен на схему <span className="doc-target">{target}</span>.</>}
          <PromptCopyButton
            label="Скопировать промпт"
            copiedLabel="Скопировано ✓"
            kind="primary"
            buttonStyle={copyBtn}
            copy={copy}
          />
        </span>
      </li>
      <li><span>Запустите агента с этим промптом в репозитории сервиса «{service}».</span></li>
      <li><span>Перетащите файл, который вернёт агент, в поле справа.</span></li>
    </ol>
  );
}

// Двухшаговое удаление вместо вложенной модалки подтверждения: <dialog> внутри
// <dialog> нельзя (cancel бубблит — ui/Modal). Второй клик по той же кнопке
// подтверждает, увод фокуса — отменяет.
export function TwoStepDeleteButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={"doc-delbtn" + (armed ? " doc-delbtn--armed" : "")}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? "Точно удалить?" : label}
    </button>
  );
}

// Глифы режима в шапке — те же, что на кнопках-строках «Документация» в панели.
const gs = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
} as const;
export function FlowGlyph() {
  return (
    <svg {...gs}>
      <circle cx="4" cy="4" r="1.8" />
      <circle cx="12" cy="8" r="1.8" />
      <circle cx="4" cy="12" r="1.8" />
      <path d="M5.6 4H9a1.7 1.7 0 0 1 1.7 1.7v.6 M5.6 12H9a1.7 1.7 0 0 0 1.7-1.7v-.6" />
    </svg>
  );
}
export function ApiGlyph() {
  return (
    <svg {...gs}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 6.5 3.5 8 5 9.5 M11 6.5 12.5 8 11 9.5 M8.6 5.7 7.4 10.3" />
    </svg>
  );
}

const pencil = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m11.3 2.7 2 2L6.6 11.4l-2.9.9.9-2.9Z" />
  </svg>
);
// Кнопка промпта в шаге — по ширине подписи, а не на всю колонку.
const copyBtn: CSSProperties = { marginTop: 8, alignSelf: "flex-start" };
