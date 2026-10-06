// Оркестрационные тесты устойчивой подсветки связанного (linked-highlight) и сброса
// выделения LevelGraphInner (Фаза 3а). Фиксируют контракт эффекта П5/П6: что открыто
// в правой панели (linkedHighlight), то подсвечено DOM-классами по data-id:
//   • kind:"node" → сам узел (lg-linked-node) + инцидентные отрисованные стрелки
//     (lg-linked-edge);
//   • kind:"edge" → несущее ребро (ищем по id И по членству в пучке) + оба его узла;
//   • подсвеченное ребро поднимается НАД прочими (перестановка его <svg> в конец
//     контейнера .react-flow__edges);
//   • смена выделения (linkedHighlight→null) снимает классы (cleanup).
// Плюс: двойной клик по пустому холсту → onClearSelection.
// RF/конвейер замоканы; rfEdges контролируются тестом, подсветка — на реальном DOM.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";
import type { Edge as RFEdge } from "@xyflow/react";
import LevelGraph from "../LevelGraph";
import { resetHarness, rfHandles, rfProps, flushRaf, settle } from "./levelGraphHarness";
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

// --- хелперы: RF-рёбра (контролируемый стейт) и DOM-элементы (мишени подсветки) ---
function rfEdge(id: string, source: string, target: string, over: Partial<RFEdge> = {}): RFEdge {
  return { id, source, target, data: { memberIds: [id] }, ...over } as RFEdge;
}
async function setRfEdges(edges: RFEdge[]): Promise<void> {
  await act(async () => {
    rfHandles.setEdges?.(edges);
  });
}
function addDomNode(id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "react-flow__node";
  el.setAttribute("data-id", id);
  document.body.appendChild(el);
  return el;
}
function addDomEdge(id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "react-flow__edge";
  el.setAttribute("data-id", id);
  document.body.appendChild(el);
  return el;
}

type Linked = NonNullable<LevelGraphProps["linkedHighlight"]>;

