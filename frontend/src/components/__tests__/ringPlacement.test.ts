import { describe, it, expect } from "vitest";
import { placeGhostsOnRings } from "../graph/layout/ringPlacement";
import { enforceFramesKeepOut } from "../graph/layout/keepGhostsOut";
import { NODE_W, NODE_H } from "../graph/constants";
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
      ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
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
      ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
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
      nodes: [node("L")], entities: ents, ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
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
      ancestorIds: ["A", "B"], levelPositions: {}, expanded: new Set(),
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

describe("placeGhostsOnRings — внутренняя полка детей гостевой рамки (D1)", () => {
  // Вертикальный столбец локалов La/Lb/Lc; раскрытая гостевая рамка P с детьми g1/g2/g3,
  // каждый связан со своим локалом. Гость садится сбоку (горизонтальные связи не режут
  // соседей) → дети встают одной вертикальной полкой в ПОРЯДКЕ ЯКОРЕЙ (по проекции y
  // связанных локалов), независимо от входных ELK-позиций детей.
  const vertLocals = () => ({
    nodes: [node("La"), node("Lb"), node("Lc")],
    entities: [leaf("g1", [a("P")]), leaf("g2", [a("P")]), leaf("g3", [a("P")])],
    ancestorIds: ["A"], levelPositions: {} as Record<string, { pos_x: number; pos_y: number; anchor_rel: boolean }>,
    expanded: new Set(["P"]),
    layoutEdges: [edge("e1", "g1", "La"), edge("e2", "g2", "Lb"), edge("e3", "g3", "Lc")],
  });
  const localPos = (): [string, { x: number; y: number }][] => [
    ["La", { x: 0, y: 0 }], ["Lb", { x: 0, y: 260 }], ["Lc", { x: 0, y: 520 }],
  ];

  it("дети упорядочены по якорю и стоят одной колонкой", () => {
    // входные позиции детей НАМЕРЕННО перепутаны относительно их якорей
    const positions = new Map([
      ...localPos(),
      ["g1", { x: 5, y: 999 }], ["g2", { x: 5, y: 5 }], ["g3", { x: 5, y: 480 }],
    ]);
    const res = placeGhostsOnRings({ ...vertLocals(), positions });
    expect(res).not.toBeNull();
    const g1 = positions.get("g1")!, g2 = positions.get("g2")!, g3 = positions.get("g3")!;
    // порядок по якорю: La(y0) < Lb(y260) < Lc(y520) → g1 выше g2 выше g3
    expect(g1.y).toBeLessThan(g2.y);
    expect(g2.y).toBeLessThan(g3.y);
    // одна колонка — общий x
    expect(g1.x).toBe(g2.x);
    expect(g2.x).toBe(g3.x);
    // якоря разнесены > NODE_H+зазор → дети сидят РОВНО на проекциях якорей (Δ = Δлокалов)
    expect(g2.y - g1.y).toBeCloseTo(260);
    expect(g3.y - g2.y).toBeCloseTo(260);
  });

  it("раскладка не зависит от входных ELK-позиций детей", () => {
    const run = (childPos: [string, { x: number; y: number }][]) => {
      const positions = new Map([...localPos(), ...childPos]);
      placeGhostsOnRings({ ...vertLocals(), positions });
      return ["g1", "g2", "g3"].map((id) => positions.get(id)!);
    };
    const a1 = run([["g1", { x: 5, y: 999 }], ["g2", { x: 5, y: 5 }], ["g3", { x: 5, y: 480 }]]);
    const a2 = run([["g1", { x: 700, y: 12 }], ["g2", { x: 5, y: 700 }], ["g3", { x: 5, y: 50 }]]);
    expect(a2).toEqual(a1);
  });

  it("после внутренней полки enforceFramesKeepOut — no-op (рамка села на буфер)", () => {
    const positions = new Map([
      ...localPos(),
      ["g1", { x: 5, y: 999 }], ["g2", { x: 5, y: 5 }], ["g3", { x: 5, y: 480 }],
    ]);
    placeGhostsOnRings({ ...vertLocals(), positions });
    const v = vertLocals();
    const enf = enforceFramesKeepOut({
      nodes: v.nodes, entities: v.entities, ancestorIds: v.ancestorIds,
      layoutEdges: v.layoutEdges, positions,
    });
    expect(enf).toBeNull();
  });
});

describe("placeGhostsOnRings — ручные позиции", () => {

  it("гость с ручной позицией не двигается; один такой → null", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 5, y: 5 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: ["A"],
      levelPositions: { G: { pos_x: 999, pos_y: 999, anchor_rel: false } }, expanded: new Set(),
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).toBeNull();
    expect(positions.get("G")).toEqual({ x: 5, y: 5 });
  });

  it("frame (для обводов) = bbox локальных узлов, без вынесенных гостей", () => {
    const positions = new Map([["L", { x: 0, y: 0 }], ["G", { x: 5, y: 5 }]]);
    const res = placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).not.toBeNull();
    expect(res!.frame).toEqual({ minX: 0, minY: 0, maxX: NODE_W, maxY: 100 });
  });
});

