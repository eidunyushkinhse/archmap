// Остаток слияния как ПОСЛЕДОВАТЕЛЬНОСТЬ ВОПРОСОВ: чистая логика без React
// (Ф-E, docs/plan-byoa-quality.md; ТЗ «Остаток слияния — разбор вопросами»).
//
// Что мердж решить не может, приезжает в превью структурой (remainder) и здесь
// превращается в список вопросов: один вопрос — одно решение. Ответы уезжают
// применению двумя каналами: споры содержимого — прежними резолюциями
// (resolutions: id → «cand:<i>» | «all», протокол не менялся), остальное —
// словарём decisions (toDecisions).
//
// Ни один вопрос не обязателен: у каждого есть вариант «как сейчас», а «нет
// ответа» = сегодняшнее поведение бэка. Поэтому keep/diff в payload НЕ едут — их
// отправка ничего бы не изменила, а лишний ключ пришлось бы валидировать.
import type {
  ContainerEdgeOut, FamilyConflictOut, FieldDisputeOut, FuzzyPairOut,
  IsolatedGroupOut, RemainderOut,
} from "../../../types";
import {
  edgeTexts, familyTexts, fieldTexts, groupTexts, humanValue, lastSegment, pairTexts,
} from "./questionText";

export type QuestionKind = "family" | "field" | "edge" | "group" | "pair";

interface QuestionBase {
  /** id элемента бэка: детерминирован между превью и применением. */
  id: string;
  title: string;
  /** Строка контекста под вопросом; null — её у вида нет. */
  context: string | null;
  why: string;
  ifLeft: string | null;
}
export interface FamilyQuestion extends QuestionBase { kind: "family"; source: FamilyConflictOut }
export interface FieldQuestion extends QuestionBase { kind: "field"; source: FieldDisputeOut }
export interface EdgeQuestion extends QuestionBase { kind: "edge"; source: ContainerEdgeOut }
export interface GroupQuestion extends QuestionBase { kind: "group"; source: IsolatedGroupOut }
export interface PairQuestion extends QuestionBase { kind: "pair"; source: FuzzyPairOut }
export type Question =
  FamilyQuestion | FieldQuestion | EdgeQuestion | GroupQuestion | PairQuestion;

// Ответы на всё, кроме споров содержимого (те живут в resolutions).
export interface FieldAnswer { kind: "field"; index: number }
export interface EdgeAnswer { kind: "edge"; toPath: string }
export interface NewEdgeAnswer {
  kind: "new_edge"; fromPath: string; toPath: string;
  label: string; tech: string; channel: "sync" | "async";
}
export interface MergeAnswer { kind: "merge"; name: string }
/** «Оставить как есть» у связи в контейнер и у изолированной группы. */
export interface KeepAnswer { kind: "keep" }
/** «Разные объекты» у похожих имён. */
export interface DiffAnswer { kind: "diff" }
export type Answer = FieldAnswer | EdgeAnswer | NewEdgeAnswer | MergeAnswer | KeepAnswer | DiffAnswer;
export type Answers = Record<string, Answer>;
/** Выбор по спорам содержимого: id → «cand:<i>» либо «all». */
export type Resolutions = Record<string, string>;

/** Форма поля `decisions` применения (контракт Ф1, backend/app/unified_apply.py). */
export interface NewEdgeDecision {
  group_id: string; from_path: string; to_path: string;
  label: string; tech: string; channel: "sync" | "async";
}
export interface DecisionsPayload {
  fields?: Record<string, number>;
  edges?: Record<string, { to_path: string }>;
  new_edges?: NewEdgeDecision[];
  merges?: Record<string, { name: string }>;
}

/**
 * Список вопросов из превью. Порядок — от самого дешёвого решения к самому
 * ответственному (§4 ТЗ): содержимое → поля → связи в контейнер → пропущенные
 * связи → похожие имена; внутри вида — порядок бэка. Названия видов на экран не
 * выводятся: пользователь видит вопросы, а не таксономию остатка.
 */
export function buildQuestions(input: {
  family_conflicts: FamilyConflictOut[];
  remainder: RemainderOut;
}): Question[] {
  const { family_conflicts: семьи, remainder: r } = input;
  const out: Question[] = [];
  for (const c of семьи) {
    const t = familyTexts(c);
    out.push({ kind: "family", id: c.id, source: c, context: null, ...t });
  }
  for (const d of r.field_conflicts) {
    const t = fieldTexts(d);
    out.push({ kind: "field", id: d.id, source: d, context: null, ...t });
  }
  for (const e of r.container_edges) {
    out.push({ kind: "edge", id: e.id, source: e, ...edgeTexts(e) });
  }
  for (const g of r.isolated_groups) {
    out.push({ kind: "group", id: g.id, source: g, ...groupTexts(g) });
  }
  for (const p of r.fuzzy_pairs) {
    out.push({ kind: "pair", id: p.id, source: p, ...pairTexts(p) });
  }
  return out;
}

