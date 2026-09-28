// Блок «Без ваших решений не объединить» (§3, §8 ТЗ): остаток слияния задаётся по
// одному вопросу. Шапка со счётчиком, прогресс, тело текущего вопроса
// (QuestionBody), подвал навигации, список всех вопросов и итог разбора.
//
// Главное правило механики: ВЫБОР ВАРИАНТА НЕ ПЕРЕВОДИТ ДАЛЬШЕ. Пользователь
// ходит «Назад/Дальше», точками, списком и стрелками — иначе ответ, данный
// случайным кликом, утаскивал бы экран, и вернуться было бы некуда.
//
// Разбор не обязателен: без единого ответа результат тот же, что сегодня. Поэтому
// блок ничем не блокирует кнопку окна и не показывает ни янтарного, ни красного.
import { useEffect, useState } from "react";
import { plural } from "../../../ui/plural";
import { CheckIcon } from "../../../ui/icons";
import type { Answer, Answers, Question, Resolutions } from "./questions";
import {
  answerLabel, answerState, progressMode, segments, summarize,
} from "./questions";
import { emptyEdgesDraft, mergeDraftFor } from "./drafts";
import type { EdgesDraft, MergeDraft } from "./drafts";
import { MERGE_TITLE, mergeContext, NEW_EDGE_CONTEXT, NEW_EDGE_TITLE } from "./questionText";
import QuestionBody from "./QuestionBody";
import "./remainder.css";

interface Props {
  questions: Question[];
  answers: Answers;
  resolutions: Resolutions;
  onAnswer: (id: string, answer: Answer) => void;
  onResolve: (id: string, choice: string) => void;
  /**
   * Окно, в котором стоит блок. Слова разбора в обоих одни и те же (§8), а
   * массовые кнопки догрузки живут отдельным блоком снаружи (§7) — поле принято
   * как контекст вызова и различий в самом блоке пока не даёт.
   */
  mode: "create" | "into";
}

type View = "q" | "list" | "done";

