// Маппинг контрактного ProcessDetail → презентационную модель SequenceDiagram.
// Раскладочные индексы строк (r) выводятся из order; фрагмент берём первый (движок
// рендерит один, как дизайн-референс), order фрагмента проецируем на индексы строк.
import type { ProcessDetail, ProcessFragment, ProcessMessage, ProcessParticipant } from "../../../types";
import type { SeqFragment, SeqMessage, SeqParticipant } from "./layout";

export function toSeqParticipants(participants: ProcessParticipant[]): SeqParticipant[] {
  return [...participants]
    .sort((a, b) => a.order - b.order)
    .map((p) => ({ id: p.node_id, shape: p.shape, name: p.name, role: p.role, external: p.is_external }));
}

export function toSeqMessages(messages: ProcessMessage[]): SeqMessage[] {
  return [...messages]
    .sort((a, b) => a.order - b.order)
    .map((m, i) => ({
      id: m.id,
      r: i,
      n: i + 1,
      from: m.from_id,
      to: m.to_id,
      kind: m.kind,
      label: m.caption ?? "",
      tech: m.technology,
      valid: m.valid,
    }));
}

export function toSeqFragment(fragments: ProcessFragment[], messages: ProcessMessage[]): SeqFragment | null {
  if (fragments.length === 0) return null;
  const f: ProcessFragment = fragments[0];
  // order сообщения → индекс строки: число сообщений с меньшим order.
  const orders = messages.map((m) => m.order);
  const rowOf = (order: number) => orders.filter((o) => o < order).length;
  return {
    kind: f.kind,
    fromRow: rowOf(f.from_order),
    toRow: rowOf(f.to_order),
    guard: f.guard,
    elseRow: f.else_order != null ? rowOf(f.else_order) : null,
    elseGuard: f.else_guard,
  };
}

export function detailToSeq(detail: ProcessDetail) {
  const participants = toSeqParticipants(detail.participants);
  const messages = toSeqMessages(detail.messages);
  const fragment = toSeqFragment(detail.fragments, detail.messages);
  return { participants, messages, fragment };
}
