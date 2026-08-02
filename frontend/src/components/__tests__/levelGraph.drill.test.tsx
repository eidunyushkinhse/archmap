// Оркестрационные тесты DRILL/EXPAND LevelGraphInner (Фаза 3а). Фиксируют контракт
// навигации и инлайн-раскрытия контейнеров:
//   • drillWithPath: прямой узел уровня → onDrillDown; узел из раскрытого контейнера
//     → onEnterNode с ПОЛНЫМ путём (предки breadcrumb + промежуточные контейнеры + сам
//     узел); невосстановимая цепочка → fallback onDrillDown;
//   • expandContainer/collapseContainer (гость) → commitLayout({expanded}) →
//     onLayoutChanged + анимационная нота (noteExpand/noteCollapse);
//   • own-on-expand: нерасположенный контейнер закрепляет текущую позицию из раскладки;
//   • expandLocalContainer (локал): ленивая догрузка детей (nodesApi.list) → раскрытие;
//     пустое раскрытие в read-only (дети нерелевантны) → НЕ раскрываем.
// RF/конвейер замоканы; колбэки оркестрации — через getCb.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import type { Node as AppNode, AncestorRef } from "../../types";
import {
  resetHarness, layoutAnimMock, apiNodesMock, pipeline, settle,
} from "./levelGraphHarness";
import { renderGraph, getCb, baseProps } from "./levelGraphRender";

// --- vi.mock: зависимости LevelGraph → реализации из общего harness ---
vi.mock("@xyflow/react", async () => (await import("./levelGraphHarness")).xyflowMock);
vi.mock("../../api/nodes", async () => (await import("./levelGraphHarness")).apiNodesMock);
vi.mock("../graph/layout/pipelineClient", async () => (await import("./levelGraphHarness")).pipelineClientMock);
vi.mock("../graph/layout/layoutSig", async () => (await import("./levelGraphHarness")).layoutSigMock);
vi.mock("../graph/assembleRf", async () => (await import("./levelGraphHarness")).assembleRfMock);
vi.mock("../graph/nodes", async () => (await import("./levelGraphHarness")).nodesRegistryMock);
vi.mock("../graph/edges", async () => (await import("./levelGraphHarness")).edgesRegistryMock);
vi.mock("../graph/shapes", async () => (await import("./levelGraphHarness")).shapesMock);
vi.mock("../graph/ConnectionLine", async () => (await import("./levelGraphHarness")).connectionLineMock);
vi.mock("../graph/boundaries", async () => (await import("./levelGraphHarness")).boundariesMock);
vi.mock("../graph/QuickConnectPreview", async () => (await import("./levelGraphHarness")).quickConnectPreviewMock);
vi.mock("../graph/EdgeJumpContext", async () => (await import("./levelGraphHarness")).edgeJumpMock);
vi.mock("../graph/interaction/useLayoutAnimation", async () => (await import("./levelGraphHarness")).useLayoutAnimationMock);
vi.mock("../graph/interaction/useSnapAlignment", async () => (await import("./levelGraphHarness")).useSnapAlignmentMock);
vi.mock("../graph/interaction/useLiveDragHandles", async () => (await import("./levelGraphHarness")).useLiveDragHandlesMock);
vi.mock("../graph/interaction/useFrameFollowOverlay", async () => (await import("./levelGraphHarness")).useFrameFollowOverlayMock);
vi.mock("../graph/interaction/useCanvasDelete", async () => (await import("./levelGraphHarness")).useCanvasDeleteMock);
vi.mock("../graph/interaction/useTemplateDrop", async () => (await import("./levelGraphHarness")).useTemplateDropMock);
vi.mock("../graph/interaction/useAlignmentGuides", async () => (await import("./levelGraphHarness")).useAlignmentGuidesMock);
vi.mock("../graph/interaction/useHistory", async () => (await import("./levelGraphHarness")).useHistoryMock);
vi.mock("../graph/interaction/useEdgeConnect", async () => (await import("./levelGraphHarness")).useEdgeConnectMock);

function appNode(id: string, over: Partial<AppNode> = {}): AppNode {
  return {
    id,
    name: id.toUpperCase(),
    parent_id: null,
    shape: "service",
    is_external: false,
    ...over,
  } as AppNode;
}

