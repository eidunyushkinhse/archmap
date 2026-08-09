// Оркестрационные тесты LOCATE («показать на схеме») LevelGraphInner (Фаза 3а).
// Фиксируют контракт эффекта фокуса: запрос locate центрирует холст на цели
// (setCenter для одиночного узла, fitBounds для связи/группы) и коротко подсвечивает
// её (класс lg-locate-flash на DOM-элементе по data-id). Обработка ОТЛОЖЕННАЯ — ждёт,
// пока цель появится в rfNodes/rfEdges (раскладка async); по token фиксируется, чтобы
// повторный тот же запрос не дёргал центрирование дважды.
// RF/конвейер замоканы; rfNodes/rfEdges контролируются тестом через rfHandles.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { NODE_W, NODE_H } from "../graph/constants";
import LevelGraph from "../LevelGraph";
import { resetHarness, rf, rfHandles, flushRaf, settle } from "./levelGraphHarness";
import { renderGraph, baseProps, type LevelGraphProps } from "./levelGraphRender";

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

// --- хелперы RF-сущностей (минимальные, для эффекта locate) ---
function rfNode(id: string, x: number, y: number, over: Partial<RFNode> = {}): RFNode {
  return { id, type: "block", position: { x, y }, data: {}, ...over } as RFNode;
}
function rfEdge(id: string, source: string, target: string, over: Partial<RFEdge> = {}): RFEdge {
  return { id, source, target, data: { memberIds: [id] }, ...over } as RFEdge;
}
async function setRfNodes(nodes: RFNode[]): Promise<void> {
  await act(async () => {
    rfHandles.setNodes?.(nodes);
  });
}
async function setRfEdges(edges: RFEdge[]): Promise<void> {
  await act(async () => {
    rfHandles.setEdges?.(edges);
  });
}

type Locate = NonNullable<LevelGraphProps["locate"]>;

describe("LevelGraph orchestration: locate (показать на схеме)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("одиночный узел: setCenter на центр узла с zoom 1.2 (крупнее обычного)", async () => {
    const locate: Locate = { kind: "node", ids: ["n1"], token: 1 };
    await renderGraph({ locate });

    await setRfNodes([rfNode("n1", 100, 100)]);

    expect(rf.setCenter).toHaveBeenCalledOnce();
    // Центр = position + половина габарита (NODE_W×NODE_H, замер не задан).
    expect(rf.setCenter).toHaveBeenCalledWith(100 + NODE_W / 2, 100 + NODE_H / 2, {
      zoom: 1.2,
      duration: 600,
    });
    expect(rf.fitBounds).not.toHaveBeenCalled();
  });

  it("отложенность: цели ещё нет на холсте → центрирование ждёт её появления", async () => {
    const locate: Locate = { kind: "node", ids: ["n1"], token: 1 };
    await renderGraph({ locate });

    // rfNodes пуст — эффект не находит цель и не центрирует.
    expect(rf.setCenter).not.toHaveBeenCalled();

    await setRfNodes([rfNode("n1", 0, 0)]);
    expect(rf.setCenter).toHaveBeenCalledOnce();
  });

  it("дедуп по token: тот же запрос не центрирует повторно при пере-раскладке", async () => {
    const locate: Locate = { kind: "node", ids: ["n1"], token: 1 };
    await renderGraph({ locate });

    await setRfNodes([rfNode("n1", 0, 0)]);
    expect(rf.setCenter).toHaveBeenCalledTimes(1);

    // rfNodes меняется (пере-раскладка) — эффект перезапускается, но token уже
    // обработан (locateHandledRef) → повторного центрирования нет.
    await setRfNodes([rfNode("n1", 0, 0), rfNode("n2", 300, 0)]);
    expect(rf.setCenter).toHaveBeenCalledTimes(1);
  });

  it("новый token центрирует снова (повторный клик по тому же объекту)", async () => {
    const el = (token: number) => (
      <LevelGraph {...baseProps()} locate={{ kind: "node", ids: ["n1"], token }} />
    );
    const { rerender } = render(el(1));
    await settle();
    await setRfNodes([rfNode("n1", 0, 0)]);
    expect(rf.setCenter).toHaveBeenCalledTimes(1);

    // Новый token (MapEditorPage инкрементит на каждый клик) → запрос обрабатывается
    // заново, даже при неизменной цели.
    rerender(el(2));
    await settle();
    expect(rf.setCenter).toHaveBeenCalledTimes(2);
  });

  it("связь (edge): fitBounds по bbox обоих концов (не setCenter)", async () => {
    const locate: Locate = { kind: "edge", ids: ["e1"], token: 1 };
    await renderGraph({ locate });

    await setRfNodes([rfNode("n1", 0, 0), rfNode("n2", 400, 0)]);
    await setRfEdges([rfEdge("e1", "n1", "n2")]);

    expect(rf.fitBounds).toHaveBeenCalledOnce();
    // bbox: minX=0, minY=0, maxX=400+NODE_W, maxY=NODE_H.
    expect(rf.fitBounds).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 400 + NODE_W, height: NODE_H },
      { padding: 0.4, duration: 600 },
    );
    expect(rf.setCenter).not.toHaveBeenCalled();
  });

  it("связь найдена по членству в пучке (master-стрелка несёт сырой id в memberIds)", async () => {
    const locate: Locate = { kind: "edge", ids: ["raw-edge"], token: 1 };
    await renderGraph({ locate });

    await setRfNodes([rfNode("n1", 0, 0), rfNode("n2", 400, 0)]);
    // Отрисованное ребро — пучок merge:*; сырой id связи лежит в memberIds.
    await setRfEdges([
      { id: "merge:n1->n2", source: "n1", target: "n2", data: { memberIds: ["raw-edge"] } } as RFEdge,
    ]);

    expect(rf.fitBounds).toHaveBeenCalledOnce();
  });

  it("связь скрыта проекцией: фолбэк на представителей концов (endIds)", async () => {
    const locate: Locate = { kind: "edge", ids: ["hidden"], endIds: ["n1", "n2"], token: 1 };
    await renderGraph({ locate });

    // Самого ребра среди отрисованных нет — есть только представители концов.
    await setRfNodes([rfNode("n1", 0, 0), rfNode("n2", 400, 0)]);
    await setRfEdges([]);

    expect(rf.fitBounds).toHaveBeenCalledOnce();
    expect(rf.setCenter).not.toHaveBeenCalled();
  });

  it("группа (несколько узлов): fitBounds по общему bbox", async () => {
    const locate: Locate = { kind: "group", ids: ["n1", "n2"], token: 1 };
    await renderGraph({ locate });

    await setRfNodes([rfNode("n1", 0, 0), rfNode("n2", 400, 300)]);

    expect(rf.fitBounds).toHaveBeenCalledOnce();
    expect(rf.fitBounds).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 400 + NODE_W, height: 300 + NODE_H },
      { padding: 0.4, duration: 600 },
    );
  });

  it("flash-подсветка: класс lg-locate-flash добавляется и снимается по таймеру", async () => {
    const el = document.createElement("div");
    el.className = "react-flow__node";
    el.setAttribute("data-id", "n1");
    document.body.appendChild(el);

    const locate: Locate = { kind: "node", ids: ["n1"], token: 1 };
    await renderGraph({ locate });
    await setRfNodes([rfNode("n1", 0, 0)]);

    // rAF вешает класс.
    await flushRaf();
    expect(el.classList.contains("lg-locate-flash")).toBe(true);

    // Через 2200мс класс снимается.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2300);
    });
    expect(el.classList.contains("lg-locate-flash")).toBe(false);
  });
});
