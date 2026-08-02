// Оркестрационные тесты выбора связи (edge choice) LevelGraphInner (Фаза 3а).
// Фиксируют контракт инспекции связей через cbRef (openEdgeMembers/openTrunkMembers):
//   • openEdgeMembers(id связей) → onEdgesChoice с найденными связями (даже ОДНА связь
//     открывает «Выберите связь» — оттуда доступна дозапись новой); неизвестные id
//     фильтруются; пусто → onEdgesChoice НЕ зовётся;
//   • openTrunkMembers(kind, id) → onTrunkChoice(kind, связи) только при ≥2 найденных
//     связях ОБЩЕГО ПЛЕЧА (иначе вырожденный ствол → false, обычная детализация) и при
//     заданном onTrunkChoice.
// RF/конвейер замоканы; колбэки оркестрации — через getCb.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Edge as AppEdge } from "../../types";
import { resetHarness } from "./levelGraphHarness";
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

describe("LevelGraph orchestration: выбор связи (edges choice / trunk)", () => {
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
    expect(props.onEdgesChoice).toHaveBeenCalledOnce();
    expect(props.onEdgesChoice).toHaveBeenCalledWith([e1]);
  });

  it("openEdgeMembers: несколько связей → все найденные; неизвестные id фильтруются", async () => {
    const e1 = edge("e1");
    const e2 = edge("e2");
    const { props } = await renderGraph({ edges: [e1, e2] });

    getCb().openEdgeMembers(["e1", "missing", "e2"]);
    expect(props.onEdgesChoice).toHaveBeenCalledWith([e1, e2]);
  });

  it("openEdgeMembers: ни одной найденной связи → onEdgesChoice НЕ вызывается", async () => {
    const { props } = await renderGraph({ edges: [edge("e1")] });

    getCb().openEdgeMembers(["missing"]);
    expect(props.onEdgesChoice).not.toHaveBeenCalled();
  });

  it("openTrunkMembers: ≥2 связей общего плеча → onTrunkChoice(kind, связи), возврат true", async () => {
    const onTrunkChoice = vi.fn<(kind: "out" | "in", edges: AppEdge[]) => void>();
    const e1 = edge("e1");
    const e2 = edge("e2");
    const { props } = await renderGraph({ edges: [e1, e2], onTrunkChoice });
    void props;

    const handled = getCb().openTrunkMembers("out", ["e1", "e2"]);
    expect(handled).toBe(true);
    expect(onTrunkChoice).toHaveBeenCalledWith("out", [e1, e2]);
  });

  it("openTrunkMembers: вырожденный ствол (<2 связей) → false, onTrunkChoice НЕ зовётся", async () => {
    const onTrunkChoice = vi.fn<(kind: "out" | "in", edges: AppEdge[]) => void>();
    await renderGraph({ edges: [edge("e1")], onTrunkChoice });

    const handled = getCb().openTrunkMembers("in", ["e1"]);
    expect(handled).toBe(false);
    expect(onTrunkChoice).not.toHaveBeenCalled();
  });

  it("openTrunkMembers: без onTrunkChoice → false (даже при ≥2 связях)", async () => {
    // onTrunkChoice не передан (базовые пропсы его не задают).
    const { props } = await renderGraph({ edges: [edge("e1"), edge("e2")] });

    const handled = getCb().openTrunkMembers("out", ["e1", "e2"]);
    expect(handled).toBe(false);
    expect(props.onEdgesChoice).not.toHaveBeenCalled();
  });
});
