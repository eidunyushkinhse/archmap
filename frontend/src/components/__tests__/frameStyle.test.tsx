// Стиль рамки в трёх местах, где она рисуется (камень 18 docs/plan-c4-elements.md):
// compound-рамка раскрытия (FrameNode), нативная рамка уровня (LevelBoundary) и живой
// оверлей драга (useFrameFollowOverlay), который на время жеста ПОДМЕНЯЕТ скрытую
// рамку. Характеризация снята до сведения стиля в один хелпер: строки style рамки и
// границы уровня обязаны остаться байт-в-байт, а оверлей — совпадать с подменяемой
// рамкой (до хелпера он рисовал пунктир с лупой и над зоной площадки). Рядом —
// характеризация рендера блока и свёрнутого гостевого контейнера (зона входа, бейдж,
// кнопки): эпик поменяет их вид по элементу, а сегодняшний вид фиксируется здесь.
import { act, render, renderHook } from "@testing-library/react";
import { ReactFlowProvider, type Node as RFNode, type NodeProps } from "@xyflow/react";
import type { ComponentType, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { nodeTypes } from "../graph/nodes";
import { LevelBoundary } from "../graph/boundaries";
import { useFrameFollowOverlay } from "../graph/interaction/useFrameFollowOverlay";
import { getNodeColors } from "../graph/colors";
import type { BlockData, ContainerData, FrameData, GhostData } from "../graph/types";
import type { Node as AppNode, GhostNode } from "../../types";

// Плашка рамки — портал в слой плашек холста (FramePlaque → EdgeLabelRenderer); холста
// здесь нет — портал подменён на рендер на месте.
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, EdgeLabelRenderer: ({ children }: { children?: ReactNode }) => <>{children}</> };
});

const Frame = nodeTypes.frame as ComponentType<Partial<NodeProps>>;
const Block = nodeTypes.block as ComponentType<Partial<NodeProps>>;
const Container = nodeTypes.container as ComponentType<Partial<NodeProps>>;
const Ghost = nodeTypes.ghost as ComponentType<Partial<NodeProps>>;

const DASHED = "border: var(--lg-frame-bw, 1px) dashed #9ca3af; border-radius: 12px; background: transparent; box-sizing: border-box;";
const SITE = "border: var(--lg-frame-bw, 1px) solid #cbd5e1; border-radius: 12px; background: rgba(100, 116, 139, 0.07); box-sizing: border-box;";

function renderFrame(data: FrameData): HTMLElement {
  const { container } = render(
    <ReactFlowProvider><Frame id="f1" data={data} /></ReactFlowProvider>,
  );
  return container.querySelector(".lg-frame") as HTMLElement;
}

const appNode = (id: string): AppNode => ({
  id, name: id, description: null, role: null, technology: null, parent_id: null,
  shape: "service", is_external: false, status: "existing", openapi_spec: null,
  version: 1, docs: [], has_children: false, child_count: 0, created_at: "", updated_at: "",
  approval: "in_progress", approval_effective: "in_progress", sites: [],
  element: null, element_effective: "container", container_name: null,
}) as AppNode;

// Оверлей драга над рамкой f1 с одним ребёнком: старт жеста, затем его разметка.
function renderOverlay(data: FrameData): HTMLElement {
  const rfNodes: RFNode[] = [
    { id: "f1", type: "frame", position: { x: 0, y: 0 }, width: 300, height: 200, data },
    { id: "k1", type: "block", parentId: "f1", position: { x: 20, y: 20 }, data: { appNode: appNode("k1") } as unknown as BlockData },
  ];
  const { result } = renderHook(() =>
    useFrameFollowOverlay({ rfNodes, setRfNodes: vi.fn(), getNodes: () => rfNodes }),
  );
  act(() => { result.current.begin([rfNodes[1]]); });
  const { container } = render(<>{result.current.overlay}</>);
  return container.firstElementChild as HTMLElement;
}

