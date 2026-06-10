import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import "./modal.css";

interface ModalProps {
  // Единственный канал закрытия: Escape, крестик и (если включён) клик по подложке
  onClose: () => void;
  // Закрывать по клику мимо бокса. Дефолт false; true только у NodeContextModal.
  closeOnBackdrop?: boolean;
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
  closeOnBackdrop = false,
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
  // padding-зоне иначе таргетился бы в сам <dialog> и (при closeOnBackdrop)
  // ложно закрывал бы модалку.
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
      // Escape: гасим дефолт (он закрыл бы диалог в обход React) и закрываем через родителя
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      // Страховка: если диалог всё же закрылся нативно (повторный Escape в Chrome)
      onClose={() => onClose()}
      // Клик по настоящей подложке — это клик ровно по <dialog> (padding на обёртке)
      onClick={(e) => {
        if (closeOnBackdrop && e.target === dialogRef.current) onClose();
      }}
    >
      {closeButton && (
        <button onClick={onClose} style={closeBtn} aria-label="Закрыть">✕</button>
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
  borderRadius: 10,
  boxShadow: "0 8px 32px rgba(0,0,0,.18)",
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
  fontSize: 18,
  cursor: "pointer",
  color: "#6b7280",
  zIndex: 1, // поверх контента обёртки
};
