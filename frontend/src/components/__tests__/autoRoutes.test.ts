import { describe, it, expect } from "vitest";
import { buildAutoRoutes } from "../graph/layout/autoRoutes";
import { pathCrossesRects, type NodeRect } from "../graph/edgePath";
import { NODE_W, NODE_H, hid } from "../graph/constants";
import type { EdgeGroup } from "../graph/types";
import type { LayoutEdge } from "../../types";

// Посадка роутера в раскладку (A7.1). Проверяем мост группы→терминалы→маршруты:
// роутятся только routableIds, концы — порты ports.ts (порт на связь, Ф1 эпика «стрелки
// без жёстких хэндлов»), узлы-препятствия обходятся.

const edge = (id: string, s: string, t: string): LayoutEdge =>
  ({ id, source_id: s, target_id: t } as LayoutEdge);
const group = (id: string, source: string, target: string): EdgeGroup =>
  ({ id, source, target, members: [edge(id, source, target)] });
const rectOf = (p: { x: number; y: number }): NodeRect => ({ x: p.x, y: p.y, w: NODE_W, h: NODE_H });

describe("buildAutoRoutes — отбор и терминалы", () => {
  const positions = new Map([
    ["A", { x: 0, y: 0 }],
    ["B", { x: 400, y: 0 }],
  ]);
  const groups = [group("g1", "A", "B")];

  it("роутит только группы из routableIds", () => {
    const none = buildAutoRoutes({
      groups, routableIds: new Set(), positions, displayIds: ["A", "B"],
    });
    expect(none.routes.size).toBe(0);
    const one = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), positions, displayIds: ["A", "B"],
    });
    expect(one.routes.has("g1")).toBe(true);
  });

  it("узлы рядом на одной высоте: концы на обращённых сторонах (правый край A → левый край B)", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), positions, displayIds: ["A", "B"],
    });
    const r = out.routes.get("g1")!;
    // единственный порт стороны — её центр; маршрут прямой
    expect(r[0]).toEqual({ x: NODE_W, y: NODE_H / 2 });
    expect(r[r.length - 1]).toEqual({ x: 400, y: NODE_H / 2 });
    expect(r.length).toBe(2);
    // выбранная сторона отдана хэндлом её центра
    expect(out.handles.get("g1")).toEqual({ sourceHandle: hid("A", "right", 1), targetHandle: hid("B", "left", 1) });
  });

  it("узел далеко внизу и вбок: стороны оси потока (низ A → верх B), а не боковые", () => {
    const pos = new Map([["A", { x: 0, y: 0 }], ["B", { x: 900, y: 300 }]]);
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), positions: pos, displayIds: ["A", "B"],
    });
    const r = out.routes.get("g1")!;
    expect(r[0]).toEqual({ x: NODE_W / 2, y: NODE_H });
    expect(r[r.length - 1]).toEqual({ x: 900 + NODE_W / 2, y: 300 });
    expect(out.handles.get("g1")).toEqual({ sourceHandle: hid("A", "bottom", 1), targetHandle: hid("B", "top", 1) });
  });
});

describe("buildAutoRoutes — обход узла-препятствия", () => {
  it("маршрут не идёт сквозь чужой узел между концами", () => {
    // C ровно между A и B на прямой линии — прямой путь сквозь него, роутер должен объехать
    const positions = new Map([
      ["A", { x: 0, y: 0 }],
      ["B", { x: 400, y: 0 }],
      ["C", { x: 180, y: -NODE_H / 2 }],
    ]);
    const groups = [group("g1", "A", "B")];
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), positions,
      displayIds: ["A", "B", "C"],
    });
    const r = out.routes.get("g1")!;
    expect(pathCrossesRects(r, [rectOf(positions.get("C")!)])).toBe(false);
  });
});

