import { describe, it, expect } from "vitest";
import {
  labelCandidates,
  nodeBlockedIntervals,
  inflateIntervals,
  crossingBlockedIntervals,
} from "../graph/layout/labelIntervals";
import type { NodeRect, Segment } from "../graph/edgePath";
import type { Size } from "../graph/layout/labelBox";
import type { EdgePoint } from "../../types";

// Допустимые интервалы плашки (A5, R2-узлы + R4): путь минус совпавшие плечи и зоны под
// узлами (узел раздут на пол-плашки). Чистая интервальная геометрия.

const poly = (...pairs: [number, number][]): EdgePoint[] =>
  pairs.map(([x, y]) => ({ x, y }));
const box: Size = { w: 20, h: 16 };

describe("labelCandidates — вычитание узлов (R2)", () => {
  it("чистый путь без узлов и совпадений → весь путь", () => {
    const path = poly([0, 0], [300, 0]);
    expect(labelCandidates(path, [], [], box)).toEqual([{ s: 0, e: 300 }]);
  });

  it("узел на пути → зона под ним вырезана с учётом габаритов плашки", () => {
    const path = poly([0, 0], [300, 0]);
    // узел x∈[130,170], y∈[-30,30]; раздут на пол-плашки (10,8) → x∈[120,180]
    const node: NodeRect = { x: 130, y: -30, w: 40, h: 60 };
    expect(labelCandidates(path, [], [node], box)).toEqual([
      { s: 0, e: 120 },
      { s: 180, e: 300 },
    ]);
  });

  it("узел в стороне от пути → не вырезает ничего", () => {
    const path = poly([0, 0], [300, 0]);
    const node: NodeRect = { x: 130, y: 200, w: 40, h: 60 }; // далеко по y
    expect(labelCandidates(path, [], [node], box)).toEqual([{ s: 0, e: 300 }]);
  });

  it("вертикальный путь, узел сбоку на нём → вырез по y", () => {
    const path = poly([0, 0], [0, 300]);
    const node: NodeRect = { x: -30, y: 130, w: 60, h: 40 }; // x∈[-30,30] накрывает x=0
    expect(labelCandidates(path, [], [node], box)).toEqual([
      { s: 0, e: 122 },   // 130 - 8
      { s: 178, e: 300 }, // 170 + 8
    ]);
  });
});

describe("labelCandidates — совпавшие плечи (R4)", () => {
  it("вычитает и совпавшее плечо (раздутое на пол-плашки), и узел", () => {
    const path = poly([0, 0], [300, 0]);
    const node: NodeRect = { x: 130, y: -30, w: 40, h: 60 }; // → блок [120,180]
    const shared = [{ s: 0, e: 50 }];                         // общее плечо в начале
    // плечо раздуто на w/2=10 → [.,60]: центр плашки в 60 — её край ровно у конца плеча
    expect(labelCandidates(path, shared, [node], box)).toEqual([
      { s: 60, e: 120 },
      { s: 180, e: 300 },
    ]);
  });

  it("плашку поставить негде → пустой список (дальше — лестница запасов placeLabels)", () => {
    const path = poly([0, 0], [100, 0]);
    const shared = [{ s: 0, e: 100 }]; // всё ребро — общее плечо
    expect(labelCandidates(path, shared, [], box)).toEqual([]);
  });
});

describe("nodeBlockedIntervals", () => {
  it("два узла на пути → два слитых блока", () => {
    const path = poly([0, 0], [400, 0]);
    const n1: NodeRect = { x: 50, y: -20, w: 40, h: 40 };   // → [40,100]
    const n2: NodeRect = { x: 250, y: -20, w: 40, h: 40 };  // → [240,300]
    expect(nodeBlockedIntervals(path, [n1, n2], box)).toEqual([
      { s: 40, e: 100 },
      { s: 240, e: 300 },
    ]);
  });
});

describe("inflateIntervals", () => {
  it("раздувает каждый интервал на margin с обоих концов", () => {
    const r = inflateIntervals([{ s: 0, e: 100 }, { s: 200, e: 210 }], 10);
    expect(r).toEqual([{ s: -10, e: 110 }, { s: 190, e: 220 }]);
  });
});

// Ф3: кресты чужих линий — запретные зоны для плашки (центр ± пол-протяжённости плашки
// вдоль сегмента ± запас 4): перпендикулярный крест режет, касание концом и параллель — нет.
describe("crossingBlockedIntervals — кресты чужих линий (Ф3)", () => {
  const seg = (x1: number, y1: number, x2: number, y2: number): Segment => ({
    index: 0, x1, y1, x2, y2, orient: Math.abs(y1 - y2) <= Math.abs(x1 - x2) ? "h" : "v",
  });
  const path = poly([0, 0], [300, 0]);

  it("вертикальная чужая линия сквозь горизонтальный путь → зона ширины плашки с запасом", () => {
    expect(crossingBlockedIntervals(path, [seg(100, -50, 100, 50)], box)).toEqual([{ s: 86, e: 114 }]); // 100 ± (10 + 4)
  });

  it("на вертикальном пути зона — по высоте плашки", () => {
    const v = poly([0, 0], [0, 300]);
    expect(crossingBlockedIntervals(v, [seg(-50, 100, 50, 100)], box)).toEqual([{ s: 88, e: 112 }]); // 100 ± (8 + 4)
  });

  it("параллельная линия, линия мимо и касание концом — не крест", () => {
    expect(crossingBlockedIntervals(path, [seg(0, 0, 300, 0)], box)).toEqual([]);        // параллель
    expect(crossingBlockedIntervals(path, [seg(100, 10, 100, 50)], box)).toEqual([]);     // не доходит до y=0
    expect(crossingBlockedIntervals(path, [seg(0, -50, 0, 50)], box)).toEqual([]);        // через конец пути
  });

  it("два близких креста сливаются в одну зону", () => {
    expect(crossingBlockedIntervals(path, [seg(100, -50, 100, 50), seg(120, -50, 120, 50)], box))
      .toEqual([{ s: 86, e: 134 }]);
  });
});
