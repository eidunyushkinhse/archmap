import { describe, expect, it } from "vitest";
import type { ProcessFragment, ProcessMessage, ProcessParticipant } from "../../types";
import { toSeqFragments, toSeqParticipants } from "../processes/sequence/fromDetail";
import { arrayMove } from "../processes/sequence/layout";

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

// Фикстура участника: toSeqParticipants читает order/node_id/имя/форму/статус.
const part = (id: string, node_id: string, order: number): ProcessParticipant =>
  ({
    id, node_id, order, name: node_id, role: null, shape: "service",
    is_external: false, status: "existing",
  } as ProcessParticipant);

describe("toSeqParticipants — порядок линий жизни из поля order", () => {
  it("сортирует по order независимо от порядка в ответе API", () => {
    const out = toSeqParticipants([part("p2", "B", 1), part("p1", "A", 0), part("p3", "C", 2)]);
    expect(out.map((p) => p.id)).toEqual(["A", "B", "C"]);
  });

  it("id линии жизни = node_id узла (не id сущности-участника)", () => {
    const [p] = toSeqParticipants([part("participant-uuid", "node-uuid", 0)]);
    expect(p.id).toBe("node-uuid");
  });
});

describe("arrayMove — перестановка одного элемента (основа reorder)", () => {
  it("сдвиг вправо", () => {
    expect(arrayMove(["A", "B", "C", "D"], 0, 2)).toEqual(["B", "C", "A", "D"]);
  });

  it("сдвиг влево", () => {
    expect(arrayMove(["A", "B", "C", "D"], 3, 1)).toEqual(["A", "D", "B", "C"]);
  });

  it("на ту же позицию — порядок не меняется", () => {
    expect(arrayMove(["A", "B", "C"], 1, 1)).toEqual(["A", "B", "C"]);
  });

  it("не мутирует исходный массив", () => {
    const src = ["A", "B", "C"];
    arrayMove(src, 0, 2);
    expect(src).toEqual(["A", "B", "C"]);
  });
});
