import { describe, it, expect } from "vitest";
import { projectGhosts } from "../graph/layout/projectGhosts";
import { autoHandles, assignEdgeHandles } from "../graph/layout/level";
import { layoutLevel } from "../graph/layout/engine";
import type { LayoutEdge, GhostNode, AncestorRef } from "../../types";

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
    has_children: false,
    child_count: 0,
    ancestors,
    status: "existing",
    is_ghost: true,
    ...over,
  };
}

function edge(id: string, source_id: string, target_id: string, over: Partial<LayoutEdge> = {}): LayoutEdge {
  return {
    id,
    label: null,
    technology: null,
    source_id,
    target_id,
    version: 1,
    created_at: "2026-06-08T00:00:00Z",
    ...over,
  };
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

  it("назначает autoHandles по позициям (ручных хэндлов больше нет)", () => {
    const edgeHandles = assignEdgeHandles([{ id: "a" }, { id: "b" }], [edge("e1", "a", "b")], ab);
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
    { id: "root", name: "Root", is_external: false },
    { id: "A", name: "A", is_external: false },
    { id: "B", name: "B", is_external: false },
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

  it("нет общего предка-рамки, но есть контейнер-предок → сворачивается к нему (не голый лист)", () => {
    // напр. лист «БД» под корнем «Объекты мониторинга» (корень-сосед текущей ветки):
    // общего breadcrumb-предка нет, но гость всё равно представлен верхним контейнером.
    const r = projectGhosts([ghost("g1", [{ id: "X", name: "X", is_external: false }])], ["root"], new Set());
    expect(r.ghostToEffective.get("g1")).toBe("X");
    expect(r.entities[0]).toMatchObject({ kind: "container", id: "X" });
  });

  it("раскрытие верхнего контейнера без общего предка обнажает лист и фиксирует emergedFrom", () => {
    const r = projectGhosts([ghost("g1", [{ id: "X", name: "X", is_external: false }])], ["root"], new Set(["X"]));
    expect(r.ghostToEffective.get("g1")).toBe("g1");
    expect(r.entities[0]).toMatchObject({ kind: "leaf", id: "g1" });
    expect(r.emergedFrom.get("g1")).toBe("X");
  });

  it("гость вовсе без предков (сам корень) → показывается листом", () => {
    const r = projectGhosts([ghost("g1", [])], ["root"], new Set());
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
