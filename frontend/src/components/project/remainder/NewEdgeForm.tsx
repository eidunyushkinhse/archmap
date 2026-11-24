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
//
// Раскладка (фаза 8б редизайна): на объект одна строка высотой поля, без карточки. Объект
// слева — обычный текст: имя видно всегда, префикс пути тихим цветом и обрезается только
// он, полный путь в подсказке. Поля «что ходит по связи» и «технология» появляются второй
// строкой, только когда сосед выбран; очищенный сосед прячет их, а введённое остаётся в
// черновике и вернётся при новом выборе. Кнопки на новом языке: «Провести связь» первой,
// «Назад к вопросу» за ней.
import type { ComponentOut } from "../../../types";
import type { NewEdgesAnswer } from "./questions";
import type { EdgesDraft } from "./drafts";
import { answerFromDraft } from "./drafts";
import { SwapIcon } from "../../../ui/icons";
import ObjectCombobox from "./ObjectCombobox";
import { noAutofill } from "../../../ui/noAutofill";
import "../../../ui/ds.css";
import "./remainder.css";

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
      <div className="rq-eform">
        {draft.map((row, i) => (
          <div key={row.nodePath} className="rq-erow">
            <div className="rq-epair">
              <ObjectName path={row.nodePath} />
              {/* Соединитель: линия от объекта к полю, наконечник у ЦЕЛИ связи,
                  переключатель посередине. Направление видно, не читая подписей. */}
              <div className="rq-econn">
                {row.reversed && <Head dir="left" />}
                <span className="rq-econn-line" />
                {!row.reversed && <Head dir="right" />}
                <button
                  type="button"
                  className="ds-icon-btn rq-econn-btn"
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
            {row.toPath !== null && (
              <div className="rq-frow">
                <input
                  {...noAutofill("new-edge-form-1")}
                  className="ds-input"
                  value={row.label}
                  aria-label={`Описание связи от «${row.nodePath}»`}
                  placeholder="Что ходит по связи"
                  onChange={(e) => правка(i, { label: e.target.value })}
                />
                <input
                  {...noAutofill("new-edge-form-2")}
                  className="ds-input"
                  value={row.tech}
                  aria-label={`Технология связи от «${row.nodePath}»`}
                  placeholder="Технология, например HTTP"
                  onChange={(e) => правка(i, { tech: e.target.value })}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="rq-acts">
        <button
          type="button"
          className="ds-btn ds-btn--primary"
          disabled={готово === 0}
          onClick={() => onAdd(answerFromDraft(draft))}
        >
          {готово > 1 ? "Провести связи" : "Провести связь"}
        </button>
        <button type="button" className="ds-btn" onClick={onBack}>
          Назад к вопросу
        </button>
      </div>
    </>
  );
}

const lastName = (path: string): string => path.split(" / ").pop() ?? path;

/**
 * Объект группы слева: обычный текст, не поле. Имя (последний сегмент) видно всегда, префикс
 * пути тихим цветом обрезается многоточием первым; полный путь — в подсказке.
 */
function ObjectName({ path }: { path: string }) {
  const name = lastName(path);
  // Пробел после « /» даёт зазор flex-строки (.rq-eobj): хвостовой пробел элемента схлопнулся бы.
  const prefix = path.slice(0, path.length - name.length).trimEnd();
  return (
    <div className="rq-eobj" title={path}>
      {prefix !== "" && <span className="rq-eobj-pre">{prefix}</span>}
      <span className="rq-eobj-name">{name}</span>
    </div>
  );
}

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
