import { describe, it, expect } from "vitest";
import { buildAutoRoutes } from "../graph/layout/autoRoutes";
import { pathCrossesRects, type NodeRect } from "../graph/edgePath";
import { NODE_W, NODE_H, hid } from "../graph/constants";
import type { EdgeGroup } from "../graph/types";
import type { LayoutEdge } from "../../types";

// Посадка роутера в раскладку (A7.1). Проверяем мост группы→терминалы→маршруты:
// роутятся только routableIds, концы на сторонах узлов, узлы-препятствия обходятся.

const edge = (id: string, s: string, t: string): LayoutEdge =>
  ({ id, source_id: s, target_id: t } as LayoutEdge);
const group = (id: string, source: string, target: string): EdgeGroup =>
  ({ id, source, target, members: [edge(id, source, target)] });
const rectOf = (p: { x: number; y: number }): NodeRect => ({ x: p.x, y: p.y, w: NODE_W, h: NODE_H });

describe("buildAutoRoutes — отбор и терминалы", () => {
  const positions = new Map([
    ["A", { x: 0, y: 0 }],
    ["B", { x: 400, y: 0 }],
  ]);
  const groups = [group("g1", "A", "B")];

  it("роутит только группы из routableIds", () => {
    const none = buildAutoRoutes({
      groups, routableIds: new Set(), pairableIds: new Set(), lockedIds: new Set(), positions, edgeHandles: new Map(), displayIds: ["A", "B"],
    });
    expect(none.routes.size).toBe(0);
    const one = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), pairableIds: new Set(["g1"]), lockedIds: new Set(), positions, edgeHandles: new Map(), displayIds: ["A", "B"],
    });
    expect(one.routes.has("g1")).toBe(true);
  });

  it("свободное ребро (A8): концы на обращённых сторонах (правый край A → левый край B)", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), pairableIds: new Set(["g1"]), lockedIds: new Set(), positions, edgeHandles: new Map(), displayIds: ["A", "B"],
    });
    const r = out.routes.get("g1")!;
    // дешевле всего прямой ход: правый центр A → левый центр B
    expect(r[0]).toEqual({ x: NODE_W, y: NODE_H / 2 });
    expect(r[r.length - 1]).toEqual({ x: 400, y: NODE_H / 2 });
    // выбранная сторона отдана как хэндл
    expect(out.handles.get("g1")).toEqual({ sourceHandle: hid("A", "right", 1), targetHandle: hid("B", "left", 1) });
  });

  it("зафиксированный хэндл (lockedIds): сторона из него, в ar.handles не подменяется", () => {
    const handles = new Map([["g1", { sourceHandle: hid("A", "bottom", 1), targetHandle: hid("B", "top", 1) }]]);
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), pairableIds: new Set(["g1"]), lockedIds: new Set(["g1"]),
      positions, edgeHandles: handles, displayIds: ["A", "B"],
    });
    const r = out.routes.get("g1")!;
    expect(r[0]).toEqual({ x: NODE_W / 2, y: NODE_H }); // низ-центр A
    expect(r[r.length - 1]).toEqual({ x: 400 + NODE_W / 2, y: 0 }); // верх-центр B
    expect(out.handles.has("g1")).toBe(false); // locked — хэндл не трогаем
  });
});

describe("buildAutoRoutes — обход узла-препятствия", () => {
  it("маршрут не идёт сквозь чужой узел между концами", () => {
    // C ровно между A и B на прямой линии — прямой путь сквозь него, роутер должен объехать
    const positions = new Map([
      ["A", { x: 0, y: 0 }],
      ["B", { x: 400, y: 0 }],
      ["C", { x: 180, y: -NODE_H / 2 }],
    ]);
    const groups = [group("g1", "A", "B")];
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), pairableIds: new Set(["g1"]), lockedIds: new Set(), positions, edgeHandles: new Map(),
      displayIds: ["A", "B", "C"],
    });
    const r = out.routes.get("g1")!;
    expect(pathCrossesRects(r, [rectOf(positions.get("C")!)])).toBe(false);
  });
});