describe("buildAutoRoutes — рамки-препятствия с воротами (V2.4)", () => {
  // рамка 200×300 стоит между A и B; узлов внутри нет — раньше маршрут резал её насквозь
  const positions = new Map([
    ["A", { x: 0, y: 100 }],
    ["B", { x: 700, y: 100 }],
  ]);
  const frame = { rect: { x: 250, y: 0, w: 200, h: 300 }, plaque: { x: 260, y: 270, w: 100, h: 22 }, memberIds: new Set<string>() };
  const groups = [group("g1", "A", "B")];

  it("чужое ребро обходит рамку (2 перехода дороже обхода)", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]),
      positions, displayIds: ["A", "B"], frames: [frame],
    });
    const r = out.routes.get("g1")!;
    // ни один сегмент не заходит внутрь рамки
    const inside = r.some((p) => p.x > 250 && p.x < 450 && p.y > 0 && p.y < 300);
    expect(inside).toBe(false);
  });

  it("без рамки тот же маршрут — прямой (санити разницы)", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]),
      positions, displayIds: ["A", "B"],
    });
    expect(out.routes.get("g1")!.length).toBe(2); // прямая
  });

  it("ребро внутрь СВОЕЙ рамки идёт без штрафа (не вьётся), но не сквозь плашку", () => {
    // C — «ребёнок» внутри рамки, у нижнего края возле плашки
    const pos = new Map([...positions, ["C", { x: 270, y: 180 }]]);
    const g = [group("g2", "A", "C")];
    const ownFrame = { ...frame, memberIds: new Set(["C"]) };
    const out = buildAutoRoutes({
      groups: g, routableIds: new Set(["g2"]),
      positions: pos, displayIds: ["A", "C"], frames: [ownFrame],
    });
    const r = out.routes.get("g2")!;
    expect(r.length).toBeLessThanOrEqual(5); // прямой заход, без вихляний от штрафа своей рамки
    expect(pathCrossesRects(r, [ownFrame.plaque])).toBe(false); // плашка — жёсткое препятствие
  });
});

describe("buildAutoRoutes — рамка как КОНЕЦ связи", () => {
  // A снаружи слева, C внутри рамки; рамка F — прямоугольник вокруг C.
  const positions = new Map([
    ["A", { x: 0, y: 100 }],
    ["C", { x: 500, y: 100 }],
  ]);
  const frameRect = { x: 450, y: 20, w: 260, h: 260 };
  const frame = { id: "F", rect: frameRect, plaque: { x: 460, y: 250, w: 100, h: 22 }, memberIds: new Set(["C"]) };

  it("конец-рамка стыкуется с ГРАНИЦЕЙ её прямоугольника: порт — проекция дальнего конца", () => {
    const out = buildAutoRoutes({
      groups: [group("gF", "A", "F")], routableIds: new Set(["gF"]),
      positions, displayIds: ["A", "C"], frames: [frame],
      frameEndpoints: new Map([["F", frameRect]]),
    });
    const r = out.routes.get("gF")!;
    const end = r[r.length - 1];
    // конец на левой грани рамки (ближайшей к A), на высоте центра A (проекция, R4)
    expect(end.x).toBeCloseTo(frameRect.x, 1);
    expect(end.y).toBeCloseTo(100 + NODE_H / 2, 1);
    // хэндл выдан по рамке — RF состыкует стрелку там же
    expect(out.handles.get("gF")?.targetHandle).toBe(hid("F", "left", 1));
  });

  it("рамка-конец НЕ становится телом-препятствием: чужой маршрут внутрь неё не меняется", () => {
    // Один и тот же маршрут A→C (C внутри рамки) с объявленным концом-рамкой и без него.
    // Если бы rect рамки попал в тела-препятствия, C оказался бы заперт и маршрут поехал.
    const args = {
      groups: [group("g", "A", "C")], routableIds: new Set(["g"]),
      positions, displayIds: ["A", "C"], frames: [frame],
    };
    const plain = buildAutoRoutes(args);
    const withDock = buildAutoRoutes({ ...args, frameEndpoints: new Map([["F", frameRect]]) });
    expect(withDock.routes.get("g")).toEqual(plain.routes.get("g"));
  });
});

