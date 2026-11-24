// Разовое предупреждение перегруженной сцены (perf.md P8): на сцене больше OVERLOAD_NODES
// узлов холст один раз на вид показывает «На схеме очень много объектов, поэтому анимации
// могут отключаться» — и архитектору, и наблюдателю; на обычной сцене плашки нет. Разового
// совета о неаккуратных стрелках (P15) больше нет: у архитектора плашка на холсте одна.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetHarness, pipeline } from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";
import { OVERLOAD_NODES } from "../graph/constants";
import type { Node as AppNode } from "../../types";

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

const appNode = (id: string): AppNode => ({ id, name: id, shape: "service" } as AppNode);

// Перегруженная по узлам сцена (displayedCount > OVERLOAD_NODES → P8).
const overloadNodes = () =>
  Array.from({ length: OVERLOAD_NODES + 1 }, (_, i) => appNode(`n${i}`));

const overload = (c: HTMLElement) => c.querySelector(".lg-overload-toast");

describe("LevelGraph — разовое предупреждение перегруженной сцены (P8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("перегруженная сцена у архитектора: предупреждение P8, и плашка на холсте одна", async () => {
    pipeline.result.layout.nodes = overloadNodes();
    const { container } = await renderGraph({});
    expect(overload(container)).not.toBeNull();
    expect(overload(container)?.textContent).toContain("анимации могут отключаться");
    expect(container.querySelectorAll('[class$="-toast"]').length).toBe(1);
  });

  it("обычная сцена: предупреждения P8 нет", async () => {
    pipeline.result.layout.nodes = [appNode("A")];
    const { container } = await renderGraph({});
    expect(overload(container)).toBeNull();
  });

  it("наблюдатель на перегруженной сцене: предупреждение P8 есть", async () => {
    pipeline.result.layout.nodes = overloadNodes();
    const { container } = await renderGraph({ isArchitect: false, mode: { readOnly: true } });
    expect(overload(container)).not.toBeNull();
  });
});
