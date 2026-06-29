import { describe, it, expect } from "vitest";
import {
  coincidentLegs,
  mergeIntervals,
  subtractIntervals,
  edgeArcLength,
  type Interval,
} from "../graph/layout/coincidentLegs";
import type { EdgePoint } from "../../types";

// Детект совпавших плеч (A4, R4): участки, где разные стрелки идут по одной линии,
// в координатах arc-length каждой. Плюс интервальная алгебра (merge/subtract) для A5.

const poly = (...pairs: [number, number][]): EdgePoint[] =>
  pairs.map(([x, y]) => ({ x, y }));

describe("coincidentLegs — совпадение плеч", () => {
  it("две стрелки из общего узла, общий горизонтальный участок", () => {
    // A и B выходят из (0,0) по y=0, расходятся на x=80 и x=100
    const A = poly([0, 0], [100, 0], [100, 50]);
    const B = poly([0, 0], [80, 0], [80, -50]);
    const shared = coincidentLegs(new Map([["A", A], ["B", B]]));
    expect(shared.get("A")).toEqual([{ s: 0, e: 80 }]);
    expect(shared.get("B")).toEqual([{ s: 0, e: 80 }]);
  });

  it("перпендикулярное пересечение (крестик) → НЕ совпадение", () => {
    const A = poly([0, 0], [100, 0]);       // горизонталь y=0
    const B = poly([50, -50], [50, 50]);    // вертикаль x=50
    const shared = coincidentLegs(new Map([["A", A], ["B", B]]));
    expect(shared.get("A")).toEqual([]);
    expect(shared.get("B")).toEqual([]);
  });

  it("параллельные на РАЗНЫХ линиях → не совпадают", () => {
    const A = poly([0, 0], [100, 0]);
    const B = poly([0, 10], [100, 10]);
    const shared = coincidentLegs(new Map([["A", A], ["B", B]]));
    expect(shared.get("A")).toEqual([]);
    expect(shared.get("B")).toEqual([]);
  });

  it("совпавший участок не в начале второго ребра → arc-смещение учтено", () => {
    const A = poly([0, 0], [100, 0]);                 // y=0, arc 0..100
    const B = poly([50, -30], [50, 0], [150, 0]);     // вертикаль arc 0..30, затем y=0 arc 30..130
    const shared = coincidentLegs(new Map([["A", A], ["B", B]]));
    // перекрытие по x∈[50,100]: на A arc [50,100]; на B горизонталь arc0=30, a=50 → [30,80]
    expect(shared.get("A")).toEqual([{ s: 50, e: 100 }]);
    expect(shared.get("B")).toEqual([{ s: 30, e: 80 }]);
  });

  it("касание концами (нулевое перекрытие) → не совпадение", () => {
    const A = poly([0, 0], [50, 0]);
    const B = poly([50, 0], [100, 0]);
    const shared = coincidentLegs(new Map([["A", A], ["B", B]]));
    expect(shared.get("A")).toEqual([]);
    expect(shared.get("B")).toEqual([]);
  });

  it("три стрелки на одной линии → объединение перекрытий", () => {
    const A = poly([0, 0], [100, 0]);
    const B = poly([0, 0], [60, 0], [60, 40]);   // совпадает с A на [0,60]
    const C = poly([40, 0], [120, 0]);            // совпадает с A на [40,100]
    const shared = coincidentLegs(new Map([["A", A], ["B", B], ["C", C]]));
    // на A: [0,60] ∪ [40,100] = [0,100]
    expect(shared.get("A")).toEqual([{ s: 0, e: 100 }]);
  });
});

describe("mergeIntervals", () => {
  it("сливает перекрывающиеся", () => {
    const r = mergeIntervals([{ s: 0, e: 80 }, { s: 50, e: 100 }]);
    expect(r).toEqual([{ s: 0, e: 100 }]);
  });
  it("сливает смежные (зазор ≤ eps)", () => {
    const r = mergeIntervals([{ s: 0, e: 50 }, { s: 50, e: 90 }]);
    expect(r).toEqual([{ s: 0, e: 90 }]);
  });
  it("оставляет раздельные", () => {
    const r = mergeIntervals([{ s: 0, e: 30 }, { s: 60, e: 90 }]);
    expect(r).toEqual([{ s: 0, e: 30 }, { s: 60, e: 90 }]);
  });
  it("пустой вход → пустой выход", () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe("subtractIntervals — дополнение (уникальные участки)", () => {
  const whole: Interval = { s: 0, e: 100 };
  it("дыра в начале → остаток в конце", () => {
    expect(subtractIntervals(whole, [{ s: 0, e: 80 }])).toEqual([{ s: 80, e: 100 }]);
  });
  it("дыра в середине → два остатка", () => {
    expect(subtractIntervals(whole, [{ s: 30, e: 80 }])).toEqual([
      { s: 0, e: 30 },
      { s: 80, e: 100 },
    ]);
  });
  it("нет дыр → весь интервал", () => {
    expect(subtractIntervals(whole, [])).toEqual([{ s: 0, e: 100 }]);
  });
  it("дыра целиком покрывает → пусто", () => {
    expect(subtractIntervals(whole, [{ s: -10, e: 110 }])).toEqual([]);
  });
});

describe("edgeArcLength", () => {
  it("ортогональная ломаная — манхэттенова длина", () => {
    expect(edgeArcLength(poly([0, 0], [100, 0], [100, 50]))).toBe(150);
  });
});
