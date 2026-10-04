// Шина тура (docs/tasks/demo-tour.md) из холста: раскрытие лупой и законченный драг
// узла — события «node-expanded» и «node-drag-end». Драг без записи позиций (узел
// вернули на место) событием не считается.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import type { Node as RFNode } from "@xyflow/react";
import { resetHarness, apiNodesMock, rfProps, settle, snapMock } from "./levelGraphHarness";
import { renderGraph, getCb } from "./levelGraphRender";
import { onTourEvent, type TourBusEvent } from "../tour/tourBus";

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

const events: TourBusEvent[] = [];
let off: () => void = () => {};

describe("LevelGraph — события тура", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
    events.length = 0;
    off = onTourEvent((e) => { events.push(e); });
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it("лупа на узле — «node-expanded» с его id", async () => {
    apiNodesMock.nodesApi.list.mockResolvedValueOnce([]);
    await renderGraph({});
    await act(async () => { getCb().expandLocalContainer("c1"); });
    await settle();
    expect(events).toContainEqual({ type: "node-expanded", id: "c1" });
  });

  it("драг с записью позиции — «node-drag-end»; узел вернули на место — тишина", async () => {
    await renderGraph({});
    const drop = rfProps.current.onNodeDragStop as (e: MouseEvent, n: RFNode, ns: RFNode[]) => void;
    const n = { id: "a", position: { x: 0, y: 0 }, data: {} } as RFNode;

    snapMock.handleNodeDragStop.mockReturnValue(false);
    act(() => { drop(new MouseEvent("mouseup"), n, [n]); });
    expect(events.filter((e) => e.type === "node-drag-end")).toHaveLength(0);

    snapMock.handleNodeDragStop.mockReturnValue(true);
    act(() => { drop(new MouseEvent("mouseup"), n, [n]); });
    expect(events).toContainEqual({ type: "node-drag-end", ids: ["a"] });
  });
});
