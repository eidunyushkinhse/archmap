// Оркестрационные тесты ИСТОРИИ холста (history.md U15): кнопки отмены и клавиши
// Ctrl+Z / Ctrl+Shift+Z. Зависимости (RF/конвейер/хуки) замоканы через levelGraphHarness,
// история — historyMock (свою холст берёт, когда бандл undo не передан).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { resetHarness, historyMock } from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";

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

// Страничная схема: структура только для чтения, расстановка включена.
const PAGE = { readOnly: true, arrangeOnly: true };

describe("LevelGraph orchestration: кнопки и клавиши истории", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("архитектор на схеме с расстановкой: кнопки отмены есть, Ctrl+Z и Ctrl+Shift+Z работают", async () => {
    await renderGraph({ mode: PAGE });
    expect(screen.getByRole("button", { name: "Отменить" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Вернуть" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(historyMock.undo).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(historyMock.redo).toHaveBeenCalledOnce();
  });

  // С задания П2 (решение владельца 2026-11-24) у читателя с расстановкой та же история:
  // отменяются его перемещения и перераскладки на время просмотра.
  it("читатель на схеме с расстановкой: те же кнопки отмены и клавиши", async () => {
    await renderGraph({ isArchitect: false, mode: PAGE });
    expect(screen.getByRole("button", { name: "Отменить" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Вернуть" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(historyMock.undo).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(historyMock.redo).toHaveBeenCalledOnce();
  });

  it("без расстановки (только просмотр): кнопок отмены и клавиш нет ни у одной роли", async () => {
    await renderGraph({ mode: { readOnly: true } });
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    resetHarness();
    await renderGraph({ isArchitect: false, mode: { readOnly: true } });
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(historyMock.undo).not.toHaveBeenCalled();
  });
});