describe("placeGhostsOnRings — живой якорь и офсеты владеемой группы (D2/D3)", () => {
  // Раскрытая гостевая рамка P (expanded) с детьми g1/g2, у каждого СОХРАНЁННЫЙ офсет
  // (anchor_rel=true). Абсолют = anchorG + офсет, где anchorG — центроид связанных локалов.
  const owned = (localX: number) => {
    const positions = new Map([
      ["La", { x: localX, y: 0 }], ["Lb", { x: localX, y: 200 }],
      ["g1", { x: 0, y: 0 }], ["g2", { x: 0, y: 0 }], // savedPos не важен — owned-проход перезапишет
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("La"), node("Lb")],
      entities: [leaf("g1", [a("P")]), leaf("g2", [a("P")])],
      ancestorIds: ["A"],
      levelPositions: {
        g1: { pos_x: 50, pos_y: -30, anchor_rel: true },
        g2: { pos_x: 50, pos_y: 80, anchor_rel: true },
      },
      expanded: new Set(["P"]),
      layoutEdges: [edge("e1", "g1", "La"), edge("e2", "g2", "Lb")],
      positions,
    });
    return { positions, res };
  };

  it("восстановление = anchorG + офсет", () => {
    const { positions, res } = owned(0);
    expect(res).not.toBeNull();
    // anchorG = центроид центров La(95,50) и Lb(95,250) = (95,150); g1 = anchorG + (50,-30)
    const g1 = positions.get("g1")!;
    expect(g1.x).toBeCloseTo(NODE_W / 2 + 50);
    expect(g1.y).toBeCloseTo(150 - 30);
    expect(res!.placedOutside.has("g1")).toBe(true);
  });

  it("сдвиг локалов двигает рамку за якорем, относительная расстановка стабильна", () => {
    const a0 = owned(0).positions;
    const a1 = owned(300).positions;
    const g1a = a0.get("g1")!, g2a = a0.get("g2")!;
    const g1b = a1.get("g1")!, g2b = a1.get("g2")!;
    // локалы уехали на +300 по x → anchorG тоже → оба ребёнка сдвинулись на +300
    expect(g1b.x - g1a.x).toBeCloseTo(300);
    expect(g2b.x - g2a.x).toBeCloseTo(300);
    expect(g1b.y).toBeCloseTo(g1a.y);
    // взаимное расположение детей не изменилось
    expect(g2b.x - g1b.x).toBeCloseTo(g2a.x - g1a.x);
    expect(g2b.y - g1b.y).toBeCloseTo(g2a.y - g1a.y);
  });

  it("легаси-абсолют ребёнка раскрытой рамки мигрирует в офсет, не двигаясь", () => {
    const positions = new Map([
      ["La", { x: 0, y: 0 }], ["Lb", { x: 0, y: 200 }],
      ["g1", { x: NODE_W / 2 + 50, y: NODE_H / 2 + 70 }], // savedPos = абсолют
    ]);
    const res = placeGhostsOnRings({
      nodes: [node("La"), node("Lb")],
      entities: [leaf("g1", [a("P")])],
      ancestorIds: ["A"],
      levelPositions: { g1: { pos_x: NODE_W / 2 + 50, pos_y: NODE_H / 2 + 70, anchor_rel: false } },
      expanded: new Set(["P"]),
      layoutEdges: [edge("e1", "g1", "La")],
      positions,
    });
    expect(res).not.toBeNull();
    // g1 связан только с La → anchorG = центр La (95,50); на экране узел НЕ двинулся
    expect(positions.get("g1")).toEqual({ x: NODE_W / 2 + 50, y: NODE_H / 2 + 70 });
    // миграция вернула офсет = абсолют − anchorG = (50, 70)
    const mig = res!.migrations.find((m) => m.id === "g1")!;
    expect(mig.pos_x).toBeCloseTo(50);
    expect(mig.pos_y).toBeCloseTo(70);
  });
});

describe("placeGhostsOnRings — вырожденные входы", () => {
  it("нет локальных узлов → null", () => {
    expect(placeGhostsOnRings({
      nodes: [], entities: [leaf("G", [a("D")])], ancestorIds: ["A"], levelPositions: {}, expanded: new Set(),
      layoutEdges: [], positions: new Map(),
    })).toBeNull();
  });
  it("нет breadcrumb-предков (нет колец) → null", () => {
    expect(placeGhostsOnRings({
      nodes: [node("L")], entities: [leaf("G", [a("D")])], ancestorIds: [], levelPositions: {}, expanded: new Set(),
      layoutEdges: [], positions: new Map([["L", { x: 0, y: 0 }]]),
    })).toBeNull();
  });
});
