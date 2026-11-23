// Переключатель «Вид схемы» (тихий бар, Вариант A) — презентационный компонент.
// Логика видов (какие статусы показывает каждый вид) — в ./schemaView. Стили —
// в inspector/inspector.css (классы insp-seg*: нужны hover/active).
//
// ДВА ВАРИАНТА ОДНОГО компонента, а не две копии:
//   panel  — вертикальная секция с заголовком и двухстрочными кнопками. Родом из
//            правой панели редактора, где сверху вниз места сколько угодно.
//   inline — одна строка без заголовка, пояснение вида уезжает в подсказку. Для
//            ГОРИЗОНТАЛЬНЫХ тулбаров: вариант panel, вставленный в такой тулбар,
//            растягивал его заголовком и второй строкой подписей, а сам получался
//            непропорционально узким и высоким (находка ручной проверки №12).
//   tabs   — та же строка вкладками-текстом нового языка (редизайн, направление А):
//            активный вид подчёркнут, без подложки-сегмента. Для строки заголовка
//            раздела «Схема» на страницах объекта и проекта.
import { SCHEMA_VIEWS, VIEW_BY_ID, type SchemaView } from "./schemaView";
import "./inspector/inspector.css";
import "../ui/ds.css";

// Микро-подзаголовок сегмента под крупной подписью (его роль — заменить прежнюю
// строку-hint). По id вида. В inline-варианте не показывается. Говорит, что вид
// прячет: названия видов одни на весь интерфейс («Как есть / Переход / Как будет»),
// второго словаря («целевое») нет (ревизия текстов 2026-11).
const SEG_SUB: Record<SchemaView, string> = {
  asis: "без проектируемых",
  all: "все статусы",
  tobe: "без выводимых",
};

interface Props {
  view: SchemaView;
  onChange: (v: SchemaView) => void;
  /** Раскладка: секция панели (по умолчанию) или вкладки-текст. */
  variant?: "panel" | "tabs";
}

export function SchemaViewFilter({ view, onChange, variant = "panel" }: Props) {
  if (variant === "tabs") {
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
