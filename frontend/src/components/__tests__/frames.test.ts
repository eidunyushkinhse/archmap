import { describe, it, expect } from "vitest";
import { computeFrames } from "../graph/layout/frames";
import {
  NODE_W, NODE_H, BOUNDARY_PAD, BOUNDARY_STEP, BOUNDARY_LABEL_PAD, BOUNDARY_LABEL_STEP,
} from "../graph/constants";
import type { AncestorRef } from "../../types";

// Геометрия рамок (единый источник правды для рендера boundaries.tsx и энфорса
// keepGhostsOut.ts). Характеризационные числа фиксируют паритет с прежним boundaries.

const a = (id: string): AncestorRef => ({ id, name: id });
// нарисованный прямоугольник рамки глубины d при максимальной глубине md и content-bbox
function drawn(content: { minX: number; minY: number; maxX: number; maxY: number }, d: number, md: number) {
  const pad = BOUNDARY_PAD + (md - d) * BOUNDARY_STEP;
  const labelPad = BOUNDARY_LABEL_PAD + (md - d) * BOUNDARY_LABEL_STEP;
  return {
    x: content.minX - pad, y: content.minY - pad,
    w: content.maxX - content.minX + 2 * pad,
    h: content.maxY - content.minY + 2 * pad + labelPad,
  };
}

describe("computeFrames — вложенные родные рамки", () => {
  // Просмотр внутри B (breadcrumb A>B). Локальный C; гость F (член A, не B); гость E (ничей).
  const pos = (id: string) =>
    ({ C: { x: 0, y: 0 }, F: { x: 300, y: 0 }, E: { x: 600, y: 0 } } as Record<string, { x: number; y: number }>)[id];

  const frames = computeFrames({
    localIds: ["C"],
    externals: [{ id: "F", ancestors: [a("A")] }, { id: "E", ancestors: [a("D")] }],
    pos,
    ancestorIds: ["A", "B"],
    ancestorNames: ["A", "B"],
  });

  it("обе breadcrumb-рамки нативны; E (ничей) не входит ни в одну", () => {
    const A = frames.find((f) => f.id === "A")!;
    const B = frames.find((f) => f.id === "B")!;
    expect(A.native).toBe(true);
    expect(B.native).toBe(true);
    expect([...A.memberIds].sort()).toEqual(["C", "F"]); // F — член A
    expect([...B.memberIds].sort()).toEqual(["C"]);       // F НЕ член B
    expect(frames.some((f) => f.memberIds.has("E"))).toBe(false);
  });

  it("прямоугольники совпадают с прежней формулой boundaries (паритет)", () => {
    const A = frames.find((f) => f.id === "A")!;
    const B = frames.find((f) => f.id === "B")!;
    // maxDepth = 1; A content = C∪F, B content = C
    expect(A.rect).toEqual(drawn({ minX: 0, minY: 0, maxX: 300 + NODE_W, maxY: NODE_H }, 0, 1));
    expect(B.rect).toEqual(drawn({ minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H }, 1, 1));
  });

  it("внешние рамки (меньший depth) идут первыми", () => {
    expect(frames.map((f) => f.id)).toEqual(["A", "B"]);
  });
});

describe("computeFrames — гостевая рамка (раскрытый промежуточный контейнер)", () => {
  it("промежуточный контейнер P — НЕ нативная рамка глубже общего предка", () => {
    // breadcrumb [IM]; локальный X; гость Zabbix с предками IM>ProdMon
    const pos = (id: string) =>
      ({ X: { x: 0, y: 0 }, Z: { x: 300, y: 0 } } as Record<string, { x: number; y: number }>)[id];
    const frames = computeFrames({
      localIds: ["X"],
      externals: [{ id: "Z", ancestors: [a("IM"), a("ProdMon")] }],
      pos,
      ancestorIds: ["IM"],
      ancestorNames: ["IM"],
    });
    const IM = frames.find((f) => f.id === "IM")!;
    const P = frames.find((f) => f.id === "ProdMon")!;
    expect(IM.native).toBe(true);
    expect([...IM.memberIds].sort()).toEqual(["X", "Z"]); // Z член общего предка
    expect(P.native).toBe(false);
    expect([...P.memberIds]).toEqual(["Z"]);
    expect(P.depth).toBe(1);
  });
});

describe("computeFrames — вырожденные входы", () => {
  it("нет breadcrumb-предков → пусто", () => {
    expect(computeFrames({ localIds: ["L"], externals: [], pos: () => ({ x: 0, y: 0 }), ancestorIds: [], ancestorNames: [] })).toEqual([]);
  });
  it("нет локальных узлов → пусто", () => {
    expect(computeFrames({ localIds: [], externals: [], pos: () => ({ x: 0, y: 0 }), ancestorIds: ["A"], ancestorNames: ["A"] })).toEqual([]);
  });
});
