// Переключатель «Вид схемы» — презентационный компонент. Логика видов (какие статусы
// показывает каждый вид) — в ./schemaView.
//
// Одна строка вкладками-текстом нового языка (редизайн, направление А; ui/ds.css, ds-tabs):
// активный вид подчёркнут, без подложки-сегмента, пояснение вида в подсказке. Стоит в
// строке заголовка раздела «Схема» на страницах объекта и проекта и в шапке
// редактора-карты. Прежний вид секцией панели с двухстрочными кнопками удалён вместе с
// его стилями (фаза 13в-2): его вызывала только прежняя правая панель редактора.
import { SCHEMA_VIEWS, VIEW_BY_ID, type SchemaView } from "./schemaView";
import "../ui/ds.css";

interface Props {
  view: SchemaView;
  onChange: (v: SchemaView) => void;
}

export function SchemaViewFilter({ view, onChange }: Props) {
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
            onClick={() => onChange(v.id)}
            className={"ds-tab" + (active ? " is-active" : "")}
            title={VIEW_BY_ID[v.id].hint}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