describe("стиль рамки раскрытия (FrameNode) — байт-в-байт", () => {
  it("без декора — пунктир, лупа на плашке", () => {
    const frame = renderFrame({ name: "Витрина", onCollapse: () => {} });
    expect(frame.className).toBe("lg-frame");
    expect(frame.getAttribute("style")).toBe(`width: 100%; height: 100%; ${DASHED} pointer-events: none;`);
  });

  it("площадка — зона с заливкой и сплошной светлой границей", () => {
    const frame = renderFrame({ name: "Кластер", decor: { kind: "site", icon: "kubernetes" } });
    expect(frame.getAttribute("style")).toBe(`width: 100%; height: 100%; ${SITE} pointer-events: none;`);
  });

  it("класс рамки — lg-frame (хук полигона), у декора — модификатор вида", () => {
    expect(renderFrame({ name: "Кластер", decor: { kind: "site" } }).className).toBe("lg-frame lg-frame--site");
    expect(renderFrame({ name: "Не указано", decor: { kind: "group", collapsible: false } }).className)
      .toBe("lg-frame lg-frame--group");
  });

  it("группа — пунктир, как у раскрытия; в режиме выбора тело ловит щелчок", () => {
    const frame = renderFrame({ name: "Размещение не указано", decor: { kind: "group", collapsible: false } });
    expect(frame.getAttribute("style")).toBe(`width: 100%; height: 100%; ${DASHED} pointer-events: none;`);
    const picking = renderFrame({ name: "Кластер", decor: { kind: "site" }, onPick: () => {} });
    expect(picking.getAttribute("style")).toBe(`width: 100%; height: 100%; ${SITE} pointer-events: auto;`);
  });
});

describe("стиль нативной рамки уровня (LevelBoundary) — байт-в-байт", () => {
  it("пунктир вокруг узлов уровня, класс lg-frame — хук полигона", () => {
    const rfNodes: RFNode[] = [
      { id: "b1", type: "block", position: { x: 0, y: 0 }, data: { appNode: appNode("b1") } as unknown as BlockData },
    ];
    const { container } = render(
      <LevelBoundary rfNodes={rfNodes} ancestorIds={["p1"]} ancestorNames={["Маркетплейс"]} />,
    );
    const frame = container.querySelector(".lg-frame") as HTMLElement;
    expect(frame).not.toBeNull();
    const style = frame.getAttribute("style") ?? "";
    expect(style.startsWith("position: absolute; left: ")).toBe(true);
    expect(style.endsWith(`${DASHED} pointer-events: none;`)).toBe(true);
  });
});

describe("стиль нативных рамок нескольких предков", () => {
  it("каждый предок breadcrumb — своя рамка тем же пунктиром", () => {
    const rfNodes: RFNode[] = [
      { id: "b1", type: "block", position: { x: 0, y: 0 }, data: { appNode: appNode("b1") } as unknown as BlockData },
    ];
    const { container } = render(
      <LevelBoundary rfNodes={rfNodes} ancestorIds={["p0", "p1"]} ancestorNames={["Торговля", "Витрина"]} />,
    );
    const frames = [...container.querySelectorAll(".lg-frame")] as HTMLElement[];
    expect(frames.map((f) => f.getAttribute("data-frame-id"))).toEqual(["p0", "p1"]);
    for (const f of frames) {
      expect(f.className).toBe("lg-frame");
      expect((f.getAttribute("style") ?? "").endsWith(`${DASHED} pointer-events: none;`)).toBe(true);
    }
  });
});

describe("оверлей драга подменяет рамку тем же стилем", () => {
  // Геометрия (left/top/width/height) у оверлея своя — живой bbox; сверяется остальное.
  const visual = (el: HTMLElement) => (el.getAttribute("style") ?? "").replace(/^.*?height: [^;]+; /, "");

  it("без декора — пунктир и лупа на плашке", () => {
    const el = renderOverlay({ name: "Витрина" });
    expect(visual(el)).toBe(`${DASHED} pointer-events: none;`);
    expect(el.textContent).toBe("🔍 Витрина");
  });

  it("площадка — зона, как у самой рамки, без лупы", () => {
    const el = renderOverlay({ name: "Кластер", decor: { kind: "site", icon: "kubernetes" } });
    expect(visual(el)).toBe(`${SITE} pointer-events: none;`);
    expect(el.textContent).toBe("Кластер");
    expect(el.querySelector("svg")).not.toBeNull(); // иконка вида, как на плашке рамки
  });

  it("группа — пунктир, плашка без лупы", () => {
    const el = renderOverlay({ name: "Размещение не указано", decor: { kind: "group", collapsible: false } });
    expect(visual(el)).toBe(`${DASHED} pointer-events: none;`);
    expect(el.textContent).toBe("Размещение не указано");
  });
});