describe("LevelGraph orchestration: linked-highlight / выделение", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("kind:node подсвечивает узел и инцидентные стрелки (соседние узлы — нет)", async () => {
    const linked: Linked = { kind: "node", id: "n1" };
    await renderGraph({ linkedHighlight: linked });
    await setRfEdges([rfEdge("e1", "n1", "n2"), rfEdge("e2", "n2", "n3")]);

    const domN1 = addDomNode("n1");
    const domN2 = addDomNode("n2");
    const domE1 = addDomEdge("e1");
    const domE2 = addDomEdge("e2");
    await flushRaf();

    expect(domN1.classList.contains("lg-linked-node")).toBe(true);
    expect(domE1.classList.contains("lg-linked-edge")).toBe(true); // инцидентно n1
    expect(domE2.classList.contains("lg-linked-edge")).toBe(false); // не инцидентно n1
    expect(domN2.classList.contains("lg-linked-node")).toBe(false); // сосед не подсвечен
  });

  it("kind:edge подсвечивает несущее ребро и оба его узла", async () => {
    const linked: Linked = { kind: "edge", id: "e1" };
    await renderGraph({ linkedHighlight: linked });
    await setRfEdges([rfEdge("e1", "n1", "n2")]);

    const domN1 = addDomNode("n1");
    const domN2 = addDomNode("n2");
    const domE1 = addDomEdge("e1");
    await flushRaf();

    expect(domE1.classList.contains("lg-linked-edge")).toBe(true);
    expect(domN1.classList.contains("lg-linked-node")).toBe(true);
    expect(domN2.classList.contains("lg-linked-node")).toBe(true);
  });

  it("kind:edge находит несущее ребро по членству в пучке (memberIds)", async () => {
    // Панель держит ЧЛЕНА пучка (raw-id), отрисовано мастер-ребро merge:*.
    const linked: Linked = { kind: "edge", id: "raw-member" };
    await renderGraph({ linkedHighlight: linked });
    await setRfEdges([
      { id: "merge:n1->n2", source: "n1", target: "n2", data: { memberIds: ["raw-member"] } } as RFEdge,
    ]);

    const domMaster = addDomEdge("merge:n1->n2");
    await flushRaf();

    expect(domMaster.classList.contains("lg-linked-edge")).toBe(true);
  });

  it("подсвеченное ребро поднимается над прочими (svg переносится в конец контейнера)", async () => {
    // Контейнер .react-flow__edges с двумя рёбрами; e1 — первым. Подсветка e1 → его
    // <svg> становится последним (рисуется поверх e2).
    const container = document.createElement("div");
    container.className = "react-flow__edges";
    const svg1 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const svg2 = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const g1 = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g1.setAttribute("class", "react-flow__edge");
    g1.setAttribute("data-id", "e1");
    const g2 = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g2.setAttribute("class", "react-flow__edge");
    g2.setAttribute("data-id", "e2");
    svg1.appendChild(g1);
    svg2.appendChild(g2);
    container.appendChild(svg1);
    container.appendChild(svg2);
    document.body.appendChild(container);

    const linked: Linked = { kind: "edge", id: "e1" };
    await renderGraph({ linkedHighlight: linked });
    await setRfEdges([rfEdge("e1", "n1", "n2")]);
    await flushRaf();

    expect(container.lastElementChild).toBe(svg1); // e1 поднято над e2
  });

  it("смена выделения (linkedHighlight → null) снимает подсветку (cleanup)", async () => {
    const el = (linked: Linked | null) => (
      <LevelGraph {...baseProps()} linkedHighlight={linked} />
    );
    const { rerender } = render(el({ kind: "node", id: "n1" }));
    await settle();
    await setRfEdges([rfEdge("e1", "n1", "n2")]);
    const domN1 = addDomNode("n1");
    await flushRaf();
    expect(domN1.classList.contains("lg-linked-node")).toBe(true);

    // Правая панель закрыта → подсветка гаснет.
    rerender(el(null));
    await settle();
    expect(domN1.classList.contains("lg-linked-node")).toBe(false);
  });

  it("двойной клик по пустому холсту вызывает onClearSelection", async () => {
    const { props, container } = await renderGraph({});
    const canvas = container.querySelector(".lg-canvas");
    expect(canvas).not.toBeNull();

    fireEvent.doubleClick(canvas as HTMLElement);
    expect(props.drill.onClearSelection).toHaveBeenCalledOnce();
  });

  it("двойной клик по узлу НЕ вызывает onClearSelection (у узла свой триггер)", async () => {
    const { props, container } = await renderGraph({});
    const canvas = container.querySelector(".lg-canvas") as HTMLElement;
    // Клик «по узлу» — closest('.react-flow__node') исключает сброс выделения.
    const node = document.createElement("div");
    node.className = "react-flow__node";
    canvas.appendChild(node);

    fireEvent.doubleClick(node);
    expect(props.drill.onClearSelection).not.toHaveBeenCalled();
  });

  // Двойной клик по ЛЮБОМУ узлу — сплошной фигуре — открывает его панель (решение
  // пользователя 2026-10-05): у свёрнутого контейнера гостя объекта узла нет — хозяин
  // получает id. Рамка раскрытого узла — не узел: ни плашка, ни пустое место внутри
  // панель не открывают (пустое место — как пустой холст: сброс).
  it("двойной клик по свёрнутому контейнеру — onInspectNodeId(id); по рамке — ничего", async () => {
    const { props } = await renderGraph({});
    const dbl = rfProps.current.onNodeDoubleClick as (e: unknown, n: unknown) => void;
    act(() => dbl({}, { id: "f1", type: "frame", position: { x: 0, y: 0 }, data: { name: "Система" } }));
    expect(props.drill.onInspectNodeId).not.toHaveBeenCalled();
    act(() => dbl({}, { id: "c1", type: "container", position: { x: 0, y: 0 }, data: { id: "c1", name: "Партнёр" } }));
    expect(props.drill.onInspectNodeId).toHaveBeenCalledWith("c1");
    expect(props.drill.onEditNode).not.toHaveBeenCalled();
  });

  it("двойной клик в пустом месте раскрытой рамки — как по пустому холсту: сброс панели", async () => {
    const { props, container } = await renderGraph({});
    const canvas = container.querySelector(".lg-canvas") as HTMLElement;
    const frame = (id: string, x: number, y: number, w: number, h: number) => {
      const el = document.createElement("div");
      el.className = "react-flow__node react-flow__node-frame";
      el.setAttribute("data-id", id);
      el.style.pointerEvents = "none";
      el.getBoundingClientRect = () => ({
        x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}),
      }) as DOMRect;
      canvas.appendChild(el);
    };
    frame("outer", 100, 100, 600, 400);
    fireEvent.doubleClick(canvas, { clientX: 150, clientY: 450 });
    expect(props.drill.onInspectNodeId).not.toHaveBeenCalled();
    expect(props.drill.onClearSelection).toHaveBeenCalledOnce();
  });
});
