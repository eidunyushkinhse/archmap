// Оркестрационные тесты QUICK-CONNECT («быстрая связь») LevelGraphInner (Фаза 3а).
// Фиксируют контракт стрелки-кнопки у хэндла: enter (наведение) подбирает цель из
// геометрии узлов уровня (findQuickConnectTarget уже под юнит-тестами) и строит
// qcCandidate; activate (клик) создаёт связь через те же колбэк-пропсы, что и ручное
// протягивание:
//   • цель-ЛИСТ (блок без детей / гость) → onCreateEdge(source, target, sourceHandle,
//     targetHandle, sourceName, targetName);
//   • цель-«зона входа» (контейнер ИЛИ сервис с детьми) → onConnectInto(source,
//     containerId, containerName, sourceHandle, sourceName) — как дроп в тело;
//   • сервис vs БД: has_children у БД/брокера НЕ делает зону входа (canHaveChildren);
//   • leave / нет цели в радиусе → activate не создаёт связь; activate одноразов
//     (гасит qc после клика).
// RF/конвейер замоканы; rfNodes контролируются тестом, колбэки — через getCb.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import type { Node as RFNode } from "@xyflow/react";
import type { Node as AppNode } from "../../types";
import { resetHarness, rfHandles } from "./levelGraphHarness";
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

// --- хелперы RF-узлов (позиции в координатах графа; источник слева, цель справа) ---
function blockNode(id: string, x: number, name: string, over: Partial<AppNode> = {}): RFNode {
  return {
    id,
    type: "block",
    position: { x, y: 0 },
    data: { appNode: { id, name, shape: "service", has_children: false, ...over } },
  } as RFNode;
}
function containerNode(id: string, x: number, name: string): RFNode {
  return { id, type: "container", position: { x, y: 0 }, data: { id, name } } as RFNode;
}
function ghostNode(id: string, x: number, name: string): RFNode {
  return {
    id,
    type: "ghost",
    position: { x, y: 0 },
    data: { appNode: { id, name, shape: "service", has_children: false } },
  } as RFNode;
}
async function setRfNodes(nodes: RFNode[]): Promise<void> {
  await act(async () => {
    rfHandles.setNodes?.(nodes);
  });
}
// Навестись на правый хэндл источника и подтвердить (клик по стрелке-кнопке).
async function enterRight(sourceId: string): Promise<void> {
  await act(async () => {
    getCb().quickConnect.enter(sourceId, `${sourceId}--right--1`, "right", 0.5);
  });
}
async function activate(): Promise<void> {
  await act(async () => {
    getCb().quickConnect.activate();
  });
}

describe("LevelGraph orchestration: quick-connect (быстрая связь)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("цель-лист (блок без детей): activate → onCreateEdge с полными концами и именами", async () => {
    const { props } = await renderGraph({});
    await setRfNodes([blockNode("s", 0, "Source"), blockNode("t", 300, "Target")]);

    await enterRight("s");
    await activate();

    // Хэндл цели подобран напротив источника (left, индекс 1 — центр по Y).
    expect(props.edgeCallbacks.onCreateEdge).toHaveBeenCalledOnce();
    expect(props.edgeCallbacks.onCreateEdge).toHaveBeenCalledWith(
      "s", "t", "s--right--1", "t--left--1", "Source", "Target",
    );
    expect(props.edgeCallbacks.onConnectInto).not.toHaveBeenCalled();
  });

  it("цель-гость: activate → onCreateEdge (гость всегда прямая связь)", async () => {
    const { props } = await renderGraph({});
    await setRfNodes([blockNode("s", 0, "Source"), ghostNode("g", 300, "Ghost")]);

    await enterRight("s");
    await activate();

    expect(props.edgeCallbacks.onCreateEdge).toHaveBeenCalledWith(
      "s", "g", "s--right--1", "g--left--1", "Source", "Ghost",
    );
    expect(props.edgeCallbacks.onConnectInto).not.toHaveBeenCalled();
  });

  it("цель-контейнер: activate → onConnectInto (выбор потомка, не прямая связь)", async () => {
    const { props } = await renderGraph({});
    await setRfNodes([blockNode("s", 0, "Source"), containerNode("c", 300, "Cont")]);

    await enterRight("s");
    await activate();

    expect(props.edgeCallbacks.onConnectInto).toHaveBeenCalledOnce();
    expect(props.edgeCallbacks.onConnectInto).toHaveBeenCalledWith("s", "c", "Cont", "s--right--1", "Source");
    expect(props.edgeCallbacks.onCreateEdge).not.toHaveBeenCalled();
  });

  it("цель-сервис с детьми: activate → onConnectInto (зона входа)", async () => {
    const { props } = await renderGraph({});
    await setRfNodes([
      blockNode("s", 0, "Source"),
      blockNode("big", 300, "Big", { has_children: true, shape: "service" }),
    ]);

    await enterRight("s");
    await activate();

    expect(props.edgeCallbacks.onConnectInto).toHaveBeenCalledWith("s", "big", "Big", "s--right--1", "Source");
    expect(props.edgeCallbacks.onCreateEdge).not.toHaveBeenCalled();
  });

  it("БД с детьми — НЕ зона входа (canHaveChildren): activate → onCreateEdge напрямую", async () => {
    const { props } = await renderGraph({});
    await setRfNodes([
      blockNode("s", 0, "Source"),
      blockNode("db", 300, "DB", { has_children: true, shape: "database" }),
    ]);

    await enterRight("s");
    await activate();

    expect(props.edgeCallbacks.onCreateEdge).toHaveBeenCalledOnce();
    expect(props.edgeCallbacks.onConnectInto).not.toHaveBeenCalled();
  });

  it("leave до подтверждения: qc гаснет → activate не создаёт связь", async () => {
    const { props } = await renderGraph({});
    await setRfNodes([blockNode("s", 0, "Source"), blockNode("t", 300, "Target")]);

    await enterRight("s");
    await act(async () => {
      getCb().quickConnect.leave();
    });
    await activate();

    expect(props.edgeCallbacks.onCreateEdge).not.toHaveBeenCalled();
    expect(props.edgeCallbacks.onConnectInto).not.toHaveBeenCalled();
  });

  it("нет подходящей цели в радиусе: activate не создаёт связь", async () => {
    const { props } = await renderGraph({});
    // Только источник — кандидатов нет.
    await setRfNodes([blockNode("s", 0, "Source")]);

    await enterRight("s");
    await activate();

    expect(props.edgeCallbacks.onCreateEdge).not.toHaveBeenCalled();
    expect(props.edgeCallbacks.onConnectInto).not.toHaveBeenCalled();
  });

  it("activate одноразов: после клика qc гаснет, повторный activate без наведения — no-op", async () => {
    const { props } = await renderGraph({});
    await setRfNodes([blockNode("s", 0, "Source"), blockNode("t", 300, "Target")]);

    await enterRight("s");
    await activate();
    await activate(); // qc уже null

    expect(props.edgeCallbacks.onCreateEdge).toHaveBeenCalledOnce();
  });

  it("наведение само по себе не создаёт связь (только превью)", async () => {
    const { props } = await renderGraph({});
    await setRfNodes([blockNode("s", 0, "Source"), blockNode("t", 300, "Target")]);

    await enterRight("s");

    expect(props.edgeCallbacks.onCreateEdge).not.toHaveBeenCalled();
    expect(props.edgeCallbacks.onConnectInto).not.toHaveBeenCalled();
  });
});
