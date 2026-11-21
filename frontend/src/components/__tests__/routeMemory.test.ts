// ПАМЯТЬ УЖЕ ПОСЧИТАННЫХ СЦЕН (эпик render-scale, спека perf.md P11, слой «память сцен»):
// сама очередь вытеснения и её связка с конвейером — прогон, у которого prev по сигнатуре не
// совпал, берёт сцену из памяти той же веткой кэш-хита; в память идёт только авторитетный
// результат.
import { describe, it, expect } from "vitest";
import { computeViewLayout, type LayoutResult, type PipelineInput } from "../graph/layout/pipeline";
import { createRouteMemory, type RouteMemory, type RouteMemoryEntry } from "../graph/layout/routeMemory";
import { __clearElkCacheForTests, layoutGraphCached } from "../graph/layout/engine";
import { NODE_W, NODE_H, TYPICAL_NODES } from "../graph/constants";
import type { Node as AppNode, Edge as AppEdge } from "../../types";

function appNode(id: string): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: "P", shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1,
    created_at: "", updated_at: "", has_children: false, child_count: 0,
    approval: "in_progress", approval_effective: "in_progress", sites: [],
    element: null, element_effective: "container", container_name: null,
  } as AppNode;
}

function edge(id: string, source_id: string, target_id: string, label: string | null = null): AppEdge {
  return { id, label, technology: null, source_id, target_id, created_at: "2026-11-21T00:00:00Z" } as AppEdge;
}

const SZ = { w: NODE_W, h: NODE_H };

// Уровень контейнера P: цепочка A → B → C с подписями, позиции владеемы, всё замерено.
function scene(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    nodes: [appNode("A"), appNode("B"), appNode("C")],
    endpoints: [],
    edges: [edge("eAB", "A", "B", "зов"), edge("eBC", "B", "C", "событие")],
    containerId: "P",
    viewLayout: { A: { x: 0, y: 0 }, B: { x: 400, y: 0 }, C: { x: 400, y: 300 } },
    ancestorIds: ["P"],
    expanded: new Set(),
    localChildren: {},
    sizes: { A: SZ, B: SZ, C: SZ },
    ...overrides,
  };
}

const MEM_MARK = "стадии качества стрелок: кэш-хит по routeSig (память сцен)";
const ROUTER_MARK = "роутер: порты+Z+A*+rip-up (проход 1)";

async function traced(input: PipelineInput, memory: RouteMemory) {
  const g = globalThis as unknown as { __ARCHMAP_TRACE?: (stage: string, ms: number) => void };
  const marks: string[] = [];
  g.__ARCHMAP_TRACE = (stage) => { marks.push(stage); };
  try {
    return { out: await computeViewLayout(input, { routeMemory: memory }), marks };
  } finally {
    delete g.__ARCHMAP_TRACE;
  }
}

// Стабильная сериализация стрелок результата (Map → отсортированные пары).
function arrows(l: LayoutResult): string {
  const m = (x?: Map<string, unknown>) => (x ? [...x.entries()].sort((p, q) => p[0].localeCompare(q[0])) : null);
  return JSON.stringify({ pos: m(l.positions), handles: m(l.edgeHandles), routes: m(l.autoRoutes), labels: m(l.labelPlacements) });
}

/** Память-шпион: считает записи поверх настоящей очереди. */
function spyMemory(limit?: number): RouteMemory & { puts: string[] } {
  const inner = createRouteMemory(limit);
  const puts: string[] = [];
  return {
    puts,
    get: (sig) => inner.get(sig),
    put: (sig, e) => { puts.push(sig); inner.put(sig, e); },
  };
}

const entry = (tag: string): RouteMemoryEntry => ({
  routes: new Map([[tag, [{ x: 0, y: 0 }]]]), handles: new Map(), labels: new Map(),
});

describe("память сцен: очередь вытеснения", () => {
  it("помнит не больше предела, вытесняет давнее всего тронутую запись", () => {
    const m = createRouteMemory(2);
    m.put("a", entry("a"));
    m.put("b", entry("b"));
    expect(m.get("a")).toBeDefined(); // обращение освежает «a» — давней становится «b»
    m.put("c", entry("c"));
    expect(m.get("b")).toBeUndefined();
    expect(m.get("a")).toBeDefined();
    expect(m.get("c")).toBeDefined();
  });

  it("повторная запись той же сигнатуры заменяет её, а не копит", () => {
    const m = createRouteMemory(2);
    m.put("a", entry("a1"));
    m.put("a", entry("a2"));
    m.put("b", entry("b"));
    expect(m.get("a")?.routes.has("a2")).toBe(true);
    expect(m.get("b")).toBeDefined();
  });
});

