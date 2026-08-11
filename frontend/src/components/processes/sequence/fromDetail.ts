// Маппинг контрактного ProcessDetail → презентационную модель SequenceDiagram.
// Раскладочные индексы строк (r) выводятся из order; order каждого фрагмента проецируем
// на индексы строк (движок рендерит все фрагменты, в т.ч. вложенные).
import type { BranchIn, ProcessDetail, ProcessFragment, ProcessMessage, ProcessParticipant } from "../../../types";
import type { SeqFragment, SeqMessage, SeqParticipant } from "./layout";

/**
 * Ветви по возрастанию границы — вид, которого требует бэк (границы обязаны строго
 * возрастать). Приписать новую ветвь в конец НЕЛЬЗЯ: она не обязана быть последней —
 * когда хвост охвата занят, свободная строка находится выше существующих ветвей.
 */
export function orderedBranches(branches: readonly BranchIn[]): BranchIn[] {
  return [...branches].sort((a, b) => a.start_order - b.start_order);
}

export function toSeqParticipants(participants: ProcessParticipant[]): SeqParticipant[] {
  return [...participants]
    .sort((a, b) => a.order - b.order)
    .map((p) => ({
      id: p.id, // ключ дорожки — участник, а не узел (у непривязанного узла нет)
      nodeId: p.node_id,
      shape: p.shape,
      name: p.name,
      role: p.role,
      // «Внешний» — свойство узла; у непривязанного его нет, а на раскладку оно не
      // влияет, поэтому здесь безопасный дефолт.
      external: p.is_external ?? false,
      status: p.status,
    }));
}

export function toSeqMessages(messages: ProcessMessage[]): SeqMessage[] {
  return [...messages]
    .sort((a, b) => a.order - b.order)
    .map((m, i) => ({
      id: m.id,
      r: i,
      n: i + 1,
      from: m.from_participant_id,
      to: m.to_participant_id,
      kind: m.kind,
      label: m.caption ?? "",
      tech: m.technology,
      valid: m.valid,
      invalidReason: m.invalid_reason ?? null,
    }));
}

export function toSeqFragments(fragments: ProcessFragment[], messages: ProcessMessage[]): SeqFragment[] {
  // order сообщения → индекс строки: число сообщений с меньшим order.
  const orders = messages.map((m) => m.order);
  const rowOf = (order: number) => orders.filter((o) => o < order).length;
  // Сорт: внешние (более широкий диапазон) раньше — стабильный порядок для вложенности.
  return [...fragments]
    .sort((a, b) => a.from_order - b.from_order || b.to_order - a.to_order)
    .map((f) => ({
      id: f.id,
      kind: f.kind,
      fromRow: rowOf(f.from_order),
      toRow: rowOf(f.to_order),
      guard: f.guard,
      branches: f.branches.map((b) => ({ row: rowOf(b.start_order), guard: b.guard })),
    }));
}

export function detailToSeq(detail: ProcessDetail) {
  const participants = toSeqParticipants(detail.participants);
  const messages = toSeqMessages(detail.messages);
  const fragments = toSeqFragments(detail.fragments, detail.messages);
  return { participants, messages, fragments };
}
