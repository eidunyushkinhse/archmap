import { describe, it, expect } from "vitest";
import { projectGhosts } from "../graph/layout/projectGhosts";
import { autoHandles, assignEdgeHandles } from "../graph/layout/level";
import { layoutLevel } from "../graph/layout/engine";
import { computeContextLayout } from "../graph/layout/context";
import type { Edge as AppEdge, GhostNode, AncestorRef } from "../../types";

// Характеризационные тесты: фиксируют ТЕКУЩЕЕ поведение чистых функций
// раскладки/проекции из LevelGraph.tsx, чтобы предстоящий рефактор (декомпозиция,
// useMemo, ELK) не менял его незаметно. См. REFACTOR_PLAN.md, Фаза 1.

// --- хелперы для построения тестовых сущностей ---

function ghost(id: string, ancestors: AncestorRef[], over: Partial<GhostNode> = {}): GhostNode {
  return {
    id,
    name: id,
    role: null,
    technology: null,
    is_external: false,
    shape: "service",
    node_depth: ancestors.length,
    ancestors,
    pos_x: null,
    pos_y: null,
    is_ghost: true,
    ...over,
  };
}

function edge(id: string, source_id: string, target_id: string, over: Partial<AppEdge> = {}): AppEdge {
  return {
    id,
    label: null,
    technology: null,
    source_id,
    target_id,
    source_handle: null,
    target_handle: null,
    created_at: "2026-06-08T00:00:00Z",
    ...over,
  };
}

function noNaN(positions: Map<string, { x: number; y: number }>): boolean {
  for (const p of positions.values()) {
    if (Number.isNaN(p.x) || Number.isNaN(p.y)) return false;
  }
  return true;
}

// =================== autoHandles ===================

describe("autoHandles", () => {
  it("горизонтальное преобладание: исходящий справа, входящий слева, одиночное ребро в центр", () => {
    const positions = new Map([
      ["s", { x: 0, y: 0 }],
      ["t", { x: 300, y: 10 }],
    ]);
    expect(autoHandles("s", "t", positions, 0, 1)).toEqual({
      sourceHandle: "s--right--1",
      targetHandle: "t--left--1",
    });
  });

  it("цель левее источника: стороны зеркалятся", () => {
    const positions = new Map([
      ["s", { x: 300, y: 0 }],
      ["t", { x: 0, y: 0 }],
    ]);
    expect(autoHandles("s", "t", positions, 0, 1)).toEqual({
      sourceHandle: "s--left--1",
      targetHandle: "t--right--1",
    });
  });

  it("вертикальное преобладание: вниз — bottom→top", () => {
    const positions = new Map([
      ["s", { x: 0, y: 0 }],
      ["t", { x: 5, y: 300 }],
    ]);
    expect(autoHandles("s", "t", positions, 0, 1)).toEqual({
      sourceHandle: "s--bottom--1",
      targetHandle: "t--top--1",
    });
  });

  it("две параллельные связи разводятся по краям (offset 0 и 2)", () => {
    const positions = new Map([
      ["s", { x: 0, y: 0 }],
      ["t", { x: 300, y: 0 }],
    ]);
    expect(autoHandles("s", "t", positions, 0, 2).sourceHandle).toBe("s--right--0");
    expect(autoHandles("s", "t", positions, 1, 2).sourceHandle).toBe("s--right--2");
  });

  it("отсутствующая позиция трактуется как (0,0)", () => {
    const positions = new Map<string, { x: number; y: number }>();
    // оба в (0,0): dx=dy=0 → |dx|>=|dy| → right/left
    expect(autoHandles("s", "t", positions, 0, 1)).toEqual({
      sourceHandle: "s--right--1",
      targetHandle: "t--left--1",
    });
  });
});

// =================== assignEdgeHandles ===================
// Хэндлы считаются от ГОТОВЫХ позиций (чем посчитаны — dagre/ELK — неважно),
// поэтому тестируем чистую функцию на явных позициях, без движка раскладки.

describe("assignEdgeHandles", () => {
  const ab = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 400, y: 0 }],
  ]);

  it("без валидных хэндлов назначает autoHandles по позициям", () => {
    const edgeHandles = assignEdgeHandles([{ id: "a" }, { id: "b" }], [edge("e1", "a", "b")], ab);
    expect(edgeHandles.get("e1")).toEqual({
      sourceHandle: "a--right--1",
      targetHandle: "b--left--1",
    });
  });

  it("валидные сохранённые хэндлы (префикс совпадает) сохраняются как есть", () => {
    const edgeHandles = assignEdgeHandles(
      [{ id: "a" }, { id: "b" }],
      [edge("e1", "a", "b", { source_handle: "a--top--0", target_handle: "b--bottom--2" })],
      ab,
    );
    expect(edgeHandles.get("e1")).toEqual({
      sourceHandle: "a--top--0",
      targetHandle: "b--bottom--2",
    });
  });

  it("хэндл с чужим префиксом невалиден → откат к autoHandles", () => {
    const edgeHandles = assignEdgeHandles(
      [{ id: "a" }, { id: "b" }],
      // source_handle ссылается на другой узел — невалиден для текущей проекции
      [edge("e1", "a", "b", { source_handle: "x--top--0", target_handle: "b--bottom--2" })],
      ab,
    );
    expect(edgeHandles.get("e1")).toEqual({
      sourceHandle: "a--right--1",
      targetHandle: "b--left--1",
    });
  });

  it("ребро на отсутствующий узел игнорируется", () => {
    const edgeHandles = assignEdgeHandles(
      [{ id: "a" }],
      [edge("e1", "a", "missing")],
      new Map([["a", { x: 0, y: 0 }]]),
    );
    expect(edgeHandles.has("e1")).toBe(false);
  });
});

