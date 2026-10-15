import { processesApi } from "../../api/processes";
import type { MessageCreate, ProcessMessage } from "../../types";

// Снимок шага для восстановления при undo (как в прежнем редакторе). Хранит УЗЛЫ, а не
// участников: при пересоздании участника его id меняется, node_id — нет.
export interface MessageSnapshot {
  edge_id: string | null;
  leg: ProcessMessage["leg"];
  from_id: string;
  to_id: string;
  caption: string | null;
  order: number;
  // Привязка к схеме логики (Д7): без неё undo восстанавливал бы шаг «раздетым»,
  // и привязка терялась бы молча — при живой-то схеме.
  doc_id: string | null;
}

// Узел → участник в СВЕЖЕМ состоянии: нужен для восстановления сообщений после
// undo (id участника при пересоздании меняется, node_id — нет). Непривязанных
// участников тут нет: восстанавливать их шаги всё равно нечем.
export async function freshPartByNode(processId: string): Promise<Record<string, string>> {
  const fresh = await processesApi.get(processId);
  const m: Record<string, string> = {};
  for (const p of fresh.participants) if (p.node_id) m[p.node_id] = p.id;
  return m;
}

// Пересоздание шага из снимка. Привязка едет вместе с шагом (Д7), но шаг ДОРОЖЕ
// привязки: если схема умерла между снимком и откатом (_check_doc ответит 404),
// пересоздаём непривязанным — шаг честно попадёт в алерт полноты, а не утащит за
// собой весь откат. Тот же принцип, что у переноса: не разрешилось — едет голым.
export async function addFromSnap(
  processId: string, snap: MessageSnapshot, fromP: string, toP: string,
): Promise<ProcessMessage> {
  const payload: MessageCreate = {
    edge_id: snap.edge_id, leg: snap.leg, from_participant_id: fromP, to_participant_id: toP,
    caption: snap.caption, order: snap.order, doc_id: snap.doc_id,
  };
  try {
    return await processesApi.addMessage(processId, payload);
  } catch (e: unknown) {
    if (!snap.doc_id) throw e;
    return await processesApi.addMessage(processId, { ...payload, doc_id: null });
  }
}