describe("buildAutoRoutes — порт на связь (Ф1 эпика «стрелки без жёстких хэндлов»)", () => {
  // веер трёх исходящих из H вправо + одно входящее в H справа: у каждой связи своя точка
  const positions = new Map([
    ["H", { x: 0, y: 300 }],
    ["T1", { x: 500, y: 0 }],
    ["T2", { x: 500, y: 300 }],
    ["T3", { x: 500, y: 600 }],
    ["S", { x: 900, y: 300 }],
  ]);
  const groups = [
    group("o1", "H", "T1"), group("o2", "H", "T2"), group("o3", "H", "T3"),
    group("in", "S", "H"),
  ];
  const ids = ["o1", "o2", "o3", "in"];
  const run = () => buildAutoRoutes({
    groups, routableIds: new Set(ids), positions, displayIds: [...positions.keys()],
  });

  it("все четыре связи на правой стороне H, точки разные, порядок по дальнему концу", () => {
    const out = run();
    const ends = ids.map((id) => {
      const r = out.routes.get(id)!;
      return id === "in" ? r[r.length - 1] : r[0];
    });
    for (const p of ends) expect(p.x).toBe(NODE_W);                  // правая грань H
    expect(new Set(ends.map((p) => p.y)).size).toBe(4);              // общих точек нет
    // порядок сверху вниз: o1 (цель вверху) < o2, in (цели на высоте H) < o3 (цель внизу)
    const y = Object.fromEntries(ids.map((id, i) => [id, ends[i].y]));
    expect(y.o1).toBeLessThan(Math.min(y.o2, y.in));
    expect(Math.max(y.o2, y.in)).toBeLessThan(y.o3);
    // равный шаг с полями: 4 порта на стороне 100 → (100 − 20) / 5 = 16
    const sorted = ends.map((p) => p.y).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeCloseTo(16, 0);
    // хэндлы — центр выбранной стороны (одинаковый id у всех четырёх — это сторона, не порт)
    for (const id of ids) {
      const h = out.handles.get(id)!;
      expect(id === "in" ? h.targetHandle : h.sourceHandle).toBe(hid("H", "right", 1));
    }
  });

  it("единственная связь стороны садится в её центр: прямая остаётся прямой", () => {
    const out = buildAutoRoutes({
      groups: [group("o2", "H", "T2")], routableIds: new Set(["o2"]),
      positions, displayIds: [...positions.keys()],
    });
    expect(out.routes.get("o2")).toEqual([{ x: NODE_W, y: 350 }, { x: 500, y: 350 }]);
  });

  it("нероутируемые связи занимают свои порты: порты роутируемых не ложатся на их концы", () => {
    // o1..o3 заморожены (вне routableIds, идут prev-контекстом), роутится только «in»:
    // его порт обязан отличаться от точек всех трёх выходов
    const full = run();
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["in"]), positions, displayIds: [...positions.keys()],
      prev: { routes: full.routes, handles: full.handles },
    });
    const dock = out.routes.get("in")!.at(-1)!;
    for (const id of ["o1", "o2", "o3"]) {
      const o = full.routes.get(id)![0];
      expect(Math.abs(dock.x - o.x) + Math.abs(dock.y - o.y)).toBeGreaterThan(10);
    }
  });
});

