import { describe, it, expect } from "vitest";
import { enforceFramesKeepOut } from "../graph/layout/keepGhostsOut";
import { computeFrames, type FrameRect } from "../graph/layout/frames";
import { NODE_W, NODE_H } from "../graph/constants";
import type { DisplayExternal } from "../graph/types";
import type { GhostNode, AncestorRef } from "../../types";

// Запрет проникновения гостей в чужие родные рамки. Чистые данные (позиции заданы явно),
// ELK не нужен.

const a = (id: string): AncestorRef => ({ id, name: id });
function ghost(id: string, ancestors: AncestorRef[]): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: true,
    shape: "service", node_depth: ancestors.length, has_children: false, ancestors, is_ghost: true,
  };
}
function leaf(id: string, ancestors: AncestorRef[]): DisplayExternal {
  return { kind: "leaf", id, ghost: ghost(id, ancestors) };
}
const node = (id: string) => ({ id });

// пересечение прямоугольника узла id с нарисованной рамкой f
function nodeOverlapsFrame(pos: { x: number; y: number }, f: FrameRect): boolean {
  const r = { minX: pos.x, minY: pos.y, maxX: pos.x + NODE_W, maxY: pos.y + NODE_H };
  const b = { minX: f.rect.x, minY: f.rect.y, maxX: f.rect.x + f.rect.w, maxY: f.rect.y + f.rect.h };
  return r.minX < b.maxX && r.maxX > b.minX && r.minY < b.maxY && r.maxY > b.minY;
}

describe("enforceFramesKeepOut — выталкивание", () => {
  it("гость-ничей внутри F_0 вытолкнут к ближайшему краю + зазор", () => {
    // breadcrumb [A]; локальный L(0,0); E (ничей, предок D вне breadcrumb) внутри рамки A.
    // E обведён своей гостевой рамкой D — выталкивается ИМЕННО рамка (с паддингом), а не
    // голый узел: нарисованный пунктир D не должен задевать буфер A.
    const positions = new Map([["L", { x: 0, y: 0 }], ["E", { x: 50, y: 20 }]]);
    const res = enforceFramesKeepOut({
      nodes: [node("L")], entities: [leaf("E", [a("D")])],
      ancestorIds: ["A"], layoutEdges: [], positions,
    });
    expect(res).not.toBeNull();
    expect(res!.moved.has("E")).toBe(true);
    // A buffer maxY = 160 + 28 = 188; рамка D = bbox(E)+pad30 (верх = E.y−30).
    // Низ ближайший: E.y − 30 = 188 → E.y = 218.
    expect(positions.get("E")).toEqual({ x: 50, y: 218 });
  });

  it("«член A, но не B» вытолкнут из B и остаётся внутри A", () => {
    // breadcrumb [A,B]; локальный C(0,0); гость F (предок A) внутри рамки B
    const positions = new Map([["C", { x: 0, y: 0 }], ["F", { x: 50, y: 20 }]]);
    const entities = [leaf("F", [a("A")])];
    const res = enforceFramesKeepOut({
      nodes: [node("C")], entities, ancestorIds: ["A", "B"], layoutEdges: [], positions,
    });
    expect(res).not.toBeNull();
    expect(positions.get("F")).toEqual({ x: 50, y: 188 });
    // финально: F вне B, но внутри A
    const frames = computeFrames({
      localIds: ["C"], externals: [{ id: "F", ancestors: [a("A")] }],
      pos: (id) => positions.get(id), ancestorIds: ["A", "B"], ancestorNames: ["A", "B"],
    });
    const A = frames.find((f) => f.id === "A")!;
    const B = frames.find((f) => f.id === "B")!;
    expect(nodeOverlapsFrame(positions.get("F")!, B)).toBe(false); // вне чужой B
    expect(nodeOverlapsFrame(positions.get("F")!, A)).toBe(true);  // внутри своей A
  });

  it("гостевая рамка в зоне буфера (не пересекла реальный край) отжимается к границе буфера", () => {
    // breadcrumb [A]; L(0,0). A buffer maxY = 188. E (предок D) обведён рамкой D; верх
    // D = E.y−30 = 140 — реальный край A (160) рамка НЕ пересекает, но в зоне буфера.
    // Должна мягко отжаться к границе буфера (верх D = 188 → E.y = 218), без рывка.
    const positions = new Map([["L", { x: 0, y: 0 }], ["E", { x: 50, y: 170 }]]);
    const res = enforceFramesKeepOut({
      nodes: [node("L")], entities: [leaf("E", [a("D")])],
      ancestorIds: ["A"], layoutEdges: [], positions,
    });
    expect(res).not.toBeNull();
    expect(positions.get("E")).toEqual({ x: 50, y: 218 });
  });

  it("непересекающийся гость не тронут → null", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["E", { x: 500, y: 0 }]]);
    const res = enforceFramesKeepOut({
      nodes: [node("L")], entities: [leaf("E", [a("D")])],
      ancestorIds: ["A"], layoutEdges: [], positions,
    });
    expect(res).toBeNull();
    expect(positions.get("E")).toEqual({ x: 500, y: 0 }); // не тронут
  });

  it("раскрытая гостевая рамка двигается жёсткой группой", () => {
    // breadcrumb [A,B]; локальный C; два гостя g1,g2 в общем контейнере P (предки A>P) —
    // форбидден B. Стоят стопкой внутри B → выталкиваются ВМЕСТЕ одним дельтой.
    const positions = new Map([
      ["C", { x: 0, y: 0 }],
      ["g1", { x: 50, y: 20 }],
      ["g2", { x: 50, y: 140 }],
    ]);
    const entities = [leaf("g1", [a("A"), a("P")]), leaf("g2", [a("A"), a("P")])];
    const res = enforceFramesKeepOut({
      nodes: [node("C")], entities, ancestorIds: ["A", "B"], layoutEdges: [], positions,
    });
    expect(res).not.toBeNull();
    // обе сдвинуты на одну и ту же дельту (рамка не разорвана)
    const d1 = positions.get("g1")!.y - 20;
    const d2 = positions.get("g2")!.y - 140;
    expect(d1).toBe(d2);
    expect(positions.get("g1")!.x).toBe(50);
    expect(positions.get("g2")!.x).toBe(50);
    expect(d1).toBeGreaterThan(0); // вниз (ближайший край)
  });
});