describe("LevelGraph orchestration: drill / expand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------- DRILL ----------------

  it("drill без onEnterNode: любой узел → onDrillDown", async () => {
    const { props } = await renderGraph({ containerId: "root" });
    const n = appNode("a", { parent_id: "root" });

    getCb().drillWithPath(n);
    expect(props.drill.onDrillDown).toHaveBeenCalledWith(n);
  });

  it("drill прямого ребёнка уровня (parent_id === containerId) → onDrillDown, не onEnterNode", async () => {
    const onEnterNode = vi.fn<(path: AncestorRef[]) => void>();
    const { props } = await renderGraph({ containerId: "root", drill: { ...baseProps().drill, onEnterNode } });
    const n = appNode("a", { parent_id: "root" });

    getCb().drillWithPath(n);
    expect(props.drill.onDrillDown).toHaveBeenCalledWith(n);
    expect(onEnterNode).not.toHaveBeenCalled();
  });

  it("drill узла из раскрытого контейнера → onEnterNode с полным путём (breadcrumb + цепочка + узел)", async () => {
    const onEnterNode = vi.fn<(path: AncestorRef[]) => void>();
    // Уровень «root» (хлебные крошки), внутри раскрытого p1 лежит целевой n.
    const p1 = appNode("p1", { name: "Промежуточный", parent_id: "root" });
    const n = appNode("n", { name: "Цель", parent_id: "p1" });
    await renderGraph({
      containerId: "root",
      ancestorIds: ["root"],
      ancestorNames: ["Root"],
      nodes: [p1],
      drill: { ...baseProps().drill, onEnterNode },
    });

    getCb().drillWithPath(n);

    expect(onEnterNode).toHaveBeenCalledOnce();
    expect(onEnterNode).toHaveBeenCalledWith([
      { id: "root", name: "Root", is_external: false },
      { id: "p1", name: "Промежуточный", is_external: false },
      { id: "n", name: "Цель", is_external: false },
    ]);
  });

  it("drill: цепочка предков не восстанавливается → fallback onDrillDown", async () => {
    const onEnterNode = vi.fn<(path: AncestorRef[]) => void>();
    // parent_id указывает на узел, которого нет ни в nodes, ни в localChildren.
    const n = appNode("n", { parent_id: "missing" });
    const { props } = await renderGraph({ containerId: "root", drill: { ...baseProps().drill, onEnterNode } });

    getCb().drillWithPath(n);
    expect(props.drill.onDrillDown).toHaveBeenCalledWith(n);
    expect(onEnterNode).not.toHaveBeenCalled();
  });

  // ---------------- EXPAND / COLLAPSE (гость) ----------------

  it("expandContainer: раскрытие гостя → noteExpand + commitLayout({expanded:true})", async () => {
    const { props } = await renderGraph({});

    await act(async () => {
      getCb().expandContainer("g1");
    });

    expect(layoutAnimMock.noteExpand).toHaveBeenCalledWith("g1");
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ g1: { expanded: true } });
  });

  it("collapseContainer: сворачивание → noteCollapse + commitLayout({expanded:null})", async () => {
    const { props } = await renderGraph({});

    await act(async () => {
      getCb().collapseContainer("g1");
    });

    expect(layoutAnimMock.noteCollapse).toHaveBeenCalledWith("g1");
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ g1: { expanded: null } });
  });

  it("own-on-expand: нерасположенный контейнер закрепляет текущую позицию из раскладки", async () => {
    // Конвейер «посчитал» позицию контейнера; в зеркале (viewLayout) её ещё нет.
    pipeline.result.layout.positions = new Map([["c1", { x: 50, y: 60 }]]);
    const { props } = await renderGraph({});

    await act(async () => {
      getCb().expandContainer("c1");
    });

    // Раскрытие идёт ВМЕСТЕ с закреплением позиции (иначе ELK унёс бы рамку).
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ c1: { expanded: true, x: 50, y: 60 } });
  });

  it("own-on-expand не подмешивает позицию раскладки, если контейнер уже владеет ей (owned)", async () => {
    pipeline.result.layout.positions = new Map([["c1", { x: 50, y: 60 }]]);
    const { props } = await renderGraph({ viewLayout: { c1: { x: 1, y: 2 } } });

    await act(async () => {
      getCb().expandContainer("c1");
    });

    // Владеет позицией → координаты из ЗЕРКАЛА (1,2), а не из раскладки (50,60):
    // own-on-expand не перезаписывает уже сохранённое место.
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ c1: { expanded: true, x: 1, y: 2 } });
  });

  // ---------------- EXPAND ЛОКАЛА (ленивая догрузка детей) ----------------

  it("expandLocalContainer: догружает детей (nodesApi.list) и раскрывает", async () => {
    const kid = appNode("kid", { parent_id: "c1" });
    apiNodesMock.nodesApi.list.mockResolvedValueOnce([kid]);
    const { props } = await renderGraph({});

    await act(async () => {
      getCb().expandLocalContainer("c1");
    });
    await settle();

    expect(apiNodesMock.nodesApi.list).toHaveBeenCalledWith("c1");
    expect(layoutAnimMock.noteExpand).toHaveBeenCalledWith("c1");
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ c1: { expanded: true } });
  });

  it("expandLocalContainer в read-only: нерелевантные дети (нет рёбер) → не раскрываем", async () => {
    const kid = appNode("kid", { parent_id: "c1" });
    apiNodesMock.nodesApi.list.mockResolvedValueOnce([kid]);
    // read-only: релевантность = связанность рёбрами; рёбер нет → детей в схеме нет.
    const { props } = await renderGraph({ mode: { readOnly: true } });

    await act(async () => {
      getCb().expandLocalContainer("c1");
    });
    await settle();

    expect(apiNodesMock.nodesApi.list).toHaveBeenCalledWith("c1");
    expect(layoutAnimMock.noteExpand).not.toHaveBeenCalled();
    expect(props.persistence?.onLayoutChanged).not.toHaveBeenCalled();
  });
});
