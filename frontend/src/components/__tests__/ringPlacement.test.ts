import { describe, it, expect } from "vitest";
import { placeGhostsOnRings } from "../graph/layout/ringPlacement";
import { enforceFramesKeepOut } from "../graph/layout/keepGhostsOut";
import { NODE_W } from "../graph/constants";
import type { DisplayExternal } from "../graph/types";
import type { Edge as AppEdge, GhostNode, AncestorRef } from "../../types";

// Раскладка гостей на кольца запретных рамок (boundary labeling). Чистые данные: позиции
// заданы явно, ELK не нужен. Ключевой инвариант — после колец enforceFramesKeepOut no-op.

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });
function ghost(id: string, ancestors: AncestorRef[]): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: true,
    shape: "service", node_depth: ancestors.length, has_children: false, ancestors, is_ghost: true,
  };
}
function leaf(id: string, ancestors: AncestorRef[]): DisplayExternal {
  return { kind: "leaf", id, ghost: ghost(id, ancestors) };
}
function edge(id: string, source_id: string, target_id: string): AppEdge {
  return {
    id, label: null, technology: null, source_id, target_id,
    source_handle: null, target_handle: null, created_at: "2026-06-12T00:00:00Z",
  };
}
const node = (id: string) => ({ id });

describe("placeGhostsOnRings — сторона по потоку", () => {
  it("источник → слева от уровня, приёмник → справа", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["Gs", { x: 5, y: 5 }], ["Gt", { x: 9, y: 9 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("L")],
      entities: [leaf("Gs", [a("D")]), leaf("Gt", [a("E")])],
      ancestorIds: ["A"], levelPositions: {},
      layoutEdges: [edge("e1", "Gs", "L"), edge("e2", "L", "Gt")], positions,
    });
    expect(res).not.toBeNull();
    expect(positions.get("Gs")!.x).toBeLessThan(0);          // источник слева
    expect(positions.get("Gt")!.x).toBeGreaterThan(NODE_W);  // приёмник справа
    expect(res!.placedOutside.has("Gs")).toBe(true);
    expect(res!.placedOutside.has("Gt")).toBe(true);
  });

  it("связь к среднему узлу ряда: горизонталь сквозь соседей → гость уходит ВВЕРХ", () => {
    // La(0,0) Lb(300,0) Lc(600,0); гость связан со средним Lb. Лево/право увели бы стрелку
    // сквозь La/Lc; верх (вертикаль к Lb) чист → гость над рамкой, по центру над связью.
    const positions = new Map([
      ["La", { x: 0, y: 0 }], ["Lb", { x: 300, y: 0 }], ["Lc", { x: 600, y: 0 }], ["G", { x: 5, y: 5 }],
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("La"), node("Lb"), node("Lc")],
      entities: [leaf("G", [a("D")])],
      ancestorIds: ["A"], levelPositions: {},
      layoutEdges: [edge("e", "G", "Lb")], positions,
    });
    expect(res).not.toBeNull();
    expect(positions.get("G")!.x).toBe(300);       // по центру над Lb (вертикаль, не сбоку)
    expect(positions.get("G")!.y).toBeLessThan(0); // над рамкой
  });
});

describe("placeGhostsOnRings — keep-out по построению", () => {
  it("после колец enforceFramesKeepOut НИЧЕГО не двигает (no-op → null)", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 5, y: 5 }]]);
    const ents = [leaf("G", [a("D")])];
    placeGhostsOnRings({
      nodes: [node("L")], entities: ents, ancestorIds: ["A"], levelPositions: {},
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    const enf = enforceFramesKeepOut({
      nodes: [node("L")], entities: ents, ancestorIds: ["A"], layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(enf).toBeNull(); // гость с рамкой посажен ровно на границу буфера → no-op
  });

  it("гости разной глубины: оба валидны по keep-out (разные запретные кольца)", () => {
    // breadcrumb [A,B]; локальный C. Gin (предок A, член A) — запретна B (внутреннее кольцо);
    // Gout (предок D, ничей) — запретна A (внешнее). Каскад изнутри наружу размещает обоих
    // так, что страховочный keep-out — no-op (точная сторона зависит от формы выросшей рамки).
    const positions = new Map([
      ["C", { x: 0, y: 0 }], ["Gin", { x: 5, y: 5 }], ["Gout", { x: 9, y: 9 }],
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("C")],
      entities: [leaf("Gin", [a("A")]), leaf("Gout", [a("D")])],
      ancestorIds: ["A", "B"], levelPositions: {},
      layoutEdges: [edge("e1", "Gin", "C"), edge("e2", "Gout", "C")], positions,
    });
    expect(res).not.toBeNull();
    expect(res!.placedOutside.has("Gin")).toBe(true);
    expect(res!.placedOutside.has("Gout")).toBe(true);
    // ключевой инвариант: после колец keep-out ничего не двигает (оба вне своих запретных)
    const ents = [leaf("Gin", [a("A")]), leaf("Gout", [a("D")])];
    const enf = enforceFramesKeepOut({
      nodes: [node("C")], entities: ents, ancestorIds: ["A", "B"],
      layoutEdges: [edge("e1", "Gin", "C"), edge("e2", "Gout", "C")], positions,
    });
    expect(enf).toBeNull();
  });
});

describe("placeGhostsOnRings — жёсткая группа и ручные позиции", () => {
  it("дети раскрытого контейнера-гостя двигаются ВМЕСТЕ (рамка не рвётся)", () => {
    // g1,g2 в общей гостевой рамке P (оба предок P, ничей). Стоят стопкой (Δy=135).
    const positions = new Map([
      ["L", { x: 0, y: 0 }], ["g1", { x: 5, y: 5 }], ["g2", { x: 5, y: 140 }],
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("L")],
      entities: [leaf("g1", [a("P")]), leaf("g2", [a("P")])],
      ancestorIds: ["A"], levelPositions: {},
      layoutEdges: [edge("e", "g1", "L")], positions,
    });
    expect(res).not.toBeNull();
    const g1 = positions.get("g1")!, g2 = positions.get("g2")!;
    // относительное смещение сохранено (жёсткий перенос группы)
    expect(g2.x - g1.x).toBe(0);
    expect(g2.y - g1.y).toBe(135);
    expect(res!.placedOutside.has("g1")).toBe(true);
    expect(res!.placedOutside.has("g2")).toBe(true);
  });

  it("гость с ручной позицией не двигается; один такой → null", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 5, y: 5 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: ["A"],
      levelPositions: { G: { pos_x: 999, pos_y: 999 } },
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).toBeNull();
    expect(positions.get("G")).toEqual({ x: 5, y: 5 });
  });

  it("frame (для обводов) = bbox локальных узлов, без вынесенных гостей", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 5, y: 5 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: ["A"], levelPositions: {},
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).not.toBeNull();
    expect(res!.frame).toEqual({ minX: 0, minY: 0, maxX: NODE_W, maxY: 100 });
  });
});

describe("placeGhostsOnRings — вырожденные входы", () => {
  it("нет локальных узлов → null", () => {
    expect(placeGhostsOnRings({
      nodes: [], entities: [leaf("G", [a("D")])], ancestorIds: ["A"], levelPositions: {},
      layoutEdges: [], positions: new Map(),
    })).toBeNull();
  });
  it("нет breadcrumb-предков (нет колец) → null", () => {
    expect(placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: [], levelPositions: {},
      layoutEdges: [], positions: new Map([["L", { x: 0, y: 0 }]]),
    })).toBeNull();
  });
});