describe("buildAutoRoutes — штраф езды по чужой линии (shared-path, 2026-07-13)", () => {
  // Мини-версия бага «Провайдер → Покупатель»: вход в узел не должен ехать по линии
  // ЧУЖОГО ВЫХОДА из того же узла (раньше езда была бесплатной — маршрут седлал чужую
  // линию на сотни px и парковался в её хэндл, нарушая Т4).
  const positions = new Map([
    ["H", { x: 0, y: 300 }],
    ["T", { x: 500, y: 300 }],
    ["S", { x: 900, y: 300 }],
  ]);
  const groups = [group("out", "H", "T"), group("in", "S", "H")];

  // суммарная длина коллинеарных наложений двух ломаных
  const overlapLen = (a: { x: number; y: number }[], b: { x: number; y: number }[]): number => {
    let total = 0;
    for (let i = 1; i < a.length; i++) {
      for (let j = 1; j < b.length; j++) {
        const ah = Math.abs(a[i].y - a[i - 1].y) <= Math.abs(a[i].x - a[i - 1].x);
        const bh = Math.abs(b[j].y - b[j - 1].y) <= Math.abs(b[j].x - b[j - 1].x);
        if (ah !== bh) continue;
        const ac = ah ? a[i].y : a[i].x, bc = bh ? b[j].y : b[j].x;
        if (Math.abs(ac - bc) > 0.5) continue;
        const [a1, a2] = ah ? [a[i - 1].x, a[i].x] : [a[i - 1].y, a[i].y];
        const [b1, b2] = bh ? [b[j - 1].x, b[j].x] : [b[j - 1].y, b[j].y];
        const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
        const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
        if (hi - lo > 0.5) total += hi - lo;
      }
    }
    return total;
  };

  it("вход не седлает линию чужого выхода и не паркуется в его точку", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["out", "in"]),
      positions, displayIds: [...positions.keys()],
    });
    const rOut = out.routes.get("out")!, rIn = out.routes.get("in")!;
    expect(overlapLen(rOut, rIn)).toBeLessThan(30); // без совместной езды (докинг-мелочь ок)
    expect(rIn[rIn.length - 1]).not.toEqual(rOut[0]);
  });
});

describe("buildAutoRoutes — плашки как штраф маршрута (T4, 2026-07-13)", () => {
  const positions = new Map([
    ["A", { x: 0, y: 300 }],
    ["B", { x: 800, y: 300 }],
  ]);
  const groups = [group("g", "A", "B")];
  // плашка ЧУЖОГО ребра ровно на прямой A→B (y=350): маршрут обязан объехать
  const foreign = { x: 420, y: 330, w: 140, h: 40 };

  it("чужая плашка отталкивает маршрут (объезд вместо линии сквозь текст)", () => {
    const clean = buildAutoRoutes({
      groups, routableIds: new Set(["g"]), positions, displayIds: ["A", "B"],
    });
    expect(pathCrossesRects(clean.routes.get("g")!, [foreign])).toBe(true); // без T4 — сквозь
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g"]), positions, displayIds: ["A", "B"],
      labelObstacles: new Map([["other", foreign]]),
    });
    expect(pathCrossesRects(out.routes.get("g")!, [foreign])).toBe(false);
  });

  it("СВОЯ плашка не отталкивает (online-плашка лежит на собственной линии)", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g"]), positions, displayIds: ["A", "B"],
      labelObstacles: new Map([["g", foreign]]),
    });
    // маршрут остаётся прямым, сквозь «свою» плашку
    expect(out.routes.get("g")!.length).toBe(2);
  });
});

