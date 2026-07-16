import { describe, it, expect } from "vitest";
import { compareByRank } from "../../types";
import type { Node } from "../../types";

// Порядок сиблингов в дереве: внутренние раньше внешних (первичный ключ), внутри
// группы — по child_count убыв., затем по имени. См. types/index.ts.

function n(name: string, opts: { external?: boolean; kids?: number } = {}): Node {
  return {
    id: name, name, description: null, role: null, technology: null,
    parent_id: null, openapi_spec: null, docs: [],
    is_external: opts.external ?? false, shape: "service", status: "existing",
    child_count: opts.kids ?? 0, has_children: (opts.kids ?? 0) > 0,
    version: 1,
    created_at: "2026-07-13T00:00:00Z", updated_at: "2026-07-13T00:00:00Z",
  };
}

const order = (ns: Node[]): string[] => [...ns].sort(compareByRank).map((x) => x.name);

describe("compareByRank", () => {
  it("внутренние идут раньше внешних независимо от числа детей", () => {
    // Пример пользователя: внутр(10), внутр(2), внеш(5) → именно в таком порядке.
    const inRich = n("in10", { kids: 10 });
    const inPoor = n("in2", { kids: 2 });
    const exMid = n("ex5", { external: true, kids: 5 });
    expect(order([exMid, inPoor, inRich])).toEqual(["in10", "in2", "ex5"]);
  });

  it("внутри одной группы (is_external) — по child_count убыв., затем по имени", () => {
    expect(order([n("b", { kids: 1 }), n("a", { kids: 1 }), n("c", { kids: 3 })]))
      .toEqual(["c", "a", "b"]);
  });

  it("внешние сортируются между собой по тем же вторичным ключам", () => {
    const exA = n("exA", { external: true, kids: 2 });
    const exB = n("exB", { external: true, kids: 9 });
    expect(order([exA, exB])).toEqual(["exB", "exA"]);
  });
});
