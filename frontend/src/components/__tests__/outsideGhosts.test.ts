import { describe, it, expect } from "vitest";
import { placeOutsideGhosts } from "../graph/layout/outsideGhosts";
import { NODE_W, NODE_H, BOUNDARY_PAD, BOUNDARY_STEP } from "../graph/constants";
import type { DisplayExternal } from "../graph/types";
import type { Edge as AppEdge, GhostNode, AncestorRef } from "../../types";

// Юнит-тесты выноса внешних гостей в колонки за рамку (R4, шаг 1). Чистые данные,
// ELK не нужен: модуль работает с уже посчитанными позициями. Конвенции — как в
// engine.test.ts (фабрики-хелперы).

function ghost(id: string, ancestors: AncestorRef[] = []): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: true,
    shape: "service", node_depth: 0, has_children: false, ancestors, is_ghost: true,
  };
}
function leaf(id: string, ancestors: AncestorRef[] = []): DisplayExternal {
  return { kind: "leaf", id, ghost: ghost(id, ancestors) };
}
function edge(id: string, source_id: string, target_id: string): AppEdge {
  return {
    id, label: null, technology: null, source_id, target_id,
    source_handle: null, target_handle: null, created_at: "2026-06-10T00:00:00Z",
  };
}
// клиренс колонок (как в модуле) для глубины breadcrumb d
const clearance = (d: number) => BOUNDARY_PAD + (d + 1) * BOUNDARY_STEP + 48;

describe("placeOutsideGhosts — сторона колонки", () => {
  // один локальный узел L в начале координат → рамка bbox (0,0,190,100), midY=50
  const baseLocal = () => ({
    nodes: [{ id: "L" }],
    positions: new Map([["L", { x: 0, y: 0 }]]),
  });

  it("гость-ИСТОЧНИК связи в уровень → левая колонка", () => {
    const { nodes, positions } = baseLocal();
    const res = placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).not.toBeNull();
    // leftX = fMinX − clearance − NODE_W; desiredY центрируется по L (== L.y)
    expect(positions.get("G")).toEqual({ x: 0 - clearance(0) - NODE_W, y: 0 });
  });

  it("гость-ПРИЁМНИК связи из уровня → правая колонка", () => {
    const { nodes, positions } = baseLocal();
    placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [edge("e", "L", "G")], positions,
    });
    expect(positions.get("G")).toEqual({ x: 0 + NODE_W + clearance(0), y: 0 });
  });

  it("приёмник от ЛЕВОГО узла широкой рамки → левая колонка (близость важнее направления)", () => {
    // Широкая рамка: Lleft(0,0) и Lright(600,0) → frameCx=395. Гость G — ПРИЁМНИК от
    // Lleft (по направлению — правая колонка), но Lleft левее центра → кладём СЛЕВА,
    // у ближнего края (раньше улетал колонкой через всю схему вправо).
    const nodes = [{ id: "Lleft" }, { id: "Lright" }];
    const positions = new Map([["Lleft", { x: 0, y: 0 }], ["Lright", { x: 600, y: 0 }]]);
    const res = placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [edge("e", "Lleft", "G")], positions,
    });
    expect(res).not.toBeNull();
    // fMinX=0 → левая колонка; desiredY по Lleft (== 0)
    expect(positions.get("G")).toEqual({ x: 0 - clearance(0) - NODE_W, y: 0 });
  });

  it("источник у ПРАВОГО узла широкой рамки → правая колонка (близость важнее направления)", () => {
    // Зеркально: G — ИСТОЧНИК для Lright (по направлению — левая колонка), но Lright
    // правее центра → правая колонка у ближнего края.
    const nodes = [{ id: "Lleft" }, { id: "Lright" }];
    const positions = new Map([["Lleft", { x: 0, y: 0 }], ["Lright", { x: 600, y: 0 }]]);
    const res = placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [edge("e", "G", "Lright")], positions,
    });
    expect(res).not.toBeNull();
    // fMaxX = 600 + NODE_W = 790 → правая колонка; desiredY по Lright (== 0)
    expect(positions.get("G")).toEqual({ x: 790 + clearance(0), y: 0 });
  });

  it("гость без связей (ничья) → правая колонка (rightVotes >= leftVotes)", () => {
    const { nodes, positions } = baseLocal();
    placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [], positions,
    });
    // desiredY = midY − NODE_H/2 = 50 − 50 = 0
    expect(positions.get("G")).toEqual({ x: NODE_W + clearance(0), y: 0 });
  });
});

