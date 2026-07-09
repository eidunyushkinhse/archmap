import { describe, it, expect } from "vitest";
import { projectGhosts } from "../graph/layout/projectGhosts";
import { autoHandles, assignEdgeHandles } from "../graph/layout/level";
import { layoutLevel } from "../graph/layout/engine";
import { computeContextLayout } from "../graph/layout/context";
import { NODE_H } from "../graph/constants";
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

  // Регрессия: раскрытие промежуточного контейнера не должно «угонять» его детей в
  // другую часть колонки. Сценарий Account Synchronizer: фокус f (предки HelixMon→UM),
  // все связи исходящие → правая колонка. Соседи umk/selfiam делят с f рамку UM (lcaIdx=1),
  // ObsCore — только HelixMon (lcaIdx=0), потому стоит снаружи (выше центрированного соседа).
  it("раскрытие промежуточного контейнера держит детей на той же стороне, соседи не прыгают", () => {
    const anc = ["I", "UM"];
    const I: AncestorRef = { id: "I", name: "I", is_external: false };
    const UM: AncestorRef = { id: "UM", name: "UM", is_external: false };
    const Mon: AncestorRef = { id: "ObsCore", name: "ObsCore", is_external: false };
    const leafA = (id: string, a: AncestorRef[]) => ({ kind: "leaf" as const, id, ghost: ghost(id, a) });
    const container = (id: string, a: AncestorRef[]) =>
      ({ kind: "container" as const, id, name: id, depth: a.length, ancestors: a, is_external: false });
    const cy = (m: Map<string, { x: number; y: number }>, id: string) => m.get(id)!.y + NODE_H / 2;

    const baseEdges = [edge("e1", "f", "umk"), edge("e2", "f", "selfiam")];
    // свёрнуто: umk, selfiam и контейнер ObsCore
    const r1 = computeContextLayout(
      "f", NODE_H,
      [leafA("umk", [I, UM]), leafA("selfiam", [I, UM]), container("ObsCore", [I])],
      [...baseEdges, edge("e3", "f", "ObsCore")], anc, new Set(),
    );
    const cUmk = cy(r1.positions, "umk");
    const cSelf = cy(r1.positions, "selfiam");
    const cMon = cy(r1.positions, "ObsCore");
    expect(cMon).toBeLessThan(0); // свёрнутый ObsCore — выше фокуса

    // раскрыто: дети grafana/zabbix вместо контейнера
    const r2 = computeContextLayout(
      "f", NODE_H,
      [leafA("umk", [I, UM]), leafA("selfiam", [I, UM]), leafA("grafana", [I, Mon]), leafA("zabbix", [I, Mon])],
      [...baseEdges, edge("e4", "f", "grafana"), edge("e5", "f", "zabbix")], anc, new Set(["ObsCore"]),
    );
    // соседи не из ObsCore стоят ровно там же, где и были
    expect(cy(r2.positions, "umk")).toBe(cUmk);
    expect(cy(r2.positions, "selfiam")).toBe(cSelf);
    // дети остались ВЫШЕ фокуса (на стороне свёрнутого ObsCore), а не уехали вниз колонки
    expect(cy(r2.positions, "grafana")).toBeLessThan(0);
    expect(cy(r2.positions, "zabbix")).toBeLessThan(0);
  });
});
