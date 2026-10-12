import { describe, it, expect } from "vitest";
import { buildLocalBlocks } from "../graph/layout/localBlocks";
import { NODE_W, NODE_H, BOUNDARY_PAD, BOUNDARY_STEP, BOUNDARY_LABEL_PAD, BOUNDARY_LABEL_STEP } from "../graph/constants";
import type { LayoutEdge, Node as AppNode } from "../../types";

// Блоки раскрытых локалов на свежей сцене (Ф4б, шаги 3–4): мини-раскладка детей, контейнер
// — узел размера своей рамки, дети внутрь, доводка порядка по внешним связям.

function appNode(id: string, parent_id = "P"): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1,
    created_at: "", updated_at: "", has_children: false, child_count: 0,
  } as AppNode;
}
function edge(id: string, source_id: string, target_id: string): LayoutEdge {
  return { id, label: null, technology: null, source_id, target_id, version: 1, created_at: "" };
}

describe("buildLocalBlocks — блок раскрытого локала", () => {
  it("рамка = bbox детей + поля C12; дети внутри от угла рамки; внутренние рёбра выброшены, внешние подняты к блоку", async () => {
    const blocks = await buildLocalBlocks({
      absorbed: new Set(["C"]),
      localChildren: { C: [appNode("a", "C"), appNode("b", "C")] },
      layoutEdges: [edge("eab", "a", "b"), edge("eax", "a", "X"), edge("eyb", "Y", "b")],
    });
    expect(blocks).not.toBeNull();
    const [c] = blocks!.top;
    expect(c.id).toBe("C");
    expect(c.rings).toBe(0);
    expect(c.pad).toBe(BOUNDARY_PAD);
    // bbox листьев начинается в (pad, pad) от угла рамки (свёртка MULTI_EDGE мини-раскладки
    // вольна поставить пару a→b и в ряд — форма подграфа здесь не нормируется)
    const a = c.leafRel.get("a")!, b = c.leafRel.get("b")!;
    expect(Math.min(a.x, b.x)).toBe(BOUNDARY_PAD);
    expect(Math.min(a.y, b.y)).toBe(BOUNDARY_PAD);
    expect(a).not.toEqual(b);
    expect(c.frame.w).toBe(Math.max(a.x, b.x) + NODE_W - Math.min(a.x, b.x) + 2 * BOUNDARY_PAD);
    expect(c.frame.h).toBe(Math.max(a.y, b.y) + NODE_H - Math.min(a.y, b.y) + 2 * BOUNDARY_PAD + BOUNDARY_LABEL_PAD);
    expect(blocks!.blockOf.get("a")).toBe("C");
    expect(blocks!.blockOf.get("b")).toBe("C");
    const lifted = blocks!.liftEdges([edge("eab", "a", "b"), edge("eax", "a", "X"), edge("eyb", "Y", "b")]);
    expect(lifted.map((e) => `${e.source_id}>${e.target_id}`)).toEqual(["C>X", "Y>C"]);
    expect(lifted[0].id).toBe("eax"); // id ребра сохранён — по нему плашка подписи в ELK
  });

  it("place: листья ставятся от позиции блока, запись блока удаляется, позиция контейнера — левый-верх bbox детей (C6)", async () => {
    const blocks = await buildLocalBlocks({
      absorbed: new Set(["C"]),
      localChildren: { C: [appNode("a", "C"), appNode("b", "C")] },
      layoutEdges: [edge("eab", "a", "b")],
    });
    const c = blocks!.top[0];
    const positions = new Map([["C", { x: 100, y: 200 }], ["X", { x: 900, y: 0 }]]);
    const origins = blocks!.place(positions);
    expect(positions.has("C")).toBe(false);
    expect(positions.get("a")).toEqual({ x: 100 + c.leafRel.get("a")!.x, y: 200 + c.leafRel.get("a")!.y });
    expect(origins.get("C")).toEqual({ x: 100 + BOUNDARY_PAD, y: 200 + BOUNDARY_PAD });
    expect(positions.get("X")).toEqual({ x: 900, y: 0 }); // чужие не тронуты
  });

  it("вложенный блок: родитель получает кольцо (поля 64/54), вложенная рамка целиком внутри родительской", async () => {
    const blocks = await buildLocalBlocks({
      absorbed: new Set(["C", "D"]),
      localChildren: { C: [appNode("D", "C"), appNode("a", "C")], D: [appNode("d1", "D"), appNode("d2", "D")] },
      layoutEdges: [edge("e1", "d1", "d2"), edge("e2", "a", "d1")],
    });
    expect(blocks!.top.map((b) => b.id)).toEqual(["C"]);
    const c = blocks!.top[0];
    const d = c.nested[0];
    expect(d.id).toBe("D");
    expect(d.rings).toBe(0);
    expect(c.rings).toBe(1);
    expect(c.pad).toBe(BOUNDARY_PAD + BOUNDARY_STEP);
    expect(c.frame.h).toBeGreaterThan(d.frame.h + BOUNDARY_LABEL_PAD + BOUNDARY_LABEL_STEP);
    const dAt = c.nestedRel.get("D")!;
    expect(dAt.x).toBeGreaterThanOrEqual(c.pad - BOUNDARY_PAD); // рамка D внутри рамки C с запасом поля C минус поле D
    expect(dAt.x + d.frame.w).toBeLessThanOrEqual(c.frame.w - (c.pad - BOUNDARY_PAD));
    // листья D в leafRel родителя — через угол вложенной рамки
    expect(c.leafRel.get("d1")).toEqual({ x: dAt.x + d.leafRel.get("d1")!.x, y: dAt.y + d.leafRel.get("d1")!.y });
    const positions = new Map([["C", { x: 0, y: 0 }]]);
    const origins = blocks!.place(positions);
    expect(origins.has("C")).toBe(true);
    expect(origins.has("D")).toBe(true);
    expect(positions.has("d1") && positions.has("d2") && positions.has("a")).toBe(true);
  });

  it("доводка порядка (шаг 4): ребёнок, связанный с соседом слева от блока, уезжает в левый слот ряда; ширина ряда прежняя", async () => {
    // a и b — один ряд (оба → c); внешний X далеко слева связан с b
    const blocks = await buildLocalBlocks({
      absorbed: new Set(["C"]),
      localChildren: { C: [appNode("a", "C"), appNode("b", "C"), appNode("c", "C")] },
      layoutEdges: [edge("e1", "a", "c"), edge("e2", "b", "c"), edge("e3", "X", "b")],
    });
    const c = blocks!.top[0];
    const a0 = c.leafRel.get("a")!, b0 = c.leafRel.get("b")!;
    expect(a0.y).toBe(b0.y); // один ряд
    const slots = [a0.x, b0.x].sort((p, q) => p - q);
    const positions = new Map([["C", { x: 0, y: 0 }], ["X", { x: -2000, y: 0 }]]);
    blocks!.place(positions);
    const a = positions.get("a")!, b = positions.get("b")!;
    expect(b.x).toBeLessThan(a.x);
    expect([b.x, a.x]).toEqual(slots); // те же слоты, другой порядок
  });

  it("без раскрытых локалов — null", async () => {
    expect(await buildLocalBlocks({ absorbed: new Set(), localChildren: {}, layoutEdges: [] })).toBeNull();
  });
});
