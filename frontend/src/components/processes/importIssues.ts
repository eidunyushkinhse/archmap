// Проблемы черновика импорта процесса по превью бэкенда (редизайн, фаза 3б): что
// показать под черновиком и раскрыт ли он. Чистые функции; разметка — ImportDraftIssues.
import type { ProcessImportPreview } from "../../types";
import type { LimitMessage } from "../demo/demoLimits";

export type Participant = ProcessImportPreview["participants"][number];
type Step = ProcessImportPreview["steps"][number];

/** Отказ импорта или замены: текст ошибки или отказ по пределу демо-стенда. */
export type DraftFailure = string | LimitMessage;

// Шаг не встанет на связь схемы: связи нет, их несколько или участник без объекта.
const NO_LINK: ReadonlySet<Step["status"]> = new Set(["no_channel", "ambiguous", "unbound"]);

/** Что в превью требует внимания человека. */
export function issuesOf(preview: ProcessImportPreview) {
  return {
    unmatched: preview.participants.filter((p) => !p.node_id),
    matched: preview.participants.filter((p) => !!p.node_id),
    noLink: preview.steps.filter((s) => NO_LINK.has(s.status)),
    docLost: preview.steps.filter((s) => s.doc_status === "unresolved"),
    docKept: preview.steps.filter((s) => s.doc_status === "linked").length,
  };
}

/** Привязки шагов к схемам логики при замене: k — у процесса сейчас, m — разрешится. */
export interface DocKeep {
  m: number;
  k: number;
}

/** Есть ли у черновика что показать раскрытым. */
export function hasIssues(
  preview: ProcessImportPreview | null,
  errors: boolean,
  keep: DocKeep | null,
): boolean {
  if (errors) return true;
  if (!preview) return false;
  const i = issuesOf(preview);
  return i.unmatched.length > 0 || i.noLink.length > 0 || preview.unsupported.length > 0
    || i.docLost.length > 0 || (keep !== null && keep.m < keep.k);
}

/** Выбранный объект участника: выбор человека, иначе автосопоставление. */
export function chosenNode(p: Participant, choice: Record<string, string>): string {
  return p.alias in choice ? choice[p.alias] : (p.node_id ?? "");
}
