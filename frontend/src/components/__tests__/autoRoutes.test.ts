import { describe, it, expect } from "vitest";
import { buildAutoRoutes, separateInOutDocks } from "../graph/layout/autoRoutes";
import { pathCrossesRects, type NodeRect } from "../graph/edgePath";
import { NODE_W, NODE_H, hid } from "../graph/constants";
import type { EdgeGroup } from "../graph/types";
import type { LayoutEdge } from "../../types";

// Посадка роутера в раскладку (A7.1). Проверяем мост группы→терминалы→маршруты:
// роутятся только routableIds, концы на сторонах узлов, узлы-препятствия обходятся.

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

  it("свободное ребро (A8): концы на обращённых сторонах (правый край A → левый край B)", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["g1"]), positions, displayIds: ["A", "B"],
    });
    const r = out.routes.get("g1")!;
    // дешевле всего прямой ход: правый центр A → левый центр B
    expect(r[0]).toEqual({ x: NODE_W, y: NODE_H / 2 });
    expect(r[r.length - 1]).toEqual({ x: 400, y: NODE_H / 2 });
    // выбранная сторона отдана как хэндл
    expect(out.handles.get("g1")).toEqual({ sourceHandle: hid("A", "right", 1), targetHandle: hid("B", "left", 1) });
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

describe("buildAutoRoutes — раздача слотов портов (V2.4c)", () => {
  // три исходящих из H вправо + одно входящее в H справа: вход и выход не делят слот
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

  it("входящее и исходящие получают разные слоты одной стороны", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(ids),
      positions, displayIds: [...positions.keys()],
    });
    const hOf = (id: string, end: "sourceHandle" | "targetHandle") => out.handles.get(id)![end];
    // все четыре стыкуются на правой стороне H
    const sides = ids.map((id) => (id === "in" ? hOf("in", "targetHandle") : hOf(id, "sourceHandle")));
    expect(sides.every((h) => h.startsWith("H--right--"))).toBe(true);
    const outSlots = new Set(["o1", "o2", "o3"].map((id) => hOf(id, "sourceHandle")));
    expect(outSlots.size).toBe(1); // веер исходящих делит один слот (ствол легитимен)
    expect(hOf("in", "targetHandle")).not.toBe([...outSlots][0]); // вход — на другом слоте
    // маршрут входящего реально стыкуется в точке нового слота (эндпоинт сдвинут)
    const inRoute = out.routes.get("in")!;
    const dockY = inRoute[inRoute.length - 1].y;
    expect(Math.abs(dockY - 350)).toBeGreaterThan(10); // не центр стороны (350)
  });
});

