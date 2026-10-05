// Оркестрационные тесты ПЕРЕПРИВЯЗКИ КОНЦА-В-РАМКУ (эпик «связи, упирающиеся в рамку»).
//
// Ручной слой геометрии стрелок удалён (edge.md E1), и это единственное исключение:
// тянуть можно ТОЛЬКО конец, упёршийся в рамку, и ТОЛЬКО на узел внутри неё. Здесь
// фиксируется контракт склейки: что холст пропускает наружу, а что гасит молча.
// Промах не должен ни писать в БД, ни оставлять связь с одним концом — поэтому
// «не позвал колбэк» здесь такое же важное утверждение, как «позвал».
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Edge as RFEdge, Connection } from "@xyflow/react";
import { resetHarness, pipeline, rfProps, edgeConnectMock } from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";
import type { FrameRect } from "../graph/layout/frames";

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

// Рамка раскрытого контейнера F с единственным ребёнком K внутри.
function frame(id: string, members: string[]): FrameRect {
  return {
    id, name: id, depth: 1, native: false,
    memberIds: new Set(members),
    content: { minX: 0, minY: 0, maxX: 190, maxY: 100 },
    rect: { x: -30, y: -30, w: 250, h: 190 },
  };
}

// Ребро «X → рамка F» так, как его собирает assembleRf: id группы, реальные связи в data.
const edgeToFrame = (memberIds: string[]): RFEdge =>
  ({ id: "g", source: "X", target: "F", data: { memberIds } } as RFEdge);

const reconnect = (oldEdge: RFEdge, conn: Connection) =>
  (rfProps.current.onReconnect as (e: RFEdge, c: Connection) => void)(oldEdge, conn);

describe("LevelGraph — перепривязка конца-в-рамку", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
    pipeline.result.layout.guestFrames = [frame("F", ["K"])];
    pipeline.result.layout.frameEnds = ["F"];
  });
  afterEach(() => { vi.useRealTimers(); });

  it("конец перевешен на узел ВНУТРИ рамки — колбэк с реальными связями группы", async () => {
    const onReconnectFrameEnd = vi.fn();
    const { props } = await renderGraph({
      edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd },
    });
    expect(props.edgeCallbacks.onReconnectFrameEnd).toBe(onReconnectFrameEnd);

    reconnect(edgeToFrame(["e1", "e2"]), { source: "X", target: "K", sourceHandle: null, targetHandle: null });

    expect(onReconnectFrameEnd).toHaveBeenCalledWith(["e1", "e2"], "target", "F", "K");
  });

  it("промах мимо детей рамки — жест отменён, наружу ничего не идёт", async () => {
    const onReconnectFrameEnd = vi.fn();
    await renderGraph({ edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd } });

    // Z есть на уровне, но членом рамки F не является
    reconnect(edgeToFrame(["e1"]), { source: "X", target: "Z", sourceHandle: null, targetHandle: null });

    expect(onReconnectFrameEnd).not.toHaveBeenCalled();
  });

  it("обычный конец (не рамка) не перевешивается", async () => {
    const onReconnectFrameEnd = vi.fn();
    pipeline.result.layout.frameEnds = []; // связь ни во что не упирается
    await renderGraph({ edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd } });

    reconnect(edgeToFrame(["e1"]), { source: "X", target: "K", sourceHandle: null, targetHandle: null });

    expect(onReconnectFrameEnd).not.toHaveBeenCalled();
  });

  it("в read-only жест не работает", async () => {
    const onReconnectFrameEnd = vi.fn();
    await renderGraph({
      mode: { readOnly: true },
      edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd },
    });

    reconnect(edgeToFrame(["e1"]), { source: "X", target: "K", sourceHandle: null, targetHandle: null });

    expect(onReconnectFrameEnd).not.toHaveBeenCalled();
  });

  it("начало и конец перевеса уходят в поток протягивания — он гасит «Новую связь»", async () => {
    // RF зовёт для перевеса общие onConnectStart/onConnectEnd; метку перевеса ставят
    // onReconnectStart/End (регресс: перевес открывал ещё и окно «Новая связь»,
    // поведение самой метки — useEdgeConnect.reconnect.test.ts).
    await renderGraph({ edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd: vi.fn() } });

    expect(rfProps.current.onReconnectStart).toBe(edgeConnectMock.handleReconnectStart);
    expect(rfProps.current.onReconnectEnd).toBe(edgeConnectMock.handleReconnectEnd);
    expect(rfProps.current.onConnectEnd).toBe(edgeConnectMock.handleConnectEnd);
  });

  it("оба конца не изменились — не жест перепривязки", async () => {
    const onReconnectFrameEnd = vi.fn();
    await renderGraph({ edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd } });

    reconnect(edgeToFrame(["e1"]), { source: "X", target: "F", sourceHandle: null, targetHandle: null });

    expect(onReconnectFrameEnd).not.toHaveBeenCalled();
  });
});
