import { describe, it, expect } from "vitest";
import { generateOverlapConstraints, type Rect } from "../graph/layout/overlapConstraints";
import { solveSeparation } from "../graph/layout/vpsc";

const rect = (minX: number, minY: number, w: number, h: number): Rect => ({
  minX, minY, maxX: minX + w, maxY: minY + h,
});

describe("generateOverlapConstraints (геометрия → separation)", () => {
  it("непересекающиеся прямоугольники — без ограничений", () => {
    const rects = [rect(0, 0, 100, 100), rect(200, 200, 100, 100)];
    const c = generateOverlapConstraints(rects, 0);
    expect(c.x).toEqual([]);
    expect(c.y).toEqual([]);
  });

  it("касание/чуть-чуть по одной оси не считается наложением", () => {
    const rects = [rect(0, 0, 100, 100), rect(100, 0, 100, 100)]; // встык по X (penX=0)
    const c = generateOverlapConstraints(rects, 0);
    expect(c.x).toEqual([]);
    expect(c.y).toEqual([]);
  });

  it("малое перекрытие по X (большое по Y) — разводим по X (мин. ось)", () => {
    const rects = [rect(0, 0, 100, 100), rect(90, 0, 100, 100)]; // penX=10, penY=100
    const c = generateOverlapConstraints(rects, 0);
    expect(c.y).toEqual([]);
    expect(c.x).toEqual([{ left: 0, right: 1, gap: 100 }]); // (100/2 + 100/2 + 0)
  });

  it("малое перекрытие по Y (большое по X) — разводим по Y", () => {
    const rects = [rect(0, 0, 100, 100), rect(0, 90, 100, 100)]; // penX=100, penY=10
    const c = generateOverlapConstraints(rects, 0);
    expect(c.x).toEqual([]);
    expect(c.y).toEqual([{ left: 0, right: 1, gap: 100 }]);
  });

  it("сторона ограничения — по центрам (меньший центр = left), порядок сохраняется", () => {
    // b левее a по X, налегают слабо по X
    const rects = [rect(90, 0, 100, 100), rect(0, 0, 100, 100)]; // a=idx0 правее
    const c = generateOverlapConstraints(rects, 0);
    expect(c.x).toEqual([{ left: 1, right: 0, gap: 100 }]); // idx1 (центр 50) < idx0 (центр 140)
  });

  it("pad добавляется к гэпу", () => {
    const rects = [rect(0, 0, 100, 100), rect(90, 0, 100, 100)];
    const c = generateOverlapConstraints(rects, 12);
    expect(c.x[0].gap).toBe(112);
  });

  it("связка генерация+солвер: наложение уходит, прямоугольники расходятся", () => {
    const rects = [rect(0, 0, 100, 100), rect(90, 0, 100, 100)]; // налегают по X на 10
    const c = generateOverlapConstraints(rects, 0);
    const cx = solveSeparation(rects.map((r) => (r.minX + r.maxX) / 2), [1, 1], c.x);
    // после развода центры по X отстоят ≥ 100 → края не пересекаются
    expect(Math.abs(cx[1] - cx[0])).toBeGreaterThanOrEqual(100 - 1e-6);
  });

  it("АБВ: И и З налегают, мин. ось = Y → разводим по Y, владеемый тяжелее → двигается И", () => {
    // И=(89,310) З=(123,318), NODE_W=190 NODE_H=100
    const И = rect(89, 310, 190, 100);
    const З = rect(123, 318, 190, 100);
    const c = generateOverlapConstraints([И, З], 0);
    expect(c.x).toEqual([]);
    expect(c.y).toEqual([{ left: 0, right: 1, gap: 100 }]); // И(центр 360) < З(368)
    const cy = solveSeparation([360, 368], [1, 1000], c.y); // З тяжёлый (владеемый)
    expect(cy[1]).toBeCloseTo(368, 0); // З почти на месте
    expect(cy[1] - cy[0]).toBeGreaterThanOrEqual(100 - 1e-6); // развели на высоту узла
  });
});
