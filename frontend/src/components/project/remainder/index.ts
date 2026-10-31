// Публичный вход модуля разбора остатка (Ф-E). Окна ввоза (создание проекта и
// догрузка архивов) берут отсюда: статус, блок вопросов, свёртку незакрываемых
// замечаний, массовые кнопки догрузки — и чистые функции для состояния ответов и
// для формы применения. Внутренности (тексты, черновики) наружу не выставляются: их
// меняет только сам модуль. Примитивы вопроса (вариант, подпись пути, сплит-кнопка,
// вьюер тела) выставлены для окон, которые задают вопросы тем же языком вне ввоза, —
// «Собрать с компонентов» (Ф15); у варианта и сплит-кнопки своих стилей нет, remainder.css
// импортирует окно.
export { default as RemainderBlock } from "./RemainderBlock";
export { default as StatusLine } from "./StatusLine";
export type { StatusError } from "./StatusLine";
export { default as UnfixableFold } from "./UnfixableFold";
export { default as BulkBox } from "./BulkBox";
export { default as Option, PathLabel } from "./Option";
export { default as SplitOption } from "./SplitOption";
export { default as DocViewer } from "./DocViewer";

export {
  answerLabel, answerState, buildQuestions, bulkAnswers, hasMineDisputes,
  progressMode, pruneAnswers, segments, summarize, toDecisions,
} from "./questions";
export type {
  Answer, Answers, DecisionsPayload, NewEdgeDecision, NewEdgesAnswer, ProgressSegment,
  Question, QuestionKind, Resolutions, Summary,
} from "./questions";
export { humanValue, splitErrorLine } from "./questionText";
export { useRemainderAnswers } from "./useRemainderAnswers";
export type { QuestionMode } from "./questionText";