// =================== layoutLevel (ELK) ===================

describe("layoutLevel", () => {
  it("сохранённые координаты переопределяют раскладку ELK", async () => {
    const { positions } = await layoutLevel(
      [
        { id: "a", savedPos: { x: 111, y: 222 } },
        { id: "b", savedPos: { x: 333, y: 444 } },
      ],
      [edge("e1", "a", "b")],
    );
    expect(positions.get("a")).toEqual({ x: 111, y: 222 });
    expect(positions.get("b")).toEqual({ x: 333, y: 444 });
  });
});

// =================== projectGhosts ===================

describe("projectGhosts", () => {
  // гость глубоко вложен: root → A → B → (гость)
  const anc: AncestorRef[] = [
    { id: "root", name: "Root" },
    { id: "A", name: "A" },
    { id: "B", name: "B" },
  ];

  it("по умолчанию гость сворачивается к верхнему контейнеру ниже общего предка", () => {
    const r = projectGhosts([ghost("g1", anc)], ["root"], new Set());
    expect(r.ghostToEffective.get("g1")).toBe("A");
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0]).toMatchObject({ kind: "container", id: "A" });
  });

  it("раскрытие A углубляет проекцию до B", () => {
    const r = projectGhosts([ghost("g1", anc)], ["root"], new Set(["A"]));
    expect(r.ghostToEffective.get("g1")).toBe("B");
    expect(r.entities[0]).toMatchObject({ kind: "container", id: "B" });
  });

  it("раскрытие A и B показывает самого гостя (лист) и фиксирует emergedFrom", () => {
    const r = projectGhosts([ghost("g1", anc)], ["root"], new Set(["A", "B"]));
    expect(r.ghostToEffective.get("g1")).toBe("g1");
    expect(r.entities[0]).toMatchObject({ kind: "leaf", id: "g1" });
    expect(r.emergedFrom.get("g1")).toBe("B");
  });

  it("нет общего предка-рамки → гость показывается как лист", () => {
    const r = projectGhosts([ghost("g1", [{ id: "X", name: "X" }])], ["root"], new Set());
    expect(r.ghostToEffective.get("g1")).toBe("g1");
    expect(r.entities[0]).toMatchObject({ kind: "leaf", id: "g1" });
  });

  it("два гостя под одним свёрнутым контейнером схлопываются в одну сущность", () => {
    const g2 = ghost("g2", anc);
    const r = projectGhosts([ghost("g1", anc), g2], ["root"], new Set());
    expect(r.entities).toHaveLength(1);
    expect(r.ghostToEffective.get("g1")).toBe("A");
    expect(r.ghostToEffective.get("g2")).toBe("A");
  });
});

// =================== computeContextLayout ===================

describe("computeContextLayout", () => {
  const leaf = (id: string) => ({ kind: "leaf" as const, id, ghost: ghost(id, []) });

  it("фокус стоит ровно в центре (0, -h/2), без NaN", () => {
    const entities = [leaf("out"), leaf("in")];
    const edges = [edge("e1", "f", "out"), edge("e2", "in", "f")];
    const r = computeContextLayout("f", 100, entities, edges, [], new Set());
    expect(r.positions.get("f")).toEqual({ x: 0, y: -50 });
    expect(noNaN(r.positions)).toBe(true);
  });

  it("исходящий сосед уходит вправо (x>0), входящий — влево (x<0)", () => {
    const entities = [leaf("out"), leaf("in")];
    const edges = [edge("e1", "f", "out"), edge("e2", "in", "f")];
    const r = computeContextLayout("f", 100, entities, edges, [], new Set());
    expect(r.positions.get("out")!.x).toBeGreaterThan(0);
    expect(r.positions.get("in")!.x).toBeLessThan(0);
  });

  it("двунаправленный сосед при равенстве чистых колонок встаёт справа", () => {
    const entities = [leaf("out"), leaf("in"), leaf("bi")];
    const edges = [
      edge("e1", "f", "out"),
      edge("e2", "in", "f"),
      edge("e3", "f", "bi"),
      edge("e4", "bi", "f"),
    ];
    const r = computeContextLayout("f", 100, entities, edges, [], new Set());
    // pureRight=[out], pureLeft=[in] → равны → bidi справа
    expect(r.positions.get("bi")!.x).toBeGreaterThan(0);
  });
});
