import { describe, it, expect } from "vitest";
import { buildAutoRoutes } from "../graph/layout/autoRoutes";
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

describe("buildAutoRoutes — рамка как КОНЕЦ связи", () => {
  // A снаружи слева, C внутри рамки; рамка F — прямоугольник вокруг C.
  const positions = new Map([
    ["A", { x: 0, y: 100 }],
    ["C", { x: 500, y: 100 }],
  ]);
  const frameRect = { x: 450, y: 20, w: 260, h: 260 };
  const frame = { id: "F", rect: frameRect, plaque: { x: 460, y: 250, w: 100, h: 22 }, memberIds: new Set(["C"]) };

  it("конец-рамка стыкуется с ГРАНИЦЕЙ её прямоугольника, а не с центром", () => {
    const out = buildAutoRoutes({
      groups: [group("gF", "A", "F")], routableIds: new Set(["gF"]),
      positions, displayIds: ["A", "C"], frames: [frame],
      frameEndpoints: new Map([["F", frameRect]]),
    });
    const r = out.routes.get("gF")!;
    const end = r[r.length - 1];
    // конец на левой грани рамки (ближайшей к A), в створе её высоты
    expect(end.x).toBeCloseTo(frameRect.x, 1);
    expect(end.y).toBeGreaterThanOrEqual(frameRect.y);
    expect(end.y).toBeLessThanOrEqual(frameRect.y + frameRect.h);
    // хэндл выдан по рамке — RF состыкует стрелку там же
    expect(out.handles.get("gF")?.targetHandle.startsWith("F--left--")).toBe(true);
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

  it("входящее не делит точку стыковки с веером исходящих (Т4)", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(ids),
      positions, displayIds: [...positions.keys()],
    });
    const hOf = (id: string, end: "sourceHandle" | "targetHandle") => out.handles.get(id)![end];
    // исходящие к прямой/нижней цели — на правой стороне H; o1 (цель сверху) волен
    // выйти верхом — сторону выбирает A*. Обязательного СЛИЯНИЯ o2/o3 в один слот
    // больше не фиксируем: T1 разрешает вееру расползтись по свободным слотам, а
    // прежнее слияние в этой сцене было случайным артефактом rip-up-цепочки, которую
    // портовый штраф (2026-07-15) убрал вместе с Т4-нарушением в pass1 (выход o1
    // садился ровно в точку входа in). Бесплатность легитимного ствола держит
    // соседний тест («прямое ребро едет по собрату без виляний»).
    const outHandles = ["o1", "o2", "o3"].map((id) => hOf(id, "sourceHandle"));
    expect(hOf("o2", "sourceHandle").startsWith("H--right--")).toBe(true);
    expect(hOf("o3", "sourceHandle").startsWith("H--right--")).toBe(true);
    // вход НЕ делит хэндл ни с одним выходом (Т4): либо другой слот той же стороны
    // (распределение слотов V2.4c), либо вовсе другая сторона
    const inHandle = hOf("in", "targetHandle");
    expect(inHandle.startsWith("H--")).toBe(true);
    for (const oh of outHandles) expect(inHandle).not.toBe(oh);
    // и ГЕОМЕТРИЧЕСКИ: точка стыковки входа не совпадает с точкой НИ ОДНОГО выхода
    // (строже прежней проверки одного ствол-центра)
    const inRoute = out.routes.get("in")!;
    const dock = inRoute[inRoute.length - 1];
    for (const id of ["o1", "o2", "o3"]) {
      const or = out.routes.get(id)!;
      expect(Math.abs(dock.x - or[0].x) + Math.abs(dock.y - or[0].y)).toBeGreaterThan(10);
    }
  });

  it("ствол веера из общего порта БЕСПЛАТЕН: прямое ребро едет по собрату без виляний", () => {
    // o2 (H → T2 строго вправо) обязано остаться идеальной прямой, хотя целиком совпадает
    // с первым плечом o3 (общий порт H--right — легитимный ствол Т4). Регрессия штрафа
    // наложений: без исключения ствола o2 виляло вокруг собственного собрата.
    const out = buildAutoRoutes({
      groups, routableIds: new Set(ids),
      positions, displayIds: [...positions.keys()],
    });
    expect(out.routes.get("o2")!.length).toBe(2); // прямая без изломов
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

  it("вход не седлает линию чужого выхода и не паркуется в его хэндл", () => {
    const out = buildAutoRoutes({
      groups, routableIds: new Set(["out", "in"]),
      positions, displayIds: [...positions.keys()],
    });
    const rOut = out.routes.get("out")!, rIn = out.routes.get("in")!;
    expect(overlapLen(rOut, rIn)).toBeLessThan(30); // без совместной езды (докинг-мелочь ок)
    expect(out.handles.get("in")!.targetHandle).not.toBe(out.handles.get("out")!.sourceHandle);
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
