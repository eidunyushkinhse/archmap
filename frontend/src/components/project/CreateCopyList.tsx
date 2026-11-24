// Режим «Копия» окна «Новый проект»: проекты-образцы строками в одну линию, выбранный —
// галочкой справа, как текущий проект в списке проектов шапки (ProjectSwitcher). Длинное
// имя обрезается многоточием, целиком — в подсказке. Больше восьми проектов — список
// прокручивается внутри себя.
import type { Project } from "../../types";
import { CheckIcon } from "../../ui/icons";
import "./createProject.css";

export default function CreateCopyList({ projects, selected, onSelect }: {
  projects: Project[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="cp-sources" role="group" aria-label="Образец">
      {projects.map((p) => {
        const on = p.id === selected;
        return (
          <button
            key={p.id}
            type="button"
            className={"cp-source" + (on ? " is-on" : "")}
            aria-pressed={on}
            onClick={() => onSelect(p.id)}
          >
            <span className="cp-source-name" title={p.name}>{p.name}</span>
            {on && <span className="cp-source-check" aria-hidden="true"><CheckIcon size={14} /></span>}
          </button>
        );
      })}
    </div>
  );
}
