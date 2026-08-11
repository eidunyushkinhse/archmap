// Приглашение пустого слоя (эпик «связи, упирающиеся в рамку»): пока архитектор тянет
// шаблон, внутренность рамки родителя подсвечивается, а попадание центра будущего узла
// внутрь усиливает подсветку. Подсветка ЧИСТО ВИЗУАЛЬНАЯ (canvas.md CV20a) — в цели
// дропа рамка уровня не входит, поэтому здесь проверяется именно рендер-условие:
// показывается ТОЛЬКО на пустом слое и ТОЛЬКО во время драга.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetHarness, pipeline, templateDropMock } from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";
import type { FrameRect } from "../graph/layout/frames";
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

// Рамка пустого слоя: синтетический бокс 190×100 в начале координат + паддинг 30.
const levelFrame: FrameRect = {
  id: "P", name: "Родитель", depth: 0, native: true,
  memberIds: new Set(),
  content: { minX: 0, minY: 0, maxX: 190, maxY: 100 },
  rect: { x: -30, y: -30, w: 250, h: 190 },
};

const appNode = (id: string): AppNode => ({ id, name: id, shape: "service" } as AppNode);

const hint = (c: HTMLElement) => c.querySelector("[data-empty-frame-hint]")?.getAttribute("data-empty-frame-hint");

describe("LevelGraph — приглашение пустого слоя", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
    pipeline.result.layout.levelFrame = levelFrame;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("без драга подсветки нет — рамка просто нарисована", async () => {
    const { container } = await renderGraph({});
    expect(hint(container)).toBeUndefined();
  });

  it("во время драга светится приглашением, а центр внутри рамки усиливает подсветку", async () => {
    // центр будущего узла (x+95, y+50) далеко справа — мимо рамки
    templateDropMock.dropPreview = { shape: "service", x: 900, y: 900 };
    const { container, rerenderWith } = await renderGraph({});
    expect(hint(container)).toBe("idle");

    // центр внутри rect (-30..220 × -30..160): x+95 = 95, y+50 = 50
    templateDropMock.dropPreview = { shape: "service", x: 0, y: 0 };
    rerenderWith({});
    expect(hint(container)).toBe("hit");
  });

  it("на НЕпустом слое приглашения нет, даже если рамка уровня есть", async () => {
    // рамка уровня существует и на непустом слое (в неё упирается связь), но
    // «приглашение положить первый узел» там неуместно
    pipeline.result.layout.nodes = [appNode("A")];
    templateDropMock.dropPreview = { shape: "service", x: 0, y: 0 };
    const { container } = await renderGraph({});
    expect(hint(container)).toBeUndefined();
  });
});
