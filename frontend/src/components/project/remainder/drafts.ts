// Черновики двухшаговых вопросов (§4.6 ТЗ): форма новой связи и выбор имени
// склейки. Живут по id вопроса у того, кто владеет разбором, — «Назад к вопросу»
// и хождение «Назад/Дальше» их не стирают, ответ перезаписывается только явной
// кнопкой («Добавить связь», «Склеить»).
//
// Отдельный модуль от самих форм: это состояние, а не компоненты.
import type { FuzzyPairOut } from "../../../types";
import type { NewEdgeAnswer } from "./questions";
import { lastSegment } from "./questionText";

export interface EdgeDraft {
  fromPath: string | null;
  toPath: string | null;
  label: string;
  tech: string;
  channel: "sync" | "async";
}

export const EMPTY_EDGE_DRAFT: EdgeDraft = {
  fromPath: null, toPath: null, label: "", tech: "", channel: "sync",
};

/** Черновик из уже данного ответа — «изменить» открывает форму заполненной. */
export const draftFromAnswer = (a: NewEdgeAnswer): EdgeDraft => ({
  fromPath: a.fromPath, toPath: a.toPath, label: a.label, tech: a.tech, channel: a.channel,
});

export interface MergeDraft { pick: "a" | "b" | "own"; own: string }

/** Черновик под уже выбранное имя: имя одного из двух узнаётся, иначе — «своё». */
export function mergeDraftFor(pair: FuzzyPairOut, name: string | null): MergeDraft {
  if (name === null) return { pick: "a", own: "" };
  if (name === lastSegment(pair.a_path)) return { pick: "a", own: "" };
  if (name === lastSegment(pair.b_path)) return { pick: "b", own: "" };
  return { pick: "own", own: name };
}
