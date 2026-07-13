import { describe, it, expect } from "vitest";
import { placeLabels, type LabelInput, type Placement } from "../graph/layout/placeLabels";
import { rectFromCenter, rectsOverlap, countLabelOverlaps, countLabelsUnderNodes } from "../graph/layout/arrowMetrics";
import type { NodeRect, Segment } from "../graph/edgePath";
import type { EdgePoint } from "../../types";

// сегмент-плечо стрелки для edgeSegs (препятствие выноске)
const seg = (x1: number, y1: number, x2: number, y2: number): Segment => ({
  index: 0, x1, y1, x2, y2, orient: Math.abs(y1 - y2) <= Math.abs(x1 - x2) ? "h" : "v",
});

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
    // Путь: ствол [0,150] слит с соседом (shared), уникальный хвост [150,200]. Плашке на
    // линии места нет (candidates пуст — так labelCandidates отдаёт короткий хвост,
    // упирающийся в узел). Желаемая доля — середина (arc 100), она НА слитом стволе:
    // якорь выноски обязан уехать в уникальный хвост [150,200].
    const labels: LabelInput[] = [
      {
        id: "A", path: poly([0, 0], [200, 0]),
        candidates: [],             // инлайн-мест нет → выноска
        shared: [{ s: 0, e: 150 }], // ствол слит — якорю туда нельзя
        box: box(60, 16),
      },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("leader");
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

describe("placeLabels — качество выноски (A15)", () => {
  it("плашка-выноска не садится на ЧУЖОЕ плечо стрелки", () => {
    // A: горизонтальное ребро, плашке на линии места нет (candidates []) → выноска у якоря (100,0).
    // B: вертикальное плечо ровно через x=100 (вся высота) — выноска A не должна на него лечь.
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const edgeSegs = new Map<string, Segment[]>([
      ["A", [seg(0, 0, 200, 0)]],
      ["B", [seg(100, -200, 100, 200)]], // плечо соседа поперёк якоря
    ]);
    const [p] = placeLabels(labels, [], edgeSegs);
    expect(p.mode).toBe("leader");
    const boxRect = rectFromCenter(p.center.x, p.center.y, p.box.w, p.box.h);
    const bLeg: NodeRect = { x: 96, y: -200, w: 8, h: 400 }; // плечо B с запасом
    expect(rectsOverlap(boxRect, bLeg)).toBe(false); // плашка ушла с плеча соседа
  });

  it("якорь — в центре самого ДЛИННОГО уникального плеча (не ближайшего к середине)", () => {
    // shared [60,100]; уникальные [0,60] (60px) и [100,200] (100px). Якорь → центр длинного = 150.
    const labels: LabelInput[] = [
      {
        id: "A", path: poly([0, 0], [200, 0]),
        candidates: [], shared: [{ s: 60, e: 100 }], box: box(60, 16),
      },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("leader");
    expect(p.anchor.x).toBeCloseTo(150, 0);
  });

  it("конец поводка обрезан до края плашки (не прячется под ней)", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("leader");
    // leaderEnd лежит на отрезке anchor→center, но НЕ в центре (иначе пунктир под плашкой)
    const dAnchorEnd = Math.hypot(p.leaderEnd.x - p.anchor.x, p.leaderEnd.y - p.anchor.y);
    const dAnchorCenter = Math.hypot(p.center.x - p.anchor.x, p.center.y - p.anchor.y);
    expect(dAnchorEnd).toBeLessThan(dAnchorCenter);          // конец ближе к якорю, чем центр
    expect(dAnchorEnd).toBeGreaterThan(0);                   // поводок не нулевой
    // и leaderEnd на границе бокса: |center - leaderEnd| ≈ пол-высоты (вынос по нормали к линии)
    const dEndCenter = Math.hypot(p.center.x - p.leaderEnd.x, p.center.y - p.leaderEnd.y);
    expect(dEndCenter).toBeCloseTo(p.box.h / 2, 0);
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
