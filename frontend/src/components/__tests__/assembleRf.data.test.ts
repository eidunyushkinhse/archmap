// Данные RF-узлов из раскладки (assembleRfGraph) для локалов, гостей, свёрнутых гостевых
// контейнеров и рамок раскрытия — характеризация Ф0 эпика «Элемент архитектуры»
// (docs/plan-c4-elements.md, scout-canvas §7.4). Эпик добавит сюда элемент узла; до тех
// пор сборка обязана отдавать ровно это (холст, полигон и тесты LevelGraph на ней стоят).
import { describe, it, expect, vi } from "vitest";
import { assembleRfGraph, type AssembleCallbacks } from "../graph/assembleRf";
import type { LayoutResult } from "../graph/layout/pipeline";
import type { BlockData, ContainerData, FrameData, GhostData } from "../graph/types";
import type { Node as AppNode, AncestorRef, GhostNode } from "../../types";

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });

function appNode(id: string, over: Partial<AppNode> = {}): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: "P", shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1, created_at: "", updated_at: "",
    has_children: false, child_count: 0,
    approval: "in_progress", approval_effective: "in_progress", sites: [],
    ...over,
  } as AppNode;
}

const ghost: GhostNode = {
  id: "g", name: "Гость", role: null, technology: null, is_external: true,
  shape: "service", status: "planned", node_depth: 2, has_children: false, child_count: 0,
  ancestors: [a("R"), a("S")],
} as GhostNode;

// Сцена: на уровне сервис с детьми, лист, база с детьми (данные до проверки формы
// родителя), гость-лист и свёрнутый гостевой контейнер; рамка раскрытия F с ребёнком.
const layout: LayoutResult = {
  nodes: [
    appNode("group", { has_children: true, child_count: 3 }),
    appNode("leaf"),
    appNode("db", { shape: "database", has_children: true, child_count: 1 }),
    appNode("inF"),
  ],
  entities: [
    { kind: "leaf", id: "g", ghost },
    { kind: "container", id: "c", name: "Витрина", depth: 1, ancestors: [a("R")], is_external: false },
  ],
  positions: new Map(["group", "leaf", "db", "inF", "g", "c"].map((id) => [id, { x: 10, y: 20 }])),
  edgeHandles: new Map(),
  guestFrames: [{
    id: "F", name: "Рамка", depth: 1, native: false, memberIds: new Set(["inF"]),
    content: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    rect: { x: 0, y: 0, w: 300, h: 200 },
  }],
  frameEnds: [],
  groupArr: [],
  spacers: [],
} as unknown as LayoutResult;

const callbacks = (): AssembleCallbacks => ({
  drillWithPath: vi.fn(), onEnterNode: vi.fn(), expandContainer: vi.fn(), expandLocalContainer: vi.fn(),
  collapseContainer: vi.fn(), openEdgeMembers: vi.fn(),
  quickConnect: { enter: vi.fn(), leave: vi.fn(), activate: vi.fn() },
});

function assemble(over: { isReadOnly?: boolean; drillNav?: boolean; relevantCounts?: Map<string, number> } = {}) {
  const cb = callbacks();
  const { nextNodes } = assembleRfGraph({
    layout, isArchitect: true, isReadOnly: over.isReadOnly ?? false, drillNav: over.drillNav ?? true,
    relevantCounts: over.relevantCounts, depth: 1, schemaView: "all", getCb: () => cb,
  });
  const byId = new Map(nextNodes.map((n) => [n.id, n]));
  return { cb, byId, order: nextNodes.map((n) => `${n.type}:${n.id}`) };
}

