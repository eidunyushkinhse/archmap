import type { CSSProperties } from "react";
import { loadErrorText } from "./loadErrorText";
import { primaryBtn, secondaryBtn } from "./styles";

// Экран отказа загрузки вместо вечной «Загрузки…» (аудит R-2, R-9, R-10): что не
// загрузилось, почему, и два выхода — повторить и уйти назад.
interface Props {
  what: string; // «объект», «уровень схемы» — после «Не удалось загрузить»
  error: unknown;
  onRetry?: () => void;
  onBack?: () => void;
  backLabel?: string;
}

export default function LoadError({ what, error, onRetry, onBack, backLabel = "К проекту" }: Props) {
  return (
    <div role="alert" style={wrap}>
      <p style={title}>Не удалось загрузить {what}</p>
      <p style={detail}>{loadErrorText(error)}</p>
      <div style={actions}>
        {onRetry && (
          <button type="button" style={primaryBtn} onClick={onRetry}>
            Повторить
          </button>
        )}
        {onBack && (
          <button type="button" style={secondaryBtn} onClick={onBack}>
            {backLabel}
          </button>
        )}
      </div>
    </div>
  );
}

const wrap: CSSProperties = { padding: 24, maxWidth: 520 };
const title: CSSProperties = { margin: "0 0 6px", fontSize: 15, fontWeight: 600, color: "#1e293b" };
const detail: CSSProperties = { margin: "0 0 14px", fontSize: 14, lineHeight: 1.5, color: "#475569" };
const actions: CSSProperties = { display: "flex", gap: 8 };
