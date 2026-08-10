// Презентационная модель sequence-диаграммы и деривация полос активации.
// Раскладка детерминирована из данных и НЕ персистится (ТЗ §4.2): координаты считаем
// в SequenceDiagram, активации выводим здесь простым стеком.
import type { FragmentKind, MessageKind, NodeShape, NodeStatus } from "../../../types";

// Участник = линия жизни. id — id УЧАСТНИКА процесса (он же ключ дорожки для
// сообщений), а НЕ узла: участник может быть непривязанным, и тогда узла у него нет
// вовсе, а два таких участника по node_id были бы неразличимы.
// nodeId — узел C4, если участник привязан (для перехода на объект и свойств).
// shape/status = null у непривязанного: свойств узла взять неоткуда, а подставлять
// «сервис existing» нельзя — на схеме он притворился бы настоящим узлом.
export interface SeqParticipant {
  id: string;
  nodeId: string | null;
  shape: NodeShape | null;
  name: string;
  role: string | null;
  external: boolean;
  status: NodeStatus | null;
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

// Ветвь [иначе] у alt: начинается со строки row и идёт до следующей ветви. ПЕРВОЙ
// ветви в списке нет — она начинается с fromRow, её условие лежит в guard фрагмента.
export interface SeqBranch {
  row: number;
  guard: string | null;
}

// Управляющий фрагмент (рамка). Движок рендерит ЛЮБОЕ число фрагментов (в т.ч.
// вложенных); строки заданы индексами r. branches — ветви [иначе] по возрастанию
// строки (только у alt; сколько угодно — mermaid их числом не ограничивает).
export interface SeqFragment {
  id: string; // id сущности (для клика-удаления)
  kind: FragmentKind;
  fromRow: number;
  toRow: number;
  guard: string | null;
  branches: SeqBranch[];
}

/**
 * Полосы активации (кто «работает»), выведенные из сообщений простым стеком:
 * forward к участнику открывает активацию на нём; парный return ОТ него — закрывает;
 * async — одиночная полоса в одну строку (ответа нет); подвисшие открытые активации
 * закрываем на последней строке. Не персистится.
 */
// «Сильнейший» из двух статусов: deprecated > planned > existing. Цвет плеча задаёт
// сильнейший конец сообщения (на C4 ребро красится так же).
const STATUS_RANK: Record<NodeStatus, number> = { existing: 0, planned: 1, deprecated: 2 };
export function strongestStatus(a: NodeStatus, b: NodeStatus): NodeStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * Строка под НОВУЮ ветвь [иначе] у alt. `taken` — строки уже заведённых ветвей по
 * возрастанию.
 *
 * Обычный случай: середина последней секции (после последней ветви) — новая ветвь
 * дописывается в хвост, как её и ждут. Вырожденный: последняя ветвь стоит на нижней
 * строке охвата, места в хвосте нет — берём первую свободную строку сверху.
 * null — свободных строк не осталось вовсе (кнопку «+ иначе» в этом случае не
 * показываем, но проверить дешевле, чем полагаться на вызывающего).
 */
export function newBranchRow(fromRow: number, toRow: number, taken: number[]): number | null {
  const last = taken.length ? taken[taken.length - 1] : fromRow;
  if (last < toRow) return last + Math.ceil((toRow - last) / 2);
  const busy = new Set(taken);
  for (let r = fromRow + 1; r <= toRow; r++) if (!busy.has(r)) return r;
  return null;
}

/**
 * Перестановка одного элемента из позиции `from` в позицию `to` (чистая функция).
 * Основа reorder участников: новый порядок колонок = arrayMove(текущий, откуда, куда);
 * порядок линий жизни полностью определяет раскладку диаграммы (ТЗ §4.2).
 */
export function arrayMove<T>(arr: readonly T[], from: number, to: number): T[] {
  const res = arr.slice();
  const [moved] = res.splice(from, 1);
  res.splice(to, 0, moved);
  return res;
}

export function deriveActivations(messages: SeqMessage[]): SeqActivation[] {
  const open: Record<string, number[]> = {}; // дорожка → стек строк-начал
  const acts: SeqActivation[] = [];
  const maxRow = messages.reduce((m, x) => Math.max(m, x.r), 0);
  for (const m of [...messages].sort((a, b) => a.r - b.r)) {
    if (m.kind === "async" || m.kind === "self") {
      // async — событие без ответа; self — внутренняя операция: обе дают полосу в одну строку.
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
