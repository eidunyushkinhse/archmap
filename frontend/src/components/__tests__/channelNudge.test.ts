import { describe, it, expect } from "vitest";
import { nudgeChannels } from "../graph/layout/channelNudge";
import type { EdgePoint } from "../../types";

// Канальный nudging (V2.3): наложенные плечи из разных хэндлов упорядочиваются и
// разводятся равными зазорами; стволы одного хэндла остаются слитыми (Т4).

const H = (id: string, s: string, t: string) => [id, { sourceHandle: s, targetHandle: t }] as const;

// горизонтальный маршрут с интерьерным плечом на y=axis: старт слева-сверху, финиш справа
const zRoute = (y0: number, axis: number, y1: number): EdgePoint[] => [
  { x: 0, y: y0 }, { x: 40, y: y0 }, { x: 40, y: axis }, { x: 360, y: axis }, { x: 360, y: y1 }, { x: 400, y: y1 },
];
const midY = (pts: EdgePoint[]): number => pts[2].y; // ось интерьерного плеча zRoute

describe("nudgeChannels", () => {
  it("два плеча из разных хэндлов на одной линии → разведены на gap, порядок по подходам", () => {
    const routes = new Map([
      ["A", zRoute(40, 100, 40)],   // приходит сверху (ref < 100)
      ["B", zRoute(160, 100, 160)], // приходит снизу (ref > 100)
    ]);
    const { routes: out, nudged } = nudgeChannels({
      routes,
      handles: new Map([H("A", "n1--right--1", "n2--left--1"), H("B", "n3--right--1", "n4--left--1")]),
      obstacles: [],
    });
    expect(nudged).toEqual(new Set(["A", "B"]));
    // A пришёл сверху → верхний слот (-6), B снизу → нижний (+6); зазор = gap
    expect(midY(out.get("A")!)).toBeCloseTo(94);
    expect(midY(out.get("B")!)).toBeCloseTo(106);
  });

  it("ствол одного хэндла не расщепляется, чужое плечо уходит в сторону", () => {
    const routes = new Map([
      ["A", zRoute(40, 100, 40)],
      ["B", zRoute(60, 100, 60)],   // общий хэндл с A → один ствол
      ["C", zRoute(180, 100, 180)], // чужое
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([
        H("A", "n1--right--1", "n2--left--1"),
        H("B", "n1--right--1", "n5--left--1"), // тот же источник, что у A
        H("C", "n3--right--1", "n4--left--1"),
      ]),
      obstacles: [],
    });
    expect(midY(out.get("A")!)).toBeCloseTo(midY(out.get("B")!)); // ствол слит
    expect(Math.abs(midY(out.get("C")!) - midY(out.get("A")!))).toBeGreaterThanOrEqual(11);
  });

  it("три чужих плеча → слоты -gap/0/+gap", () => {
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(100, 100, 100)],
      ["C", zRoute(200, 100, 200)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([
        H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1"), H("C", "e--right--1", "f--left--1"),
      ]),
      obstacles: [],
    });
    expect(midY(out.get("A")!)).toBeCloseTo(88);
    expect(midY(out.get("B")!)).toBeCloseTo(100);
    expect(midY(out.get("C")!)).toBeCloseTo(112);
  });

  it("пришпиленное (концевое) плечо не двигается — шкала слотов сдвигается вокруг него", () => {
    const fixed: EdgePoint[] = [{ x: 0, y: 100 }, { x: 360, y: 100 }, { x: 360, y: 200 }]; // первый сегмент = концевой
    const routes = new Map([
      ["F", fixed],
      ["A", zRoute(20, 100, 20)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([H("F", "x--right--1", "y--top--1"), H("A", "a--right--1", "b--left--1")]),
      obstacles: [],
    });
    expect(out.get("F")![0].y).toBe(100); // пришпиленный на месте
    expect(midY(out.get("A")!)).toBeCloseTo(88); // сосед ушёл на свой слот от нуля пришпиленного
  });

  it("сдвиг в тело узла отменяется", () => {
    const routes = new Map([
      ["A", zRoute(20, 100, 20)],
      ["B", zRoute(200, 100, 200)],
    ]);
    const { routes: out } = nudgeChannels({
      routes,
      handles: new Map([H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1")]),
      // тело точно там, куда уехал бы A (y=94): верхний слот заблокирован
      obstacles: [{ x: 100, y: 60, w: 100, h: 40 }],
    });
    expect(midY(out.get("A")!)).toBeCloseTo(100); // сдвиг отменён
    expect(midY(out.get("B")!)).toBeCloseTo(106); // партнёр всё же ушёл вниз
  });

  it("уже разведённые (≥gap) плечи не трогаются", () => {
    const routes = new Map([
      ["A", zRoute(20, 94, 20)],
      ["B", zRoute(200, 106, 200)],
    ]);
    const { nudged } = nudgeChannels({
      routes,
      handles: new Map([H("A", "a--right--1", "b--left--1"), H("B", "c--right--1", "d--left--1")]),
      obstacles: [],
    });
    expect(nudged.size).toBe(0);
  });
});
