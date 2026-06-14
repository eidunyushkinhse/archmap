// Презентационная модель sequence-диаграммы и деривация полос активации.
// Раскладка детерминирована из данных и НЕ персистится (ТЗ §4.2): координаты считаем
// в SequenceDiagram, активации выводим здесь простым стеком.
import type { FragmentKind, MessageKind, NodeShape } from "../../../types";

// Участник = линия жизни. id — node_id узла C4 (он же ключ дорожки для сообщений).
export interface SeqParticipant {
  id: string;
  shape: NodeShape;
  name: string;
  role: string | null;
  external: boolean;
}

// Сообщение = горизонтальная стрелка. r — индекс строки (время, 0..R-1), n — номер
// в подписи. from/to — id участников (node_id). valid=false → связь удалена из схемы.
export interface SeqMessage {
  id: string;
  r: number;
  n: number;
  from: string;
  to: string;
  kind: MessageKind;
  label: string;
  tech: string | null;
  valid: boolean;
}

export interface SeqActivation {
  lane: string;
  from: number;
  to: number;
}

// Управляющий фрагмент (рамка). Движок рендерит ОДИН фрагмент (как дизайн-референс);
// строки заданы индексами r. elseRow — начало ветки [иначе] (только alt).
export interface SeqFragment {
  kind: FragmentKind;
  fromRow: number;
  toRow: number;
  guard: string | null;
  elseRow: number | null;
  elseGuard: string | null;
}

/**
 * Полосы активации (кто «работает»), выведенные из сообщений простым стеком:
 * forward к участнику открывает активацию на нём; парный return ОТ него — закрывает;
 * async — одиночная полоса в одну строку (ответа нет); подвисшие открытые активации
 * закрываем на последней строке. Не персистится.
 */
export function deriveActivations(messages: SeqMessage[]): SeqActivation[] {
  const open: Record<string, number[]> = {}; // дорожка → стек строк-начал
  const acts: SeqActivation[] = [];
  const maxRow = messages.reduce((m, x) => Math.max(m, x.r), 0);
  for (const m of [...messages].sort((a, b) => a.r - b.r)) {
    if (m.kind === "async") {
      acts.push({ lane: m.to, from: m.r, to: m.r });
      continue;
    }
    if (m.kind === "return") {
      const stack = open[m.from];
      if (stack && stack.length) {
        const start = stack.pop() as number;
        acts.push({ lane: m.from, from: start, to: m.r });
      }
      continue;
    }
    // forward: активируем получателя
    (open[m.to] ??= []).push(m.r);
  }
  // Подвисшие (без парного return) тянем до последней строки.
  for (const lane of Object.keys(open)) {
    for (const start of open[lane]) acts.push({ lane, from: start, to: maxRow });
  }
  return acts;
}