describe("блок и свёрнутый гостевой контейнер — характеризация рендера", () => {
  const colors = getNodeColors(false, 1, "existing");
  const blockData = (over: Partial<AppNode>, extra: Partial<BlockData> = {}): BlockData => ({
    appNode: { ...appNode("b"), name: "Блок", ...over }, colors, isArchitect: true, hideActions: false,
    connectable: false, badgeCount: over.child_count ?? 0, expandLimited: false, ...extra,
  }) as BlockData;
  const renderBlock = (data: BlockData) => render(
    <ReactFlowProvider><Block id="b" data={data} /></ReactFlowProvider>,
  ).container;

  it("сервис с детьми — зона входа, бейдж, «Войти» и лупа", () => {
    const el = renderBlock(blockData(
      { has_children: true, child_count: 3 },
      { onExpand: vi.fn(), onDrillDown: vi.fn() },
    ));
    expect(el.querySelector("[data-into]")?.getAttribute("data-into")).toBe("1");
    expect(el.querySelector(".lg-into-cue")).not.toBeNull();
    expect(el.querySelector('button[title="Войти"]')).not.toBeNull();
    expect(el.querySelector('button[title="Раскрыть содержимое"]')).not.toBeNull();
    expect(el.textContent).toContain("3");
  });

  it("бейдж детей у сервиса с детьми — глиф-дерево и число прямых детей", () => {
    const el = renderBlock(blockData({ has_children: true, child_count: 3 }, { onExpand: vi.fn() }));
    // дерево: три кружка (родитель и два ребёнка) и ветви
    expect(el.querySelectorAll('circle[r="2.3"]')).toHaveLength(3);
    expect(el.textContent).toContain("3");
  });

  it("лупа на пределе глубины — неактивна, подсказка про предел", () => {
    const el = renderBlock(blockData({ has_children: true, child_count: 2 }, { expandLimited: true }));
    const lens = el.querySelector('button[aria-disabled="true"]');
    expect(lens?.getAttribute("title")).toBe(
      "Контейнеры можно раскрыть только два раза подряд. Чтобы посмотреть состав этого контейнера, спуститесь на слой ниже",
    );
  });

  it("гость с детьми — «Войти к компонентам» и бейдж детей с глифом-деревом", () => {
    const ghost = {
      id: "g", name: "Гость", role: null, technology: null, is_external: false, shape: "service",
      status: "existing", node_depth: 1, has_children: true, child_count: 4, ancestors: [], is_ghost: true,
      element_effective: "system",
    } as unknown as GhostNode;
    const data: GhostData = { appNode: ghost, colors, onEnter: vi.fn() };
    const el = render(<ReactFlowProvider><Ghost id="g" data={data} /></ReactFlowProvider>).container;
    expect(el.querySelector('button[title="Войти к компонентам"]')).not.toBeNull();
    expect(el.querySelectorAll('circle[r="2.3"]')).toHaveLength(3);
    expect(el.textContent).toContain("4");
    // гость-лист — ни кнопки, ни бейджа
    const leaf: GhostData = { appNode: { ...ghost, has_children: false, child_count: 0 }, colors, onEnter: vi.fn() };
    const el2 = render(<ReactFlowProvider><Ghost id="g2" data={leaf} /></ReactFlowProvider>).container;
    expect(el2.querySelector('button[title="Войти к компонентам"]')).toBeNull();
    expect(el2.querySelectorAll('circle[r="2.3"]')).toHaveLength(0);
  });

  it("база с детьми и лист — не зона входа, без бейджа и лупы", () => {
    for (const over of [{ shape: "database", has_children: true, child_count: 1 }, {}] as Partial<AppNode>[]) {
      const el = renderBlock(blockData(over, { onDrillDown: vi.fn() }));
      expect(el.querySelector("[data-into]")).toBeNull();
      expect(el.querySelector(".lg-into-cue")).toBeNull();
      expect(el.querySelector('button[title="Раскрыть содержимое"]')).toBeNull();
    }
  });

  it("свёрнутый гостевой контейнер — всегда зона входа, подпись «контейнер», лупа и «Войти к компонентам»", () => {
    const data = {
      id: "c", name: "Витрина", depth: 1, ancestors: [], colors,
      onExpand: vi.fn(), onEnter: vi.fn(), expandLimited: false, connectable: false,
    } as unknown as ContainerData;
    const el = render(<ReactFlowProvider><Container id="c" data={data} /></ReactFlowProvider>).container;
    expect(el.querySelector("[data-into]")?.getAttribute("data-into")).toBe("1");
    expect(el.querySelector(".lg-into-cue")).not.toBeNull();
    expect(el.textContent).toContain("контейнер");
    expect(el.textContent).toContain("Витрина");
    expect(el.querySelector('button[title="Войти к компонентам"]')).not.toBeNull();
    expect(el.querySelector('button[title="Раскрыть содержимое"]')).not.toBeNull();
    expect(el.querySelector('rect[stroke-dasharray="5 3"]')).not.toBeNull();
  });
});
