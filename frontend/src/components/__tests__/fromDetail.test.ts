import { describe, expect, it } from "vitest";
import type { ProcessFragment, ProcessMessage } from "../../types";
import { toSeqFragments } from "../processes/sequence/fromDetail";

// Минимальные фикстуры: toSeqFragments читает у сообщения только order, у фрагмента —
// kind/диапазон/else. Остальные поля контракта не нужны (каст через unknown).
const msg = (order: number): ProcessMessage => ({ order } as unknown as ProcessMessage);
const frag = (
  id: string,
  from_order: number,
  to_order: number,
  extra: Partial<ProcessFragment> = {},
): ProcessFragment =>
  ({ id, kind: "alt", from_order, to_order, guard: null, else_guard: null, else_order: null, ...extra } as ProcessFragment);

describe("toSeqFragments — проекция order→строка и множественные фрагменты", () => {
  // Сообщения с разреженными order: индекс строки = число сообщений с меньшим order.
  const messages = [msg(0), msg(2), msg(5), msg(7)]; // строки 0,1,2,3

  it("order фрагмента проецируется на индекс строки", () => {
    const [f] = toSeqFragments([frag("f1", 2, 7)], messages);
    expect(f.fromRow).toBe(1); // order 2 → строка 1
    expect(f.toRow).toBe(3); // order 7 → строка 3
  });

  it("возвращает ВСЕ фрагменты (не только первый)", () => {
    const out = toSeqFragments([frag("a", 0, 2), frag("b", 5, 7)], messages);
    expect(out.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("сортирует внешние (более широкие) раньше — для стабильной вложенности", () => {
    const inner = frag("inner", 2, 5);
    const outer = frag("outer", 0, 7);
    const out = toSeqFragments([inner, outer], messages);
    expect(out.map((f) => f.id)).toEqual(["outer", "inner"]);
  });

  it("ветка else проецируется в elseRow", () => {
    const [f] = toSeqFragments([frag("f", 0, 7, { else_order: 5, else_guard: "иначе" })], messages);
    expect(f.elseRow).toBe(2); // order 5 → строка 2
    expect(f.elseGuard).toBe("иначе");
  });

  it("пустой список фрагментов → пустой массив", () => {
    expect(toSeqFragments([], messages)).toEqual([]);
  });
});
