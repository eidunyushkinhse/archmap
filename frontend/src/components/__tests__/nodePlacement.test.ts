// ПРАВИЛО РАССТАНОВКИ УЗЛОВ ПО РАЗМЕРУ ГРАФА ELK (эпик render-scale, шаг «быстрый ELK и один
// прогон»; спецификации node.md N20, container.md C9): до NODE_PLACEMENT_SMALL_MAX узлов графа
// включительно — NETWORK_SIMPLEX, больше — LINEAR_SEGMENTS. Одно правило на раскладку уровня
// и на мини-раскладку детей; проверяется по опциям, которые на деле уходят в ELK. Хук
// полигона (diag.__archmapElkOverride) по-прежнему перекрывает стратегию уровня.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getElk, layoutLevel, nodePlacementFor, NODE_PLACEMENT_SMALL_MAX, __clearElkCacheForTests,
} from "../graph/layout/engine";
import { layoutChildrenBlock } from "../graph/layout/spawnChildren";
import { diag } from "../graph/layout/diag";
import { NODE_W, NODE_H } from "../graph/constants";
import type { LayoutEdge } from "../../types";

const STRATEGY = "elk.layered.nodePlacement.strategy";

function chain(n: number): { ids: string[]; edges: LayoutEdge[] } {
  const ids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(2, "0")}`);
  const edges = ids.slice(1).map((id, i) => ({
    id: `e${i}`, label: null, technology: null, source_id: ids[i], target_id: id,
    version: 1, created_at: "2026-11-21T00:00:00Z",
  })) as LayoutEdge[];
  return { ids, edges };
}

/** Стратегии, ушедшие в ELK за время fn (по графу верхнего уровня). */
async function strategiesSent(fn: () => Promise<unknown>): Promise<(string | undefined)[]> {
  const elk = await getElk();
  const spy = vi.spyOn(elk, "layout");
  try {
    await fn();
    return spy.mock.calls.map(([g]) => (g.layoutOptions as Record<string, string> | undefined)?.[STRATEGY]);
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  delete diag.__archmapElkOverride;
  __clearElkCacheForTests();
});

describe("стратегия расстановки по размеру графа ELK", () => {
  it("порог включительно: 30 узлов — NETWORK_SIMPLEX, 31 — LINEAR_SEGMENTS", () => {
    expect(NODE_PLACEMENT_SMALL_MAX).toBe(30);
    expect(nodePlacementFor(1)).toBe("NETWORK_SIMPLEX");
    expect(nodePlacementFor(30)).toBe("NETWORK_SIMPLEX");
    expect(nodePlacementFor(31)).toBe("LINEAR_SEGMENTS");
    expect(nodePlacementFor(120)).toBe("LINEAR_SEGMENTS");
  });

  it("раскладка уровня: граф из 30 узлов уходит в ELK с NETWORK_SIMPLEX, из 31 — с LINEAR_SEGMENTS", async () => {
    for (const [n, want] of [[30, "NETWORK_SIMPLEX"], [31, "LINEAR_SEGMENTS"]] as const) {
      __clearElkCacheForTests();
      const { ids, edges } = chain(n);
      const sent = await strategiesSent(() => layoutLevel(ids.map((id) => ({ id })), edges));
      expect(sent, `${n} узлов`).toEqual([want]);
    }
  });

  it("мини-раскладка детей — то же правило по числу детей", async () => {
    for (const [n, want] of [[30, "NETWORK_SIMPLEX"], [31, "LINEAR_SEGMENTS"]] as const) {
      __clearElkCacheForTests();
      const { ids, edges } = chain(n);
      const sent = await strategiesSent(() => layoutChildrenBlock({
        cid: "P", ids, sizeOf: () => ({ w: NODE_W, h: NODE_H }), layoutEdges: edges, parentOf: new Map(),
      }));
      expect(sent, `${n} детей`).toEqual([want]);
    }
  });

  it("хук полигона перекрывает стратегию уровня", async () => {
    diag.__archmapElkOverride = { [STRATEGY]: "NETWORK_SIMPLEX" };
    const { ids, edges } = chain(31);
    const sent = await strategiesSent(() => layoutLevel(ids.map((id) => ({ id })), edges));
    expect(sent).toEqual(["NETWORK_SIMPLEX"]);
  });

  it("кэш ELK уровня различает графы по размеру: граф другого размера считается заново", async () => {
    const small = chain(30), big = chain(31);
    const sent = await strategiesSent(async () => {
      await layoutLevel(small.ids.map((id) => ({ id })), small.edges);
      await layoutLevel(big.ids.map((id) => ({ id })), big.edges);
      await layoutLevel(small.ids.map((id) => ({ id })), small.edges); // из кэша
    });
    expect(sent).toEqual(["NETWORK_SIMPLEX", "LINEAR_SEGMENTS"]);
  });
});
