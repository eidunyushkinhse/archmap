import { useEffect, useRef } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { CloseIcon } from "./icons";
import "./modal.css";

interface ModalProps {
  // Единственный канал закрытия: Escape и крестик (клик по подложке не закрывает).
  onClose: () => void;
  // Подтверждение окна с клавиатуры: Enter в однострочном поле, Ctrl/Cmd+Enter в
  // многострочном (там Enter — перенос строки). Передают окна с полями ввода; это тот
  // же обработчик, что у главной кнопки, и с тем же гардом «занято/заперта»: Enter не
  // делает того, чего не даёт кнопка. Окнам без полей (подтверждения) не нужен — там
  // Enter и так нажимает кнопку в фокусе.
  onSubmit?: () => void;
  // Показывать крестик ✕. Дефолт true; false только у NodeDeleteConfirm.
  closeButton?: boolean;
  // Переопределения геометрии бокса: width/maxHeight/overflowY уходят на <dialog>,
  // padding/display/flexDirection — на внутреннюю обёртку (см. split ниже).
  boxStyle?: CSSProperties;
  children: ReactNode;
}

// Ключи boxStyle, которые относятся к внутренней обёртке (она несёт padding и
// раскладку контента), а не к самому <dialog> (он несёт размер бокса).
const WRAPPER_KEYS = ["padding", "display", "flexDirection"] as const;

// Типы <input>, где Enter — не «готово»: флажки, переключатели, файлы, кнопки, ползунки.
// Текстовые — всё остальное (text, password, search, number, email, url…).
const NON_TEXT_INPUT = new Set(["checkbox", "radio", "file", "button", "submit", "reset", "range", "color", "image"]);

/**
 * Тот ли это Enter, которым подтверждают окно. Поле, которое само обработало клавишу
 * (комбобокс выбрал подсказку и погасил событие), и набор через IME (isComposing: Enter
 * завершает подстановку, а не ввод) окно не подтверждают. Enter с модификатором в
 * однострочном поле — тоже нет (Shift/Alt+Enter ничего не значат, но и не «готово»).
 */
function isSubmitKey(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return false;
  const t = e.target;
  if (t instanceof HTMLTextAreaElement) return e.ctrlKey || e.metaKey;
  if (t instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT.has(t.type) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  }
  return false;
}

/**
 * Общая модалка на нативном <dialog> + showModal(): top-layer (zIndex не нужен),
 * Escape, ::backdrop и фокус-менеджмент — бесплатно от браузера.
 *
 * Жизненный цикл: единственный источник правды — React-состояние родителя.
 * Диалог никогда не закрывается «сам» — мы не зовём dialog.close() и не
 * используем form method="dialog". Поэтому нативное событие close прилетает
 * только при пользовательском Escape (в т.ч. если Chrome закрыл в обход
 * preventDefault по повторному Escape) — и тогда мы дёргаем onClose. Размонтирует
 * нас родитель: при unmount элемент просто убирается из DOM, событие close не
 * стреляет, лишнего onClose нет (важно для StrictMode-двойного маунта).
 */
export default function Modal({
  onClose,
  onSubmit,
  closeButton = true,
  boxStyle,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // В StrictMode эффект может отработать дважды: повторный showModal на уже
    // открытом диалоге кидает исключение, поэтому проверяем open.
    if (!dialog.open) dialog.showModal();
    // showModal уводит фокус на первый фокусируемый элемент (это был бы крестик ✕).
    // Если в контенте помечен [data-autofocus] — фокусируем его; иначе уводим фокус
    // на сам диалог (tabIndex=-1), чтобы не подсвечивать обводкой крестик.
    const target = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog;
    target.focus();
  }, []);

  // Делим boxStyle: размер бокса (width/maxHeight/overflowY…) — на <dialog>,
  // отступы и раскладку — на обёртку. Padding обязан жить на обёртке: клик по
  // padding-зоне иначе таргетился бы в сам <dialog>.
  const dialogOverrides: CSSProperties = {};
  const wrapperOverrides: CSSProperties = {};
  for (const [k, v] of Object.entries(boxStyle ?? {})) {
    if ((WRAPPER_KEYS as readonly string[]).includes(k)) {
      (wrapperOverrides as Record<string, unknown>)[k] = v;
    } else {
      (dialogOverrides as Record<string, unknown>)[k] = v;
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="app-modal"
      tabIndex={-1}
      style={{ ...dialogBase, ...dialogOverrides }}
      // Escape: гасим дефолт (он закрыл бы диалог в обход React) и закрываем через
      // родителя. ⚠️ Проверка цели обязательна: `cancel` шлёт не только сам диалог —
      // <input type=file> стреляет им (с bubbles:true) при ОТМЕНЕ системного выбора
      // файлов. Без неё окно закрывалось вместе с файловым диалогом во всех окнах с
      // загрузкой (находка ручной проверки 2026-08-08).
      onCancel={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onClose();
      }}
      // Страховка: если диалог всё же закрылся нативно (повторный Escape в Chrome)
      onClose={() => onClose()}
      // Enter в поле всплывает сюда от любого потомка; preventDefault — чтобы поле в
      // <form> (если окно когда-нибудь его заведёт) не отправило её нативно второй раз.
      onKeyDown={onSubmit ? (e) => {
        if (!isSubmitKey(e)) return;
        e.preventDefault();
        onSubmit();
      } : undefined}
    >
      {closeButton && (
        <button onClick={onClose} className="app-close" style={closeBtn} aria-label="Закрыть">
          <CloseIcon />
        </button>
      )}
      <div style={{ ...wrapperBase, ...wrapperOverrides }}>{children}</div>
    </dialog>
  );
}

// Сброс UA-стилей <dialog> (чёрная рамка, padding, узкий max-*) + наш бокс.
const dialogBase: CSSProperties = {
  border: "none",
  padding: 0,
  maxWidth: "calc(100vw - 32px)",
  background: "#fff",
  borderRadius: 12,
  boxShadow: "0 16px 40px rgba(15,23,42,.18)",
  color: "inherit",
};
// Обёртка контента: дефолтный padding 28 (переопределяется через boxStyle.padding)
const wrapperBase: CSSProperties = {
  padding: 28,
};
const closeBtn: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  border: "none",
  background: "none",
  cursor: "pointer",
  color: "#94a3b8", // hover #1e293b — каскадом из modal.css (.app-close)
  display: "inline-flex",
  padding: 2,
  zIndex: 1, // поверх контента обёртки
};
