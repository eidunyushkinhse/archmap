import { describe, it, expect } from "vitest";
import { liftEdgesToLevel } from "../graph/projection";
import type { GhostNode, AncestorRef } from "../../types";

// Первая половина проекции (R2): подъём концов СЫРЫХ рёбер к ближайшему локальному
// предку уровня. Кейсы перенесены из прежних бэкенд-тестов find_effective
// (test_build_graph.py) — семантика должна совпадать один-в-один.

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });

function ep(id: string, ancestors: AncestorRef[]): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: false,
    shape: "service", status: "existing", node_depth: ancestors.length,
    has_children: false, child_count: 0, ancestors, is_ghost: true,
  } as GhostNode;
}

const edge = (id: string, source_id: string, target_id: string) => ({ id, source_id, target_id });

describe("liftEdgesToLevel — подъём концов к ближайшему локальному предку", () => {
  it("глубокие концы поднимаются к корневым предкам на корневом уровне", () => {
    // A→A1, B→B1, ребро A1→B1; уровень корня: локалы A и B.
    const res = liftEdgesToLevel({
      edges: [edge("e", "A1", "B1")],
      endpoints: [ep("A1", [a("A")]), ep("B1", [a("B")])],
      localIds: new Set(["A", "B"]),
      containerId: null,
    });
    expect(res.edges).toEqual([{ id: "e", source_id: "A", target_id: "B" }]);
    expect(res.ghosts).toEqual([]); // на корне гостей не бывает
  });

  it("подъём — к БЛИЖАЙШЕМУ локальному предку (не к самому верхнему)", () => {
    // Уровень внутри A: локал A1 (контейнер), конец A1a лежит глубже внутри A1.
    const res = liftEdgesToLevel({
      edges: [edge("e", "A1a", "X")],
      endpoints: [ep("A1a", [a("A"), a("A1")]), ep("X", [])],
      localIds: new Set(["A1"]),
      containerId: "A",
    });
    expect(res.edges[0].source_id).toBe("A1");
    expect(res.edges[0].target_id).toBe("X");
  });

  it("внутреннее ребро одного ребёнка (оба конца поднялись в одну сущность) — скрыто", () => {
    const res = liftEdgesToLevel({
      edges: [edge("e", "A1", "A2")],
      endpoints: [ep("A1", [a("A")]), ep("A2", [a("A")])],
      localIds: new Set(["A"]),
      containerId: null,
    });
    expect(res.edges).toEqual([]);
    expect(res.ghosts).toEqual([]);
  });

  it("конец вне поддерева остаётся гостем со своей identity", () => {
    // Уровень A (локал A1); дальний конец B1 под чужим корнем B.
    const res = liftEdgesToLevel({
      edges: [edge("e", "A1", "B1")],
      endpoints: [ep("B1", [a("B")])],
      localIds: new Set(["A1"]),
      containerId: "A",
    });
    expect(res.edges).toEqual([{ id: "e", source_id: "A1", target_id: "B1" }]);
    expect(res.ghosts.map((g) => g.id)).toEqual(["B1"]);
  });

  it("ребро, не касающееся локалов ни одним поднятым концом, — скрыто", () => {
    const res = liftEdgesToLevel({
      edges: [edge("e", "B1", "C1")],
      endpoints: [ep("B1", [a("B")]), ep("C1", [a("C")])],
      localIds: new Set(["A1"]),
      containerId: "A",
    });
    expect(res.edges).toEqual([]);
    expect(res.ghosts).toEqual([]);
  });

  it("конец на самом контейнере уровня — ребро не показывается", () => {
    const res = liftEdgesToLevel({
      edges: [edge("e", "A", "A1")],
      endpoints: [ep("A", [])],
      localIds: new Set(["A1"]),
      containerId: "A",
    });
    expect(res.edges).toEqual([]);
  });

  it("предок контейнера уровня показывается гостем-листом (как раньше у бэкенда)", () => {
    // Уровень A (внутри корня P): ребро A1→P. P — предок контейнера, не локал,
    // его цепочка не содержит локалов → гость с identity P.
    const res = liftEdgesToLevel({
      edges: [edge("e", "A1", "P")],
      endpoints: [ep("P", [])],
      localIds: new Set(["A1"]),
      containerId: "A",
    });
    expect(res.edges).toEqual([{ id: "e", source_id: "A1", target_id: "P" }]);
    expect(res.ghosts.map((g) => g.id)).toEqual(["P"]);
  });

  it("гости дедуплицируются по identity (два ребра к одному концу)", () => {
    const res = liftEdgesToLevel({
      edges: [edge("e1", "A1", "B1"), edge("e2", "B1", "A1")],
      endpoints: [ep("B1", [a("B")])],
      localIds: new Set(["A1"]),
      containerId: "A",
    });
    expect(res.edges).toHaveLength(2);
    expect(res.ghosts.map((g) => g.id)).toEqual(["B1"]);
  });
});
