import { describe, expect, it } from "vitest";
import type { ProcessDetail, ProcessFragment, ProcessMessage, ProcessParticipant } from "../../types";
import { detailToMermaid } from "../processes/sequence/toMermaid";

// Минимальные фикстуры: конвертер читает у участника node_id/name/order, у сообщения —
// order/from_id/to_id/kind/caption, у фрагмента — kind/диапазон/guard/else. Остальные
// поля контракта не нужны (каст через unknown).
const part = (node_id: string, name: string, order: number): ProcessParticipant =>
  ({ node_id, name, order } as unknown as ProcessParticipant);
const msg = (
  order: number,
  from_id: string,
  to_id: string,
  kind: ProcessMessage["kind"],
  caption: string | null,
): ProcessMessage => ({ order, from_id, to_id, kind, caption } as unknown as ProcessMessage);
const frag = (
  from_order: number,
  to_order: number,
  extra: Partial<ProcessFragment> = {},
): ProcessFragment =>
  ({ kind: "alt", from_order, to_order, guard: null, branches: [], ...extra } as ProcessFragment);

const detail = (
  participants: ProcessParticipant[],
  messages: ProcessMessage[],
  fragments: ProcessFragment[] = [],
): ProcessDetail => ({ participants, messages, fragments } as unknown as ProcessDetail);

describe("detailToMermaid — экспорт процесса в Mermaid sequenceDiagram", () => {
  it("участники → алиасы Pn в порядке order", () => {
    const out = detailToMermaid(detail([part("nb", "Bob", 1), part("na", "Alice", 0)], []));
    expect(out).toBe(
      ["sequenceDiagram", "    participant P1 as Alice", "    participant P2 as Bob"].join("\n"),
    );
  });

  it("стрелки по виду сообщения: forward/return/async/self", () => {
    const out = detailToMermaid(
      detail(
        [part("a", "A", 0), part("b", "B", 1)],
        [
          msg(0, "a", "b", "forward", "запрос"),
          msg(1, "b", "a", "return", "ответ"),
          msg(2, "a", "b", "async", "событие"),
          msg(3, "a", "a", "self", "проверка"),
        ],
      ),
    );
    expect(out).toContain("P1->>P2: запрос");
    expect(out).toContain("P2-->>P1: ответ");
    expect(out).toContain("P1-)P2: событие");
    expect(out).toContain("P1->>P1: проверка");
  });

  it("пустая реплика → плейсхолдер «—»", () => {
    const out = detailToMermaid(
      detail([part("a", "A", 0), part("b", "B", 1)], [msg(0, "a", "b", "forward", null)]),
    );
    expect(out).toContain("P1->>P2: —");
  });

  it("alt с веткой else оборачивает сообщения и закрывается end", () => {
    const out = detailToMermaid(
      detail(
        [part("a", "A", 0), part("b", "B", 1)],
        [
          msg(0, "a", "b", "forward", "первое"),
          msg(1, "a", "b", "forward", "второе"),
        ],
        [frag(0, 1, { guard: "успех", branches: [{ start_order: 1, guard: "ошибка" }] })],
      ),
    );
    expect(out).toBe(
      [
        "sequenceDiagram",
        "    participant P1 as A",
        "    participant P2 as B",
        "    alt успех",
        "        P1->>P2: первое",
        "    else ошибка",
        "        P1->>P2: второе",
        "    end",
      ].join("\n"),
    );
  });

  it("несколько веток else выводятся цепочкой", () => {
    // Ради этого весь эпик: mermaid принимает цепочку else любой длины.
    const out = detailToMermaid(
      detail(
        [part("a", "A", 0), part("b", "B", 1)],
        [
          msg(0, "a", "b", "forward", "первое"),
          msg(1, "a", "b", "forward", "второе"),
          msg(2, "a", "b", "forward", "третье"),
        ],
        [frag(0, 2, {
          guard: "успех",
          branches: [
            { start_order: 1, guard: "отказ" },
            { start_order: 2, guard: "таймаут" },
          ],
        })],
      ),
    );
    expect(out).toBe(
      [
        "sequenceDiagram",
        "    participant P1 as A",
        "    participant P2 as B",
        "    alt успех",
        "        P1->>P2: первое",
        "    else отказ",
        "        P1->>P2: второе",
        "    else таймаут",
        "        P1->>P2: третье",
        "    end",
      ].join("\n"),
    );
  });

  it("вложенные фрагменты: внешний открывается раньше, внутренний закрывается раньше", () => {
    const out = detailToMermaid(
      detail(
        [part("a", "A", 0), part("b", "B", 1)],
        [
          msg(0, "a", "b", "forward", "m0"),
          msg(1, "a", "b", "forward", "m1"),
          msg(2, "a", "b", "forward", "m2"),
        ],
        [
          frag(0, 2, { kind: "loop", guard: "по каждому" }),
          frag(1, 1, { kind: "opt", guard: "если надо" }),
        ],
      ),
    );
    expect(out).toBe(
      [
        "sequenceDiagram",
        "    participant P1 as A",
        "    participant P2 as B",
        "    loop по каждому",
        "        P1->>P2: m0",
        "        opt если надо",
        "            P1->>P2: m1",
        "        end",
        "        P1->>P2: m2",
        "    end",
      ].join("\n"),
    );
  });

  it("чистит «;» и переводы строк в репликах/именах", () => {
    const out = detailToMermaid(
      detail([part("a", "A\nname", 0), part("b", "B", 1)], [msg(0, "a", "b", "forward", "a;b")]),
    );
    expect(out).toContain("participant P1 as A name");
    expect(out).toContain("P1->>P2: a,b");
  });
});
