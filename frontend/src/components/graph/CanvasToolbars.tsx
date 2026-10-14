// Элементы интерфейса поверх холста уровня — не объекты графа (аудит F-1: вынесено из
// разметки LevelGraph): тулбар Undo/Redo, правый угол «Переразложить» + «Подписи связей»
// и плитка «вне уровня» для протягивания связи.
import { UndoIcon, RedoIcon, RelayoutIcon, EdgeLabelsIcon } from "../../ui/icons";

// Тулбар Undo/Redo. Кнопка надёжнее клавиш — не зависит от фокуса.
export function HistoryToolbar({ onUndo, onRedo, canUndo, canRedo }: {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  return (
    <div style={{ position: "absolute", top: 14, left: 14, zIndex: 5 }}>
      <div className="lg-seg">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          title="Отменить · Ctrl+Z"
          aria-label="Отменить"
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          title="Вернуть · Ctrl+Shift+Z"
          aria-label="Вернуть"
        >
          <RedoIcon />
        </button>
      </div>
    </div>
  );
}

// ПРАВЫЙ верхний угол: «Переразложить» (архитектор) и тумблер «Скрыть подписи связей»
// (CV32, все роли — просмотровый режим, не правка). Стилистика едина с тулбаром
// Undo/Redo (тот же класс lg-seg). Нет ни того, ни другого — угла нет.
export function ViewToolbar({ onRelayout, labels }: {
  onRelayout?: () => void;
  // Тумблером владеет холст (не редактор-карта, у которой он в топбаре).
  labels?: { hidden: boolean; onToggle: () => void };
}) {
  if (!onRelayout && !labels) return null;
  return (
    <div style={{ position: "absolute", top: 14, right: 14, zIndex: 5 }}>
      <div className="lg-seg">
        {onRelayout && (
          <button
            type="button"
            onClick={onRelayout}
            title="Переразложить уровень"
            aria-label="Переразложить"
          >
            <RelayoutIcon />
          </button>
        )}
        {labels && (
          <button
            type="button"
            onClick={labels.onToggle}
            aria-pressed={labels.hidden}
            title={labels.hidden ? "Показать подписи связей" : "Скрыть подписи связей"}
            aria-label="Подписи связей"
          >
            <EdgeLabelsIcon off={labels.hidden} />
          </button>
        )}
      </div>
    </div>
  );
}

// Плитка «вне уровня»: полоса у верхнего края холста на время протягивания НОВОЙ связи
// на не-корневом уровне. Отпустил на неё конец стрелки → выбор дальнего конца из всей
// схемы (useEdgeConnect ловит дроп по data-exit-up).
export function ExitUpTile() {
  return (
    <div className="lg-exit-up" data-exit-up>
      <span className="lg-exit-up-node">
        <span className="lg-exit-up-ico" aria-hidden>
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19 V5" />
            <path d="M6 11 L12 5 L18 11" />
          </svg>
        </span>
        Объект вне уровня
      </span>
    </div>
  );
}
