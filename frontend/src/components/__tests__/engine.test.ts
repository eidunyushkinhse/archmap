import { describe, it, expect } from "vitest";
import { getElk, layoutLevel, __clearElkCacheForTests } from "../graph/layout/engine";
import type { GuestLayer } from "../graph/layout/guestLayers";
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
    // a→b раскладывается ELK сверху вниз (DOWN, Ф4 эпика «стрелки без жёстких
    // хэндлов») → b ниже a, фолбэк-хэндлы bottom/top
    expect(asyncRes.positions.get("b")!.y).toBeGreaterThan(asyncRes.positions.get("a")!.y);
    expect(asyncRes.edgeHandles.get("e1")).toEqual({
      sourceHandle: "a--bottom--1",
      targetHandle: "b--top--1",
    });
  });
});

describe("форма уровня — всегда layered DOWN (R10, N30 снят)", () => {
  const starNodes = [{ id: "hub" }, { id: "l1" }, { id: "l2" }, { id: "l3" }, { id: "l4" }, { id: "l5" }];
  const starEdges = ["l1", "l2", "l3", "l4", "l5"].map((l, i) => edge(`e${i}`, "hub", l));

  it("звезда раскладывается потоком: все листья в слое ниже хаба (force снят в Ф4)", async () => {
    __clearElkCacheForTests();
    const res = await layoutLevel(starNodes, starEdges);
    const hub = res.positions.get("hub")!;
    const ys = ["l1", "l2", "l3", "l4", "l5"].map((l) => res.positions.get(l)!.y);
    for (const y of ys) expect(y).toBeGreaterThan(hub.y);
  });

  it("ЗАМОК ДЕТЕРМИНИЗМА: два живых прогона (кэш сброшен) — позиции идентичны", async () => {
    __clearElkCacheForTests();
    const a = await layoutLevel(starNodes, starEdges);
    __clearElkCacheForTests();
    const b = await layoutLevel(starNodes, starEdges);
    expect([...a.positions.entries()]).toEqual([...b.positions.entries()]);
  });
});

describe("крайние слои гостей (Ф4б, guestLayers)", () => {
  // цепочка локалов L1→L2→L3; гость-источник Gs → L3 (без ограничения ELK ставил бы его
  // во второй ряд), гость-приёмник L1 → Gt; Gs2 связан только с Gs (гость→гость внутри
  // одного крайнего слоя — ELK не отдаётся) и с L2
  const nodes = [{ id: "L1" }, { id: "L2" }, { id: "L3" }, { id: "Gs" }, { id: "Gs2" }, { id: "Gt" }];
  const edges = [
    edge("e1", "L1", "L2"), edge("e2", "L2", "L3"), edge("e3", "Gs", "L3"),
    edge("e4", "L1", "Gt"), edge("e5", "Gs", "Gs2"), edge("e6", "Gs2", "L2"),
  ];
  const guestLayers = new Map<string, GuestLayer>([["Gs", "first"], ["Gs2", "first"], ["Gt", "last"]]);

  it("источники — слоем выше всех локалов, приёмники — ниже; поток локалов не тронут", async () => {
    __clearElkCacheForTests();
    const res = await layoutLevel(nodes, edges, { guestLayers });
    const y = (id: string): number => res.positions.get(id)!.y;
    const localYs = ["L1", "L2", "L3"].map(y);
    expect(y("Gs")).toBeLessThan(Math.min(...localYs));
    expect(y("Gs2")).toBeLessThan(Math.min(...localYs));
    expect(y("Gt")).toBeGreaterThan(Math.max(...localYs));
    expect(y("L1")).toBeLessThan(y("L2"));
    expect(y("L2")).toBeLessThan(y("L3"));
  });

  it("контроль: без ограничений гость-источник к третьему ряду встаёт ВНУТРЬ потока", async () => {
    __clearElkCacheForTests();
    const res = await layoutLevel(
      [{ id: "L1" }, { id: "L2" }, { id: "L3" }, { id: "Gs" }],
      [edge("e1", "L1", "L2"), edge("e2", "L2", "L3"), edge("e3", "Gs", "L3")],
    );
    expect(res.positions.get("Gs")!.y).toBeGreaterThan(res.positions.get("L1")!.y);
  });
});
