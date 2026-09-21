// Публичный вход модуля разбора остатка (Ф-E). Окна ввоза (создание проекта и
// догрузка архивов) берут отсюда: статус, блок вопросов, свёртку незакрываемых
// замечаний, массовые кнопки догрузки — и чистые функции для состояния ответов и
// для формы применения. Внутренности (примитивы, тексты, черновики) наружу не
// выставляются: их меняет только сам модуль.
export { default as RemainderBlock } from "./RemainderBlock";
export { default as StatusLine } from "./StatusLine";
export type { StatusError } from "./StatusLine";
export { default as UnfixableFold } from "./UnfixableFold";
export { default as BulkBox } from "./BulkBox";

export {
  answerLabel, answerState, buildQuestions, bulkAnswers, hasMineDisputes,
  progressMode, pruneAnswers, segments, summarize, toDecisions,
} from "./questions";
export type {
  Answer, Answers, DecisionsPayload, NewEdgeDecision, NewEdgesAnswer, ProgressSegment,
  Question, QuestionKind, Resolutions, Summary,
} from "./questions";
export { humanValue, splitErrorLine } from "./questionText";
export type { QuestionMode } from "./questionText";
