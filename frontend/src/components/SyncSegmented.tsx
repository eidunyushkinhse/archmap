import type { CSSProperties } from "react";

/**
 * Переключатель типа связи: синхронная (вызов+ответ) ↔ асинхронная (событие).
 * Бинарный сегментированный контрол — синхронность канала теперь задаётся явно,
 * без авто-вывода из технологии.
 */
export default function SyncSegmented({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: boolean; // true = синхронная
  onChange: (v: boolean) => void;
  disabled?: boolean;
  compact?: boolean; // мелкий вариант для шапки канала (короткие подписи)
}) {
  return (
    <div role="group" aria-label="Тип связи" style={compact ? wrapSm : wrap}>
      <button type="button" disabled={disabled} aria-pressed={value} onClick={() => onChange(true)} style={seg(value, compact)}>
        {compact ? "синхр." : "Синхронная"}
      </button>
      <button type="button" disabled={disabled} aria-pressed={!value} onClick={() => onChange(false)} style={seg(!value, compact)}>
        {compact ? "асинхр." : "Асинхронная"}
      </button>
    </div>
  );
}

const ACCENT = "#2563eb";
const wrap: CSSProperties = {
  display: "inline-flex",
  padding: 2,
  gap: 2,
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const wrapSm: CSSProperties = { ...wrap, padding: 1, gap: 1, borderRadius: 6 };
const seg = (on: boolean, compact?: boolean): CSSProperties => ({
  border: "none",
  borderRadius: compact ? 5 : 6,
  padding: compact ? "2px 7px" : "5px 11px",
  fontSize: compact ? 10 : 12,
  fontWeight: 600,
  cursor: "pointer",
  background: on ? ACCENT : "transparent",
  color: on ? "#fff" : "#64748b",
  transition: "background .12s, color .12s",
});
