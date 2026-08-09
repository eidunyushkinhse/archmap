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
import { SCHEMA_VIEWS, VIEW_BY_ID, type SchemaView } from "./schemaView";
import "./inspector/inspector.css";

// Микро-подзаголовок сегмента под крупной подписью (его роль — заменить прежнюю
// строку-hint). По id вида. В inline-варианте не показывается.
const SEG_SUB: Record<SchemaView, string> = {
  asis: "как есть",
  all: "переход",
  tobe: "целевое",
};

interface Props {
  view: SchemaView;
  onChange: (v: SchemaView) => void;
  /** Раскладка: секция панели (по умолчанию) или строка тулбара. */
  variant?: "panel" | "inline";
}

export function SchemaViewFilter({ view, onChange, variant = "panel" }: Props) {
  const inline = variant === "inline";
  const seg = (
    <div
      className={"insp-seg" + (inline ? " insp-seg--inline" : "")}
      role="radiogroup"
      aria-label="Вид схемы"
    >
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
            // В одну строку пояснение не влезает — отдаём его подсказкой.
            title={inline ? VIEW_BY_ID[v.id].hint : undefined}
          >
            <span className="insp-seg-main">{v.label}</span>
            {!inline && <span className="insp-seg-sub">{SEG_SUB[v.id]}</span>}
          </button>
        );
      })}
    </div>
  );

  if (inline) return seg;
  return (
    <div>
      <div className="insp-eyebrow">Вид схемы</div>
      {seg}
    </div>
  );
}
