// Флаг reconnectable у RF-рёбер (эпик «связи, упирающиеся в рамку»).
//
// Ручной слой геометрии стрелок удалён (edge.md E1) и `reconnectable:false` стоит у
// ВСЕХ рёбер — кроме одного исключения: конец, упёршийся в рамку, тянуть можно.
// Флаг важен сам по себе: без него React Flow вообще не начнёт жест, и проверки
// холста (levelGraph.reconnect.test.tsx) никогда не позовутся.
import { describe, it, expect, vi } from "vitest";
import { assembleRfGraph } from "../graph/assembleRf";
import type { LayoutResult } from "../graph/layout/pipeline";
import type { Edge as AppEdge } from "../../types";
import type { AssembleCallbacks } from "../graph/assembleRf";

const edge = (id: string, s: string, t: string): AppEdge =>
  ({ id, label: null, technology: null, source_id: s, target_id: t, created_at: "" } as AppEdge);

function layoutWith(frameEnds: string[]): LayoutResult {
  return {
    nodes: [],
    entities: [],
    positions: new Map([["X", { x: 0, y: 0 }], ["Y", { x: 400, y: 0 }]]),
    edgeHandles: new Map(),
    guestFrames: [],
    frameEnds,
    groupArr: [
      { id: "gToFrame", source: "X", target: "F", members: [edge("e1", "X", "F")] },
      { id: "gFromFrame", source: "F", target: "Y", members: [edge("e2", "F", "Y")] },
      { id: "gPlain", source: "X", target: "Y", members: [edge("e3", "X", "Y")] },
      { id: "gBoth", source: "F", target: "F2", members: [edge("e4", "F", "F2")] },
    ],
    spacers: [],
  };
}

const cb = (): AssembleCallbacks => ({
  drillWithPath: vi.fn(), expandContainer: vi.fn(), expandLocalContainer: vi.fn(),
  collapseContainer: vi.fn(), openEdgeMembers: vi.fn(),
  quickConnect: { enter: vi.fn(), leave: vi.fn(), activate: vi.fn() },
});

function build(frameEnds: string[], over: { isArchitect?: boolean; isReadOnly?: boolean } = {}) {
  const { nextEdges } = assembleRfGraph({
    layout: layoutWith(frameEnds),
    isArchitect: over.isArchitect ?? true,
    isReadOnly: over.isReadOnly ?? false,
    drillNav: true,
    depth: 0,
    schemaView: "all",
    getCb: cb,
  });
  return new Map(nextEdges.map((e) => [e.id, e.reconnectable]));
}

describe("assembleRfGraph — reconnectable только у конца-в-рамку", () => {
  it("тянется ровно тот конец, что упёрся в рамку", () => {
    const r = build(["F", "F2"]);
    expect(r.get("gToFrame")).toBe("target");   // рамка — цель
    expect(r.get("gFromFrame")).toBe("source"); // рамка — источник
    expect(r.get("gBoth")).toBe(true);          // обе стороны — рамки
    expect(r.get("gPlain")).toBe(false);        // обычная связь неприкосновенна (E1)
  });

  it("рамка, в которую никто не упирается, ничего не разрешает", () => {
    expect(build([]).get("gToFrame")).toBe(false);
  });

  it("наблюдателю и в read-only жест недоступен", () => {
    expect(build(["F"], { isArchitect: false }).get("gToFrame")).toBe(false);
    expect(build(["F"], { isReadOnly: true }).get("gToFrame")).toBe(false);
  });
});