describe("placeOutsideGhosts — desiredY и стопка", () => {
  it("desiredY — средний центр связанных локальных узлов", () => {
    // L1 (0,0) и L2 (0,200); гость G — приёмник обоих → правая колонка
    const nodes = [{ id: "L1" }, { id: "L2" }];
    const positions = new Map([
      ["L1", { x: 0, y: 0 }],
      ["L2", { x: 0, y: 200 }],
    ]);
    placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [edge("e1", "L1", "G"), edge("e2", "L2", "G")], positions,
    });
    // центры L1=50, L2=250 → среднее 150; desiredY = 150 − NODE_H/2 = 100
    expect(positions.get("G")!.y).toBe(100);
  });

  it("два гостя одной колонки с близким desiredY разнесены симметрично на ≥ NODE_H + 28", () => {
    // оба гостя — приёмники одного L(0,0) → одинаковый desiredY=0, одна (правая) колонка.
    // PAV расходится симметрично вокруг центра масс (0): −64 и +64, а не 0 и +128.
    const nodes = [{ id: "L" }];
    const positions = new Map([["L", { x: 0, y: 0 }]]);
    placeOutsideGhosts({
      nodes, entities: [leaf("G1"), leaf("G2")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [edge("e1", "L", "G1"), edge("e2", "L", "G2")], positions,
    });
    const y1 = positions.get("G1")!.y, y2 = positions.get("G2")!.y;
    const gap = NODE_H + 28; // 128
    expect(y1).toBe(-gap / 2); // −64
    expect(y2).toBe(gap / 2);  // +64
    expect(Math.abs(y2 - y1)).toBeGreaterThanOrEqual(gap);
    expect(y1 + y2).toBe(0); // центр масс сохранён
  });
});

describe("placeOutsideGhosts — что НЕ выносится", () => {
  it("гость с сохранённой позицией (levelPositions) не выносится → null", () => {
    const nodes = [{ id: "L" }];
    const positions = new Map([
      ["L", { x: 0, y: 0 }],
      ["G", { x: 5, y: 5 }],
    ]);
    const res = placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: [],
      levelPositions: { G: { pos_x: 999, pos_y: 999 } },
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).toBeNull();
    expect(positions.get("G")).toEqual({ x: 5, y: 5 }); // не тронут
  });

  it("гость с предком из breadcrumb (внутренний) не выносится и входит в bbox рамки", () => {
    const nodes = [{ id: "L" }];
    const positions = new Map([
      ["L", { x: 0, y: 0 }],
      ["Gin", { x: 0, y: 300 }],   // внутренний гость, лежит в рамке ниже
      ["Gout", { x: 5, y: 5 }],    // внешний гость (будет вынесен)
    ]);
    const res = placeOutsideGhosts({
      nodes,
      entities: [leaf("Gin", [{ id: "P", name: "P", is_external: false }]), leaf("Gout")],
      stableAncestorIds: ["P"], levelPositions: {},
      layoutEdges: [], positions,
    });
    expect(res).not.toBeNull();
    // bbox рамки = L + внутренний Gin (но НЕ Gout)
    expect(res!.frame).toEqual({ minX: 0, minY: 0, maxX: NODE_W, maxY: 400 });
    expect(positions.get("Gin")).toEqual({ x: 0, y: 300 }); // не тронут
    // Gout — ничья → правая колонка, depth=1
    const midY = (0 + 400) / 2;
    expect(positions.get("Gout")).toEqual({
      x: NODE_W + clearance(1), y: midY - NODE_H / 2,
    });
  });
});

