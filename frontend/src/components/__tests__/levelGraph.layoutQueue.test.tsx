// ХОЛСТ × ОЧЕРЕДЬ ВОРКЕРА (эпик render-scale, шаг «быстрый ELK и один прогон»). Очередь
// клиента (pipelineClient) работает внутри владельца-холста: LevelGraph обязан (1) звать
// конвейер с одним и тем же владельцем на все свои прогоны, уборку (P14) — с пометкой
// фонового; (2) исход «устарел» (LayoutSupersededError) принимать как перегнанный прогон —
// без необработанной ошибки и без вечного бейджа «Расставляем объекты»; (3) на уходе
// сообщать очереди, что холст ушёл.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import { resetHarness, pipeline, pipelineClientMock, settle } from "./levelGraphHarness";
import { renderGraph, getCb } from "./levelGraphRender";
import { CLEANUP_IDLE_MS } from "../graph/interaction/useIdleCleanup";
import type { PipelineOutput } from "../graph/layout/pipeline";

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

type Opts = { owner?: object; background?: boolean } | undefined;
const optsOf = () => pipelineClientMock.computeViewLayoutOffThread.mock.calls.map((c) => c[1] as Opts);
// Свежий объект результата на каждый прогон (setLayout с той же ссылкой React бэйл-аутит).
const fresh = (over: Partial<PipelineOutput> = {}): PipelineOutput =>
  ({ ...pipeline.result, layout: { ...pipeline.result.layout }, ...over });

describe("LevelGraph × очередь воркера (render-scale)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("все прогоны холста идут с одним владельцем; уход холста отпускает именно его", async () => {
    const { unmount } = await renderGraph({});
    await act(async () => { getCb().expandContainer("g1"); await settle(); });
    const opts = optsOf();
    expect(opts.length).toBeGreaterThanOrEqual(2);
    const owner = opts[0]?.owner;
    expect(owner).toBeDefined();
    for (const o of opts) {
      expect(o?.owner).toBe(owner);
      expect(o?.background).toBe(false);
    }
    unmount();
    expect(pipelineClientMock.releaseLayoutOwner).toHaveBeenCalledWith(owner);
  });

  it("исход «устарел» — перегнанный прогон: без необработанной ошибки, бейдж гаснет, победитель применяется", async () => {
    // Необработанную ошибку ловит сам vitest: Unhandled Rejection валит прогон файла.
    const { container } = await renderGraph({});
    // первый прогон очередь «вытесняет», второй досчитывается
    let resolveSecond: ((o: PipelineOutput) => void) | null = null;
    const { LayoutSupersededError } = pipelineClientMock;
    pipelineClientMock.computeViewLayoutOffThread
      .mockImplementationOnce(() => Promise.reject(new LayoutSupersededError()))
      .mockImplementationOnce(() => new Promise((res) => { resolveSecond = res; }));
    await act(async () => { getCb().expandContainer("g1"); });
    await act(async () => { getCb().expandContainer("g2"); });
    expect(container.querySelector(".lg-busy")).not.toBeNull(); // второй ещё в полёте
    await act(async () => { resolveSecond?.(fresh()); await settle(); });
    expect(container.querySelector(".lg-busy")).toBeNull();
  });

  it("уборка (P14) зовёт конвейер с пометкой фонового прогона", async () => {
    await renderGraph({});
    // скоупный прогон взводит уборку
    pipelineClientMock.computeViewLayoutOffThread.mockImplementationOnce(() =>
      Promise.resolve(fresh({ scoped: true, authoritative: false })));
    await act(async () => { getCb().expandContainer("g1"); await settle(); });
    const before = optsOf().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(CLEANUP_IDLE_MS + 10); await settle(); });
    const after = optsOf().slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.background).toBe(true);
  });
});
