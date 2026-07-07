import { describe, it, expect } from "vitest";
import { separateOverlappingNodes, clampOutOfNodeRects, NODE_SEP_PAD } from "../graph/layout/separateNodes";
import { NODE_W, NODE_H } from "../graph/constants";

// Инвариант: никакие два отображаемых узла не накладываются.

const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x < b.x + NODE_W && a.x + NODE_W > b.x && a.y < b.y + NODE_H && a.y + NODE_H > b.y;

describe("separateOverlappingNodes (конвейерная стадия)", () => {
  it("свежий уступает владеемому; после развода наложения нет", () => {
    const positions = new Map([
      ["owned", { x: 100, y: 100 }],
      ["fresh", { x: 120, y: 110 }], // лежит на владеемом
    ]);
    const moved = separateOverlappingNodes({
      ids: ["owned", "fresh"],
      positions,
      ownedPositions: { owned: { pos_x: 100, pos_y: 100 } },
    });
    expect(moved.has("fresh")).toBe(true);
    expect(overlap(positions.get("owned")!, positions.get("fresh")!)).toBe(false);
    // владеемый почти не сдвинулся (вес)
    const o = positions.get("owned")!;
    expect(Math.abs(o.x - 100) + Math.abs(o.y - 100)).toBeLessThan(2);
  });

  it("два наложенных ВЛАДЕЕМЫХ разъезжаются (не Infinity), поровну", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 20, y: 4 }],
    ]);
    const moved = separateOverlappingNodes({
      ids: ["a", "b"],
      positions,
      ownedPositions: { a: { pos_x: 0, pos_y: 0 }, b: { pos_x: 20, pos_y: 4 } },
    });
    expect(moved.size).toBe(2);
    expect(overlap(positions.get("a")!, positions.get("b")!)).toBe(false);
  });

  it("не налегающие пары не трогаются (стоящие вплотную не расталкиваются)", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: NODE_W + 2, y: 0 }], // рядом, зазор 2px — но НЕ наложение
    ]);
    const moved = separateOverlappingNodes({
      ids: ["a", "b"],
      positions,
      ownedPositions: {},
    });
    expect(moved.size).toBe(0);
    expect(positions.get("b")).toEqual({ x: NODE_W + 2, y: 0 });
  });
});

describe("clampOutOfNodeRects (живой кламп драга)", () => {
  it("субъект выталкивается MTV из чужого узла с зазором", () => {
    const other = { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H };
    const out = clampOutOfNodeRects({ x: 150, y: 10 }, NODE_W, NODE_H, [other]);
    // минимальная ось — X вправо: 180 + pad
    expect(out.x).toBeCloseTo(NODE_W + NODE_SEP_PAD);
    expect(out.y).toBe(10);
  });

  it("каскад: вытолкнуло на второго — итерации доводят до чистого места", () => {
    const others = [
      { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H },
      { minX: NODE_W + NODE_SEP_PAD, minY: 0, maxX: 2 * NODE_W + NODE_SEP_PAD, maxY: NODE_H },
    ];
    const out = clampOutOfNodeRects({ x: 160, y: 8 }, NODE_W, NODE_H, others);
    for (const o of others) {
      const hit = out.x < o.maxX && out.x + NODE_W > o.minX && out.y < o.maxY && out.y + NODE_H > o.minY;
      expect(hit).toBe(false);
    }
  });
});
