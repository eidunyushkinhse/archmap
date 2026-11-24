// Переключатель «Вида схемы» в шапке процесса — вкладками нового языка (ds-tabs), как и
// переключатель масштаба рядом. Что показывает вид, говорит подсказка вкладки: отдельной
// строки-плашки над диаграммой больше нет (редизайн, фаза 3а). Логика видов — в
// ../schemaView. Все экспорты — компоненты (правило react-refresh).
import { SCHEMA_VIEWS, type SchemaView } from "../schemaView";
import "../../ui/ds.css";

export function SchemaViewSeg({ view, onChange }: { view: SchemaView; onChange: (v: SchemaView) => void }) {
  return (
    <div className="ds-tabs" role="radiogroup" aria-label="Вид схемы">
      {SCHEMA_VIEWS.map((v) => {
        const active = v.id === view;
        return (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={v.hint}
            onClick={() => onChange(v.id)}
            className={"ds-tab" + (active ? " is-active" : "")}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