/** Точки или полоса по видам: на полутора десятках точек ряд перестаёт читаться. */
export const progressMode = (n: number): "dots" | "segments" => (n <= 14 ? "dots" : "segments");

/** Состояние ответа: «как сейчас» (keep/diff) отмечается серым, а не синим. */
export function answerState(
  q: Question, answers: Answers, resolutions: Resolutions,
): "none" | "answered" | "keep" {
  // У спора содержимого «как сейчас» не бывает: любой выбор — содержательный.
  if (q.kind === "family") return resolutions[q.id] === undefined ? "none" : "answered";
  const a = answers[q.id];
  if (a === undefined) return "none";
  return a.kind === "keep" || a.kind === "diff" ? "keep" : "answered";
}

// Подписи сегментов полосы прогресса (§3 ТЗ) — единственное место, где названия
// видов видны пользователю.
const SEGMENT_LABEL: Record<QuestionKind, string> = {
  family: "Содержимое", field: "Поля", edge: "В контейнер", group: "Связи", pair: "Имена",
};

export interface ProgressSegment {
  kind: QuestionKind;
  label: string;
  /** Готовая подпись «Содержимое · 3/8». */
  caption: string;
  /** Индекс первого вопроса вида: клик по сегменту ведёт туда. */
  first: number;
  total: number;
  done: number;
  /** Сколько из отвеченных — «как сейчас» (серая доля заливки). */
  kept: number;
}

export function segments(
  questions: Question[], answers: Answers, resolutions: Resolutions,
): ProgressSegment[] {
  const out: ProgressSegment[] = [];
  questions.forEach((q, i) => {
    let s = out.find((x) => x.kind === q.kind);
    if (!s) {
      s = { kind: q.kind, label: SEGMENT_LABEL[q.kind], caption: "", first: i, total: 0, done: 0, kept: 0 };
      out.push(s);
    }
    s.total += 1;
    const st = answerState(q, answers, resolutions);
    if (st !== "none") s.done += 1;
    if (st === "keep") s.kept += 1;
  });
  for (const s of out) s.caption = `${s.label} · ${s.done}/${s.total}`;
  return out;
}

export interface Summary {
  rewired: number;
  added: number;
  merged: number;
  fields: number;
  kept: number;
  unanswered: number;
}

/**
 * Числа итога разбора (§8). resolutions нужны, чтобы споры содержимого не
 * считались неотвеченными: их ответ живёт не в answers.
 */
export function summarize(
  questions: Question[], answers: Answers, resolutions: Resolutions = {},
): Summary {
  const s: Summary = { rewired: 0, added: 0, merged: 0, fields: 0, kept: 0, unanswered: 0 };
  for (const q of questions) {
    const st = answerState(q, answers, resolutions);
    if (st === "none") s.unanswered += 1;
    if (st === "keep") s.kept += 1;
    const a = answers[q.id];
    if (a?.kind === "edge") s.rewired += 1;
    if (a?.kind === "new_edge") s.added += 1;
    if (a?.kind === "merge") s.merged += 1;
    if (a?.kind === "field") s.fields += 1;
  }
  return s;
}

/**
 * Ответы в форму применения. keep/diff не едут (это дефолт бэка), споры
 * содержимого — тоже: они уезжают своим каналом resolutions. Нечего отправлять —
 * null, чтобы клиент не клал в форму пустой объект.
 */
export function toDecisions(questions: Question[], answers: Answers): DecisionsPayload | null {
  const fields: Record<string, number> = {};
  const edges: Record<string, { to_path: string }> = {};
  const new_edges: NewEdgeDecision[] = [];
  const merges: Record<string, { name: string }> = {};
  for (const q of questions) {
    const a = answers[q.id];
    if (a === undefined) continue;
    if (a.kind === "field") fields[q.id] = a.index;
    else if (a.kind === "edge") edges[q.id] = { to_path: a.toPath };
    else if (a.kind === "new_edge") {
      new_edges.push({
        group_id: q.id, from_path: a.fromPath, to_path: a.toPath,
        label: a.label, tech: a.tech, channel: a.channel,
      });
    } else if (a.kind === "merge") merges[q.id] = { name: a.name };
  }
  const payload: DecisionsPayload = {};
  if (Object.keys(fields).length) payload.fields = fields;
  if (Object.keys(edges).length) payload.edges = edges;
  if (new_edges.length) payload.new_edges = new_edges;
  if (Object.keys(merges).length) payload.merges = merges;
  return Object.keys(payload).length ? payload : null;
}