describe("buildAutoRoutes — гистерезис (prev, 2026-07-09)", () => {
  const positions = new Map([
    ["A", { x: 0, y: 0 }],
    ["B", { x: 400, y: 0 }],
  ]);
  const groups = [group("g1", "A", "B")];
  const base = {
    groups, routableIds: new Set(["g1"]), positions,
    displayIds: ["A", "B"],
  };

  it("свой же вывод, поданный как prev, удерживается вместе с хэндлами (устойчивая точка)", () => {
    const first = buildAutoRoutes(base);
    const again = buildAutoRoutes({
      ...base,
      prev: { routes: first.routes, handles: first.handles },
    });
    expect(again.routes.get("g1")).toEqual(first.routes.get("g1"));
    expect(again.handles.get("g1")).toEqual(first.handles.get("g1"));
  });

  it("prev с равноценной, но ДРУГОЙ формой удерживается (нет перекладки на ничьей)", () => {
    // пара друг под другом со сдвигом: ступенек равной стоимости много (та же длина, те же
    // 2 излома); prev — ступенька с переходом на «неканоничном» y: держим её, а не свежую
    const diag = new Map([["A", { x: 0, y: 0 }], ["B", { x: 60, y: 400 }]]);
    const prevRoute = [
      { x: NODE_W / 2, y: NODE_H },        // нижний центр A (95,100)
      { x: NODE_W / 2, y: 173 },
      { x: 60 + NODE_W / 2, y: 173 },      // x верхнего центра B
      { x: 60 + NODE_W / 2, y: 400 },
    ];
    const out = buildAutoRoutes({
      ...base, positions: diag,
      prev: {
        routes: new Map([["g1", prevRoute]]),
        handles: new Map([["g1", { sourceHandle: hid("A", "bottom", 1), targetHandle: hid("B", "top", 1) }]]),
      },
    });
    expect(out.routes.get("g1")).toEqual(prevRoute);
  });

  it("конец узла ДВИГАЛСЯ (порт уехал) → prev невалиден, честный пере-роутинг", () => {
    const moved = new Map([["A", { x: 0, y: 40 }], ["B", { x: 400, y: 0 }]]);
    const prevRoute = [{ x: NODE_W, y: NODE_H / 2 }, { x: 400, y: NODE_H / 2 }];
    const out = buildAutoRoutes({
      ...base, positions: moved,
      prev: {
        routes: new Map([["g1", prevRoute]]),
        handles: new Map([["g1", { sourceHandle: hid("A", "right", 1), targetHandle: hid("B", "left", 1) }]]),
      },
    });
    expect(out.routes.get("g1")).not.toEqual(prevRoute);
  });

  it("на prev надвинулось чужое тело → prev невалиден, маршрут обходит", () => {
    const prevRoute = [{ x: NODE_W, y: NODE_H / 2 }, { x: 600, y: NODE_H / 2 }];
    const pos = new Map([["A", { x: 0, y: 0 }], ["B", { x: 600, y: 0 }], ["C", { x: 300, y: 0 }]]); // C сел на прямую
    const out = buildAutoRoutes({
      ...base, displayIds: ["A", "B", "C"], positions: pos,
      prev: {
        routes: new Map([["g1", prevRoute]]),
        handles: new Map([["g1", { sourceHandle: hid("A", "right", 1), targetHandle: hid("B", "left", 1) }]]),
      },
    });
    const r = out.routes.get("g1")!;
    expect(r).not.toEqual(prevRoute);
    expect(pathCrossesRects(r, [rectOf({ x: 300, y: 0 })])).toBe(false);
  });

  it("прежняя сторона держится в полосе гистерезиса: узел чуть ушёл за край соседа", () => {
    // Уровень сверху вниз (A → C под ним держит ось). B правее A и чуть ниже (перекрытие
    // по высоте 10 px): без prev — рядом (боковые стороны); с prev «низ → верх» — режим
    // по оси потока удерживается
    const pos = new Map([["A", { x: 0, y: 0 }], ["B", { x: 400, y: 90 }], ["C", { x: 0, y: 400 }]]);
    const args = { ...base, groups: [...groups, group("g2", "A", "C")], routableIds: new Set(["g1", "g2"]), positions: pos, displayIds: ["A", "B", "C"] };
    const fresh = buildAutoRoutes(args);
    expect(fresh.handles.get("g1")).toEqual({ sourceHandle: hid("A", "right", 1), targetHandle: hid("B", "left", 1) });
    const held = buildAutoRoutes({
      ...args,
      prev: {
        routes: new Map(),
        handles: new Map([
          ["g1", { sourceHandle: hid("A", "bottom", 1), targetHandle: hid("B", "top", 1) }],
          ["g2", { sourceHandle: hid("A", "bottom", 1), targetHandle: hid("C", "top", 1) }],
        ]),
      },
    });
    expect(held.handles.get("g1")).toEqual({ sourceHandle: hid("A", "bottom", 1), targetHandle: hid("B", "top", 1) });
  });
});
