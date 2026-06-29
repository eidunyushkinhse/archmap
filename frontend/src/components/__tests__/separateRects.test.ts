import { describe, it, expect } from "vitest";
import { separateRects } from "../graph/layout/separateRects";
import type { Rect } from "../graph/layout/overlapConstraints";

const rect = (minX: number, minY: number, w: number, h: number): Rect => ({
  minX, minY, maxX: minX + w, maxY: minY + h,
});
const EPS = 1e-6;
const overlap = (a: Rect, b: Rect): boolean =>
  a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS;
const anyOverlap = (rs: Rect[]): boolean =>
  rs.some((a, i) => rs.some((b, j) => j > i && overlap(a, b)));
const sameSize = (a: Rect, b: Rect): boolean =>
  Math.abs((a.maxX - a.minX) - (b.maxX - b.minX)) < EPS &&
  Math.abs((a.maxY - a.minY) - (b.maxY - b.minY)) < EPS;

describe("separateRects (плоское взвешенное разведение)", () => {
  it("без наложений — прямоугольники не сдвинуты", () => {
    const rects = [rect(0, 0, 100, 100), rect(200, 0, 100, 100)];
    const out = separateRects(rects, [1, 1], 0);
    expect(out).toEqual(rects);
  });

  it("размеры прямоугольников не меняются (только трансляция)", () => {
    const rects = [rect(0, 0, 190, 100), rect(20, 20, 190, 100)];
    const out = separateRects(rects, [1, 1], 0);
    out.forEach((r, i) => expect(sameSize(r, rects[i])).toBe(true));
  });

  it("две налегающие — наложение уходит", () => {
    const rects = [rect(0, 0, 100, 100), rect(90, 10, 100, 100)];
    const out = separateRects(rects, [1, 1], 0);
    expect(anyOverlap(out)).toBe(false);
  });

  it("равные веса — симметричное разведение вокруг центра масс", () => {
    const rects = [rect(0, 0, 100, 100), rect(90, 0, 100, 100)]; // мин. ось X, центры 50 и 140
    const out = separateRects(rects, [1, 1], 0);
    // центр масс по X = (50+140)/2 = 95 сохраняется
    const cx = out.map((r) => (r.minX + r.maxX) / 2);
    expect((cx[0] + cx[1]) / 2).toBeCloseTo(95, 6);
    expect(anyOverlap(out)).toBe(false);
  });

  it("веса: тяжёлый почти не двигается, лёгкий уезжает", () => {
    const rects = [rect(0, 0, 100, 100), rect(90, 0, 100, 100)];
    const out = separateRects(rects, [1000, 1], 0);
    expect((out[0].minX + out[0].maxX) / 2).toBeCloseTo(50, 0); // тяжёлый на месте
    expect(anyOverlap(out)).toBe(false);
  });

  it("кластер из трёх в одной точке — все разведены", () => {
    const rects = [rect(0, 0, 100, 100), rect(5, 5, 100, 100), rect(-5, 3, 100, 100)];
    const out = separateRects(rects, [1, 1, 1], 0);
    expect(anyOverlap(out)).toBe(false);
    out.forEach((r, i) => expect(sameSize(r, rects[i])).toBe(true));
  });

  it("pad выдерживается как зазор между сторонами", () => {
    const rects = [rect(0, 0, 100, 100), rect(90, 0, 100, 100)];
    const out = separateRects(rects, [1, 1], 20);
    // разведены по X с зазором ≥ 20 между ближними краями
    const gap = Math.min(out[0].maxX, out[1].maxX) === out[0].maxX
      ? out[1].minX - out[0].maxX
      : out[0].minX - out[1].maxX;
    expect(gap).toBeGreaterThanOrEqual(20 - 1e-6);
  });

  it("АБВ: И налезает на владеемый З (тяжёлый) → И сдвигается, наложение уходит", () => {
    const И = rect(89, 310, 190, 100); // новичок (лёгкий)
    const З = rect(123, 318, 190, 100); // владеемый (тяжёлый)
    const out = separateRects([И, З], [1, 1000], 0);
    expect(anyOverlap(out)).toBe(false);
    expect((out[1].minX + out[1].maxX) / 2).toBeCloseTo(218, 0); // центр X З на месте
    expect((out[1].minY + out[1].maxY) / 2).toBeCloseTo(368, 0); // центр Y З на месте
  });
});
