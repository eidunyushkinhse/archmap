import type { CSSProperties, ReactNode } from "react";
import Modal from "./Modal";
import { dangerBtn, secondaryBtn } from "./styles";

/**
 * Базовый компонент подтверждения (danger-вид): строка заголовка с плашкой-
 * предупреждением, lead-текст, произвольный контент (например, список связей),
 * ошибка и футер «Да, …» / «Отмена». Единый источник вида для всех подтверждений
 * (удаление узла/узлов/участника, «Переразложить») — раньше каждая модалка несла
 * свою копию WARN_ICON и ~6 стилей.
 *
 * Обёртка: variant="modal" (по умолчанию, обычные модалки) или variant="card"
 * (оверлей редактора процесса, где второй <dialog> вкладывать нельзя). scroll —
 * ограничение высоты с прокруткой для длинных списков.
 */

// Знак-предупреждение (линейный SVG, наследует цвет плашки через currentColor).
const WARN_ICON = (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4 L21.5 20 H2.5 Z" />
    <path d="M12 10 V14.5" />
    <circle cx="12" cy="17.5" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

interface Props {
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  error?: string | null;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "modal" | "card";
  scroll?: boolean;
}

export default function ConfirmDialog({
  title, lead, children, error,
  confirmLabel, busyLabel, cancelLabel = "Отмена", busy = false,
  onConfirm, onCancel,
  variant = "modal", scroll = false,
}: Props) {
  const body = (
    <>
      <div style={titleRow}>
        <span style={warnPlaque} aria-hidden>{WARN_ICON}</span>
        <h3 style={titleStyle}>{title}</h3>
      </div>
      {lead != null && <p style={leadStyle}>{lead}</p>}
      {children}
      {error && <p style={errText}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={onConfirm} disabled={busy} style={dangerBtn}>
          {busy && busyLabel ? busyLabel : confirmLabel}
        </button>
        <button onClick={onCancel} disabled={busy} style={secondaryBtn}>
          {cancelLabel}
        </button>
      </div>
    </>
  );

  if (variant === "card") {
    return <div style={card}>{body}</div>;
  }
  return (
    <Modal
      onClose={onCancel}
      closeButton={false}
      boxStyle={{ width: 460, padding: 24, ...(scroll ? { maxHeight: "80vh", overflowY: "auto" } : {}) }}
    >
      {body}
    </Modal>
  );
}

const card: CSSProperties = {
  width: 440,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 13,
  boxShadow: "0 20px 56px rgba(15,23,42,.24)",
  padding: 22,
};
const titleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 14,
};
const warnPlaque: CSSProperties = {
  flexShrink: 0,
  width: 36,
  height: 36,
  borderRadius: 10,
  background: "#fee2e2",
  color: "#dc2626",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 700,
  color: "#1e293b",
  lineHeight: 1.3,
};
const leadStyle: CSSProperties = {
  color: "#475569",
  margin: "0 0 8px",
  fontSize: 14,
  lineHeight: 1.5,
};
const errText: CSSProperties = {
  color: "#dc2626",
  margin: "8px 0 0",
  fontSize: 13,
};
