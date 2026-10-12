// Оркестрационные тесты ПЕРЕПРИВЯЗКИ КОНЦА-В-РАМКУ (эпик «связи, упирающиеся в рамку»).
//
// Ручной слой геометрии стрелок удалён (edge.md E1), и это единственное исключение:
// тянуть можно ТОЛЬКО конец, упёршийся в рамку, и ТОЛЬКО на узел внутри неё. Здесь
// фиксируется контракт склейки: что холст пропускает наружу, а что гасит молча.
// Промах не должен ни писать в БД, ни оставлять связь с одним концом — поэтому
// «не позвал колбэк» здесь такое же важное утверждение, как «позвал».
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetHarness, pipeline, rehangProps, edgeConnectMock } from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";
import type { FrameRect } from "../graph/layout/frames";
import type { RehangEdge, RehangEnd } from "../graph/ReconnectContext";

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
vi.mock("../graph/ReconnectContext", async () => (await import("./levelGraphHarness")).reconnectContextMock);

// Рамка раскрытого контейнера F с единственным ребёнком K внутри.
function frame(id: string, members: string[]): FrameRect {
  return {
    id, name: id, depth: 1, native: false,
    memberIds: new Set(members),
    content: { minX: 0, minY: 0, maxX: 190, maxY: 100 },
    rect: { x: -30, y: -30, w: 250, h: 190 },
  };
}

// Ребро «X → рамка F» глазами ручки перевеса (RehangAnchor): концы, служебные хэндлы,
// реальные связи группы.
const edgeToFrame = (memberIds: string[]): RehangEdge =>
  ({ id: "g", source: "X", target: "F", sourceHandle: null, targetHandle: null, memberIds });

// Ручка на ребре зовёт правила холста через ReconnectProvider (Ф5): конец end ребра
// отпущен на узле toNodeId.
const reconnect = (edge: RehangEdge, end: RehangEnd, toNodeId: string) =>
  rehangProps.current?.reconnect(edge, end, toNodeId);
const isValid = (edge: RehangEdge, end: RehangEnd, toNodeId: string) =>
  rehangProps.current?.isValidTarget(edge, end, toNodeId);

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

    expect(isValid(edgeToFrame(["e1"]), "target", "K")).toBe(true);
    reconnect(edgeToFrame(["e1", "e2"]), "target", "K");

    expect(onReconnectFrameEnd).toHaveBeenCalledWith(["e1", "e2"], "target", "F", "K");
  });

  it("промах мимо детей рамки — жест отменён, наружу ничего не идёт", async () => {
    const onReconnectFrameEnd = vi.fn();
    await renderGraph({ edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd } });

    // Z есть на уровне, но членом рамки F не является
    expect(isValid(edgeToFrame(["e1"]), "target", "Z")).toBe(false);
    reconnect(edgeToFrame(["e1"]), "target", "Z");

    expect(onReconnectFrameEnd).not.toHaveBeenCalled();
  });

  it("обычный конец (не рамка) не перевешивается", async () => {
    const onReconnectFrameEnd = vi.fn();
    pipeline.result.layout.frameEnds = []; // связь ни во что не упирается
    await renderGraph({ edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd } });

    expect(isValid(edgeToFrame(["e1"]), "target", "K")).toBe(false);
    reconnect(edgeToFrame(["e1"]), "target", "K");

    expect(onReconnectFrameEnd).not.toHaveBeenCalled();
  });

  it("в read-only жест не работает", async () => {
    const onReconnectFrameEnd = vi.fn();
    await renderGraph({
      mode: { readOnly: true },
      edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd },
    });

    expect(isValid(edgeToFrame(["e1"]), "target", "K")).toBe(false);
    reconnect(edgeToFrame(["e1"]), "target", "K");

    expect(onReconnectFrameEnd).not.toHaveBeenCalled();
  });

  it("начало и конец перевеса ставят метку потоку протягивания — он гасит «Новую связь»", async () => {
    // Жест ручки идёт через общие onConnectStart/onConnectEnd холста; метку перевеса
    // ставят onStart/onEnd провайдера (регресс: перевес открывал ещё и окно «Новая
    // связь», поведение самой метки — useEdgeConnect.reconnect.test.ts).
    await renderGraph({ edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd: vi.fn() } });

    rehangProps.current?.onStart();
    expect(edgeConnectMock.handleReconnectStart).toHaveBeenCalledTimes(1);
    rehangProps.current?.onEnd();
    expect(edgeConnectMock.handleReconnectEnd).toHaveBeenCalledTimes(1);
  });

  it("конец отпущен на втором конце той же связи — не связь (сам на себя)", async () => {
    const onReconnectFrameEnd = vi.fn();
    await renderGraph({ edgeCallbacks: { onEdgesChoice: vi.fn(), onReconnectFrameEnd } });

    expect(isValid(edgeToFrame(["e1"]), "target", "X")).toBe(false);
    reconnect(edgeToFrame(["e1"]), "target", "X");

    expect(onReconnectFrameEnd).not.toHaveBeenCalled();
  });
});