describe("enforceFramesKeepOut — сходимость каскада", () => {
  it("F (в B) и E (в A) одновременно: терминирует, без NaN, оба вне чужих рамок", () => {
    // Двигая F (член A), рамка A растёт → может задеть E (ничей) → второй проход.
    const positions = new Map([
      ["C", { x: 0, y: 0 }],
      ["F", { x: 50, y: 20 }],   // внутри B
      ["E", { x: 120, y: 60 }],  // внутри A (ничей)
    ]);
    const entities = [leaf("F", [a("A")]), leaf("E", [a("D")])];
    const res = enforceFramesKeepOut({
      nodes: [node("C")], entities, ancestorIds: ["A", "B"], layoutEdges: [], positions,
    });
    expect(res).not.toBeNull();
    for (const p of positions.values()) {
      expect(Number.isNaN(p.x)).toBe(false);
      expect(Number.isNaN(p.y)).toBe(false);
    }
    const frames = computeFrames({
      localIds: ["C"],
      externals: [{ id: "F", ancestors: [a("A")] }, { id: "E", ancestors: [a("D")] }],
      pos: (id) => positions.get(id), ancestorIds: ["A", "B"], ancestorNames: ["A", "B"],
    });
    const A = frames.find((f) => f.id === "A")!;
    const B = frames.find((f) => f.id === "B")!;
    expect(nodeOverlapsFrame(positions.get("F")!, B)).toBe(false); // F вне B
    expect(nodeOverlapsFrame(positions.get("E")!, A)).toBe(false); // E вне A
  });
});
