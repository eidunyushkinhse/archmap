import { describe, it, expect } from "vitest";
import { separateContainment, type CFrame, type CLeaf } from "../graph/layout/separateContainment";
import type { Rect } from "../graph/layout/overlapConstraints";

const rect = (minX: number, minY: number, w = 190, h = 100): Rect => ({
  minX, minY, maxX: minX + w, maxY: minY + h,
});
const leaf = (id: string, r: Rect, weight = 1): CLeaf => ({ kind: "leaf", id, rect: r, weight });
const EPS = 1e-6;
const rectAt = (p: { x: number; y: number }, w = 190, h = 100): Rect => rect(p.x, p.y, w, h);
const overlap = (a: Rect, b: Rect): boolean =>
  a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS;

describe("separateContainment (дерево containment изнутри наружу)", () => {
  it("плоский корень без рамок — как separateRects", () => {
    const root: CFrame = {
      kind: "frame", weight: 1, pad: 0,
      children: [leaf("a", rect(0, 0, 100, 100)), leaf("b", rect(90, 0, 100, 100))],
    };
    const pos = separateContainment(root, 0);
    expect(overlap(rectAt(pos.get("a")!, 100, 100), rectAt(pos.get("b")!, 100, 100))).toBe(false);
  });

  it("рамка движется жёстко: оба её листа транслируются на одну дельту", () => {
    // O — тяжёлый снаружи; рамка F (лёгкая) с листьями L1 (налезает на O) и L2 (свободен)
    const F: CFrame = {
      kind: "frame", weight: 1, pad: 0,
      children: [leaf("L1", rect(90, 0, 100, 100)), leaf("L2", rect(90, 200, 100, 100))],
    };
    const root: CFrame = {
      kind: "frame", weight: 1, pad: 0,
      children: [leaf("O", rect(0, 0, 100, 100), Infinity), F],
    };
    const pos = separateContainment(root, 0);
    expect(pos.get("O")).toEqual({ x: 0, y: 0 }); // тяжёлый снаружи не сдвинулся
    const dx1 = pos.get("L1")!.x - 90, dy1 = pos.get("L1")!.y - 0;
    const dx2 = pos.get("L2")!.x - 90, dy2 = pos.get("L2")!.y - 200;
    expect(dx1).toBeCloseTo(dx2, 6); // рамка жёсткая — одинаковый сдвиг
    expect(dy1).toBeCloseTo(dy2, 6);
    expect(dx1).toBeGreaterThan(0); // уехала вправо от O
    expect(overlap(rectAt(pos.get("O")!, 100, 100), rectAt(pos.get("L1")!, 100, 100))).toBe(false);
  });

  it("два листа внутри одной рамки разводятся между собой (внутренний слой)", () => {
    const root: CFrame = {
      kind: "frame", weight: 1, pad: 0,
      children: [{
        kind: "frame", weight: 1, pad: 0,
        children: [leaf("a", rect(0, 0, 100, 100)), leaf("b", rect(10, 10, 100, 100))],
      }],
    };
    const pos = separateContainment(root, 0);
    expect(overlap(rectAt(pos.get("a")!, 100, 100), rectAt(pos.get("b")!, 100, 100))).toBe(false);
  });

  it("АБВ: И (в рамке Ж в рамке Б) налезает на владеемый З → расходятся, локалы не тронуты", () => {
    // реальные координаты уровня А; локалы В/Г/Д далеко справа (x≥401), гости слева
    const В = leaf("В", rect(401, 333), Infinity);
    const Г = leaf("Г", rect(749, 333), Infinity);
    const Д = leaf("Д", rect(401, 575), Infinity);
    const И = leaf("И", rect(89, 310), 1);        // новичок, лёгкий
    const Ж: CFrame = { kind: "frame", weight: 1, pad: 8, children: [И] };
    const Е = leaf("Е", rect(123, 190), 1000);    // владеемый сосед, тяжёлый
    const З = leaf("З", rect(123, 318), 1000);    // владеемый сосед, тяжёлый
    const Б: CFrame = { kind: "frame", weight: 1, pad: 8, children: [Е, З, Ж] };
    const root: CFrame = { kind: "frame", weight: 1, pad: 0, children: [В, Г, Д, Б] };

    const pos = separateContainment(root, 12);

    // локалы не сдвинуты
    expect(pos.get("В")).toEqual({ x: 401, y: 333 });
    expect(pos.get("Г")).toEqual({ x: 749, y: 333 });
    expect(pos.get("Д")).toEqual({ x: 401, y: 575 });
    // И больше не налезает на З
    expect(overlap(rectAt(pos.get("И")!), rectAt(pos.get("З")!))).toBe(false);
    // и ни на одного владеемого соседа
    expect(overlap(rectAt(pos.get("И")!), rectAt(pos.get("Е")!))).toBe(false);
  });

  it("пиннутая (тяжёлая) рамка стоит, лёгкий сиблинг уезжает", () => {
    const pinned: CFrame = { kind: "frame", weight: Infinity, pad: 0, children: [leaf("p", rect(0, 0, 100, 100))] };
    const root: CFrame = {
      kind: "frame", weight: 1, pad: 0,
      children: [pinned, leaf("q", rect(90, 0, 100, 100), 1)],
    };
    const pos = separateContainment(root, 0);
    expect(pos.get("p")).toEqual({ x: 0, y: 0 }); // пиннутая рамка на месте
    expect(overlap(rectAt(pos.get("p")!, 100, 100), rectAt(pos.get("q")!, 100, 100))).toBe(false);
  });
});
