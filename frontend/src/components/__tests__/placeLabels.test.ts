import { describe, it, expect } from "vitest";
import { placeLabels, type LabelInput, type Placement } from "../graph/layout/placeLabels";
import { rectFromCenter, rectsOverlap, countLabelOverlaps, countLabelsUnderNodes, segCrossesRect } from "../graph/layout/arrowMetrics";
import type { NodeRect, Segment } from "../graph/edgePath";
import type { EdgePoint } from "../../types";

// сегмент-плечо стрелки для edgeSegs (препятствие выноске)
const seg = (x1: number, y1: number, x2: number, y2: number): Segment => ({
  index: 0, x1, y1, x2, y2, orient: Math.abs(y1 - y2) <= Math.abs(x1 - x2) ? "h" : "v",
});

// Размещение плашек (A6, R2): online без взаимных наложений; с Ф3 — только online (выносок
// нет). Проверяем инварианты через метрики A0 (countLabelOverlaps / countLabelsUnderNodes),
// не точные координаты.

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

// Ф3 эпика «стрелки без жёстких хэндлов»: выносок и поводков нет — плашка ВСЕГДА на своей
// линии (E50/E51). Пустые кандидаты не уводят плашку с линии, а спускают её по лестнице
// запасов: чистые интервалы → без вычета крестов (loose) → уникальные участки (минус
// слитые плечи) → середина пути.
describe("placeLabels — пустые кандидаты: плашка остаётся на линии (Ф3)", () => {
  it("ребро без допустимых интервалов → всё равно online, центр на линии", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("online");
    expect(p.center.y).toBe(0);
    expect(p.center.x).toBeGreaterThanOrEqual(0);
    expect(p.center.x).toBeLessThanOrEqual(200);
    expect(p.anchor).toEqual(p.center);     // якорь и конец поводка — та же точка
    expect(p.leaderEnd).toEqual(p.center);
  });

  it("узел на линии (R2): плашка сдвигается вдоль линии мимо узла, итог без плашек под узлами", () => {
    const node: NodeRect = { x: 70, y: -20, w: 60, h: 40 }; // накрывает середину (100,0)
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const ps = placeLabels(labels, [node]);
    expect(ps[0].center.y).toBe(0);
    expect(countLabelsUnderNodes(rects(ps), [node])).toBe(0);
  });

  it("слитое плечо (R4): плашка уезжает в уникальный хвост, а не на ствол (A14)", () => {
    // ствол [0,150] слит с соседом, уникальный хвост [150,200]; желаемая середина (100) —
    // на стволе, плашке туда нельзя
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], shared: [{ s: 0, e: 150 }], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels);
    expect(p.mode).toBe("online");
    expect(p.center.x).toBeGreaterThan(150);
    expect(p.center.x).toBeLessThanOrEqual(200);
  });

  it("без shared — середина пути", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels);
    expect(p.center.x).toBeCloseTo(100, 0);
  });

  it("в полной тесноте (плиты во всю ширину) плашка всё равно размещается на линии", () => {
    const top: NodeRect = { x: -100, y: -46, w: 400, h: 40 };
    const bot: NodeRect = { x: -100, y: 6, w: 400, h: 200 };
    const labels: LabelInput[] = [
      { id: "L", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const ps = placeLabels(labels, [top, bot]);
    expect(ps).toHaveLength(1);
    expect(ps[0].mode).toBe("online");
    expect(ps[0].center.y).toBe(0);
    expect(Number.isFinite(ps[0].center.x)).toBe(true);
  });
});