describe("память сцен × конвейер", () => {
  it("попадание: та же сцена без prev берётся из памяти — стадий нет, результат тот же, прогон авторитетен", async () => {
    const mem = spyMemory();
    const A = await traced(scene(), mem);
    expect(A.marks).toContain(ROUTER_MARK);
    expect(A.out.authoritative).toBe(true);
    expect(mem.puts).toEqual([A.out.routeSig]);

    const B = await traced(scene(), mem);
    expect(B.marks).toContain(MEM_MARK);
    expect(B.marks).not.toContain(ROUTER_MARK);
    expect(B.out.routeSig).toBe(A.out.routeSig);
    expect(arrows(B.out.layout)).toBe(arrows(A.out.layout));
    expect(B.out.authoritative).toBe(true);
  });

  it("prev по сигнатуре сильнее памяти: совпавший prev берётся прежней веткой", async () => {
    const mem = createRouteMemory();
    const A = await traced(scene(), mem);
    const B = await traced(scene({
      prevRoutes: A.out.layout.autoRoutes,
      prevEdgeHandles: A.out.layout.edgeHandles,
      prevRouteSig: A.out.routeSig,
      prevLabelPlacements: A.out.layout.labelPlacements,
    }), mem);
    expect(B.marks).toContain("стадии качества стрелок: кэш-хит по routeSig");
    expect(B.marks).not.toContain(MEM_MARK);
  });

  it("промах: другая сцена (иная подпись связи) считается заново", async () => {
    const mem = createRouteMemory();
    await traced(scene(), mem);
    const C = await traced(scene({ edges: [edge("eAB", "A", "B", "запрос"), edge("eBC", "B", "C", "событие")] }), mem);
    expect(C.marks).not.toContain(MEM_MARK);
    expect(C.marks).toContain(ROUTER_MARK);
  });

  it("вытеснение: сцена, вытесненная более свежими, считается заново", async () => {
    const mem = createRouteMemory(1);
    await traced(scene(), mem);
    await traced(scene({ viewLayout: { A: { x: 0, y: 0 }, B: { x: 500, y: 0 }, C: { x: 500, y: 300 } } }), mem);
    const again = await traced(scene(), mem);
    expect(again.marks).not.toContain(MEM_MARK);
    expect(again.marks).toContain(ROUTER_MARK);
  });

  it("не авторитетный результат в память не идёт: пропуск стадий, скоуп, сцена больше типовой без замеров", async () => {
    const mem = spyMemory();
    // явный пропуск стадий качества
    const skip = await traced(scene({ edgeQuality: "skip" }), mem);
    expect(skip.out.authoritative).toBe(false);
    // скоуп после драга
    const full = await computeViewLayout(scene());
    const scoped = await traced(scene({
      prevRoutes: full.layout.autoRoutes,
      prevEdgeHandles: full.layout.edgeHandles,
      scopeNodeIds: ["A"],
    }), mem);
    expect(scoped.out.scoped).toBe(true);
    expect(scoped.out.authoritative).toBe(false);
    // сцена больше типовой (P1) без замеров: черновой прогон
    const ids = Array.from({ length: TYPICAL_NODES + 1 }, (_, i) => `N${i}`);
    const big = await traced(scene({
      nodes: ids.map(appNode), edges: [], sizes: undefined,
      viewLayout: Object.fromEntries(ids.map((id, i) => [id, { x: (i % 10) * 300, y: Math.floor(i / 10) * 200 }])),
    }), mem);
    expect(big.out.authoritative).toBe(false);
    expect(mem.puts, "ни один не авторитетный прогон не записан").toEqual([]);
  });
});

describe("кэш мини-раскладок ELK (layoutGraphCached)", () => {
  const graph = (gap: string) => ({
    id: "spawn-X",
    layoutOptions: { "elk.algorithm": "layered", "elk.spacing.nodeNode": gap },
    children: [{ id: "a", width: NODE_W, height: NODE_H }, { id: "b", width: NODE_W, height: NODE_H }],
    edges: [{ id: "e", sources: ["a"], targets: ["b"] }],
  });

  it("тот же граф — та же карта из кэша; другой граф — своя раскладка; сброс чистит кэш", async () => {
    __clearElkCacheForTests();
    const a = await layoutGraphCached(graph("60"));
    const b = await layoutGraphCached(graph("60"));
    expect(b).toBe(a);
    const c = await layoutGraphCached(graph("90"));
    expect(c).not.toBe(a);
    __clearElkCacheForTests();
    const d = await layoutGraphCached(graph("60"));
    expect(d).not.toBe(a);
    expect([...d.entries()]).toEqual([...a.entries()]); // детерминизм ELK
  });
});
