import { describe, it, expect } from "vitest";
import { placeLabels, type LabelInput, type Placement } from "../graph/layout/placeLabels";
import { rectFromCenter, countLabelOverlaps, countLabelsUnderNodes } from "../graph/layout/arrowMetrics";
import type { NodeRect } from "../graph/edgePath";
import type { EdgePoint } from "../../types";

// Размещение плашек (A6, R2): online без взаимных наложений, иначе leader. Проверяем
// инварианты через метрики A0 (countLabelOverlaps / countLabelsUnderNodes), не точные коорд.

const poly = (...pairs: [number, number][]): EdgePoint[] =>
  pairs.map(([x, y]) => ({ x, y }));
const box = (w: number, h: number) => ({ w, h });
const rects = (ps: Placement[]): NodeRect[] =>
  ps.map((p) => rectFromCenter(p.center.x, p.center.y, p.box.w, p.box.h));

describe("placeLabels — одиночная плашка", () => {
  it("чистый путь → online у желаемой доли (середина)", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("online");
    expect(p.center.y).toBe(0);
    expect(p.center.x).toBeCloseTo(100, 0); // середина (preferredT=0.5)
  });
});

describe("placeLabels — развод наложений (R2)", () => {
  it("две плашки сталкивались бы посередине → разъезжаются, 0 наложений", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16) },
      { id: "B", path: poly([0, 10], [200, 10]), candidates: [{ s: 0, e: 200 }], box: box(60, 16) },
    ];
    const ps = placeLabels(labels);
    expect(countLabelOverlaps(rects(ps))).toBe(0);
    expect(ps.every((p) => p.mode === "online")).toBe(true); // места хватает, выноски не нужны
  });

  it("много плашек на близких параллельных линиях → 0 наложений", () => {
    const labels: LabelInput[] = Array.from({ length: 5 }, (_, i) => ({
      id: `E${i}`,
      path: poly([0, i * 8], [300, i * 8]),
      candidates: [{ s: 0, e: 300 }],
      box: box(80, 16),
    }));
    const ps = placeLabels(labels);
    expect(countLabelOverlaps(rects(ps))).toBe(0);
  });
});

describe("placeLabels — выноска (leader)", () => {
  it("ребро без допустимых интервалов (всё совпавшее плечо) → leader", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("leader");
  });

  it("leader не садится под узел (R2): итог без плашек под узлами", () => {
    const node: NodeRect = { x: -40, y: -20, w: 80, h: 40 }; // у якоря (0,0..200,0) середина (100,0) свободна
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const ps = placeLabels(labels, [node]);
    expect(countLabelsUnderNodes(rects(ps), [node])).toBe(0);
  });

  it("якорь выноски НЕ садится на слитое плечо, уезжает в уникальную зону (A14)", () => {
    // Путь: ствол [0,150] слит с соседом (shared), уникальный хвост [150,200]. Желаемая доля —
    // середина (arc 100), она НА слитом стволе. Якорь обязан уехать в [150,200].
    const labels: LabelInput[] = [
      {
        id: "A", path: poly([0, 0], [200, 0]),
        candidates: [{ s: 150, e: 200 }], // плашке доступен только хвост
        shared: [{ s: 0, e: 150 }],        // ствол слит — якорю туда нельзя
        box: box(60, 16),
      },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("leader");          // на хвост 50px плашка 60px не влезет → выноска
    expect(p.anchor.x).toBeGreaterThan(150); // якорь в уникальном хвосте, не на стволе
    expect(p.anchor.x).toBeLessThanOrEqual(200);
  });

  it("без shared якорь остаётся у желаемой доли (обратная совместимость)", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("leader");
    expect(p.anchor.x).toBeCloseTo(100, 0); // середина, как раньше
  });
});

describe("placeLabels — детерминизм", () => {
  it("один и тот же вход → один и тот же результат", () => {
    const make = (): LabelInput[] => [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16) },
      { id: "B", path: poly([0, 10], [200, 10]), candidates: [{ s: 0, e: 200 }], box: box(60, 16) },
    ];
    expect(placeLabels(make())).toEqual(placeLabels(make()));
  });
});
