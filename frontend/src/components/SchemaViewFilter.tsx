// Переключатель «Вид схемы» (тихий бар, Вариант A) — презентационный компонент.
// Логика видов (какие статусы показывает каждый вид) — в ./schemaView. Стили —
// в inspector/inspector.css (классы insp-seg*: нужны hover/active). Контракт
// (view/onChange) не меняем. Легенда статусов переехала в правую панель
// (inspector/ObjectInspector), отдельного SchemaLegend здесь больше нет.
import { SCHEMA_VIEWS, type SchemaView } from "./schemaView";
import "./inspector/inspector.css";

// Микро-подзаголовок сегмента под крупной подписью (его роль — заменить прежнюю
// строку-hint). По id вида.
const SEG_SUB: Record<SchemaView, string> = {
  asis: "как есть",
  all: "переход",
  tobe: "целевое",
};

export function SchemaViewFilter({
  view, onChange,
}: { view: SchemaView; onChange: (v: SchemaView) => void }) {
  return (
    <div>
      <div className="insp-eyebrow">Вид схемы</div>
      <div className="insp-seg" role="radiogroup" aria-label="Вид схемы">
        {SCHEMA_VIEWS.map((v) => {
          const active = v.id === view;
          return (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(v.id)}
              className={"insp-seg-btn" + (active ? " is-active" : "")}
            >
              <span className="insp-seg-main">{v.label}</span>
              <span className="insp-seg-sub">{SEG_SUB[v.id]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
