// Проблемы черновика импорта процесса (редизайн, фаза 3б). Показывается только то, что
// требует решения или говорит о потере: участники без объекта схемы (с выбором),
// шаги, которые не встанут на связь схемы, непонятые строки, ненайденные привязки к
// схемам логики, потеря привязок при замене, отказ. Сопоставившиеся сами участники
// свёрнуты в тихую строку «Сопоставлено N». Счётчиков «шагов · фрагментов» нет.
import { useState } from "react";
import type { ReactNode } from "react";
import type { ProcessImportPreview } from "../../types";
import { ChevronDownIcon } from "../../ui/icons";
import { plural } from "../../ui/plural";
import { LimitText } from "../demo/DemoLimitToast";
import { chosenNode, issuesOf } from "./importIssues";
import type { DocKeep, DraftFailure, Participant } from "./importIssues";

interface Props {
  preview: ProcessImportPreview | null;
  choice: Record<string, string>;
  onChoose: (alias: string, nodeId: string) => void;
  // Отказы: файл не прочитан, превью не посчиталось, импорт или замена не прошли.
  errors: DraftFailure[];
  keep: DocKeep | null;
}

export default function ImportDraftIssues({ preview, choice, onChoose, errors, keep }: Props) {
  const i = preview ? issuesOf(preview) : null;
  return (
    <div className="pim-issues">
      {errors.map((e, n) => (
        <p key={n} className="ds-danger pim-line" role="alert">
          {typeof e === "string" ? e : <LimitText message={e} />}
        </p>
      ))}
      {preview && i && (
        <>
          {i.unmatched.length > 0 && (
            <div className="pim-parts">
              {i.unmatched.map((p) => (
                <ParticipantRow key={p.alias} p={p} value={chosenNode(p, choice)} onChoose={onChoose} />
              ))}
            </div>
          )}
          {i.matched.length > 0 && (
            <Expand label={`Сопоставлено ${i.matched.length}`} quiet>
              <div className="pim-parts">
                {i.matched.map((p) => (
                  <ParticipantRow key={p.alias} p={p} value={chosenNode(p, choice)} onChoose={onChoose} />
                ))}
              </div>
            </Expand>
          )}
          {i.noLink.length > 0 && (
            <Expand label={`${i.noLink.length} ${plural(i.noLink.length, ["шаг", "шага", "шагов"])} без связи на схеме`}>
              <ul className="pim-list">
                {i.noLink.map((s) => (
                  <li key={s.order}>
                    {s.from_name} → {s.to_name}{s.caption ? `, ${s.caption}` : ""}
                  </li>
                ))}
              </ul>
            </Expand>
          )}
          {preview.unsupported.length > 0 && (
            <Expand label={unsupportedLabel(preview.unsupported.length)}>
              <ul className="pim-list pim-list--mono">
                {preview.unsupported.map((u, n) => <li key={n}>{u}</li>)}
              </ul>
            </Expand>
          )}
          {i.docLost.length > 0 && (
            <Expand label={docLostLabel(i.docLost.length)}>
              <ul className="pim-list pim-list--mono">
                {i.docLost.map((s) => <li key={s.order}>{s.doc_address}</li>)}
              </ul>
            </Expand>
          )}
          {keep !== null && keep.m < keep.k && (
            <p className="ds-warn pim-line">Привязок к схемам логики останется {keep.m} из {keep.k}</p>
          )}
        </>
      )}
    </div>
  );
}

function unsupportedLabel(n: number): string {
  const verb = plural(n, ["Не разобрана", "Не разобраны", "Не разобрано"]);
  return `${verb} ${n} ${plural(n, ["строка", "строки", "строк"])}`;
}

function docLostLabel(n: number): string {
  return plural(n, [
    `${n} привязка к схеме логики не найдена`,
    `${n} привязки к схемам логики не найдены`,
    `${n} привязок к схемам логики не найдено`,
  ]);
}

// Участник и выбор объекта схемы. У тёзок в скобках родитель: иначе одинаковые строки
// не различить. Без кандидатов выбирать не из чего, строка говорит о потере.
function ParticipantRow({ p, value, onChoose }: {
  p: Participant;
  value: string;
  onChoose: (alias: string, nodeId: string) => void;
}) {
  const namesakes = p.candidates.length > 1;
  return (
    <label className="pim-part">
      <span className="pim-part-name">{p.name}</span>
      <select
        className="ds-input pim-select"
        value={value}
        disabled={p.candidates.length === 0}
        onChange={(e) => onChoose(p.alias, e.target.value)}
      >
        <option value="">Без объекта схемы</option>
        {p.candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}{namesakes && c.parent_name ? ` (${c.parent_name})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

// Строка, раскрывающая список по клику. Потери — цветом предупреждения, «Сопоставлено» —
// тихим.
function Expand({ label, quiet = false, children }: { label: string; quiet?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pim-exp">
      <button
        type="button"
        className={"ds-expand pim-exp-btn" + (quiet ? "" : " pim-exp-btn--warn")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={"ds-chev" + (open ? "" : " is-closed")}><ChevronDownIcon /></span>
        {label}
      </button>
      {open && <div className="pim-exp-body">{children}</div>}
    </div>
  );
}
