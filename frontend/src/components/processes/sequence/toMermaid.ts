// Конвертер ProcessDetail → текст Mermaid sequenceDiagram (для экспорта процесса
// в LLM/документацию). Участники нумеруются по порядку (P1, P2…), потому что node_id —
// UUID с дефисами, а в идентификаторах Mermaid их лучше избегать; имя уходит в алиас
// `participant P1 as Имя`. Сообщения и фрагменты раскладываются по индексам строк
// (как в presentation-модели fromDetail): индекс строки = число сообщений с меньшим order.
import type { ProcessDetail, ProcessMessage } from "../../../types";

// Чистка текста реплики/условия: Mermaid обрывает оператор на переводе строки и
// плохо реагирует на «;». Схлопываем пробелы/переводы строк, «;» → «,».
function clean(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").replace(/;/g, ",").trim();
}

// Стрелка Mermaid по виду сообщения: return — пунктир с возвратом, async — открытая
// стрелка «-)», forward/self — сплошная синхронная «->>».
function arrow(kind: ProcessMessage["kind"]): string {
  switch (kind) {
    case "return":
      return "-->>";
    case "async":
      return "-)";
    default:
      return "->>";
  }
}

const indent = (depth: number) => "    ".repeat(depth);

export function detailToMermaid(detail: ProcessDetail): string {
  const lines: string[] = ["sequenceDiagram"];

  // Участники в порядке order → алиасы P1, P2…
  const parts = [...detail.participants].sort((a, b) => a.order - b.order);
  const alias = new Map<string, string>(); // node_id → Pn
  parts.forEach((p, i) => {
    const id = `P${i + 1}`;
    alias.set(p.node_id, id);
    lines.push(`${indent(1)}participant ${id} as ${clean(p.name) || id}`);
  });

  // Сообщения по order → строки 0..N-1.
  const msgs = [...detail.messages].sort((a, b) => a.order - b.order);

  // Фрагменты: order → индекс строки (число сообщений с меньшим order).
  const orders = msgs.map((m) => m.order);
  const rowOf = (order: number) => orders.filter((o) => o < order).length;
  const frags = detail.fragments.map((f) => ({
    kind: f.kind,
    fromRow: rowOf(f.from_order),
    toRow: rowOf(f.to_order),
    guard: clean(f.guard),
    elseRow: f.else_order != null ? rowOf(f.else_order) : null,
    elseGuard: clean(f.else_guard),
  }));

  // depth — текущая глубина вложенности (1 = верхний уровень тела диаграммы).
  let depth = 1;

  for (let i = 0; i < msgs.length; i++) {
    // 1) Ветка [else] для alt, начинающаяся на строке i, — на отступ родителя.
    for (const f of frags) {
      if (f.kind === "alt" && f.elseRow === i) {
        lines.push(`${indent(depth - 1)}else${f.elseGuard ? " " + f.elseGuard : ""}`);
      }
    }

    // 2) Открываем фрагменты, начинающиеся на строке i (внешние/широкие — раньше).
    const opening = frags.filter((f) => f.fromRow === i).sort((a, b) => b.toRow - a.toRow);
    for (const f of opening) {
      lines.push(`${indent(depth)}${f.kind}${f.guard ? " " + f.guard : ""}`);
      depth++;
    }

    // 3) Само сообщение.
    const m = msgs[i];
    const from = alias.get(m.from_id);
    const to = alias.get(m.to_id);
    if (from && to) {
      lines.push(`${indent(depth)}${from}${arrow(m.kind)}${to}: ${clean(m.caption) || "—"}`);
    }

    // 4) Закрываем фрагменты, заканчивающиеся на строке i (внутренние/узкие — раньше).
    const closing = frags.filter((f) => f.toRow === i).sort((a, b) => b.fromRow - a.fromRow);
    for (let k = 0; k < closing.length; k++) {
      depth--;
      lines.push(`${indent(depth)}end`);
    }
  }

  return lines.join("\n");
}
