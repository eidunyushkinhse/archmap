// Черновики двухшаговых вопросов (§4.6 ТЗ): форма проведения связей и выбор
// имени склейки. Живут по id вопроса у того, кто владеет разбором, — «Назад к
// вопросу» и хождение «Назад/Дальше» их не стирают, ответ перезаписывается
// только явной кнопкой («Провести связи», «Склеить»).
//
// Отдельный модуль от самих форм: это состояние, а не компоненты.
import type { FuzzyPairOut } from "../../../types";
import type { NewEdgesAnswer } from "./questions";
import { lastSegment } from "./questionText";

/**
 * Строка формы — ОДИН объект изолированной группы. Пользователь не должен
 * терять из виду, у каких объектов связей нет, поэтому строка есть у каждого, и
 * пустая строка — законный ответ «этот пусть останется без связи».
 */
export interface EdgeRow {
  /** Объект группы: подписан слева и не редактируется. */
  nodePath: string;
  /** Выбранный сосед по слитому дереву; null — строка пустая. */
  toPath: string | null;
  /** Стрелка развёрнута: связь идёт от соседа К объекту группы. */
  reversed: boolean;
  label: string;
  tech: string;
}
export type EdgesDraft = EdgeRow[];

export const emptyEdgesDraft = (nodePaths: string[]): EdgesDraft =>
  nodePaths.map((nodePath) => ({ nodePath, toPath: null, reversed: false, label: "", tech: "" }));

/** Черновик из уже данного ответа — «изменить» открывает форму заполненной. */
export function draftFromAnswer(a: NewEdgesAnswer, nodePaths: string[]): EdgesDraft {
  // Связь могла соединить два объекта ОДНОЙ группы — тогда её показывает строка
  // того объекта, что встретился первым, а не обе сразу (иначе «Провести связи»
  // создало бы дубль).
  const свободные = [...a.edges];
  return nodePaths.map((nodePath) => {
    const i = свободные.findIndex((e) => e.fromPath === nodePath || e.toPath === nodePath);
    if (i < 0) return { nodePath, toPath: null, reversed: false, label: "", tech: "" };
    const [e] = свободные.splice(i, 1);
    if (e === undefined) return { nodePath, toPath: null, reversed: false, label: "", tech: "" };
    const reversed = e.fromPath !== nodePath;
    return {
      nodePath,
      toPath: reversed ? e.fromPath : e.toPath,
      reversed,
      label: e.label,
      tech: e.tech,
    };
  });
}

/** Заполненные строки в ответ: направление — по перевороту стрелки. */
export function answerFromDraft(draft: EdgesDraft): NewEdgesAnswer {
  const edges = draft.flatMap((r) => {
    const сосед = r.toPath;
    if (сосед === null) return [];
    return [{
      fromPath: r.reversed ? сосед : r.nodePath,
      toPath: r.reversed ? r.nodePath : сосед,
      label: r.label.trim(),
      tech: r.tech.trim(),
    }];
  });
  return { kind: "new_edges", edges };
}

export interface MergeDraft { pick: "a" | "b" | "own"; own: string }

/** Черновик под уже выбранное имя: имя одного из двух узнаётся, иначе — «своё». */
export function mergeDraftFor(pair: FuzzyPairOut, name: string | null): MergeDraft {
  if (name === null) return { pick: "a", own: "" };
  if (name === lastSegment(pair.a_path)) return { pick: "a", own: "" };
  if (name === lastSegment(pair.b_path)) return { pick: "b", own: "" };
  return { pick: "own", own: name };
}
