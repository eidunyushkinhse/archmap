import { describe, expect, it } from "vitest";
import type { ProcessFragment, ProcessMessage, ProcessParticipant } from "../../types";
import { orderedBranches, toSeqFragments, toSeqParticipants } from "../processes/sequence/fromDetail";
import { arrayMove, newBranchRow } from "../processes/sequence/layout";

// Минимальные фикстуры: toSeqFragments читает у сообщения только order, у фрагмента —
// kind/диапазон/ветви. Остальные поля контракта не нужны (каст через unknown).
const msg = (order: number): ProcessMessage => ({ order } as unknown as ProcessMessage);
const frag = (
  id: string,
  from_order: number,
  to_order: number,
  extra: Partial<ProcessFragment> = {},
): ProcessFragment =>
  ({ id, kind: "alt", from_order, to_order, guard: null, branches: [], ...extra } as ProcessFragment);

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

  it("ветвь else проецируется в строку", () => {
    const [f] = toSeqFragments(
      [frag("f", 0, 7, { branches: [{ start_order: 5, guard: "иначе" }] })],
      messages,
    );
    expect(f.branches).toEqual([{ row: 2, guard: "иначе" }]); // order 5 → строка 2
  });

  it("несколько ветвей проецируются каждая в свою строку", () => {
    const [f] = toSeqFragments(
      [frag("f", 0, 7, {
        branches: [
          { start_order: 2, guard: "отказ" },
          { start_order: 5, guard: "таймаут" },
        ],
      })],
      messages,
    );
    expect(f.branches).toEqual([
      { row: 1, guard: "отказ" },
      { row: 2, guard: "таймаут" },
    ]);
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

describe("orderedBranches — набор ветвей всегда по возрастанию границы", () => {
  it("новая ветвь встаёт на своё место, а не в конец", () => {
    // Вырожденный случай newBranchRow: свободная строка нашлась ВЫШЕ существующих.
    // Дописанный в конец список бэк отверг бы — границы обязаны строго возрастать.
    const out = orderedBranches([
      { start_order: 5, guard: "таймаут" },
      { start_order: 2, guard: "новая" },
    ]);
    expect(out.map((b) => b.start_order)).toEqual([2, 5]);
  });

  it("не мутирует исходный список", () => {
    const src = [{ start_order: 5, guard: null }, { start_order: 2, guard: null }];
    orderedBranches(src);
    expect(src.map((b) => b.start_order)).toEqual([5, 2]);
  });
});

describe("newBranchRow — куда встанет новая ветвь [иначе]", () => {
  it("первая ветвь делит охват пополам", () => {
    expect(newBranchRow(0, 3, [])).toBe(2);
  });

  it("следующая дописывается в хвост, за последней", () => {
    expect(newBranchRow(0, 4, [2])).toBe(3);
  });

  it("охват в два шага: единственная свободная строка", () => {
    expect(newBranchRow(0, 1, [])).toBe(1);
  });

  it("ветви сбились в низ охвата — берём свободную строку сверху", () => {
    // Вырожденный случай: в хвосте места нет, но дырки выше остались.
    expect(newBranchRow(0, 3, [3])).toBe(1);
  });

  it("свободных строк не осталось — null", () => {
    expect(newBranchRow(0, 2, [1, 2])).toBeNull();
  });

  it("никогда не возвращает строку начала охвата", () => {
    // row == fromRow оставил бы ПЕРВУЮ ветвь пустой — бэк такое отклоняет.
    for (const to of [1, 2, 3, 4]) expect(newBranchRow(0, to, [])).toBeGreaterThan(0);
  });
});

// Перестановка шагов (2026-08-10). Решение пользователя: фрагмент — диапазон
// ПОЗИЦИЙ, границы за содержимым не едут. Здесь это закреплено на проекции: после
// перестановки блок накрывает тех, кто въехал в его строки.
describe("перестановка шагов: фрагмент держит позиции, а не содержимое", () => {
  // Плотная нумерация — такую пишет reorder на бэке (order 0..N-1).
  const captioned = (id: string, order: number) =>
    ({ id, order } as unknown as ProcessMessage);

  it("блок остаётся на своих строках, состав меняется", () => {
    const before = [captioned("a", 0), captioned("b", 1), captioned("c", 2), captioned("d", 3)];
    const alt = frag("f", 1, 2); // накрывает b и c

    const [rowsBefore] = toSeqFragments([alt], before);
    expect([rowsBefore.fromRow, rowsBefore.toRow]).toEqual([1, 2]);

    // Перетащили d наверх, на позицию 1: порядок стал a, d, b, c.
    const moved = arrayMove(before, 3, 1).map((m, i) => captioned(m.id, i));
    const [rowsAfter] = toSeqFragments([alt], moved);

    expect([rowsAfter.fromRow, rowsAfter.toRow]).toEqual([1, 2]); // границы на месте
    expect(moved.slice(1, 3).map((m) => m.id)).toEqual(["d", "b"]); // внутри — другие шаги
  });

  it("ветвь else тоже держится за позицию", () => {
    const msgs = [captioned("a", 0), captioned("b", 1), captioned("c", 2)];
    const [f] = toSeqFragments(
      [frag("f", 0, 2, { branches: [{ start_order: 2, guard: null }] })],
      msgs,
    );
    expect(f.branches[0].row).toBe(2);
  });
});
