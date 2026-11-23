// Публичный вход модуля разбора остатка (Ф-E). Окна ввоза (создание проекта и
// догрузка архивов) берут отсюда: статус, блок вопросов, свёртку незакрываемых
// замечаний, массовые кнопки догрузки, а также чистые функции для состояния ответов и
// для формы применения. Внутренности (тексты, черновики) наружу не выставляются: их
// меняет только сам модуль. Примитивы вопроса (вариант, подпись пути, сплит-кнопка,
// заголовок со знаком «?», вьюер тела) выставлены для окон, которые задают вопросы тем же
// языком вне ввоза: это «Собрать с компонентов» (Ф15). Вид вопросов у таких окон из той же
// области .imp-res (project/importResult.css), каркас из remainder.css: оба файла
// импортирует окно (у варианта и сплит-кнопки своих импортов стилей нет).
export { default as RemainderBlock } from "./RemainderBlock";
export { default as StatusLine } from "./StatusLine";
export type { StatusError } from "./StatusLine";
export { default as UnfixableFold } from "./UnfixableFold";
export { default as BulkBox } from "./BulkBox";
export { default as Option, PathLabel } from "./Option";
export { default as SplitOption } from "./SplitOption";
export { default as DocViewer } from "./DocViewer";
export { default as TitleWithWhy } from "./TitleWithWhy";

export {
  answerLabel, answerState, buildQuestions, bulkAnswers, defaultLabel, hasMineDisputes,
  pruneAnswers, summarize, toDecisions,
} from "./questions";
export type {
  Answer, Answers, DecisionsPayload, NewEdgeDecision, NewEdgesAnswer,
  Question, Resolutions, Summary,
} from "./questions";
export { humanValue, splitErrorLine } from "./questionText";
export { useRemainderAnswers } from "./useRemainderAnswers";
export type { QuestionMode } from "./questionText";
