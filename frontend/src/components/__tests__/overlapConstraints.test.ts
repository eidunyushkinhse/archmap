import { describe, it, expect } from "vitest";
import {
  generateAxisConstraints, countOverlaps, penetration, type Rect,
} from "../graph/layout/overlapConstraints";
import { solveSeparation } from "../graph/layout/vpsc";

const rect = (minX: number, minY: number, w: number, h: number): Rect => ({
  minX, minY, maxX: minX + w, maxY: minY + h,
});

describe("generateAxisConstraints / countOverlaps (геометрия → separation)", () => {
  it("непересекающиеся — ноль ограничений и наложений", () => {
    const rects = [rect(0, 0, 100, 100), rect(200, 200, 100, 100)];
    expect(generateAxisConstraints(rects, "x", 0)).toEqual([]);
    expect(generateAxisConstraints(rects, "y", 0)).toEqual([]);
    expect(countOverlaps(rects)).toBe(0);
  });

  it("касание встык по оси не считается наложением", () => {
    const rects = [rect(0, 0, 100, 100), rect(100, 0, 100, 100)]; // penX=0
    expect(countOverlaps(rects)).toBe(0);
    expect(generateAxisConstraints(rects, "x", 0)).toEqual([]);
  });

  it("penetration считает глубину перекрытия по осям", () => {
    const p = penetration(rect(0, 0, 100, 100), rect(90, 10, 100, 100));
    expect(p.x).toBe(10);
    expect(p.y).toBe(90);
  });

  it("ограничение по X: гэп = полусумма ширин + pad, сторона по центрам", () => {
    const rects = [rect(90, 0, 100, 100), rect(0, 0, 100, 100)]; // idx1 левее
    const cx = generateAxisConstraints(rects, "x", 12);
    expect(cx).toEqual([{ left: 1, right: 0, gap: 112 }]); // (100/2+100/2+12), idx1<idx0 по центру
  });

  it("ограничение по Y: гэп = полусумма высот + pad", () => {
    const rects = [rect(0, 0, 100, 100), rect(0, 90, 100, 100)];
    const cy = generateAxisConstraints(rects, "y", 0);
    expect(cy).toEqual([{ left: 0, right: 1, gap: 100 }]);
  });

  it("связка генерация+солвер по оси: наложение по этой оси уходит", () => {
    const rects = [rect(0, 0, 100, 100), rect(90, 0, 100, 100)];
    const cx = generateAxisConstraints(rects, "x", 0);
    const sx = solveSeparation(rects.map((r) => (r.minX + r.maxX) / 2), [1, 1], cx);
    expect(Math.abs(sx[1] - sx[0])).toBeGreaterThanOrEqual(100 - 1e-6);
  });

  it("АБВ: И и З налегают; по Y гэп = высота узла, владеемый тяжелее → двигается И", () => {
    const И = rect(89, 310, 190, 100);
    const З = rect(123, 318, 190, 100);
    expect(countOverlaps([И, З])).toBe(1);
    const cy = generateAxisConstraints([И, З], "y", 0);
    expect(cy).toEqual([{ left: 0, right: 1, gap: 100 }]); // И(центр 360) < З(368)
    const sy = solveSeparation([360, 368], [1, Infinity], cy); // З прибит
    expect(sy[1]).toBe(368);
    expect(sy[1] - sy[0]).toBeGreaterThanOrEqual(100 - 1e-6);
  });
});
