// Геометрия слоя тура: вырезы, слияние пересекающихся вырезов для перехвата кликов,
// место карточки рядом с целью (в окне, не поверх цели).
import { describe, it, expect } from "vitest";
import { inHole, mergeHoles, padHole, placeCard, shadePath, type Hole } from "../tourGeometry";

const VIEW = { w: 1440, h: 900 };
const CARD = { w: 340, h: 200 };

describe("вырезы", () => {
  it("рамка — с полями 6px, точка — круг не меньше 22px вокруг центра", () => {
    expect(padHole({ x: 100, y: 100, w: 50, h: 20 }, "rect")).toEqual({ x: 94, y: 94, w: 62, h: 32, shape: "rect" });
    const dot = padHole({ x: 100, y: 100, w: 2, h: 2 }, "dot");
    expect(dot.w).toBe(22);
    expect(dot.x + dot.w / 2).toBe(101);
    expect(inHole(dot, 101, 101)).toBe(true);
    expect(inHole(dot, dot.x + 1, dot.y + 1)).toBe(false); // угол квадрата — вне круга
  });

  it("пересекающиеся вырезы сливаются, отдельные — нет", () => {
    const a: Hole = { x: 0, y: 0, w: 100, h: 100, shape: "rect" };
    const b: Hole = { x: 90, y: 40, w: 30, h: 30, shape: "rect" };
    const c: Hole = { x: 300, y: 300, w: 10, h: 10, shape: "dot" };
    const merged = mergeHoles([a, b, c]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ x: 0, y: 0, w: 120, h: 100, shape: "rect" });
    expect(merged[1]).toEqual(c);
  });

  it("путь затемнения — окно и по контуру на каждый вырез", () => {
    const d = shadePath(1440, 900, [{ x: 10, y: 10, w: 40, h: 40, shape: "rect" }, { x: 100, y: 100, w: 20, h: 20, shape: "dot" }]);
    expect(d.startsWith("M0 0H1440V900H0Z")).toBe(true);
    expect(d.match(/Z/g)).toHaveLength(3);
  });
});

describe("место карточки", () => {
  it("крупная цель — справа, по центру по вертикали", () => {
    const at = placeCard({ x: 160, y: 272, w: 361, h: 277 }, [], CARD, VIEW);
    expect(at.x).toBe(160 + 361 + 16);
    expect(at.y).toBeCloseTo(272 + 277 / 2 - 100);
  });

  it("кнопка в шапке — снизу; у правого края — сдвинута внутрь окна", () => {
    const at = placeCard({ x: 1238, y: 375, w: 138, h: 25 }, [], CARD, VIEW);
    expect(at.y).toBe(375 + 25 + 16);
    expect(at.x + CARD.w).toBeLessThanOrEqual(VIEW.w - 16);
  });

  it("справа не помещается — слева; не закрывает то, что просили не закрывать", () => {
    const anchor = { x: 1200, y: 400, w: 200, h: 100 };
    const at = placeCard(anchor, [anchor], CARD, VIEW);
    expect(at.x + CARD.w).toBeLessThanOrEqual(anchor.x);
    // кнопка на узле: снизу легло бы на сам узел — уходим вбок
    const node = { x: 663, y: 387, w: 161, h: 84 };
    const btn = { x: 794, y: 391, w: 26, h: 19 };
    const at2 = placeCard(btn, [btn, node], CARD, VIEW);
    expect(at2.x).toBeGreaterThanOrEqual(node.x + node.w);
  });

  it("зона второго выреза: карточка по возможности не на ней, иначе — рядом с целью", () => {
    // палитра слева, холст справа во всю высоту: справа от палитры — на холсте
    const palette = { x: 20, y: 600, w: 220, h: 40 };
    const canvas = { x: 260, y: 60, w: 1180, h: 840 };
    const strict = placeCard(palette, [palette], CARD, VIEW, [{ x: 900, y: 60, w: 540, h: 840 }]);
    // зона справа узкая — карточка встаёт вне её (снизу у палитры)
    expect(strict.x + CARD.w).toBeLessThanOrEqual(900);
    // холст на весь экран — без зоны не обойтись: сторона рядом с палитрой, не угол окна
    const loose = placeCard(palette, [palette], CARD, VIEW, [canvas]);
    expect(loose).toEqual(placeCard(palette, [palette], CARD, VIEW));
  });

  it("цель на весь экран — правый нижний угол", () => {
    const at = placeCard({ x: 0, y: 0, w: 1440, h: 900 }, [], CARD, VIEW);
    expect(at).toEqual({ x: VIEW.w - CARD.w - 16, y: VIEW.h - CARD.h - 16 });
  });
});
