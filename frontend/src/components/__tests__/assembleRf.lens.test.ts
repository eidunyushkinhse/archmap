// Лупа «Раскрыть содержимое» на предельной инлайн-глубине (container.md C8).
//
// Раньше на пределе кнопка просто исчезала. Теперь она остаётся, но неактивна
// (expandLimited) и по клику объясняет предел — гейт САМОГО раскрытия при этом не
// меняется: колбэк onExpand на пределе по-прежнему не задаётся.
import { describe, it, expect, vi } from "vitest";
import { assembleRfGraph, type AssembleCallbacks } from "../graph/assembleRf";
import type { LayoutResult } from "../graph/layout/pipeline";
import type { BlockData, ContainerData } from "../graph/types";
import type { Node as AppNode, AncestorRef } from "../../types";

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });

function appNode(id: string, kids: boolean): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: "P", shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1,
    created_at: "", updated_at: "", has_children: kids, child_count: kids ? 2 : 0,
  } as AppNode;
}

// Рамка раскрытия: nesting считается по вложенности memberIds (внешняя — надмножество).
function frame(id: string, depth: number, members: string[]) {
  return {
    id, name: id, depth, native: false, memberIds: new Set(members),
    content: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    rect: { x: 0, y: 0, w: 100, h: 100 },
  };
}

// Сцена: узел на уровне (nesting 0) → рамка F1 (nesting 1) → рамка F2 (nesting 2).
// F1 накрывает всех, F2 — только своих: этого хватает parentFrameOf, чтобы увидеть
// F1 родителем F2.
const layout: LayoutResult = {
  nodes: [appNode("onLevel", true), appNode("in1", true), appNode("in2", true), appNode("leaf2", false)],
  entities: [
    { kind: "container", id: "cLevel", name: "cLevel", depth: 1, ancestors: [a("R")], is_external: true },
    { kind: "container", id: "cIn2", name: "cIn2", depth: 1, ancestors: [a("R")], is_external: true },
  ],
  positions: new Map(
    ["onLevel", "in1", "in2", "leaf2", "cLevel", "cIn2"].map((id) => [id, { x: 0, y: 0 }])
  ),
  edgeHandles: new Map(),
  guestFrames: [
    frame("F1", 1, ["in1", "in2", "leaf2", "cIn2"]),
    frame("F2", 2, ["in2", "leaf2", "cIn2"]),
  ],
  frameEnds: [],
  groupArr: [],
  spacers: [],
};

const cb = (): AssembleCallbacks => ({
  drillWithPath: vi.fn(), expandContainer: vi.fn(), expandLocalContainer: vi.fn(),
  collapseContainer: vi.fn(), openEdgeMembers: vi.fn(),
  quickConnect: { enter: vi.fn(), leave: vi.fn(), activate: vi.fn() },
});

function lensOf(): Map<string, { active: boolean; limited: boolean }> {
  const { nextNodes } = assembleRfGraph({
    layout, isArchitect: true, isReadOnly: false, drillNav: true,
    depth: 0, schemaView: "all", getCb: cb,
  });
  const out = new Map<string, { active: boolean; limited: boolean }>();
  for (const n of nextNodes) {
    if (n.type !== "block" && n.type !== "container") continue;
    const d = n.data as BlockData | ContainerData;
    out.set(n.id, { active: !!d.onExpand, limited: !!d.expandLimited });
  }
  return out;
}

describe("assembleRfGraph — лупа на предельной инлайн-глубине (C8)", () => {
  it("до предела лупа активна, на пределе — неактивна", () => {
    const l = lensOf();
    expect(l.get("onLevel")).toEqual({ active: true, limited: false });  // nesting 0
    expect(l.get("in1")).toEqual({ active: true, limited: false });      // nesting 1
    expect(l.get("in2")).toEqual({ active: false, limited: true });      // nesting 2 — предел
  });

  it("у узла без детей лупы нет вовсе — ни активной, ни неактивной", () => {
    expect(lensOf().get("leaf2")).toEqual({ active: false, limited: false });
  });

  it("гостевой контейнер подчиняется тому же пределу", () => {
    const l = lensOf();
    expect(l.get("cLevel")).toEqual({ active: true, limited: false });
    expect(l.get("cIn2")).toEqual({ active: false, limited: true });
  });
});
