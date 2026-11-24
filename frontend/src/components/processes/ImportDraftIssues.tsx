// Проблемы черновика импорта процесса (редизайн, фаза 3б). Показывается только то, что
// требует решения или говорит о потере: участники без объекта схемы (с выбором любого
// объекта схемы, NodeChoice), шаги, которые не встанут на связь схемы, непонятые строки,
// ненайденные привязки к схемам логики, потеря привязок при замене, отказ.
// Сопоставившиеся сами участники свёрнуты в тихую строку «Сопоставлено N» с тем же
// выбором. Счётчиков «шагов · фрагментов» нет.
import { useState } from "react";
import type { ReactNode } from "react";
import type { ProcessImportPreview } from "../../types";
import { ChevronDownIcon } from "../../ui/icons";
import { plural } from "../../ui/plural";
import { LimitText } from "../demo/DemoLimitToast";
import { chosenNode, issuesOf } from "./importIssues";
import type { DocKeep, DraftFailure, Participant } from "./importIssues";
import NodeChoice from "./NodeChoice";
import type { SchemaNodes } from "./schemaNodes";

interface Props {
  preview: ProcessImportPreview | null;
  choice: Record<string, string>;
  onChoose: (alias: string, nodeId: string) => void;
  // Отказы: файл не прочитан, превью не посчиталось, импорт или замена не прошли.
  errors: DraftFailure[];
  keep: DocKeep | null;
  // Объекты схемы для выбора участнику: окно грузит их один раз на всё время жизни.
  schema: SchemaNodes;
}

export default function ImportDraftIssues({ preview, choice, onChoose, errors, keep, schema }: Props) {
  const i = preview ? issuesOf(preview) : null;
  // Объекты, выбранные участникам черновика: другому участнику они не предлагаются.
  const chosen = (preview?.participants ?? []).map((p) => [p.alias, chosenNode(p, choice)] as const);
  const row = (p: Participant) => (
    <ParticipantRow
      key={p.alias}
      p={p}
      value={chosenNode(p, choice)}
      taken={new Set(chosen.filter(([a, id]) => a !== p.alias && id !== "").map(([, id]) => id))}
      schema={schema}
      onChoose={onChoose}
    />
  );
  return (
    <div className="pim-issues">
      {errors.map((e, n) => (
        <p key={n} className="ds-danger pim-line" role="alert">
          {typeof e === "string" ? e : <LimitText message={e} />}
        </p>
      ))}
      {preview && i && (
        <>
          {i.unmatched.length > 0 && <div className="pim-parts">{i.unmatched.map(row)}</div>}
          {i.matched.length > 0 && (
            <Expand label={`Сопоставлено ${i.matched.length}`} quiet>
              <div className="pim-parts">{i.matched.map(row)}</div>
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

// Участник (имя из текста диаграммы) и его объект схемы: значение-кнопка с панелью
// выбора из всей схемы, кандидаты по имени сверху.
function ParticipantRow({ p, value, taken, schema, onChoose }: {
  p: Participant;
  value: string;
  taken: ReadonlySet<string>;
  schema: SchemaNodes;
  onChoose: (alias: string, nodeId: string) => void;
}) {
  return (
    <div className="pim-part">
      <span className="pim-part-name">{p.name}</span>
      <NodeChoice participant={p} value={value} taken={taken} schema={schema} onChoose={(id) => onChoose(p.alias, id)} />
    </div>
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
