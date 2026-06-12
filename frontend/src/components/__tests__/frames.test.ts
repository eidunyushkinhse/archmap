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

  it("обе breadcrumb-рамки нативны; E (ничей) не в родных, но в своей чужой рамке D", () => {
    const A = frames.find((f) => f.id === "A")!;
    const B = frames.find((f) => f.id === "B")!;
    expect(A.native).toBe(true);
    expect(B.native).toBe(true);
    expect([...A.memberIds].sort()).toEqual(["C", "F"]); // F — член A
    expect([...B.memberIds].sort()).toEqual(["C"]);       // F НЕ член B
    // E не входит ни в одну РОДНУЮ рамку…
    expect(frames.filter((f) => f.native).some((f) => f.memberIds.has("E"))).toBe(false);
    // …но обведён своей гостевой рамкой D (чужая ветка от корня)
    const D = frames.find((f) => f.id === "D")!;
    expect(D.native).toBe(false);
    expect([...D.memberIds]).toEqual(["E"]);
  });

  it("прямоугольники совпадают с прежней формулой boundaries (паритет)", () => {
    const A = frames.find((f) => f.id === "A")!;
    const B = frames.find((f) => f.id === "B")!;
    // maxDepth = 1; A content = C∪F, B content = C
    expect(A.rect).toEqual(drawn({ minX: 0, minY: 0, maxX: 300 + NODE_W, maxY: NODE_H }, 0, 1));
    expect(B.rect).toEqual(drawn({ minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H }, 1, 1));
  });

  it("внешние рамки (меньший depth) идут первыми", () => {
    // A и D — depth 0 (родная и чужая), B — depth 1; сортировка по depth стабильна
    expect(frames.map((f) => f.id)).toEqual(["A", "D", "B"]);
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

  it("гость без общего предка: вся чужая ветка от корня — гостевые рамки", () => {
    // Просмотр с уровня OM (Объекты мониторинга); локальный BD (БД, родной). Гость DP
    // (DB Proxy) с предками HelixMon > ObsCore — ни один не в breadcrumb. Обе ветки —
    // вложенные гостевые рамки вокруг гостя, снаружи родной рамки OM.
    const pos = (id: string) =>
      ({ BD: { x: 0, y: 0 }, DP: { x: 300, y: 0 } } as Record<string, { x: number; y: number }>)[id];
    const frames = computeFrames({
      localIds: ["BD"],
      externals: [{ id: "DP", ancestors: [a("HelixMon"), a("ObsCore")] }],
      pos,
      ancestorIds: ["OM"],
      ancestorNames: ["OM"],
    });
    const OM = frames.find((f) => f.id === "OM")!;
    const IM = frames.find((f) => f.id === "HelixMon")!;
    const MC = frames.find((f) => f.id === "ObsCore")!;
    expect(OM.native).toBe(true);
    expect([...OM.memberIds]).toEqual(["BD"]); // гость DP НЕ член родной OM
    expect(IM.native).toBe(false);
    expect(MC.native).toBe(false);
    expect(IM.depth).toBe(0);
    expect(MC.depth).toBe(1);
    expect([...IM.memberIds]).toEqual(["DP"]);
    expect([...MC.memberIds]).toEqual(["DP"]);
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
