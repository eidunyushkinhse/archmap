import { describe, it, expect } from "vitest";
import {
  rectFromCenter,
  rectsOverlap,
  countLabelOverlaps,
  countLabelsUnderNodes,
  countEdgeCrossings,
  measureArrows,
} from "../graph/layout/arrowMetrics";
import type { NodeRect } from "../graph/edgePath";
import type { EdgePoint } from "../../types";

// Метрики качества стрелок (A0): наложения плашек (R2), плашки под узлами (R2),
// пересечения стрелок (R3). Чистая геометрия над финальной раскладкой.

const rect = (x: number, y: number, w: number, h: number): NodeRect => ({ x, y, w, h });

describe("rectFromCenter / rectsOverlap", () => {
  it("прямоугольник строится вокруг центра", () => {
    expect(rectFromCenter(50, 50, 20, 10)).toEqual({ x: 40, y: 45, w: 20, h: 10 });
  });

  it("реальное наложение → true, касание границей → false", () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(true);
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(false); // впритык
  });
});

describe("countLabelOverlaps", () => {
  it("разнесённые плашки → 0", () => {
    expect(countLabelOverlaps([rect(0, 0, 10, 10), rect(100, 100, 10, 10)])).toBe(0);
  });

  it("две наложенные → 1 пара; три попарно наложенные → 3 пары", () => {
    expect(countLabelOverlaps([rect(0, 0, 10, 10), rect(5, 5, 10, 10)])).toBe(1);
    expect(
      countLabelOverlaps([rect(0, 0, 10, 10), rect(4, 4, 10, 10), rect(8, 8, 10, 10)]),
    ).toBe(3);
  });
});

describe("countLabelsUnderNodes", () => {
  it("плашка на узле → считается; рядом → нет", () => {
    const nodes = [rect(0, 0, 190, 100)];
    expect(countLabelsUnderNodes([rect(50, 50, 30, 20)], nodes)).toBe(1);
    expect(countLabelsUnderNodes([rect(300, 300, 30, 20)], nodes)).toBe(0);
  });

  it("одна плашка над двумя узлами считается один раз", () => {
    const nodes = [rect(0, 0, 100, 100), rect(90, 0, 100, 100)];
    expect(countLabelsUnderNodes([rect(80, 40, 40, 20)], nodes)).toBe(1);
  });
});

describe("countEdgeCrossings", () => {
  const H: EdgePoint[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const V: EdgePoint[] = [{ x: 50, y: -50 }, { x: 50, y: 50 }];

  it("перпендикулярный крест → 1 пересечение", () => {
    expect(countEdgeCrossings(new Map([["h", H], ["v", V]]))).toBe(1);
  });

  it("коллинеарный совместный ход (R4) пересечением не считается", () => {
    const H2: EdgePoint[] = [{ x: 50, y: 0 }, { x: 150, y: 0 }];
    expect(countEdgeCrossings(new Map([["h", H], ["h2", H2]]))).toBe(0);
  });

  it("непересекающиеся → 0", () => {
    const far: EdgePoint[] = [{ x: 0, y: 500 }, { x: 100, y: 500 }];
    expect(countEdgeCrossings(new Map([["h", H], ["far", far]]))).toBe(0);
  });
});

describe("measureArrows", () => {
  it("сводит все три метрики", () => {
    const m = measureArrows({
      nodes: [rect(0, 0, 190, 100)],
      labels: [rect(50, 50, 30, 20), rect(55, 55, 30, 20)], // обе на узле и наложены
      edges: new Map([
        ["h", [{ x: 0, y: 0 }, { x: 100, y: 0 }]],
        ["v", [{ x: 50, y: -50 }, { x: 50, y: 50 }]],
      ]),
    });
    expect(m).toEqual({ labelOverlaps: 1, labelsUnderNodes: 2, edgeCrossings: 1 });
  });
});