/**
 * Отбросить ответы, чьих вопросов больше нет (правка входа пересчитала превью).
 * Ничего не отброшено — возвращается ТА ЖЕ ссылка: вызов делается прямо в
 * рендере («adjusting state when props change»), и новый объект каждый раз
 * зациклил бы setState.
 */
export function pruneAnswers(answers: Answers, questions: Question[]): Answers {
  const живые = new Set(questions.map((q) => q.id));
  const ключи = Object.keys(answers);
  if (ключи.every((id) => живые.has(id))) return answers;
  return Object.fromEntries(Object.entries(answers).filter(([id]) => живые.has(id)));
}

/**
 * Массовые ответы догрузки (§7): закрывают ТОЛЬКО споры — содержимого (4.1) и
 * полей (4.2), — и только те, где спорят с живым проектом. Жесты (перевес,
 * новая связь, склейка) не трогаются: они не «конфликт», а работа.
 *
 * Возвращает ПОЛНЫЕ следующие карты, а не приращение: «оставить, как было в
 * проекте» для спора содержимого — это УДАЛЕНИЕ записи (дефолт бэка и так
 * «моё»), приращением такое не выразить.
 */
export function bulkAnswers(
  questions: Question[],
  mine: boolean,
  state: { answers: Answers; resolutions: Resolutions },
): { answers: Answers; resolutions: Resolutions } {
  const answers: Answers = { ...state.answers };
  const принятые: Resolutions = {};
  // «Оставить моё» у спора содержимого — это СНЯТИЕ записи: дефолт бэка и так
  // «моё», а явный выбор после перезапроса превью мог бы уехать вместе с планом.
  const снятые = new Set<string>();
  for (const q of questions) {
    if (q.kind === "family") {
      const свой = q.source.candidates.findIndex((k) => k.current);
      if (свой < 0) continue;
      if (mine) снятые.add(q.id);
      else {
        const i = q.source.candidates.findIndex((k) => !k.current);
        if (i >= 0) принятые[q.id] = `cand:${i}`;
      }
    } else if (q.kind === "field") {
      const свой = q.source.candidates.findIndex((k) => k.current);
      if (свой < 0) continue;
      const i = mine ? свой : q.source.candidates.findIndex((k) => !k.current);
      if (i >= 0) answers[q.id] = { kind: "field", index: i };
    }
  }
  const resolutions: Resolutions = {
    ...Object.fromEntries(Object.entries(state.resolutions).filter(([id]) => !снятые.has(id))),
    ...принятые,
  };
  return { answers, resolutions };
}

/** Есть ли кому адресовать массовые кнопки (§7): спор с живым знанием. */
export const hasMineDisputes = (questions: Question[]): boolean =>
  questions.some((q) => {
    // Ветки раздельные намеренно: кандидаты семьи и поля — разные типы контракта,
    // и вызов .some() на их объединении TypeScript не сводит к одной сигнатуре.
    if (q.kind === "family") return q.source.candidates.some((k) => k.current);
    if (q.kind === "field") return q.source.candidates.some((k) => k.current);
    return false;
  });

/**
 * Данный ответ одной строкой — для списка «Все вопросы» (§3). «—» здесь не
 * возвращается: пустой ответ список рисует сам своим начертанием.
 */
export function answerLabel(
  q: Question, answers: Answers, resolutions: Resolutions,
): string | null {
  if (q.kind === "family") {
    const r = resolutions[q.id];
    if (r === undefined) return null;
    if (r === "all") return "добавить все";
    const i = Number(r.slice(5));
    return q.source.candidates[i]?.source_label ?? r;
  }
  const a = answers[q.id];
  if (a === undefined) return null;
  if (a.kind === "keep") return "как сейчас";
  if (a.kind === "diff") return "разные";
  if (a.kind === "edge") return lastSegment(a.toPath);
  if (a.kind === "new_edge") return "связь добавлена";
  if (a.kind === "merge") return a.name;
  // Ответ о поле — само выбранное значение человеческими словами (форма/статус).
  return q.kind === "field"
    ? humanValue(q.source.field, q.source.candidates[a.index]?.value ?? "")
    : null;
}
