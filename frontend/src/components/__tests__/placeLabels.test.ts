import { describe, it, expect } from "vitest";
import { placeLabels, type LabelInput, type Placement } from "../graph/layout/placeLabels";
import { rectFromCenter, rectsOverlap, countLabelOverlaps, countLabelsUnderNodes, segCrossesRect } from "../graph/layout/arrowMetrics";
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

describe("segCrossesRect — геометрия поводка", () => {
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

describe("placeLabels — поводок и узлы (мягкое избегание)", () => {
  it("поводок обходит узел: чистое направление выигрывает у более близкого с нырком", () => {
    // Якорь (100,0) зажат в щели: узел A вплотную сверху, глубокий B вплотную снизу.
    // Все ближние кандидаты заняты боксом; первый чистый боксом — НАД A, но его поводок
    // ныряет сквозь A (по-старому победил бы он). Чистая альтернатива — вбок по щели.
    const A: NodeRect = { x: 70, y: -46, w: 60, h: 40 };
    const B: NodeRect = { x: 70, y: 6, w: 60, h: 200 };
    const labels: LabelInput[] = [
      { id: "L", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const [p] = placeLabels(labels, [A, B]);
    expect(p.mode).toBe("leader");
    expect(segCrossesRect(p.anchor, p.center, A)).toBe(false);
    expect(segCrossesRect(p.anchor, p.center, B)).toBe(false);
  });

  it("в полной тесноте нырок допустим: плашка всё равно размещается", () => {
    // Две плиты во всю ширину со щелью 12px < высоты плашки: ЛЮБОЙ кандидат-бокс задевает
    // плиту (ovHard>0), чистых мест нет вовсе — штраф поводка не должен отвергать насмерть.
    const top: NodeRect = { x: -100, y: -46, w: 400, h: 40 };
    const bot: NodeRect = { x: -100, y: 6, w: 400, h: 200 };
    const labels: LabelInput[] = [
      { id: "L", path: poly([0, 0], [200, 0]), candidates: [], box: box(60, 16) },
    ];
    const ps = placeLabels(labels, [top, bot]);
    expect(ps).toHaveLength(1);
    expect(ps[0].mode).toBe("leader");
    expect(Number.isFinite(ps[0].center.x)).toBe(true);
    expect(Number.isFinite(ps[0].center.y)).toBe(true);
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

  it("режущую плашку уводит с линии (режущих стрелок становится 0)", () => {
    const keepRect = rectFromCenter(100, 0, 60, 16);
    const labels: LabelInput[] = [
      { id: "A", path: poly([0, 0], [200, 0]), candidates: [{ s: 0, e: 200 }], box: box(60, 16), keepRect },
    ];
    const [p] = placeLabels(labels, [], cutter, [], { repair: true });
    expect(p).toBeDefined();
    expect(cut(keepRect)).toBe(true); // прежнее место резалось…
    expect(cut(rectFromCenter(p.center.x, p.center.y, p.box.w, p.box.h))).toBe(false); // …новое нет
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
