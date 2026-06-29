import { describe, it, expect } from "vitest";
import { buildGuestForest } from "../graph/layout/separateGuests";
import { separateContainment, type CFrame } from "../graph/layout/separateContainment";
import type { FrameRect } from "../graph/layout/frames";
import type { Rect } from "../graph/layout/overlapConstraints";
import { NODE_W, NODE_H } from "../graph/constants";

// Хелпер: нативная/гостевая рамка с членами по их позициям + симметричным паддингом.
const frame = (
  id: string, depth: number, native: boolean, members: Record<string, { x: number; y: number }>, pad = 8,
): FrameRect => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of Object.values(members)) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
  }
  return {
    id, name: id, depth, native, memberIds: new Set(Object.keys(members)),
    content: { minX, minY, maxX, maxY },
    rect: { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad + 14 },
  };
};

const EPS = 1e-6;
const rectAt = (p: { x: number; y: number }): Rect => ({ minX: p.x, minY: p.y, maxX: p.x + NODE_W, maxY: p.y + NODE_H });
const overlap = (a: Rect, b: Rect): boolean =>
  a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS;

describe("buildGuestForest (лес containment из рамок уровня)", () => {
  // полигон «АБВ»: уровень А; локалы В/Г/Д справа; гости Е/З/И слева; рамки Б⊃{Е,З,И}, Ж⊃{И}
  const POS: Record<string, { x: number; y: number }> = {
    В: { x: 401, y: 333 }, Г: { x: 749, y: 333 }, Д: { x: 401, y: 575 },
    Е: { x: 123, y: 190 }, З: { x: 123, y: 318 }, И: { x: 89, y: 310 },
  };
  const pos = (id: string) => POS[id];
  const FRAMES: FrameRect[] = [
    frame("Б", 1, false, { Е: POS.Е, З: POS.З, И: POS.И }),
    frame("Ж", 2, false, { И: POS.И }),
  ];
  const build = () => buildGuestForest({
    localIds: ["В", "Г", "Д"], entityIds: ["Е", "З", "И"], frames: FRAMES, pos,
    localSet: new Set(["В", "Г", "Д"]), lightIds: new Set(["И"]),
  });

  it("вкладывает рамки концентрически: корень⊃Б⊃Ж⊃И", () => {
    const root = build();
    const Б = root.children.find((c): c is CFrame => c.kind === "frame")!;
    expect(Б).toBeDefined();
    const Ж = Б.children.find((c): c is CFrame => c.kind === "frame")!;
    expect(Ж).toBeDefined();
    // И — единственный лист внутри Ж
    expect(Ж.children.map((c) => (c.kind === "leaf" ? c.id : "frame"))).toEqual(["И"]);
    // Е/З — листья прямо в Б (их глубочайшая рамка — Б, не Ж)
    const бLeaves = Б.children.filter((c) => c.kind === "leaf").map((c) => (c as { id: string }).id).sort();
    expect(бLeaves).toEqual(["Е", "З"]);
  });

  it("локалы — листья корня с весом Infinity", () => {
    const root = build();
    const locals = root.children.filter((c) => c.kind === "leaf");
    expect(locals.map((c) => (c as { id: string }).id).sort()).toEqual(["В", "Г", "Д"]);
    expect(locals.every((c) => (c as { weight: number }).weight === Infinity)).toBe(true);
  });

  it("веса R4: новичок лёгкий, владеемые соседи тяжелее, рамка с новичком — пин", () => {
    const root = build();
    const Б = root.children.find((c): c is CFrame => c.kind === "frame")!;
    const Ж = Б.children.find((c): c is CFrame => c.kind === "frame")!;
    const И = Ж.children.find((c) => c.kind === "leaf") as { weight: number };
    const Е = Б.children.find((c) => c.kind === "leaf" && c.id === "Е") as { weight: number };
    // новичок И легче владеемого соседа Е
    expect(И.weight).toBeLessThan(Е.weight);
    // рамки, содержащие новичка, — тяжелее владеемого соседа (пин)
    expect(Ж.weight).toBeGreaterThan(Е.weight);
    expect(Б.weight).toBeGreaterThan(Е.weight);
  });

  it("АБВ через лес: И расходится с владеемыми Е/З, локалы не тронуты", () => {
    const root = build();
    const solved = separateContainment(root, 12);
    expect(solved.get("В")).toEqual(POS.В);
    expect(solved.get("Г")).toEqual(POS.Г);
    expect(solved.get("Д")).toEqual(POS.Д);
    expect(overlap(rectAt(solved.get("И")!), rectAt(solved.get("З")!))).toBe(false);
    expect(overlap(rectAt(solved.get("И")!), rectAt(solved.get("Е")!))).toBe(false);
  });

  it("без гостевых рамок — все листья в корне (плоский уровень)", () => {
    const root = buildGuestForest({
      localIds: ["В"], entityIds: ["Е"], frames: [], pos,
      localSet: new Set(["В"]), lightIds: new Set(),
    });
    expect(root.children.every((c) => c.kind === "leaf")).toBe(true);
    expect(root.children.length).toBe(2);
  });
});
