// Блок вопросов слияния (§3, §8 ТЗ): остаток слияния задаётся по одному вопросу.
// Строка над вопросом (тихий счётчик «Вопрос N из M» и «Все вопросы»), заголовок со
// знаком «?» (почему возник вопрос и что будет без ответа), тело текущего вопроса
// (QuestionBody), подвал «Назад / Дальше», список всех вопросов и итог разбора.
// Шапки «Без ваших решений…» и прогресса точками или полосой нет (фаза 8а редизайна):
// положение показывает счётчик, перейти к любому вопросу даёт «Все вопросы».
//
// Главное правило механики: ВЫБОР ВАРИАНТА НЕ ПЕРЕВОДИТ ДАЛЬШЕ. Пользователь
// ходит «Назад/Дальше», списком и стрелками — иначе ответ, данный случайным кликом,
// утаскивал бы экран, и вернуться было бы некуда.
//
// Разбор не обязателен: без единого ответа действуют варианты «по умолчанию». Поэтому
// блок ничем не блокирует кнопку окна и не показывает ни янтарного, ни красного.
import { useEffect, useState } from "react";
import { plural } from "../../../ui/plural";
import { CheckIcon } from "../../../ui/icons";
import InfoPopover from "../../../ui/InfoPopover";
import type { Answer, Answers, Question, Resolutions } from "./questions";
import { answerLabel, answerState, defaultLabel, summarize } from "./questions";
import { emptyEdgesDraft, mergeDraftFor } from "./drafts";
import type { EdgesDraft, MergeDraft } from "./drafts";
import { MERGE_TITLE, mergeContext, NEW_EDGE_CONTEXT, NEW_EDGE_TITLE } from "./questionText";
import QuestionBody from "./QuestionBody";
import "../../../ui/ds.css";
import "./remainder.css";

interface Props {
  questions: Question[];
  answers: Answers;
  resolutions: Resolutions;
  onAnswer: (id: string, answer: Answer) => void;
  onResolve: (id: string, choice: string) => void;
  /**
   * Окно, в котором стоит блок. Слова разбора от окна зависят только в сносках (их
   * собирает buildQuestions), а массовые кнопки догрузки живут отдельным блоком снаружи
   * (§7) — поле принято как контекст вызова и различий в самом блоке пока не даёт.
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

  // Второй шаг открыт, только пока его открыл человек: ответ сам по себе его не держит
  // (фаза 8б), иначе после «Объединить» вопрос навсегда становился бы шагом имени.
  const шаг2 = (q.kind === "group" || q.kind === "pair") && stage2[q.id] === true;
  const title = !шаг2 ? q.title : q.kind === "pair" ? MERGE_TITLE : NEW_EDGE_TITLE;
  // Черновик формы связей: нет своего — строка на каждый объект группы (П4).
  const edgeDraft: EdgesDraft = edgeDrafts[q.id]
    ?? (q.kind === "group" ? emptyEdgesDraft(q.source.node_paths) : []);
  // Черновик шага 2 склейки: нет своего — открываем на уже выбранном имени.
  const mergeDraft: MergeDraft = mergeDrafts[q.id]
    ?? (q.kind === "pair" ? mergeDraftFor(q.source, currentName(q, answers)) : { pick: "a", own: "" });
  const context = !шаг2 ? q.context
    : q.kind === "pair" ? mergeContext(q.source) : NEW_EDGE_CONTEXT;

  // Одна строка над вопросом и в списке: тихий счётчик и переключатель вида.
  const шапка = (
    <div className="rq-sub">
      <span className="rq-cnt">Вопрос {index + 1} из {questions.length}</span>
      <button
        type="button"
        className="ds-add rq-sp"
        onClick={() => setView(view === "list" ? "q" : "list")}
      >
        {view === "list" ? "К вопросу" : "Все вопросы"}
      </button>
    </div>
  );

  if (view === "done") {
    // Итог без счётчика и без строки частей: она называла не все ответы, полная
    // картина — в списке («Пересмотреть ответы»).
    const unanswered = summarize(questions, answers, resolutions).unanswered;
    return (
      <div className="rq-root rq-block">
        <div className="rq-bd rq-done">
          <span className={"rq-tick" + (unanswered > 0 ? " rq-tick--open" : "")} aria-hidden>
            {unanswered > 0 ? "?" : <CheckIcon size={12} />}
          </span>
          <div className="rq-done-t">
            {unanswered > 0
              ? `Осталось ${unanswered} ${plural(unanswered, ["вопрос", "вопроса", "вопросов"])} без ответа`
              : "Разбор пройден"}
          </div>
        </div>
        <div className="rq-ft">
          {unanswered > 0 && (
            <button
              type="button"
              className="ds-btn"
              onClick={() => {
                const i = questions.findIndex((x) => answerState(x, answers, resolutions) === "none");
                if (i >= 0) go(i);
              }}
            >
              Вернуться к пропущенным
            </button>
          )}
          <button type="button" className="ds-btn" onClick={() => setView("list")}>
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
              // Без ответа — тихим цветом вариант, который действует по умолчанию: список
              // показывает, что будет на самом деле.
              const ответ = answerLabel(x, answers, resolutions);
              return (
                <button
                  key={x.id}
                  type="button"
                  className={"rq-ql-r" + (i === index ? " rq-ql-r--on" : "")}
                  onClick={() => go(i)}
                >
                  <span className="rq-ql-n">{i + 1}</span>
                  <span className="rq-ql-q" title={x.title}>{x.title}</span>
                  <span className={"rq-ql-a" + (ответ === null ? " rq-ql-a--none" : "")}>
                    {ответ ?? defaultLabel(x)}
                  </span>
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
      <div className="rq-bd">
        {/* Второй шаг — продолжение того же вопроса: «почему» и «если не отвечать» он не
            повторяет (§4.6), знака «?» у него нет. */}
        <h4 className="rq-q">
          {шаг2 ? title : <TitleWithWhy title={title} why={q.why} ifLeft={q.ifLeft} />}
        </h4>
        {context !== null && <p className="rq-ctx">{context}</p>}
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
      </div>
      <div className="rq-ft">
        <button
          type="button"
          className="ds-add"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          ← Назад
        </button>
        <span className="rq-sp" />
        <button
          type="button"
          className="ds-add"
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

/**
 * Заголовок вопроса со знаком «?» сразу после текста: в подсказке «почему возник вопрос» и
 * «Если не отвечать, то …». Последнее слово и знак в одной обёртке без переноса: знак не
 * уезжает на строку один. Подсказка — fixed-слой (InfoPopover), прокрутка тела окна её не
 * режет.
 */
function TitleWithWhy({ title, why, ifLeft }: { title: string; why: string; ifLeft: string | null }) {
  const cut = title.lastIndexOf(" ") + 1;
  return (
    <>
      {title.slice(0, cut)}
      <span className="rq-q-end">
        {title.slice(cut)}
        <InfoPopover label="Почему возник вопрос" width={380}>
          <p>{why}</p>
          {ifLeft !== null && <p>{ifLeft}</p>}
        </InfoPopover>
      </span>
    </>
  );
}
