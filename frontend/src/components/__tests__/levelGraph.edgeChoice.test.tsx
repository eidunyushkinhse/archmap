// Оркестрационные тесты выбора связи (edge choice) LevelGraphInner (Фаза 3а).
// Фиксируют контракт инспекции связей через cbRef (openEdgeMembers):
//   • openEdgeMembers(id связей, концы стрелки) → onEdgesChoice с найденными связями и
//     теми же концами (даже ОДНА связь открывает «Выберите связь» — оттуда доступна
//     дозапись новой); неизвестные id фильтруются; пусто → onEdgesChoice НЕ зовётся.
// (Второй колбэк — модалка «общего плеча» E80 — снят вместе со стволами, 2026-10-11.)
// RF/конвейер замоканы; колбэки оркестрации — через getCb.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Edge as AppEdge } from "../../types";
import type { Edge as RFEdge } from "@xyflow/react";
import { resetHarness, rf, rfProps } from "./levelGraphHarness";
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

function edge(id: string, over: Partial<AppEdge> = {}): AppEdge {
  return {
    id,
    label: null,
    technology: null,
    source_id: "a",
    target_id: "b",
    version: 1,
    created_at: "",
    ...over,
  } as AppEdge;
}

describe("LevelGraph orchestration: выбор связи (edges choice)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("openEdgeMembers: одиночная связь всё равно открывает выбор (onEdgesChoice с ней)", async () => {
    const e1 = edge("e1");
    const { props } = await renderGraph({ edges: [e1] });

    getCb().openEdgeMembers(["e1"]);
    expect(props.edgeCallbacks.onEdgesChoice).toHaveBeenCalledOnce();
    expect(props.edgeCallbacks.onEdgesChoice).toHaveBeenCalledWith([e1], undefined);
  });

  it("openEdgeMembers: несколько связей → все найденные; неизвестные id фильтруются", async () => {
    const e1 = edge("e1");
    const e2 = edge("e2");
    const { props } = await renderGraph({ edges: [e1, e2] });

    getCb().openEdgeMembers(["e1", "missing", "e2"]);
    expect(props.edgeCallbacks.onEdgesChoice).toHaveBeenCalledWith([e1, e2], undefined);
  });

  // E57 (2026-11-02): концы стрелки едут с кликом до окна выбора — шапка называет ими
  // общую пару, когда настоящие концы связей пучка расходятся (свёрнутая система).
  it("openEdgeMembers: концы стрелки доходят до onEdgesChoice", async () => {
    const e1 = edge("e1");
    const e2 = edge("e2");
    const { props } = await renderGraph({ edges: [e1, e2] });

    getCb().openEdgeMembers(["e1", "e2"], { source: "a", target: "sys" });
    expect(props.edgeCallbacks.onEdgesChoice).toHaveBeenCalledWith([e1, e2], { source: "a", target: "sys" });
  });

  // Двойной клик по линии: концы стрелки — её собственные; соседняя стрелка общего участка
  // с другим концом гасит этот конец (null), члены — объединение (E57, E95).
  it("двойной клик по линии: концы своей стрелки; сосед по общему участку с другой целью гасит цель", async () => {
    const e1 = edge("e1");
    const e2 = edge("e2");
    const e3 = edge("e3", { target_id: "c" });
    const { props } = await renderGraph({ edges: [e1, e2, e3] });
    const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const bus = { id: "merge:a->sys", source: "a", target: "sys", data: { memberIds: ["e1", "e2"], autoRoute: route } } as RFEdge;
    const dbl = rfProps.current.onEdgeDoubleClick as (e: { clientX: number; clientY: number }, edge: RFEdge) => void;

    rf.getEdges.mockReturnValue([bus]);
    dbl({ clientX: 50, clientY: 0 }, bus);
    expect(props.edgeCallbacks.onEdgesChoice).toHaveBeenLastCalledWith([e1, e2], { source: "a", target: "sys" });

    const neighbor = { id: "e3", source: "a", target: "c", data: { memberIds: ["e3"], autoRoute: route } } as RFEdge;
    rf.getEdges.mockReturnValue([bus, neighbor]);
    dbl({ clientX: 50, clientY: 0 }, bus);
    expect(props.edgeCallbacks.onEdgesChoice).toHaveBeenLastCalledWith([e1, e2, e3], { source: "a", target: null });
  });

  it("openEdgeMembers: ни одной найденной связи → onEdgesChoice НЕ вызывается", async () => {
    const { props } = await renderGraph({ edges: [edge("e1")] });

    getCb().openEdgeMembers(["missing"]);
    expect(props.edgeCallbacks.onEdgesChoice).not.toHaveBeenCalled();
  });
});
