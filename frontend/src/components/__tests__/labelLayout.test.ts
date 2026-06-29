import { describe, it, expect } from "vitest";
import { buildLabelPlacements, type LabelMeta } from "../graph/layout/labelLayout";
import { rectFromCenter, countLabelOverlaps } from "../graph/layout/arrowMetrics";
import { labelBoxSize } from "../graph/layout/labelBox";
import type { NodeRect } from "../graph/edgePath";
import type { EdgeGroup } from "../graph/types";
import type { Edge as AppEdge, EdgePoint } from "../../types";

// Мост раскладки плашек (A7.2): по авто-маршрутам строит размещение без наложений (R2),
// с выноской-leader там, где на линии не встаёт. Проверяем инварианты через метрики A0.

const edge = (id: string, label?: string): AppEdge => ({ id, source_id: "s", target_id: "t", label } as AppEdge);
const group = (id: string, members: AppEdge[]): EdgeGroup => ({ id, source: "s", target: "t", members });
const poly = (...pairs: [number, number][]): EdgePoint[] => pairs.map(([x, y]) => ({ x, y }));
const meta = (text: string): LabelMeta => ({ text, lines: 1 });

describe("buildLabelPlacements — базовое", () => {
  it("у группы без подписи плашки нет", () => {
    const routes = new Map([["g1", poly([0, 0], [200, 0])]]);
    const out = buildLabelPlacements({
      routes, groups: [group("g1", [edge("g1")])],
      labelMeta: () => null, preferredT: () => undefined, nodeRects: [],
    });
    expect(out.has("g1")).toBe(false);
  });

  it("чистый маршрут → online, плашка на линии (anchor == center)", () => {
    const routes = new Map([["g1", poly([0, 0], [200, 0])]]);
    const out = buildLabelPlacements({
      routes, groups: [group("g1", [edge("g1", "связь")])],
      labelMeta: () => meta("связь"), preferredT: () => undefined, nodeRects: [],
    });
    const p = out.get("g1")!;
    expect(p.mode).toBe("online");
    expect(p.center.y).toBeCloseTo(0, 0);
    expect(p.anchor).toEqual(p.center);
  });
});

describe("buildLabelPlacements — R2 без наложений", () => {
  it("две близкие параллельные стрелки → плашки не накладываются", () => {
    const routes = new Map([
      ["g1", poly([0, 0], [220, 0])],
      ["g2", poly([0, 12], [220, 12])],
    ]);
    const groups = [group("g1", [edge("g1", "alpha")]), group("g2", [edge("g2", "beta")])];
    const out = buildLabelPlacements({
      routes, groups,
      labelMeta: (g) => meta(g.id === "g1" ? "alpha" : "beta"),
      preferredT: () => undefined, nodeRects: [],
    });
    const rects: NodeRect[] = [...out.values()].map((p) =>
      rectFromCenter(p.center.x, p.center.y, labelBoxSize("alpha").w, labelBoxSize("alpha").h));
    expect(countLabelOverlaps(rects)).toBe(0);
  });
});

describe("buildLabelPlacements — выноска", () => {
  it("маршрут целиком под узлом → leader (плашка снесена с линии)", () => {
    // путь короткий и весь накрыт большим узлом-препятствием → на линии чисто не встаёт
    const routes = new Map([["g1", poly([0, 0], [40, 0])]]);
    const node: NodeRect = { x: -120, y: -80, w: 280, h: 160 };
    const out = buildLabelPlacements({
      routes, groups: [group("g1", [edge("g1", "под узлом")])],
      labelMeta: () => meta("под узлом"), preferredT: () => undefined, nodeRects: [node],
    });
    expect(out.get("g1")!.mode).toBe("leader");
  });
});
