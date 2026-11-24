import { loadErrorText } from "./loadErrorText";
import "./ds.css";

// Экран отказа загрузки вместо вечной «Загрузки…» (аудит R-2, R-9, R-10): что не
// загрузилось, почему, и два выхода: повторить и уйти назад. Вид нового языка (ui/ds.css,
// ds-fail): блок без коробки, корень несёт ds и сам задаёт метрики текста, поэтому блок
// одинаков на странице, в области холста (legacy-root) и в теле окна.
interface Props {
  what: string; // «объект», «уровень схемы» — после «Не удалось загрузить»
  error: unknown;
  onRetry?: () => void;
  onBack?: () => void;
  backLabel?: string;
}

export default function LoadError({ what, error, onRetry, onBack, backLabel = "К проекту" }: Props) {
  return (
    <div role="alert" className="ds ds-fail">
      <p className="ds-fail-title">Не удалось загрузить {what}</p>
      <p className="ds-fail-why">{loadErrorText(error)}</p>
      {(onRetry || onBack) && (
        <div className="ds-fail-acts">
          {onRetry && (
            <button type="button" className="ds-btn ds-btn--primary" onClick={onRetry}>
              Повторить
            </button>
          )}
          {onBack && (
            <button type="button" className="ds-btn" onClick={onBack}>
              {backLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
