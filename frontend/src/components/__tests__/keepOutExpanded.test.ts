import { describe, it, expect } from "vitest";
import { keepOutOfExpandedFrames } from "../graph/layout/keepGhostsOut";
import type { FrameRect } from "../graph/layout/frames";
import { NODE_W, NODE_H } from "../graph/constants";

// Инвариант раскрытых рамок (R5-фикс): узел, НЕ относящийся к раскрытой рамке,
// не лежит внутри неё. Рамка пиннится (раскрылась на своём месте) — уступают чужие.

const frame = (
  id: string, members: string[], rect: { x: number; y: number; w: number; h: number },
  depth = 0,
): FrameRect => ({
  id, name: id, depth, native: false, memberIds: new Set(members),
  content: { minX: rect.x + 25, minY: rect.y + 25, maxX: rect.x + rect.w - 25, maxY: rect.y + rect.h - 25 },
  rect,
});

const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) =>
  p.x < r.x + r.w && p.x + NODE_W > r.x && p.y < r.y + r.h && p.y + NODE_H > r.y;

describe("keepOutOfExpandedFrames", () => {
  it("не-член внутри рамки выталкивается MTV, член остаётся", () => {
    const f = frame("F", ["m"], { x: 0, y: 0, w: 400, h: 300 });
    const positions = new Map([
      ["m", { x: 100, y: 100 }],   // член — держит рамку
      ["x", { x: 150, y: 120 }],   // чужак внутри
      ["far", { x: 900, y: 900 }], // чужак снаружи — не трогается
    ]);
    const moved = keepOutOfExpandedFrames({
      displayedIds: ["m", "x", "far"], frames: [f], positions,
    });
    expect(moved.has("x")).toBe(true);
    expect(moved.has("m")).toBe(false);
    expect(moved.has("far")).toBe(false);
    expect(inside(positions.get("x")!, f.rect)).toBe(false);
    expect(positions.get("m")).toEqual({ x: 100, y: 100 });
    expect(positions.get("far")).toEqual({ x: 900, y: 900 });
  });

  it("чужая рамка внутри рамки выталкивается ЦЕЛИКОМ (жёсткой группой)", () => {
    const big = frame("BIG", ["b1", "b2"], { x: 0, y: 0, w: 600, h: 400 });
    const small = frame("SMALL", ["s1", "s2"], { x: 50, y: 50, w: 260, h: 160 }, 1);
    const positions = new Map([
      ["b1", { x: 380, y: 80 }], ["b2", { x: 380, y: 280 }],
      ["s1", { x: 75, y: 75 }], ["s2", { x: 130, y: 105 }],
    ]);
    const rel = { x: positions.get("s2")!.x - positions.get("s1")!.x, y: positions.get("s2")!.y - positions.get("s1")!.y };
    const moved = keepOutOfExpandedFrames({
      displayedIds: ["b1", "b2", "s1", "s2"], frames: [big, small], positions,
    });
    expect(moved.has("s1")).toBe(true);
    expect(moved.has("s2")).toBe(true);
    // группа жёсткая: взаимное расположение членов сохранено
    expect(positions.get("s2")!.x - positions.get("s1")!.x).toBeCloseTo(rel.x);
    expect(positions.get("s2")!.y - positions.get("s1")!.y).toBeCloseTo(rel.y);
    // rect выехавшей рамки больше не пересекает большую
    const r = small.rect;
    const overlaps = r.x < big.rect.x + big.rect.w && r.x + r.w > big.rect.x
      && r.y < big.rect.y + big.rect.h && r.y + r.h > big.rect.y;
    expect(overlaps).toBe(false);
  });

  it("вложенная рамка в СВОЕЙ объемлющей не трогается", () => {
    const outer = frame("OUT", ["a", "b"], { x: 0, y: 0, w: 600, h: 400 });
    const inner = frame("IN", ["a"], { x: 50, y: 50, w: 230, h: 150 }, 1); // members ⊆ outer
    const positions = new Map([["a", { x: 75, y: 75 }], ["b", { x: 380, y: 200 }]]);
    const moved = keepOutOfExpandedFrames({
      displayedIds: ["a", "b"], frames: [outer, inner], positions,
    });
    expect(moved.size).toBe(0);
  });
});