export default function RemainderBlock({ questions, answers, resolutions, onAnswer, onResolve }: Props) {
  const [indexRaw, setIndex] = useState(0);
  const [view, setView] = useState<View>("q");
  // На каком вопросе открыт второй шаг; черновики форм — по id вопроса, чтобы
  // хождение «Назад/Дальше» их не стирало (§4.6).
  const [stage2, setStage2] = useState<Record<string, boolean>>({});
  const [edgeDrafts, setEdgeDrafts] = useState<Record<string, EdgesDraft>>({});
  const [mergeDrafts, setMergeDrafts] = useState<Record<string, MergeDraft>>({});
  const [viewer, setViewer] = useState<{ id: string; candidate: number } | null>(null);

  // Состав вопросов меняется при правке входов — индекс клампим ПРИ РЕНДЕРЕ
  // (производное состояние, а не зеркалящий эффект).
  const index = Math.max(0, Math.min(indexRaw, questions.length - 1));
  const q: Question | undefined = questions[index];
  const итог = summarize(questions, answers, resolutions);
  const last = index === questions.length - 1;

  const go = (to: number) => { setIndex(to); setView("q"); };

  // Стрелки ← → ходят по вопросам (Р9): не в поле ввода (в том же окне живёт
  // textarea YAML), не поверх открытого вьюера и не с модификаторами.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
      if (viewer !== null || view !== "q") return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "ArrowLeft") setIndex(Math.max(0, index - 1));
      else if (index >= questions.length - 1) setView("done");
      else setIndex(index + 1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewer, view, index, questions.length]);

  if (questions.length === 0 || q === undefined) return null;

  const шаг2 = (q.kind === "group" && stage2[q.id] === true)
    || (q.kind === "pair" && (stage2[q.id] === true || answers[q.id]?.kind === "merge"));
  const title = !шаг2 ? q.title : q.kind === "pair" ? MERGE_TITLE : NEW_EDGE_TITLE;
  // Черновик формы связей: нет своего — строка на каждый объект группы (П4).
  const edgeDraft: EdgesDraft = edgeDrafts[q.id]
    ?? (q.kind === "group" ? emptyEdgesDraft(q.source.node_paths) : []);
  // Черновик шага 2 склейки: нет своего — открываем на уже выбранном имени.
  const mergeDraft: MergeDraft = mergeDrafts[q.id]
    ?? (q.kind === "pair" ? mergeDraftFor(q.source, currentName(q, answers)) : { pick: "a", own: "" });
  const context = !шаг2 ? q.context
    : q.kind === "pair" ? mergeContext(q.source) : NEW_EDGE_CONTEXT;

  const шапка = (
    <>
      <div className="rq-hd">
        <div className="rq-h1">
          Без ваших решений не объединить. <span>Помогите сделать правильно</span>
        </div>
      </div>
      <div className="rq-sub">
        <span className="rq-cnt">
          {view === "done" ? "разбор пройден" : `вопрос ${index + 1} из ${questions.length}`}
        </span>
        <button
          type="button"
          className="rq-nav rq-sp"
          onClick={() => setView(view === "list" ? "q" : "list")}
        >
          {view === "list" ? "К вопросу" : "Все вопросы"}
        </button>
      </div>
    </>
  );

  if (view === "done") {
    // Нулевые части не выводятся вовсе, «оставлено как есть» — только когда есть
    // что оставлять: итог перечисляет сделанное, а не отчитывается по графам.
    const части = [
      { t: "перевешено связей", n: итог.rewired },
      { t: "добавлено связей", n: итог.added },
      { t: "склеек", n: итог.merged },
      { t: "оставлено как есть", n: итог.kept },
    ].filter((x) => x.n > 0);
    return (
      <div className="rq-root rq-block">
        {шапка}
        <div className="rq-bd rq-done">
          <span className={"rq-tick" + (итог.unanswered > 0 ? " rq-tick--open" : "")}>
            {итог.unanswered > 0 ? "?" : <CheckIcon size={12} />}
          </span>
          <div>
            <div className="rq-done-t">
              {итог.unanswered > 0
                ? `Осталось ${итог.unanswered} ${plural(итог.unanswered, ["вопрос", "вопроса", "вопросов"])} без ответа`
                : "Разбор пройден"}
            </div>
            {части.length > 0 && (
              <div className="rq-done-s">
                {части.map((ч, i) => (
                  <span key={ч.t}>{i > 0 && " · "}{ч.t} <b>{ч.n}</b></span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="rq-ft">
          {итог.unanswered > 0 && (
            <button
              type="button"
              className="rq-nav"
              onClick={() => {
                const i = questions.findIndex((x) => answerState(x, answers, resolutions) === "none");
                if (i >= 0) go(i);
              }}
            >
              Вернуться к пропущенным
            </button>
          )}
          <span className="rq-sp" />
          <button type="button" className="rq-nav" onClick={() => setView("list")}>
            Пересмотреть ответы
          </button>
        </div>
      </div>
    );
  }

  if (view === "list") {
    return (
      <div className="rq-root rq-block">
        {шапка}
        <div className="rq-bd">
          <div className="rq-ql">
            {questions.map((x, i) => {
              const ответ = answerLabel(x, answers, resolutions);
              const серый = ответ === null;
              return (
                <button
                  key={x.id}
                  type="button"
                  className={"rq-ql-r" + (i === index ? " rq-ql-r--on" : "")}
                  onClick={() => go(i)}
                >
                  <span className="rq-ql-n">{i + 1}</span>
                  <span className="rq-ql-q">{x.title}</span>
                  <span className={"rq-ql-a" + (серый ? " rq-ql-a--none" : "")}>{ответ ?? "—"}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rq-root rq-block">
      {шапка}
      <Progress
        questions={questions} answers={answers} resolutions={resolutions}
        index={index} onGo={go}
      />
      <div className="rq-bd">
        <h4 className="rq-q">{title}</h4>
        {context !== null && <p className="rq-ctx">{context}</p>}
        {/* Второй шаг — продолжение того же вопроса: «почему» и «если не отвечать»
            он не повторяет (§4.6). */}
        {!шаг2 && (
          <details className="rq-why">
            <summary>почему возник вопрос</summary>
            <p>{q.why}</p>
          </details>
        )}
        <QuestionBody
          question={q}
          answers={answers}
          resolutions={resolutions}
          onAnswer={onAnswer}
          onResolve={onResolve}
          stage2={шаг2}
          onStage2={(on) => setStage2((cur) => ({ ...cur, [q.id]: on }))}
          edgeDraft={edgeDraft}
          onEdgeDraft={(next) => setEdgeDrafts((cur) => ({ ...cur, [q.id]: next }))}
          mergeDraft={mergeDraft}
          onMergeDraft={(next) => setMergeDrafts((cur) => ({ ...cur, [q.id]: next }))}
          viewer={viewer?.id === q.id ? viewer.candidate : null}
          onViewer={(c) => setViewer(c === null ? null : { id: q.id, candidate: c })}
        />
        {!шаг2 && q.ifLeft !== null && <div className="rq-ifnot">{q.ifLeft}</div>}
      </div>
      <div className="rq-ft">
        <button
          type="button"
          className="rq-nav"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          ← Назад
        </button>
        <span className="rq-sp" />
        <button
          type="button"
          className="rq-nav"
          onClick={() => (last ? setView("done") : setIndex(index + 1))}
        >
          {last ? "Завершить →" : "Дальше →"}
        </button>
      </div>
    </div>
  );
}

/** Имя уже выбранной склейки — чтобы шаг 2 открылся на нём, а не на первом. */
function currentName(q: Question, answers: Answers): string | null {
  const a = answers[q.id];
  return a?.kind === "merge" ? a.name : null;
}

function Progress({ questions, answers, resolutions, index, onGo }: {
  questions: Question[]; answers: Answers; resolutions: Resolutions;
  index: number; onGo: (i: number) => void;
}) {
  // До полутора десятков вопросов ряд точек читается целиком; дальше он
  // превращается в шум, и прогресс показывается полосой по видам (§3).
  if (progressMode(questions.length) === "dots") {
    return (
      <div className="rq-prog">
        {questions.map((q, i) => {
          // «Как сейчас» — такой же ответ, как остальные (П8 приёмки): точка
          // синяя. Серым остаётся только НЕОТВЕЧЕННОЕ.
          const st = answerState(q, answers, resolutions);
          const cls = i === index ? " rq-dot--on" : st === "none" ? "" : " rq-dot--done";
          return (
            <button
              key={q.id}
              type="button"
              className={"rq-dot" + cls}
              title={q.title}
              aria-label={`вопрос ${i + 1}`}
              onClick={() => onGo(i)}
            />
          );
        })}
      </div>
    );
  }
  return (
    <div className="rq-prog">
      <div className="rq-bar">
        {segments(questions, answers, resolutions).map((s) => (
          <button key={s.kind} type="button" className="rq-bar-g" onClick={() => onGo(s.first)}>
            <span className="rq-bar-t">
              <span className="rq-bar-f" style={{ width: `${s.done / s.total * 100}%` }} />
            </span>
            <span className="rq-bar-l">{s.caption}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
