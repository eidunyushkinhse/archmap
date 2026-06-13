import { describe, it, expect } from "vitest";
import { centerEmergedChildren } from "../graph/layout/expandCenter";
import { NODE_W, NODE_H } from "../graph/constants";

// Хелпер: центр bbox набора позиций (с учётом размера узла)
function bboxCenter(positions: Map<string, { x: number; y: number }>, ids: string[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const p = positions.get(id)!;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

const ents = (...ids: string[]) => ids.map((id) => ({ id }));

describe("centerEmergedChildren", () => {
  it("несколько детей: центр общего bbox встаёт в origin, относительная раскладка сохраняется", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 300, y: 0 }],
      ["c", { x: 0, y: 200 }],
    ]);
    const emergedFrom = new Map([["a", "C"], ["b", "C"], ["c", "C"]]);
    const origins = new Map([["C", { x: 1000, y: 1000 }]]);
    const frozenDelta = new Map<string, { dx: number; dy: number }>();

    // запоминаем относительные смещения детей до центрирования
    const before = new Map([...positions].map(([k, v]) => [k, { ...v }]));

    centerEmergedChildren({
      entities: ents("a", "b", "c"), emergedFrom, origins, frozenDelta,
      settled: new Set(), positions,
    });

    const c = bboxCenter(positions, ["a", "b", "c"]);
    expect(c.x).toBeCloseTo(1000);
    expect(c.y).toBeCloseTo(1000);
    // относительная раскладка: все сдвинуты на ОДИН и тот же вектор
    const dxA = positions.get("a")!.x - before.get("a")!.x;
    const dyA = positions.get("a")!.y - before.get("a")!.y;
    for (const id of ["b", "c"]) {
      expect(positions.get(id)!.x - before.get(id)!.x).toBeCloseTo(dxA);
      expect(positions.get(id)!.y - before.get(id)!.y).toBeCloseTo(dyA);
    }
  });

  it("один ребёнок: его центр встаёт в origin", () => {
    const positions = new Map([["a", { x: 50, y: 50 }]]);
    centerEmergedChildren({
      entities: ents("a"),
      emergedFrom: new Map([["a", "C"]]),
      origins: new Map([["C", { x: 400, y: 300 }]]),
      frozenDelta: new Map(), settled: new Set(), positions,
    });
    expect(positions.get("a")!.x).toBeCloseTo(400 - NODE_W / 2);
    expect(positions.get("a")!.y).toBeCloseTo(300 - NODE_H / 2);
  });

  it("settled-ребёнок не центрируется и не входит в bbox группы", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 300, y: 0 }],
    ]);
    centerEmergedChildren({
      entities: ents("a", "b"),
      emergedFrom: new Map([["a", "C"], ["b", "C"]]),
      origins: new Map([["C", { x: 1000, y: 1000 }]]),
      frozenDelta: new Map(),
      settled: new Set(["b"]),
      positions,
    });
    // b остался на месте
    expect(positions.get("b")).toEqual({ x: 300, y: 0 });
    // a отцентрирован в одиночку (как единственный не-settled ребёнок)
    expect(positions.get("a")!.x).toBeCloseTo(1000 - NODE_W / 2);
    expect(positions.get("a")!.y).toBeCloseTo(1000 - NODE_H / 2);
  });

  it("delta замораживается: повторный проход после драга соседа не двигает остальных", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 300, y: 0 }],
    ]);
    const emergedFrom = new Map([["a", "C"], ["b", "C"]]);
    const origins = new Map([["C", { x: 1000, y: 1000 }]]);
    const frozenDelta = new Map<string, { dx: number; dy: number }>();

    // первый layout — оба центрируются, delta фиксируется
    centerEmergedChildren({ entities: ents("a", "b"), emergedFrom, origins, frozenDelta, settled: new Set(), positions });
    const aAfter1 = { ...positions.get("a")! };
    const frozen = frozenDelta.get("C")!;

    // пользователь подвинул b → b стал settled и персистнут на новом месте
    positions.set("b", { x: 9999, y: 9999 });
    // второй layout: a не двигался — позиция a в следующем входе та же исходная dagre,
    // но frozenDelta уже зафиксирован, поэтому a встаёт ровно туда же, что и в первый раз
    const positions2 = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 9999, y: 9999 }],
    ]);
    centerEmergedChildren({
      entities: ents("a", "b"), emergedFrom, origins, frozenDelta,
      settled: new Set(["b"]), positions: positions2,
    });
    expect(positions2.get("a")).toEqual(aAfter1);
    // delta не пересчитан
    expect(frozenDelta.get("C")).toEqual(frozen);
  });

  it("без позиций bbox не финитен → ни сдвига, ни заморозки delta", () => {
    const positions = new Map<string, { x: number; y: number }>();
    const frozenDelta = new Map<string, { dx: number; dy: number }>();
    centerEmergedChildren({
      entities: ents("a"),
      emergedFrom: new Map([["a", "C"]]),
      origins: new Map([["C", { x: 0, y: 0 }]]),
      frozenDelta, settled: new Set(), positions,
    });
    expect(frozenDelta.has("C")).toBe(false);
  });

  it("дети без origin (контейнер не раскрыт) не трогаются", () => {
    const positions = new Map([["a", { x: 7, y: 7 }]]);
    centerEmergedChildren({
      entities: ents("a"),
      emergedFrom: new Map([["a", "C"]]),
      origins: new Map(), // origin не запомнен
      frozenDelta: new Map(), settled: new Set(), positions,
    });
    expect(positions.get("a")).toEqual({ x: 7, y: 7 });
  });
});
