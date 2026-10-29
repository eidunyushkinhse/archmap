// Проекция хозяина в сборке RF (холст развёртывания, docs/specs/deployment.md):
// декор рамки (FrameData.decor), пометка карточки (BlockData.mark), глубина цвета
// карточки входом (depths — вместо глубины уровня + вложенности рамки) и предел гейта
// лупы входом (maxInlineDepth). Без проекции сборка прежняя: decor/mark не появляются,
// цвет — по вложенности рамки, рамка сворачивается, предел — MAX_INLINE_DEPTH.
import { describe, it, expect, vi } from "vitest";
import { assembleRfGraph, type AssembleCallbacks } from "../graph/assembleRf";
import type { LayoutResult } from "../graph/layout/pipeline";
import type { BlockData, FrameData, FrameDecor, SiteCardData } from "../graph/types";
import { getNodeColors } from "../graph/colors";
import type { Node as AppNode } from "../../types";

function appNode(id: string, kids = false): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: null, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1,
    created_at: "", updated_at: "", has_children: kids, child_count: kids ? 1 : 0,
    approval: "in_progress", approval_effective: "in_progress", sites: [],
    element: null, element_effective: kids ? "system" : "container",
  } as AppNode;
}

function frame(id: string, depth: number, members: string[]) {
  return {
    id, name: id, depth, native: false, memberIds: new Set(members),
    content: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    rect: { x: 0, y: 0, w: 100, h: 100 },
  };
}

