// Разовый совет о грязи стрелок на перегруженной сцене (perf.md P15): на сцене
// класса P8 (>OVERLOAD_NODES узлов) рядом с предупреждением об анимациях всплывает
// отдельный тост-совет «подёргайте узлы» — ТОЛЬКО тому, кто может двигать узлы
// (наблюдателю совет невыполним, ему остаётся стандартный P8).
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

// Перегруженная по узлам сцена (displayedCount > OVERLOAD_NODES → P8/P15).
const overloadNodes = () =>
  Array.from({ length: OVERLOAD_NODES + 1 }, (_, i) => appNode(`n${i}`));

const dirty = (c: HTMLElement) => c.querySelector(".lg-dirty-toast");
const overload = (c: HTMLElement) => c.querySelector(".lg-overload-toast");

describe("LevelGraph — совет о грязи стрелок на перегруженной сцене (P15)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("перегруженная сцена у архитектора: совет всплывает рядом с тостом P8", async () => {
    pipeline.result.layout.nodes = overloadNodes();
    const { container } = await renderGraph({});
    expect(overload(container)).not.toBeNull();
    expect(dirty(container)).not.toBeNull();
    expect(dirty(container)?.textContent).toContain("Подёргайте несколько узлов");
  });

  it("обычная сцена: ни P8, ни совета", async () => {
    pipeline.result.layout.nodes = [appNode("A")];
    const { container } = await renderGraph({});
    expect(overload(container)).toBeNull();
    expect(dirty(container)).toBeNull();
  });

  it("наблюдатель на перегруженной сцене: P8 остаётся, совета нет (двигать нечем)", async () => {
    pipeline.result.layout.nodes = overloadNodes();
    const { container } = await renderGraph({ isArchitect: false, mode: { readOnly: true } });
    expect(overload(container)).not.toBeNull();
    expect(dirty(container)).toBeNull();
  });
});
