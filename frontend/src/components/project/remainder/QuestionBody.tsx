// Варианты ответа текущего вопроса (§4 ТЗ). Шапка, прогресс, подвал и навигация —
// в RemainderBlock; здесь только тело: что именно выбирают.
//
// Ничего не предвыбрано — в том числе дефолт бэка: он назван сноской «Если не
// отвечать», а предвыбор превратил бы вопрос в согласие с уже сделанным выбором.
import type { Answer, Answers, NewEdgesAnswer, Question, Resolutions } from "./questions";
import type { EdgesDraft, MergeDraft } from "./drafts";
import { draftFromAnswer, mergeDraftFor } from "./drafts";
import { humanValue, lastSegment, pairEdges, VIEWER_TAG } from "./questionText";
import DocViewer from "./DocViewer";
import MergeNameStep from "./MergeNameStep";
import NewEdgeForm from "./NewEdgeForm";
import ObjectList from "./ObjectList";
import Option from "./Option";
import SplitOption from "./SplitOption";

interface Props {
  question: Question;
  answers: Answers;
  resolutions: Resolutions;
  onAnswer: (id: string, answer: Answer) => void;
  onResolve: (id: string, choice: string) => void;
  /** Второй шаг двухшагового вопроса (форма связи / имя склейки). */
  stage2: boolean;
  onStage2: (on: boolean) => void;
  edgeDraft: EdgesDraft;
  onEdgeDraft: (next: EdgesDraft) => void;
  mergeDraft: MergeDraft;
  onMergeDraft: (next: MergeDraft) => void;
  /** Индекс кандидата, чьё тело открыто вьюером; null — вьюер закрыт. */
  viewer: number | null;
  onViewer: (candidate: number | null) => void;
}

export default function QuestionBody(p: Props) {
  const q = p.question;

  if (q.kind === "family") {
    const c = q.source;
    const choice = p.resolutions[q.id];
    const открытый = p.viewer !== null ? c.candidates[p.viewer] : undefined;
    return (
      <>
        <div className="rq-opts">
          {c.candidates.map((k, i) => {
            const value = `cand:${i}`;
            const общее = {
              main: <b>{k.source_label}</b>,
              selected: choice === value,
              onSelect: () => p.onResolve(q.id, value),
            };
            // Сплит-кнопка только у схем логики: их тела длинные, и «Открыть»
            // показывает диаграмму. Спека, таблица, канал и параметр коротки.
            return c.family === "doc" ? (
              <SplitOption key={i} {...общее} open={p.viewer === i} onOpen={() => p.onViewer(i)} />
            ) : (
              <Option key={i} main={общее.main} selected={общее.selected} onClick={общее.onSelect} />
            );
          })}
          {c.allow_all && (
            <Option
              main={<b>Добавить все</b>}
              selected={choice === "all"}
              onClick={() => p.onResolve(q.id, "all")}
            />
          )}
        </div>
        {открытый !== undefined && p.viewer !== null && (
          <DocViewer
            title={c.key}
            source={открытый.source_label}
            tag={VIEWER_TAG[c.family]}
            body={открытый.body}
            diagram={c.family === "doc"}
            onPick={() => { p.onResolve(q.id, `cand:${p.viewer}`); p.onViewer(null); }}
            onClose={() => p.onViewer(null)}
          />
        )}
      </>
    );
  }

  if (q.kind === "field") {
    const a = p.answers[q.id];
    return (
      <div className="rq-opts">
        {q.source.candidates.map((k, i) => (
          <Option
            key={i}
            main={<b>{humanValue(q.source.field, k.value)}</b>}
            sub={k.source_label}
            selected={a?.kind === "field" && a.index === i}
            onClick={() => p.onAnswer(q.id, { kind: "field", index: i })}
          />
        ))}
      </div>
    );
  }

  if (q.kind === "edge") {
    const a = p.answers[q.id];
    return (
      <>
        <ObjectList
          key={q.id}
          items={q.source.components}
          base={q.source.container_path}
          value={a?.kind === "edge" ? a.toPath : null}
          onPick={(path) => p.onAnswer(q.id, { kind: "edge", toPath: path })}
        />
        <div className="rq-opts" style={{ marginTop: 6 }}>
          <Option
            main={`Оставить на контейнере «${q.source.container_path}»`}
            tag="как сейчас"
            keep
            selected={a?.kind === "keep"}
            onClick={() => p.onAnswer(q.id, { kind: "keep" })}
          />
        </div>
      </>
    );
  }

  if (q.kind === "group") {
    const a = p.answers[q.id];
    const готовые: NewEdgesAnswer | null = a?.kind === "new_edges" ? a : null;
    if (p.stage2) {
      return (
        <NewEdgeForm
          nodes={q.nodes}
          draft={p.edgeDraft}
          onDraft={p.onEdgeDraft}
          onAdd={(ответ) => { p.onAnswer(q.id, ответ); p.onStage2(false); }}
          onBack={() => p.onStage2(false)}
        />
      );
    }
    if (готовые !== null && готовые.edges.length > 0) {
      // Ответ виден одной карточкой: «изменить» открывает ту же форму
      // заполненной, и ответ переписывается только кнопкой «Провести связи».
      const видимые = готовые.edges.slice(0, 3);
      const ещё = готовые.edges.length - видимые.length;
      return (
        <div className="rq-opts">
          <Option
            main={
              <>
                {видимые.map((e, i) => (
                  <span key={i} style={{ display: "block" }}>
                    <b>{lastSegment(e.fromPath)} → {lastSegment(e.toPath)}</b>
                  </span>
                ))}
                {ещё > 0 && <span className="rq-opt-m">и ещё {ещё}</span>}
              </>
            }
            tag="изменить"
            selected
            onClick={() => {
              p.onEdgeDraft(draftFromAnswer(готовые, q.source.node_paths));
              p.onStage2(true);
            }}
          />
        </div>
      );
    }
    return (
      <div className="rq-opts">
        <Option
          main={<b>Провести связь</b>}
          sub="указать, с чем связан каждый объект"
          onClick={() => p.onStage2(true)}
        />
        <Option
          main="Оставить как есть"
          tag="как сейчас"
          keep
          selected={a?.kind === "keep"}
          onClick={() => p.onAnswer(q.id, { kind: "keep" })}
        />
      </div>
    );
  }

  const a = p.answers[q.id];
  const имя = a?.kind === "merge" ? a.name : null;
  if (p.stage2 || имя !== null) {
    return (
      <MergeNameStep
        pair={q.source}
        draft={p.mergeDraft}
        onDraft={p.onMergeDraft}
        onApply={(name) => { p.onAnswer(q.id, { kind: "merge", name }); p.onStage2(false); }}
        // Ответ уже дан — возвращаться некуда: шаг 2 и есть вопрос (§4.5).
        onBack={имя === null ? () => p.onStage2(false) : undefined}
      />
    );
  }
  return (
    <div className="rq-opts">
      <Option
        main={<b>Один объект</b>}
        sub={`связи обоих (${pairEdges(q.source)}) перейдут на склеенный`}
        onClick={() => { p.onMergeDraft(mergeDraftFor(q.source, null)); p.onStage2(true); }}
      />
      <Option
        main="Разные объекты"
        tag="как сейчас"
        keep
        selected={a?.kind === "diff"}
        onClick={() => p.onAnswer(q.id, { kind: "diff" })}
      />
    </div>
  );
}