describe("assembleRfGraph — данные узлов", () => {
  it("порядок и типы: рамки первыми, затем блоки, гости и свёрнутые контейнеры", () => {
    expect(assemble().order).toEqual([
      "frame:F", "block:group", "block:leaf", "block:db", "block:inF", "ghost:g", "container:c",
    ]);
  });

  it("локал: лупа и бейдж — у сервиса с детьми; база с детьми и лист — без лупы", () => {
    const { byId, cb } = assemble();
    const data = (id: string) => byId.get(id)?.data as BlockData;
    expect(data("group").badgeCount).toBe(3);
    expect(data("group").onExpand).toBeTypeOf("function");
    expect(data("group").expandLimited).toBe(false);
    expect(data("group").dashed).toBeUndefined();
    data("group").onExpand?.("group");
    expect(cb.expandLocalContainer).toHaveBeenCalledWith("group");
    expect(data("leaf").onExpand).toBeUndefined();
    expect(data("leaf").badgeCount).toBe(0);
    expect(data("db").onExpand).toBeUndefined();
    expect(data("db").badgeCount).toBe(1); // число детей приходит как есть, гейт — форма
    expect(data("db").expandLimited).toBe(false);
    // редактор: «Войти», хэндлы и быстрая связь
    expect(data("leaf").onDrillDown).toBeTypeOf("function");
    expect(data("leaf").connectable).toBe(true);
    expect(data("leaf").quickConnect).toBe(cb.quickConnect);
  });

  it("локал на странице: лупа и бейдж по релевантным детям, без «Войти» и хэндлов", () => {
    const { byId } = assemble({ isReadOnly: true, drillNav: false, relevantCounts: new Map([["group", 0], ["leaf", 2]]) });
    const data = (id: string) => byId.get(id)?.data as BlockData;
    expect(data("group").onExpand).toBeUndefined();
    expect(data("group").badgeCount).toBe(0);
    expect(data("leaf").onExpand).toBeTypeOf("function");
    expect(data("leaf").badgeCount).toBe(2);
    expect(data("leaf").onDrillDown).toBeUndefined();
    expect(data("leaf").connectable).toBe(false);
  });

  it("ребёнок рамки раскрытия — compound: parentId рамки и координаты в её системе", () => {
    const n = assemble().byId.get("inF");
    expect(n?.parentId).toBe("F");
    expect(n?.position).toEqual({ x: 10, y: 20 });
    expect(assemble().byId.get("leaf")?.parentId).toBeUndefined();
  });

  it("гость-лист: узел-проекция и «Войти» по пути предков плюс он сам", () => {
    const { byId, cb } = assemble();
    const data = byId.get("g")?.data as GhostData;
    expect(data.appNode).toBe(ghost);
    data.onEnter?.();
    expect(cb.onEnterNode).toHaveBeenCalledWith([a("R"), a("S"), { id: "g", name: "Гость", is_external: true }]);
  });

  it("свёрнутый гостевой контейнер: имя, глубина, предки, лупа и «Войти»", () => {
    const { byId, cb } = assemble();
    const data = byId.get("c")?.data as ContainerData;
    expect(data).toMatchObject({ id: "c", name: "Витрина", depth: 1, ancestors: [a("R")], expandLimited: false });
    data.onExpand?.("c");
    expect(cb.expandContainer).toHaveBeenCalledWith("c");
    data.onEnter?.();
    expect(cb.onEnterNode).toHaveBeenCalledWith([a("R"), { id: "c", name: "Витрина", is_external: false }]);
    expect(assemble({ drillNav: false }).byId.get("c")?.data).toMatchObject({ onEnter: undefined });
  });

  it("рамка раскрытия без декора: имя и свёртка, не таскается и не выделяется", () => {
    const { byId, cb } = assemble();
    const f = byId.get("F");
    expect(f).toMatchObject({ type: "frame", draggable: false, selectable: false, zIndex: -1, width: 300, height: 200 });
    const data = f?.data as FrameData;
    expect(Object.keys(data).sort()).toEqual(["name", "onCollapse"]);
    expect(data.name).toBe("Рамка");
    data.onCollapse?.();
    expect(cb.collapseContainer).toHaveBeenCalledWith("F");
  });
});