describe("separateInOutDocks — пост-детурная разводка in/out (рецидив Т4, 2026-07-09)", () => {
  // Сцена бага AlertDashboard: детуры посадили вход И выход в bottom-центр узла N.
  const N: NodeRect = { x: 600, y: 300, w: NODE_W, h: NODE_H }; // bottom-центр (695, 400)
  const mkScene = () => ({
    routes: new Map([
      // вход: из A снизу-слева по лейну y=550 вверх в bottom-центр N
      ["ein", [{ x: 95, y: 600 }, { x: 95, y: 550 }, { x: 695, y: 550 }, { x: 695, y: 400 }]],
      // выход: из bottom-центра N вниз на лейн y=500 и вправо в B
      ["eout", [{ x: 695, y: 400 }, { x: 695, y: 500 }, { x: 1295, y: 500 }, { x: 1295, y: 600 }]],
    ]),
    edgeHandles: new Map([
      ["ein", { sourceHandle: hid("A", "top", 1), targetHandle: hid("N", "bottom", 1) }],
      ["eout", { sourceHandle: hid("N", "bottom", 1), targetHandle: hid("B", "top", 1) }],
    ]),
    rects: new Map<string, NodeRect>([
      ["N", N],
      ["A", { x: 0, y: 600, w: NODE_W, h: NODE_H }],
      ["B", { x: 1200, y: 600, w: NODE_W, h: NODE_H }],
    ]),
    endpoints: new Map([
      ["ein", { source: "A", target: "N" }],
      ["eout", { source: "N", target: "B" }],
    ]),
  });

  it("вход и выход, склеенные детуром в центр стороны, разводятся по разным слотам", () => {
    const s = mkScene();
    separateInOutDocks({
      ...s,
      movable: new Map([["ein", { s: false, t: true }], ["eout", { s: true, t: false }]]),
    });
    const tIn = s.edgeHandles.get("ein")!.targetHandle;
    const sOut = s.edgeHandles.get("eout")!.sourceHandle;
    expect(tIn).not.toBe(sOut);
    expect(tIn.startsWith("N--bottom--")).toBe(true);
    expect(sOut.startsWith("N--bottom--")).toBe(true);
    // маршрут сдвинутого конца реально перенесён на слот (эндпоинт ушёл с центра 695)
    const moved = tIn.endsWith("--1") ? s.routes.get("eout")! : s.routes.get("ein")!;
    const dock = tIn.endsWith("--1") ? moved[0] : moved[moved.length - 1];
    expect(Math.abs(dock.x - 695)).toBeGreaterThan(10);
  });

  it("пиненный конец не двигается — уступает подвижный", () => {
    const s = mkScene();
    separateInOutDocks({
      ...s,
      // вход зафиксирован (рельса/гистерезис) — двигаться может только выход
      movable: new Map([["eout", { s: true, t: false }]]),
    });
    expect(s.edgeHandles.get("ein")!.targetHandle).toBe(hid("N", "bottom", 1)); // пин цел
    expect(s.edgeHandles.get("eout")!.sourceHandle).not.toBe(hid("N", "bottom", 1));
  });

  it("без подвижных доков ничего не меняется", () => {
    const s = mkScene();
    const before = JSON.stringify([...s.edgeHandles], null, 0) + JSON.stringify([...s.routes]);
    separateInOutDocks({ ...s, movable: new Map() });
    expect(JSON.stringify([...s.edgeHandles], null, 0) + JSON.stringify([...s.routes])).toBe(before);
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
    // диагональная пара: ступенек равной стоимости много (та же длина, те же 2 излома);
    // prev — ступенька с переходом на «неканоничном» x: держим её, а не свежую
    const diag = new Map([["A", { x: 0, y: 0 }], ["B", { x: 400, y: 300 }]]);
    const prevRoute = [
      { x: NODE_W, y: NODE_H / 2 },        // правый центр A (190,50)
      { x: 237, y: NODE_H / 2 },
      { x: 237, y: 350 },                   // y левого центра B
      { x: 400, y: 350 },
    ];
    const out = buildAutoRoutes({
      ...base, positions: diag,
      prev: {
        routes: new Map([["g1", prevRoute]]),
        handles: new Map([["g1", { sourceHandle: hid("A", "right", 1), targetHandle: hid("B", "left", 1) }]]),
      },
    });
    expect(out.routes.get("g1")).toEqual(prevRoute);
  });

  it("конец узла ДВИГАЛСЯ (точка хэндла уехала) → prev невалиден, честный пере-роутинг", () => {
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
    const prevRoute = [{ x: NODE_W, y: NODE_H / 2 }, { x: 400, y: NODE_H / 2 }];
    const out = buildAutoRoutes({
      ...base, displayIds: ["A", "B", "C"],
      positions: new Map([...positions, ["C", { x: 250, y: 0 }]]), // C сел на прямую
      prev: {
        routes: new Map([["g1", prevRoute]]),
        handles: new Map([["g1", { sourceHandle: hid("A", "right", 1), targetHandle: hid("B", "left", 1) }]]),
      },
    });
    const r = out.routes.get("g1")!;
    expect(r).not.toEqual(prevRoute);
    expect(pathCrossesRects(r, [rectOf({ x: 250, y: 0 })])).toBe(false);
  });
});
