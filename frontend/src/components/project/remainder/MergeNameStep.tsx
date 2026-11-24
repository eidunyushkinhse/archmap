// Второй шаг вопроса о похожих именах (§4.5 ТЗ): как назвать склеенный объект.
// Три варианта — имя A, имя B, своё имя; связи обоих перейдут на склеенный, а
// второе имя перестанет использоваться (это говорит строка контекста над шагом). Ответ
// перезаписывается только кнопкой «Объединить», и она же возвращает к первому шагу, где
// ответ виден выбранным вариантом; черновик сам по себе ничего не решает. «Назад к
// вопросу» есть всегда и ответа не меняет (фаза 8б). Кнопки и поле на новом языке
// (ds-btn, ds-input): «Объединить» первой, «Назад к вопросу» за ней.
import type { FuzzyPairOut } from "../../../types";
import type { MergeDraft } from "./drafts";
import { lastSegment } from "./questionText";
import Option from "./Option";
import { noAutofill } from "../../../ui/noAutofill";
import "../../../ui/ds.css";

interface Props {
  pair: FuzzyPairOut;
  draft: MergeDraft;
  onDraft: (next: MergeDraft) => void;
  onApply: (name: string) => void;
  onBack: () => void;
}

export default function MergeNameStep({ pair, draft, onDraft, onApply, onBack }: Props) {
  const a = lastSegment(pair.a_path);
  const b = lastSegment(pair.b_path);
  const own = draft.own.trim();
  const ready = draft.pick !== "own" || own !== "";

  return (
    <>
      <div className="rq-opts">
        {/* Под именем только источник: сумму связей уже назвала строка контекста. */}
        <Option
          main={<b>{a}</b>}
          sub={pair.a_source}
          selected={draft.pick === "a"}
          onClick={() => onDraft({ ...draft, pick: "a" })}
        />
        <Option
          main={<b>{b}</b>}
          sub={pair.b_source}
          selected={draft.pick === "b"}
          onClick={() => onDraft({ ...draft, pick: "b" })}
        />
        <Option
          main={<b>Своё имя</b>}
          selected={draft.pick === "own"}
          onClick={() => onDraft({ ...draft, pick: "own" })}
        />
      </div>
      {draft.pick === "own" && (
        <div className="rq-own">
          <input
            {...noAutofill("merge-name-step-1")}
            className="ds-input"
            value={draft.own}
            aria-label="Своё имя"
            placeholder="например, Оператор мониторинга"
            onChange={(e) => onDraft({ ...draft, own: e.target.value })}
          />
        </div>
      )}
      <div className="rq-acts">
        <button
          type="button"
          className="ds-btn ds-btn--primary"
          disabled={!ready}
          onClick={() => {
            const name = draft.pick === "a" ? a : draft.pick === "b" ? b : own;
            if (name !== "") onApply(name);
          }}
        >
          Объединить
        </button>
        <button type="button" className="ds-btn" onClick={onBack}>
          Назад к вопросу
        </button>
      </div>
    </>
  );
}