describe("placeLabels — лестница запасов и чужие плечи (E52, Ф3)", () => {
  it("желаемое место — центр самого ДЛИННОГО чистого интервала", () => {
    // крест чужой линии вырезал середину: чистые [0,66] и [134,200]; при равной длине —
    // первый, центр 33
    const labels: LabelInput[] = [
      {
        id: "A", path: poly([0, 0], [200, 0]), box: box(60, 16),
        candidates: [{ s: 0, e: 66 }, { s: 134, e: 200 }], loose: [{ s: 0, e: 200 }],
      },
    ];
    const [p] = placeLabels(labels);
    expect(p.center.x).toBeCloseTo(33, 0);
  });

  it("чистых нет → запасной интервал loose (без вычета крестов)", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), box: box(60, 16), candidates: [], loose: [{ s: 150, e: 200 }] },
    ];
    const [p] = placeLabels(labels);
    expect(p.center.x).toBeCloseTo(175, 0);
  });

  it("нет ни чистых, ни loose → центр самого ДЛИННОГО уникального участка (минус слитые плечи)", () => {
    // shared [60,100]; уникальные [0,60] (60px) и [100,200] (100px) → центр длинного = 150
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], shared: [{ s: 60, e: 100 }], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels);
    expect(p.center.x).toBeCloseTo(150, 0);
  });

  it("чужое плечо — мягкий конфликт: при пустых кандидатах плашка уходит с него вдоль линии", () => {
    // B — вертикальное плечо через x=100 во всю высоту; A без кандидатов метит в середину
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const edgeSegs = new Map<string, Segment[]>([
      ["A", [seg(0, 0, 200, 0)]],
      ["B", [seg(100, -200, 100, 200)]],
    ]);
    const [p] = placeLabels(labels, [], edgeSegs);
    expect(p.mode).toBe("online");
    expect(p.center.y).toBe(0);
    const boxRect = rectFromCenter(p.center.x, p.center.y, p.box.w, p.box.h);
    const bLeg: NodeRect = { x: 96, y: -200, w: 8, h: 400 };
    expect(rectsOverlap(boxRect, bLeg)).toBe(false);
  });
});

