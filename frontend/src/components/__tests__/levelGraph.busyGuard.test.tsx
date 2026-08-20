// Тесты Ф2 перф-эпика (спека perf.md): P4 — бейдж занятости конвейера,
// P5 — защита от прокликивания (повторные клики по лупе/«Свернуть» до
// применения раскладки игнорируются: каждый пропущенный клик перезапускал бы
// конвейер, а клик в момент смены кнопки «отменял» ещё не показанное).
// RF/конвейер замоканы (общий harness); занятость управляется подвешенным
// промисом computeViewLayoutOffThread.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import {
  resetHarness, layoutAnimMock, pipeline, pipelineClientMock, settle,
} from "./levelGraphHarness";
import { renderGraph, getCb } from "./levelGraphRender";

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

describe("занятость конвейера и гвард прокликивания (перф-эпик Ф2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Подвесить конвейер: раскладка «считается», пока тест не отпустит.
  // Резолв — КЛОНОМ результата: харнесс держит один объект, а setLayout с той же
  // ссылкой React бэйл-аутит (эффект-сборщик не перезапустился бы; в проде
  // каждый прогон строит свежий объект).
  function hangPipeline(): () => void {
    let release: (() => void) | null = null;
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(
      () =>
        new Promise((res) => {
          release = () => res({ ...pipeline.result, layout: { ...pipeline.result.layout } });
        }),
    );
    return () => release?.();
  }

  it("P5: повторные клики по тому же контейнеру до применения игнорируются, применение отпускает гвард", async () => {
    const { props } = await renderGraph({});
    const release = hangPipeline();

    await act(async () => { getCb().expandContainer("g1"); });
    await act(async () => { getCb().expandContainer("g1"); });   // нетерпеливый повтор
    await act(async () => { getCb().collapseContainer("g1"); }); // «отменяющий» клик в полёте

    expect(layoutAnimMock.noteExpand).toHaveBeenCalledTimes(1);
    expect(layoutAnimMock.noteCollapse).not.toHaveBeenCalled();
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledTimes(1);
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ g1: { expanded: true } });

    // конвейер досчитал → раскладка применена → гвард отпущен
    await act(async () => { release(); await settle(); });
    await act(async () => { getCb().collapseContainer("g1"); });
    expect(layoutAnimMock.noteCollapse).toHaveBeenCalledWith("g1");
  });

  it("P5: гвард пер-контейнерный — клик по ДРУГОМУ контейнеру в полёте проходит", async () => {
    await renderGraph({});
    hangPipeline();

    await act(async () => { getCb().expandContainer("g1"); });
    await act(async () => { getCb().expandContainer("g2"); });

    expect(layoutAnimMock.noteExpand).toHaveBeenCalledTimes(2);
    expect(layoutAnimMock.noteExpand).toHaveBeenCalledWith("g2");
  });

  it("P4: бейдж «Считаю раскладку…» виден, пока конвейер в полёте, и гаснет по применении", async () => {
    await renderGraph({});
    const release = hangPipeline();

    await act(async () => { getCb().expandContainer("g1"); });
    expect(document.querySelector(".lg-busy")).not.toBeNull();

    await act(async () => { release(); await settle(); });
    expect(document.querySelector(".lg-busy")).toBeNull();
  });
});
