import { describe, it, expect } from "vitest";
import { getElk, layoutLevel, __clearElkCacheForTests } from "../graph/layout/engine";
import type { LayoutEdge } from "../../types";

// Спайк Фазы 4 (шаг 4.0): убеждаемся, что ELK поднимается в main-thread под jsdom
// (через elk.bundled.js, без Web Worker) и async-адаптер сохраняет контракт старого
// синхронного движка. См. REFACTOR_PHASE4.md.

function edge(id: string, source_id: string, target_id: string): LayoutEdge {
  return {
    id, label: null, technology: null, source_id, target_id,
    version: 1,
    created_at: "2026-06-08T00:00:00Z",
  };
}

describe("ELK spike (шаг 4.0)", () => {
  it("раскладывает тривиальный layered-граф в main-thread под jsdom", async () => {
    const elk = await getElk();
    const res = await elk.layout({
      id: "root",
      layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
      children: [
        { id: "a", width: 180, height: 70 },
        { id: "b", width: 180, height: 70 },
        { id: "c", width: 180, height: 70 },
      ],
      edges: [
        { id: "e1", sources: ["a"], targets: ["b"] },
        { id: "e2", sources: ["b"], targets: ["c"] },
      ],
    });
    const pos = new Map(res.children!.map((n) => [n.id, { x: n.x!, y: n.y! }]));
    // a левее b левее c (LR-цепочка), все координаты конечны
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
    expect(pos.get("b")!.x).toBeLessThan(pos.get("c")!.x);
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("layoutLevel (async-адаптер) считает позиции на оба узла и хэндлы по ELK-раскладке", async () => {
    const nodes = [{ id: "a" }, { id: "b" }];
    const edges = [edge("e1", "a", "b")];
    const asyncRes = await layoutLevel(nodes, edges);
    expect(asyncRes.positions.has("a")).toBe(true);
    expect(asyncRes.positions.has("b")).toBe(true);
    // a→b раскладывается ELK слева направо (LR) → autoHandles right/left
    expect(asyncRes.edgeHandles.get("e1")).toEqual({
      sourceHandle: "a--right--1",
      targetHandle: "b--left--1",
    });
  });
});

describe("форма уровня N30 (перф-эпик Ф4)", () => {
  const starNodes = [{ id: "hub" }, { id: "l1" }, { id: "l2" }, { id: "l3" }, { id: "l4" }, { id: "l5" }];
  const starEdges = ["l1", "l2", "l3", "l4", "l5"].map((l, i) => edge(`e${i}`, "hub", l));

  it("звезда раскладывается force: листья по обе стороны хаба (layered посадил бы всех правее)", async () => {
    __clearElkCacheForTests();
    const res = await layoutLevel(starNodes, starEdges);
    const hub = res.positions.get("hub")!;
    const xs = ["l1", "l2", "l3", "l4", "l5"].map((l) => res.positions.get(l)!.x);
    expect(Math.min(...xs)).toBeLessThan(hub.x);
    expect(Math.max(...xs)).toBeGreaterThan(hub.x);
  });

  it("ЗАМОК ДЕТЕРМИНИЗМА: два живых прогона force (кэш сброшен) — позиции идентичны", async () => {
    __clearElkCacheForTests();
    const a = await layoutLevel(starNodes, starEdges);
    __clearElkCacheForTests();
    const b = await layoutLevel(starNodes, starEdges);
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()]);
  });
});
