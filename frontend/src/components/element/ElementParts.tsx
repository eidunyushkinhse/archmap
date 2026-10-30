// Общие части строки «Элемент архитектуры» для инспектора редактора, «Свойств» страницы
// объекта и инспектора гостя: справка «?» и значение только для чтения (текст или текст
// со ссылкой на контейнер компонента). Один рендер на три места — без копий.
import InfoPopover from "../../ui/InfoPopover";
import { ELEMENT_HELP, ELEMENT_HELP_LABEL } from "./elementText";
import type { ElementView } from "./elementView";
import "./element.css";

// Справка «?»: что такое система, контейнер и компонент.
export function ElementHelp() {
  return (
    <InfoPopover label={ELEMENT_HELP_LABEL}>
      {ELEMENT_HELP.map((p) => (
        <p key={p.head}><b>{p.head}</b> {p.body}</p>
      ))}
    </InfoPopover>
  );
}

// Значение строки без выбора. Ссылка ведёт на страницу контейнера; одним span — чтобы
// во flex-ячейке инспектора пробел между текстом и ссылкой не схлопнулся.
export function ElementValue({ view, onNavigateNode }: {
  view: Extract<ElementView, { kind: "text" | "link" }>;
  onNavigateNode: (id: string) => void;
}) {
  if (view.kind === "text") return <span>{view.text}</span>;
  return (
    <span>
      {view.lead}{" "}
      <button
        type="button"
        className="el-link"
        onClick={() => onNavigateNode(view.containerId)}
        title={`Открыть страницу «${view.name}»`}
      >
        «{view.name}»
      </button>
    </span>
  );
}
