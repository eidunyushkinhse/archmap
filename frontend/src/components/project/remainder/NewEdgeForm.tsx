// Форма проведения связей — второй шаг вопроса об изолированной группе (§4.4,
// §5.4 ТЗ; П4 v2 после приёмки 2026-09-21).
//
// Строка на КАЖДЫЙ объект группы: слева он сам, справа сосед из слитого дерева,
// между ними стрелка-соединитель с переключателем направления. Так видно, у
// каких объектов связей ещё нет, — прежняя форма про один конец это скрывала.
// Пустая строка законна: объект, у которого связи действительно нет, так и
// останется без неё.
//
// Типа канала здесь нет вовсе: синхронность связи — предмет «Процессов», а не
// разбора остатка (бэк без поля channel ставит дефолт движка).
import type { ComponentOut } from "../../../types";
import type { NewEdgesAnswer } from "./questions";
import type { EdgesDraft } from "./drafts";
import { answerFromDraft } from "./drafts";
import { SwapIcon } from "../../../ui/icons";
import ObjectCombobox from "./ObjectCombobox";
import { PathLabel } from "./Option";
import { noAutofill } from "../../../ui/noAutofill";

interface Props {
  /** Всё слитое дерево: сосед выбирается по нему. */
  nodes: ComponentOut[];
  draft: EdgesDraft;
  onDraft: (next: EdgesDraft) => void;
  onAdd: (answer: NewEdgesAnswer) => void;
  onBack: () => void;
}

export default function NewEdgeForm({ nodes, draft, onDraft, onAdd, onBack }: Props) {
  const правка = (i: number, patch: Partial<EdgesDraft[number]>) =>
    onDraft(draft.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const готово = draft.filter((r) => r.toPath !== null).length;

  return (
    <>
      {draft.map((row, i) => (
        <div key={row.nodePath} className="rq-erow">
          <div className="rq-epair">
            <div className="rq-eend--fixed" title={row.nodePath}>
              <PathLabel path={row.nodePath} />
            </div>
            {/* Соединитель: линия от поля к полю, наконечник у ЦЕЛИ связи,
                переключатель посередине. Направление видно, не читая подписей. */}
            <div className="rq-econn">
              {row.reversed && <Head dir="left" />}
              <span className="rq-econn-line" />
              {!row.reversed && <Head dir="right" />}
              <button
                type="button"
                className="rq-econn-btn"
                title="Поменять направление"
                aria-label="Поменять направление"
                onClick={() => правка(i, { reversed: !row.reversed })}
              >
                <SwapIcon size={12} />
              </button>
            </div>
            <ObjectCombobox
              items={nodes.filter((n) => n.path !== row.nodePath)}
              value={row.toPath}
              label={`С чем связан объект «${lastName(row.nodePath)}»`}
              onChange={(path) => правка(i, { toPath: path })}
            />
          </div>
          <div className="rq-frow">
            <div>
              <div className="rq-flbl">Описание</div>
              <input
                {...noAutofill("new-edge-form-1")}
                className="rq-inp"
                value={row.label}
                aria-label={`Описание связи — ${row.nodePath}`}
                placeholder="что ходит по связи"
                onChange={(e) => правка(i, { label: e.target.value })}
              />
            </div>
            <div>
              <div className="rq-flbl">Технология</div>
              <input
                {...noAutofill("new-edge-form-2")}
                className="rq-inp"
                value={row.tech}
                aria-label={`Технология связи — ${row.nodePath}`}
                placeholder="SQL, HTTP/JSON, gRPC…"
                onChange={(e) => правка(i, { tech: e.target.value })}
              />
            </div>
          </div>
        </div>
      ))}
      <div className="rq-more">
        <button
          type="button"
          className="rq-pri"
          disabled={готово === 0}
          onClick={() => onAdd(answerFromDraft(draft))}
        >
          {готово > 1 ? "Провести связи" : "Провести связь"}
        </button>
        <button type="button" className="rq-link rq-link--mut" onClick={onBack}>
          Назад к вопросу
        </button>
      </div>
    </>
  );
}

const lastName = (path: string): string => path.split(" / ").pop() ?? path;

// Наконечник соединителя. Живёт здесь, а не в ui/icons: это часть линии между
// полями, а не иконка хрома, и её сторона зависит от направления связи.
function Head({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      className="rq-econn-head"
      width="7" height="10" viewBox="0 0 7 10" aria-hidden
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
    >
      {dir === "right" ? <path d="M1.5 1.5 L5.5 5 L1.5 8.5" /> : <path d="M5.5 1.5 L1.5 5 L5.5 8.5" />}
    </svg>
  );
}