describe("placeOutsideGhosts — рескью улетевшего внутреннего гостя", () => {
  it("внутренний гость, отброшенный ELK вбок за кластер, выносится в колонку у связи", () => {
    // L(0,0) — кластер X∈[0,190]. Внутренний гость Gin (предок P в breadcrumb) ELK
    // забросил далеко вправо (x=1000) — это X целиком вне кластера → «улетел».
    const nodes = [{ id: "L" }];
    const positions = new Map([
      ["L", { x: 0, y: 0 }],
      ["Gin", { x: 1000, y: 0 }],
    ]);
    const res = placeOutsideGhosts({
      nodes,
      entities: [leaf("Gin", [{ id: "P", name: "P", is_external: false }])],
      stableAncestorIds: ["P"], levelPositions: {},
      layoutEdges: [edge("e", "L", "Gin")], positions, // Gin — приёмник → правая колонка
    });
    expect(res).not.toBeNull();
    // рамку считаем БЕЗ улетевшего: bbox = только L
    expect(res!.frame).toEqual({ minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H });
    // вынесен в правую колонку (depth=1) на высоте L
    expect(positions.get("Gin")).toEqual({ x: NODE_W + clearance(1), y: 0 });
    expect(res!.placedOutside.has("Gin")).toBe(true);
  });

  it("внутренний гость в пределах X-кластера (вложен ниже) НЕ трогается", () => {
    // Gin под кластером (x=0 — X пересекается с L), это законная вложенность → null,
    // если других выносимых нет.
    const nodes = [{ id: "L" }];
    const positions = new Map([
      ["L", { x: 0, y: 0 }],
      ["Gin", { x: 0, y: 300 }],
    ]);
    const res = placeOutsideGhosts({
      nodes,
      entities: [leaf("Gin", [{ id: "P", name: "P", is_external: false }])],
      stableAncestorIds: ["P"], levelPositions: {},
      layoutEdges: [edge("e", "L", "Gin")], positions,
    });
    expect(res).toBeNull();
    expect(positions.get("Gin")).toEqual({ x: 0, y: 300 }); // не тронут
  });
});

describe("placeOutsideGhosts — клиренс и null-кейсы", () => {
  it("leftX = fMinX − (BOUNDARY_PAD + (depth+1)·BOUNDARY_STEP + 48) − NODE_W", () => {
    const nodes = [{ id: "L" }];
    const positions = new Map([["L", { x: 0, y: 0 }]]);
    placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: ["A", "B"], levelPositions: {},
      layoutEdges: [edge("e", "G", "L")], positions, // источник → левая колонка
    });
    const expectedLeftX = 0 - (BOUNDARY_PAD + (2 + 1) * BOUNDARY_STEP + 48) - NODE_W;
    expect(positions.get("G")!.x).toBe(expectedLeftX);
  });

  it("пустой уровень (нет локальных узлов) → null, positions не изменён", () => {
    const positions = new Map([["G", { x: 7, y: 7 }]]);
    const res = placeOutsideGhosts({
      nodes: [], entities: [leaf("G")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [], positions,
    });
    expect(res).toBeNull();
    expect(positions.get("G")).toEqual({ x: 7, y: 7 });
  });

  it("нет outside-гостей (все внутренние) → null", () => {
    const nodes = [{ id: "L" }];
    const positions = new Map([["L", { x: 0, y: 0 }]]);
    const res = placeOutsideGhosts({
      nodes, entities: [leaf("Gin", [{ id: "P", name: "P", is_external: false }])],
      stableAncestorIds: ["P"], levelPositions: {},
      layoutEdges: [], positions,
    });
    expect(res).toBeNull();
  });

  it("нет валидного bbox рамки (позиции рамки отсутствуют) → null, positions не изменён", () => {
    const nodes = [{ id: "L" }]; // L нет в positions → bbox = Infinity
    const positions = new Map<string, { x: number; y: number }>();
    const res = placeOutsideGhosts({
      nodes, entities: [leaf("G")], stableAncestorIds: [], levelPositions: {},
      layoutEdges: [edge("e", "G", "L")], positions,
    });
    expect(res).toBeNull();
    expect(positions.has("G")).toBe(false); // гость не вынесен
  });
});
