// Схема логики, привязанная к шагу процесса (docs/plan-process-docs-step4.md, У7) — что
// нужно оверлею, чтобы открыть её на чтение. Общая для карточки шага (правка) и клика по
// шагу в просмотре.
import type { ProcessMessage, ProcessParticipant } from "../../types";

export interface StepDoc {
  docId: string;
  nodeId: string;
  nodeName: string;
}

/** Привязанная схема шага или null. Имя узла для шапки оверлея — последний сегмент пути
 *  из самого шага (схема может жить у потомка участника); фолбэк — имя участника с тем же
 *  узлом, лучшего всё равно нет. */
export function stepDoc(msg: ProcessMessage, participants: readonly ProcessParticipant[]): StepDoc | null {
  if (!msg.doc_id || !msg.doc_node_id) return null;
  const nodeName = msg.doc_node_path?.split(" / ").pop()
    ?? participants.find((p) => p.node_id === msg.doc_node_id)?.name
    ?? "";
  return { docId: msg.doc_id, nodeId: msg.doc_node_id, nodeName };
}
