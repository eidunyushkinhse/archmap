import { Children } from "react";
import type { ReactNode } from "react";
import Modal from "./Modal";
import "./ds.css";

/**
 * Общее подтверждение на каркасе окна нового языка (.ds-win): заголовок-вопрос, тело
 * (пояснение и перечень того, что затронет действие) и футер — главная кнопка первой,
 * «Отмена» за ней, ряд слева. Вопрос задаётся действием («Удалить «X»?», «Переразложить
 * уровень «X»?»), главная кнопка называет то же действие («Удалить», «Переразложить»);
 * кнопок «Да, удалить» и «Нет» нет (решение Р7 ревизии текстов 2026-11). Опасность
 * действия называет красная главная кнопка (tone="danger"); tone="neutral" — синяя
 * кнопка для неразрушающего, но требующего согласия шага («Привязать» при расхождении
 * имён, «В архив»). Крестика нет: окно закрывают «Отмена» и Escape.
 *
 * Тело есть, только когда есть пояснение или содержимое; оно прокручивается само, окно
 * не выше экрана (свойство .ds-win). confirmDisabled запирает главную кнопку (имя для
 * удаления навсегда ещё не введено), onSubmit — Enter в поле окна (уходит в Modal; тот же
 * обработчик, что у главной кнопки, со своей проверкой «заперта»).
 *
 * Обёртка: variant="modal" (по умолчанию, нативный <dialog>) или variant="card" — тот же
 * каркас карточкой в оверлее редактора процесса, где второй <dialog> вкладывать нельзя.
 * Класс ds на корне обязателен: без него окно получит прежние метрики (ui/tokens.css).
 */

interface Props {
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  error?: string | null;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onSubmit?: () => void;
  variant?: "modal" | "card";
  tone?: "danger" | "neutral";
}

export default function ConfirmDialog({
  title, lead, children, error,
  confirmLabel, busyLabel, cancelLabel = "Отмена", busy = false, confirmDisabled = false,
  onConfirm, onCancel, onSubmit,
  variant = "modal", tone = "danger",
}: Props) {
  // Пустое содержимое (false от условного перечня) тела не заводит: иначе пустой блок
  // добавил бы окну шаг между заголовком и кнопками.
  const hasBody = lead != null || Children.toArray(children).length > 0;
  const content = (
    <>
      <div className="ds-win-head">
        <h2 className="ds-win-title">{title}</h2>
      </div>
      {hasBody && (
        <div className="ds-win-body">
          {lead != null && <p className="ds-confirm-lead">{lead}</p>}
          {children}
        </div>
      )}
      <div className="ds-win-foot">
        {error && <p className="ds-danger ds-win-err">{error}</p>}
        <button
          type="button"
          className={tone === "danger" ? "ds-btn ds-btn--danger" : "ds-btn ds-btn--primary"}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
        >
          {busy && busyLabel ? busyLabel : confirmLabel}
        </button>
        <button type="button" className="ds-btn" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
      </div>
    </>
  );

  if (variant === "card") {
    return <div className="ds ds-win ds-confirm ds-confirm--card">{content}</div>;
  }
  return (
    <Modal onClose={onCancel} onSubmit={onSubmit} boxStyle={{ width: 440, padding: 0 }}>
      <div className="ds ds-win ds-confirm">{content}</div>
    </Modal>
  );
}
