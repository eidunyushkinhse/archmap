import { describe, it, expect } from "vitest";
import { getElk, layoutLevel } from "../graph/layout/engine";
import type { Edge as AppEdge } from "../../types";

// Спайк Фазы 4 (шаг 4.0): убеждаемся, что ELK поднимается в main-thread под jsdom
// (через elk.bundled.js, без Web Worker) и async-адаптер сохраняет контракт старого
// синхронного движка. См. REFACTOR_PHASE4.md.

function edge(id: string, source_id: string, target_id: string): AppEdge {
  return {
    id, label: null, technology: null, source_id, target_id,
    source_handle: null, target_handle: null, created_at: "2026-06-08T00:00:00Z",
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
