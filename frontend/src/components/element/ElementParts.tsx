// Общие части строки «Тип» (Р40 раздела 13 docs/plan-c4-elements.md) для инспектора
// редактора, «Свойств» страницы объекта и инспектора гостя: справка «?» у термина и
// значение — выпадашка из шести типов (TypeSelect) у редактора или текст, у компонента со
// ссылкой на его контейнер. Один рендер на три места — без копий.
import type { ReactNode } from "react";
import InfoPopover from "../../ui/InfoPopover";
import type { NodeType } from "../nodeTerms";
import { ELEMENT_HELP, ELEMENT_HELP_LABEL } from "./elementText";
import type { ContainerLink, TypeView } from "./elementView";
import type { TypeOption } from "./typeOptions";
import TypeSelect from "./TypeSelect";
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

// Контейнер компонента: имя ссылкой на его страницу или текстом, если цепочка предков
// разошлась с сервером. Одним span — чтобы во flex-ячейке инспектора пробел между текстом
// и ссылкой не схлопнулся.
function ContainerRef({ lead, container, onNavigateNode }: {
  lead: string;
  container: ContainerLink;
  onNavigateNode: (id: string) => void;
}) {
  const { id, name } = container;
  if (id === null) return <span>{lead} «{name}»</span>;
  return (
    <span>
      {lead}{" "}
      <button type="button" className="el-link" onClick={() => onNavigateNode(id)} title={`Открыть страницу «${name}»`}>
        «{name}»
      </button>
    </span>
  );
}

// Значение строки «Тип». options — варианты выбора у редактора; null — только чтение
// (читатель, гость). trigger — вид кнопки-значения в месте вызова.
export function TypeValue({ view, options, onPick, onNavigateNode, trigger }: {
  view: TypeView;
  options: readonly TypeOption[] | null;
  onPick?: (type: NodeType) => void;
  onNavigateNode: (id: string) => void;
  trigger?: { className: string; chevron: ReactNode; inline?: boolean };
}) {
  const { value, label, container } = view;
  const named = container !== null && container.name !== "";
  if (options === null || !onPick || !trigger) {
    if (!named) return <span>{label}</span>;
    return <ContainerRef lead="Компонент контейнера" container={container} onNavigateNode={onNavigateNode} />;
  }
  return (
    <span className={trigger.inline ? "ts-cell ts-cell--inline" : "ts-cell"}>
      <TypeSelect
        value={value}
        valueLabel={label}
        options={options}
        onPick={onPick}
        triggerClass={trigger.className}
        chevron={trigger.chevron}
        label="Тип"
        inline={trigger.inline}
      />
      {named && (
        <small className="ts-sub">
          <ContainerRef lead="Входит в контейнер" container={container} onNavigateNode={onNavigateNode} />
        </small>
      )}
    </span>
  );
}