describe("segCrossesRect — геометрия (метрика «сквозь плашку»)", () => {
  const r: NodeRect = { x: 40, y: -10, w: 20, h: 20 };
  it("сквозь прямоугольник → true", () => {
    expect(segCrossesRect({ x: 0, y: 0 }, { x: 100, y: 0 }, r)).toBe(true);
  });
  it("мимо → false", () => {
    expect(segCrossesRect({ x: 0, y: 20 }, { x: 100, y: 20 }, r)).toBe(false);
  });
  it("скольжение вдоль границы (в пределах EPS) → false", () => {
    expect(segCrossesRect({ x: 0, y: 10 }, { x: 100, y: 10 }, r)).toBe(false);
  });
  it("старт на границе с уходом прочь → false, старт внутри → true", () => {
    expect(segCrossesRect({ x: 60, y: 0 }, { x: 100, y: 0 }, r)).toBe(false);
    expect(segCrossesRect({ x: 50, y: 0 }, { x: 100, y: 0 }, r)).toBe(true);
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

// РЕЖИМ ПОЧИНКИ (Б3б эпика «глубокая оптимизация роутера», E40 v2 — «сначала подвинь
// плашку»): плашка-жертва уступает режущей её стрелке, а если уступить некуда — отказ,
// и ребро перепрокладывает T4. Отказ обязан ОСТАВИТЬ прежнее место занятым (E53).
describe("placeLabels — починка (Б3б, E40 v2)", () => {
  // чужая стрелка едет ровно по y=0 — плашка на линии перерезана насквозь
  const cutter = new Map<string, Segment[]>([["X", [seg(-500, 0, 500, 0)]]]);
  const cut = (r: NodeRect): boolean =>
    segCrossesRect({ x: -500, y: 0 }, { x: 500, y: 0 }, r);
  // коридор высотой 40 вокруг линии: любой отход плашки упирается в тело
  const corridor: NodeRect[] = [
    { x: -400, y: -400, w: 900, h: 380 },
    { x: -400, y: 20, w: 900, h: 380 },
  ];

  it("режущую плашку уводит ВДОЛЬ линии (режущих стрелок становится 0, плашка на линии)", () => {
    // поперечная чужая стрелка через x=100 режет плашку в середине; уступить можно вдоль
    const across = new Map<string, Segment[]>([["X", [seg(100, -500, 100, 500)]]]);
    const cutAcross = (r: NodeRect): boolean => segCrossesRect({ x: 100, y: -500 }, { x: 100, y: 500 }, r);
    const keepRect = rectFromCenter(100, 0, 60, 16);
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16), keepRect },
    ];
    const [p] = placeLabels(labels, [], across, [], { repair: true });
    expect(p).toBeDefined();
    expect(cutAcross(keepRect)).toBe(true); // прежнее место резалось…
    expect(cutAcross(rectFromCenter(p.center.x, p.center.y, p.box.w, p.box.h))).toBe(false); // …новое нет
    expect(p.center.y).toBe(0); // …и осталось на линии (Ф3)
  });

  it("стрелка вдоль всей линии: уступить на линии некуда → ОТКАЗ (плашки нет в результате)", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16),
        keepRect: rectFromCenter(100, 0, 60, 16) },
    ];
    expect(placeLabels(labels, [], cutter, [], { repair: true })).toEqual([]);
  });

  it("уступить некуда (коридор между телами) → ОТКАЗ, плашки нет в результате", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16),
        keepRect: rectFromCenter(100, 0, 60, 16) },
    ];
    expect(placeLabels(labels, corridor, cutter, [], { repair: true })).toEqual([]);
  });

  it("плашку, которую никто не режет, починка не трогает (переезд только с выигрышем)", () => {
    const keepRect = rectFromCenter(100, 200, 60, 16); // далеко от линии y=0
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 200], [200, 200]), candidates: [{ s: 0, e: 200 }], box: box(60, 16), keepRect },
    ];
    expect(cut(keepRect)).toBe(false);
    expect(placeLabels(labels, [], cutter, [], { repair: true })).toEqual([]);
  });

  it("отказавшая плашка остаётся препятствием для следующих (E53)", () => {
    // A не режется (переезд ей не полагается) и стоит ровно там, куда метит B
    const keepA = rectFromCenter(100, 20, 60, 16);
    const A: LabelInput = {
      id: "A", path: poly([0, 20], [200, 20]), candidates: [{ s: 0, e: 200 }], box: box(60, 16), keepRect: keepA,
    };
    const B: LabelInput = {
      id: "B", path: poly([100, -100], [100, 100]), candidates: [{ s: 0, e: 200 }], box: box(60, 16),
      keepRect: rectFromCenter(100, 0, 60, 16),
    };
    const withA = placeLabels([A, B], [], cutter, [], { repair: true });
    const alone = placeLabels([B], [], cutter, [], { repair: true });
    expect(withA.map((p) => p.id)).toEqual(["B"]); // A отказалась
    // прежнее место A занято: B выбрала ДРУГОЕ место, чем без A, и на A не наложилась
    expect(withA[0].center).not.toEqual(alone[0].center);
    expect(rectsOverlap(rectFromCenter(withA[0].center.x, withA[0].center.y, 60, 16), keepA)).toBe(false);
  });

  it("обычный режим (без repair) ставит плашку ВСЕГДА — отказа нет (E52)", () => {
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16) },
    ];
    expect(placeLabels(labels, corridor, cutter)).toHaveLength(1);
  });

  it("детерминизм починки: тот же вход → тот же результат", () => {
    const make = (): LabelInput[] => [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16),
        keepRect: rectFromCenter(100, 0, 60, 16) },
      { id: "B", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16),
        keepRect: rectFromCenter(140, 0, 60, 16) },
    ];
    expect(placeLabels(make(), [], cutter, [], { repair: true }))
      .toEqual(placeLabels(make(), [], cutter, [], { repair: true }));
  });
});