// Площадка S ⊃ площадка S2 ⊃ экземпляр «inner» (с детьми — для гейта лупы на
// вложенности 2); экземпляр «a@S» в S; группа «не указано» U с экземпляром «u».
const layout: LayoutResult = {
  nodes: [appNode("a@S"), appNode("inner", true), appNode("u")],
  entities: [],
  positions: new Map(["a@S", "inner", "u"].map((id) => [id, { x: 0, y: 0 }])),
  edgeHandles: new Map(),
  guestFrames: [
    frame("S", 1, ["a@S", "inner"]),
    frame("U", 1, ["u"]),
    frame("S2", 2, ["inner"]),
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

const decorOf = (id: string): FrameDecor | undefined =>
  id === "U" ? { kind: "group", collapsible: false }
  : id.startsWith("S") ? { kind: "site", icon: "kubernetes", collapsible: false }
  : undefined;

function assemble(projection: boolean) {
  return assembleRfGraph({
    layout, isArchitect: true, isReadOnly: true, drillNav: false,
    depth: 0, schemaView: "all", getCb: cb,
    ...(projection
      ? { maxInlineDepth: Infinity, frameDecor: decorOf, marks: { "a@S": "1/2" }, depths: { inner: 0, "a@S": 3 } }
      : null),
  }).nextNodes;
}

describe("assembleRfGraph — проекция хозяина (развёртывание)", () => {
  it("блоки и карточки площадок несут z-index 10 (слой плашек стоит на том же z — LevelGraph.css), рамки ниже нуля", () => {
    // Свёрнутая площадка S3 — карточкой площадки (декор site у узла, не рамки).
    const nodes = assembleRfGraph({
      layout: { ...layout, nodes: [...layout.nodes, appNode("S3")], positions: new Map([...layout.positions, ["S3", { x: 0, y: 0 }]]) },
      isArchitect: true, isReadOnly: true, drillNav: false, depth: 0, schemaView: "all", getCb: cb,
      maxInlineDepth: Infinity, frameDecor: decorOf, marks: {},
    }).nextNodes;
    const z = (id: string) => nodes.find((n) => n.id === id)?.zIndex;
    expect(nodes.find((n) => n.id === "S3")?.type).toBe("site");
    expect([z("a@S"), z("inner"), z("u"), z("S3")]).toEqual([10, 10, 10, 10]);
    expect(z("S")).toBeLessThan(0);
    expect(z("S2")).toBeLessThan(0);
  });

  it("декор рамки доезжает до FrameData; collapsible:false — без onCollapse", () => {
    const nodes = assemble(true);
    const data = (id: string) => nodes.find((n) => n.id === id)!.data as FrameData;
    expect(data("S").decor).toEqual({ kind: "site", icon: "kubernetes", collapsible: false });
    expect(data("S").onCollapse).toBeUndefined();
    expect(data("S2").decor?.kind).toBe("site");
    expect(data("U").decor).toEqual({ kind: "group", collapsible: false });
    expect(data("U").onCollapse).toBeUndefined();
  });

  it("пометка карточки доезжает до BlockData.mark только у помеченных", () => {
    const nodes = assemble(true);
    const block = (id: string) => nodes.find((n) => n.id === id)!.data as BlockData;
    expect(block("a@S").mark).toBe("1/2");
    expect("mark" in block("u")).toBe(false);
  });

  it("глубина цвета — из depths проекции, а не из вложенности рамки; без записи — как прежде", () => {
    const block = (nodes: ReturnType<typeof assemble>, id: string) => nodes.find((n) => n.id === id)!.data as BlockData;
    const withProj = assemble(true);
    // «inner» лежит в рамке глубины 2 (S ⊃ S2), но проекция велит глубину 0; «a@S» — 3
    expect(block(withProj, "inner").colors).toEqual(getNodeColors(false, 0));
    expect(block(withProj, "a@S").colors).toEqual(getNodeColors(false, 3));
    // «u» в depths нет — глубина по вложенности рамки U (1)
    expect(block(withProj, "u").colors).toEqual(getNodeColors(false, 1));
    const plain = assemble(false);
    expect(block(plain, "inner").colors).toEqual(getNodeColors(false, 2));
  });

  it("maxInlineDepth: Infinity — лупа на вложенности 2 активна (без предела C8)", () => {
    const withLimit = assemble(false).find((n) => n.id === "inner")!.data as BlockData;
    expect(!!withLimit.onExpand).toBe(false);
    expect(withLimit.expandLimited).toBe(true);
    const noLimit = assemble(true).find((n) => n.id === "inner")!.data as BlockData;
    expect(!!noLimit.onExpand).toBe(true);
    expect(noLimit.expandLimited).toBe(false);
  });

  it("expandableIds: лупа только у ключей карты состава; карточка контейнера — бейдж без лупы", () => {
    const sealed = { ...appNode("box@S", true), child_count: 5 };
    const nodes = assembleRfGraph({
      layout: {
        ...layout,
        nodes: [...layout.nodes, sealed],
        positions: new Map([...layout.positions, ["box@S", { x: 0, y: 0 }]]),
      },
      isArchitect: true, isReadOnly: true, drillNav: false,
      depth: 0, schemaView: "all", getCb: cb,
      maxInlineDepth: Infinity, frameDecor: decorOf, expandableIds: new Set(["inner"]),
    }).nextNodes;
    const block = (id: string) => nodes.find((n) => n.id === id)!.data as BlockData;
    expect(typeof block("inner").onExpand).toBe("function");
    expect(block("box@S").onExpand).toBeUndefined();
    expect(block("box@S").expandLimited).toBe(false);
    expect(block("box@S").badgeCount).toBe(5);
    // цельный контейнер — пунктирный контур; раскрываемый и лист — без пометки
    expect(block("box@S").dashed).toBe(true);
    expect("dashed" in block("inner")).toBe(false);
    expect("dashed" in block("a@S")).toBe(false);
  });

  it("площадка сворачивается: collapsible: true — onCollapse задан", () => {
    const nodes = assembleRfGraph({
      layout, isArchitect: false, isReadOnly: true, drillNav: false,
      depth: 0, schemaView: "all", getCb: cb,
      frameDecor: (id) => (id === "U" ? { kind: "group", collapsible: false } : { kind: "site", icon: "vm", collapsible: true }),
    }).nextNodes;
    const data = (id: string) => nodes.find((n) => n.id === id)!.data as FrameData;
    expect(typeof data("S").onCollapse).toBe("function");
    expect(data("U").onCollapse).toBeUndefined();
  });

  it("свёрнутая и пустая площадка — узел типа site, объект — block", () => {
    // S3 свёрнута (есть состав — ключ карты), E пуста (в карте её нет), обе — узлы уровня.
    const siteLayout: LayoutResult = {
      ...layout,
      nodes: [...layout.nodes, appNode("S3", true), appNode("E")],
      positions: new Map([...layout.positions, ["S3", { x: 0, y: 0 }], ["E", { x: 0, y: 0 }]]),
    };
    const decor = (id: string): FrameDecor | undefined =>
      id === "S3" ? { kind: "site", icon: "vm", collapsible: true, count: 4 }
      : id === "E" ? { kind: "site", icon: "cloud", collapsible: true, count: 0 }
      : decorOf(id);
    const nodes = assembleRfGraph({
      layout: siteLayout, isArchitect: true, isReadOnly: true, drillNav: false,
      depth: 0, schemaView: "all", getCb: cb,
      maxInlineDepth: Infinity, frameDecor: decor, expandableIds: new Set(["S3"]),
    }).nextNodes;
    const node = (id: string) => nodes.find((n) => n.id === id)!;
    expect(node("S3").type).toBe("site");
    const s3 = node("S3").data as SiteCardData;
    expect(s3).toMatchObject({ name: "S3", icon: "vm", count: 4 });
    expect(typeof s3.onExpand).toBe("function");
    expect(node("E").type).toBe("site");
    expect((node("E").data as SiteCardData).onExpand).toBeUndefined();
    expect(node("a@S").type).toBe("block");
  });

  it("режим выбора площадки: рамкам, карточкам площадок и объектов — onPick с id узла холста", () => {
    const pickFrame = vi.fn<(id: string) => void>();
    const callbacks = (): AssembleCallbacks => ({ ...cb(), pickFrame });
    const siteLayout: LayoutResult = {
      ...layout,
      nodes: [...layout.nodes, appNode("S3", true)],
      positions: new Map([...layout.positions, ["S3", { x: 0, y: 0 }]]),
    };
    const build = (picking: boolean) => assembleRfGraph({
      layout: siteLayout, isArchitect: true, isReadOnly: true, drillNav: false,
      depth: 0, schemaView: "all", getCb: callbacks,
      maxInlineDepth: Infinity,
      frameDecor: (id) => (id === "S3" ? { kind: "site", icon: "vm", collapsible: true, count: 1 } : decorOf(id)),
      expandableIds: new Set(["S3"]), picking,
    }).nextNodes;
    const nodes = build(true);
    const data = (id: string) => nodes.find((n) => n.id === id)!.data as { onPick?: (id: string) => void };
    for (const id of ["S", "S2", "U", "S3", "a@S", "u"]) {
      data(id).onPick?.(id);
      expect(pickFrame).toHaveBeenLastCalledWith(id);
    }
    expect(pickFrame).toHaveBeenCalledTimes(6);
    // вне режима onPick нет ни у кого
    for (const n of build(false)) expect("onPick" in (n.data as object)).toBe(false);
  });

  it("без проекции — прежняя сборка: нет decor и mark, рамка сворачивается", () => {
    const nodes = assemble(false);
    const s = nodes.find((n) => n.id === "S")!.data as FrameData;
    expect(Object.keys(s).sort()).toEqual(["name", "onCollapse"]);
    expect(typeof s.onCollapse).toBe("function");
    const a = nodes.find((n) => n.id === "a@S")!.data as BlockData;
    expect("mark" in a).toBe(false);
  });
});
