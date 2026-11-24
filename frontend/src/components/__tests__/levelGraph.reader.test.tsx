// Оркестрационные тесты РАССТАНОВКИ ЧИТАТЕЛЯ (решение владельца 2026-11-24, задание П2;
// view.md V25 v2): читатель двигает объекты на время просмотра — правки ложатся слоем в
// память холста, конвейер считает по действующей раскладке (серверная + слой), на сервер
// не уходит ни одного запроса записи и родителю — ни одного зеркала. Канал настоящий,
// остальное — levelGraphHarness.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import type { ViewLayout } from "../../types";
import { resetHarness, apiNodesMock, pipelineClientMock, pipeline, rfProps, settle } from "./levelGraphHarness";
import { renderGraph, getCb, baseProps } from "./levelGraphRender";

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

// Страничная схема читателя: структура только для чтения, расстановка включена.
const PAGE = { readOnly: true, arrangeOnly: true };
const SAVED: ViewLayout = { a: { x: 10, y: 20 }, b: { x: 300, y: 20 }, box: { x: 5, y: 6, expanded: true } };

// Раскладка, с которой конвейер считал последний прогон.
function lastPipelineLayout(): ViewLayout {
  const input = pipelineClientMock.computeViewLayoutOffThread.mock.calls.at(-1)?.[0] as { viewLayout: ViewLayout } | undefined;
  if (!input) throw new Error("конвейер не звали");
  return input.viewLayout;
}

async function mountReader(over: Parameters<typeof renderGraph>[0] = {}) {
  const viewMeta = { current: { version: 7, graphRev: 0 } };
  const onLayoutChanged = vi.fn();
  const r = await renderGraph({
    isArchitect: false, mode: PAGE, viewLayout: SAVED,
    persistence: { ...baseProps().persistence, viewMeta, onLayoutChanged },
    ...over,
  });
  return { ...r, onLayoutChanged };
}

describe("LevelGraph orchestration: расстановка читателя без записи", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("перемещение — слоем: конвейер считает по новой позиции, записи и зеркала нет", async () => {
    const { onLayoutChanged } = await mountReader();
    let committed = false;
    act(() => { committed = getCb().commitLayout({ a: { x: 30, y: 40 } }); });
    expect(committed).toBe(true);
    await settle();
    expect(lastPipelineLayout()).toEqual({ ...SAVED, a: { x: 30, y: 40 } });
    expect(onLayoutChanged).not.toHaveBeenCalled();
    expect(apiNodesMock.viewsApi.saveLayout).not.toHaveBeenCalled();
  });

  it("раскрытие и сворачивание слой не трогают (у читателя они эфемерны своим путём)", async () => {
    await mountReader();
    const runs = pipelineClientMock.computeViewLayoutOffThread.mock.calls.length;
    let committed = true;
    act(() => { committed = getCb().commitLayout({ box: { expanded: null } }); });
    expect(committed).toBe(false);
    await settle();
    expect(pipelineClientMock.computeViewLayoutOffThread.mock.calls.length).toBe(runs);
    expect(apiNodesMock.viewsApi.saveLayout).not.toHaveBeenCalled();
  });

  it("засев до первой правки: первый показ без лишнего прогона, с первым перемещением — в слой", async () => {
    // Конвейер отдаёт засев невладеемого g (как на виде, который архитектор не открывал).
    pipeline.result = { ...pipeline.result, intents: [{ kind: "seed-positions", seeds: [{ id: "g", x: 7, y: 8 }] }] };
    await mountReader();
    const runs = pipelineClientMock.computeViewLayoutOffThread.mock.calls.length;
    expect(lastPipelineLayout()).toBe(SAVED);
    pipeline.result = { ...pipeline.result, intents: [] };
    act(() => { getCb().commitLayout({ a: { x: 30, y: 40 } }); });
    await settle();
    expect(pipelineClientMock.computeViewLayoutOffThread.mock.calls.length).toBeGreaterThan(runs);
    expect(lastPipelineLayout()).toEqual({ ...SAVED, a: { x: 30, y: 40 }, g: { x: 7, y: 8 } });
    expect(apiNodesMock.viewsApi.saveLayout).not.toHaveBeenCalled();
  });

  it("фоновое перечитывание: серверная часть свежая, слой читателя поверх неё", async () => {
    const { rerenderWith } = await mountReader();
    act(() => { getCb().commitLayout({ a: { x: 30, y: 40 } }); });
    await settle();
    // архитектор в другом окне передвинул b
    rerenderWith({ viewLayout: { ...SAVED, b: { x: 500, y: 90 } } });
    await settle();
    expect(lastPipelineLayout()).toEqual({ ...SAVED, a: { x: 30, y: 40 }, b: { x: 500, y: 90 } });
  });

  it("смена вида слой забывает", async () => {
    const { rerenderWith } = await mountReader();
    act(() => { getCb().commitLayout({ a: { x: 30, y: 40 } }); });
    await settle();
    rerenderWith({ containerId: "c1", viewLayout: SAVED });
    await settle();
    expect(lastPipelineLayout()).toEqual(SAVED);
  });

  // Доработка П2 (решение архитектора): на просмотровых поверхностях (схемы страниц,
  // «Развёртывание») читатель тянет холст ЛЕВОЙ кнопкой, как до П2, и рамки выделения
  // по перетаскиванию пустого места у него нет; объект он двигает за сам объект.
  it("читатель: пан левой, объект при этом двигается", async () => {
    const { onLayoutChanged } = await mountReader();
    expect(rfProps.current.panOnDrag).toBe(true);
    expect(rfProps.current.selectionOnDrag).toBe(false);
    expect(rfProps.current.nodesDraggable).toBe(true);
    act(() => { getCb().commitLayout({ b: { x: 320, y: 60 } }); });
    await settle();
    expect(lastPipelineLayout()).toEqual({ ...SAVED, b: { x: 320, y: 60 } });
    expect(onLayoutChanged).not.toHaveBeenCalled();
    expect(apiNodesMock.viewsApi.saveLayout).not.toHaveBeenCalled();
  });

  it("архитектор на той же схеме: пан правой, левая тянет рамку выделения", async () => {
    await renderGraph({ mode: PAGE, viewLayout: SAVED });
    expect(rfProps.current.panOnDrag).toEqual([2]);
    expect(rfProps.current.selectionOnDrag).toBe(true);
  });

  it("читатель в редакторе (схема на всё окно, без readOnly): пан правой и рамка, как до П2", async () => {
    await mountReader({ mode: {} });
    expect(rfProps.current.panOnDrag).toEqual([2]);
    expect(rfProps.current.selectionOnDrag).toBe(true);
  });

  it("без расстановки (только просмотр) — ничего", async () => {
    await mountReader({ mode: { readOnly: true } });
    let committed = true;
    act(() => { committed = getCb().commitLayout({ a: { x: 30, y: 40 } }); });
    expect(committed).toBe(false);
  });
});
