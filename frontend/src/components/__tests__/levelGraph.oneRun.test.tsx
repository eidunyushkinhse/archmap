// ЛИШНИЕ ПРОГОНЫ КОНВЕЙЕРА НА МАУНТЕ ХОЛСТА (эпик render-scale, шаг «быстрый ELK и один
// прогон»). Полевая находка: на каждом маунте холста (вход на уровень, возврат, страница
// объекта) первые два входа конвейера совпадали побитово — сброс эфемерных состояний «на
// смену уровня» срабатывал и на маунте и пересоздавал их пустыми копиями, отчего
// computeNow пересоздавался при том же содержимом входа.
//
// Конвейер замокан (общий harness): проверяется ОРКЕСТРАЦИЯ — сколько раз и с каким
// входом холст зовёт конвейер.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetHarness, pipeline, pipelineClientMock } from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";
import { setCurrentProjectId } from "../../api/projectScope";
import type { PipelineInput } from "../graph/layout/pipeline";

// --- vi.mock: зависимости LevelGraph → реализации из общего harness (layoutSig — настоящий) ---
vi.mock("@xyflow/react", async () => (await import("./levelGraphHarness")).xyflowMock);
vi.mock("../../api/nodes", async () => (await import("./levelGraphHarness")).apiNodesMock);
vi.mock("../graph/layout/pipelineClient", async () => (await import("./levelGraphHarness")).pipelineClientMock);
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

const calls = (): PipelineInput[] =>
  pipelineClientMock.computeViewLayoutOffThread.mock.calls.map((c) => c[0] as PipelineInput);

describe("LevelGraph × лишние прогоны конвейера (render-scale)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setCurrentProjectId("P1");
    resetHarness();
    pipelineClientMock.computeViewLayoutOffThread.mockReset();
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(() => Promise.resolve(pipeline.result));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("маунт со статичными пропсами — ровно один прогон конвейера (без идентичного второго)", async () => {
    await renderGraph({});
    expect(calls(), "статичный маунт без замеров — один прогон").toHaveLength(1);
  });
});
