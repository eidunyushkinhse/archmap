// Оркестрационные тесты ПРОЕКЦИИ ХОЗЯИНА LevelGraphInner (холст развёртывания,
// docs/specs/deployment.md, Ф2а эпика). Фиксируют контракт бандла projection:
//   • children — полный состав раскрываемых контейнеров: детей по API не догружаем и по
//     childrenRev не перечитываем; ключ карты по умолчанию раскрыт (входит в expanded)
//     без записи expanded в раскладку; фильтр релевантных детей read-only не применяется;
//   • свёрнутость площадки — состояние вида: персистное expanded: false сворачивает,
//     сворачивание пишет false (позиция строки сохраняется), раскрытие — сброс поля;
//     у читателя (без персиста) — только правка сессии;
//   • inlineDepth — доезжает до конвейера входом maxInlineDepth;
//   • ключ кэша маршрутов вида получает признак проекции;
//   • drill.onSelectionChange — id выделенных БЛОКОВ на изменение RF-выделения;
//   • groupOf — «близнецы» выделенного блока получают класс lg-linked-node;
//   • clearSelectionToken — рост токена снимает RF-выделение;
//   • pickFrame — режим выбора площадки: сборка получает признак, колбэк зовётся из
//     latest-ref, выделение/драг/рамка выделения выключены, двойной клик гасится;
//   • selectRequest — рост токена выделяет перечисленные узлы, ждёт их появления.
// RF/конвейер замоканы (общий harness); колбэки и вход конвейера — настоящие.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import type { Node as RFNode } from "@xyflow/react";
import type { Node as AppNode } from "../../types";
import type { LevelProjectionProps } from "../graph/types";
import { routeCache } from "../graph/layout/routeCacheStore";
import {
  resetHarness, apiNodesMock, pipelineClientMock, rfHandles, rfProps, flushRaf, layoutAnimMock, settle, captured,
} from "./levelGraphHarness";
import { renderGraph, baseProps, getCb } from "./levelGraphRender";

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

function appNode(id: string, parent_id: string | null, kids = 0): AppNode {
  return {
    id, name: id, parent_id, shape: "service", is_external: false, status: "existing",
    has_children: kids > 0, child_count: kids,
  } as AppNode;
}

// Площадка S1 ⊃ S2 ⊃ экземпляр A@S2; экземпляр B@S1 рядом с S2; корневая T ⊃ A@T.
const S1 = "deploy:site:S1", S2 = "deploy:site:S2", T = "deploy:site:T";
const children: Record<string, AppNode[]> = {
  [S1]: [appNode(S2, S1, 1), appNode("deploy:B@S1", S1)],
  [S2]: [appNode("deploy:A@S2", S2)],
  [T]: [appNode("deploy:A@T", T)],
};

type PipeInput = {
  expanded: Set<string>;
  localChildren: Record<string, AppNode[]>;
  childrenLazyLoad?: boolean;
  maxInlineDepth?: number;
};
function lastInput(): PipeInput {
  const calls = pipelineClientMock.computeViewLayoutOffThread.mock.calls;
  return calls[calls.length - 1][0] as PipeInput;
}

// Холст развёртывания: read-only + расстановка, корневые площадки — узлы уровня.
function deployProps(projection: LevelProjectionProps) {
  return {
    nodes: [appNode(S1, null, 2), appNode(T, null, 1)],
    mode: { readOnly: true, arrangeOnly: true },
    projection,
  };
}

function rfBlock(id: string, selected = false): RFNode {
  return { id, type: "block", position: { x: 0, y: 0 }, data: {}, selected } as RFNode;
}
function addDomNode(id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "react-flow__node";
  el.setAttribute("data-id", id);
  document.body.appendChild(el);
  return el;
}

describe("LevelGraph orchestration: проекция хозяина (развёртывание)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("children: состав целиком в конвейер, ключи карты раскрыты, по API ничего не догружается", async () => {
    await renderGraph(deployProps({ children, inlineDepth: Infinity }));
    const input = lastInput();
    expect(input.localChildren).toBe(children);
    expect([...input.expanded].sort()).toEqual([S1, S2, T].sort());
    expect(input.childrenLazyLoad).toBe(false);
    expect(input.maxInlineDepth).toBe(Infinity);
    expect(apiNodesMock.nodesApi.list).not.toHaveBeenCalled();
    expect(apiNodesMock.nodesApi.getChildren).not.toHaveBeenCalled();
  });

  it("children: раскрытия не пишутся в раскладку, childrenRev ничего не перечитывает", async () => {
    const { props, rerenderWith } = await renderGraph(deployProps({ children }));
    await act(async () => { rerenderWith({ childrenRev: 1 }); });
    await flushRaf();
    expect(apiNodesMock.nodesApi.list).not.toHaveBeenCalled();
    expect(apiNodesMock.viewsApi.saveLayout).not.toHaveBeenCalled();
    expect(props.persistence?.onLayoutChanged).not.toHaveBeenCalled();
  });

  it("без проекции: вход конвейера прежний — maxInlineDepth не передаётся", async () => {
    await renderGraph({ nodes: [appNode("X", null)] });
    expect("maxInlineDepth" in lastInput()).toBe(false);
  });

  it("ключ кэша маршрутов вида несёт признак проекции", async () => {
    const load = vi.spyOn(routeCache, "load");
    await renderGraph(deployProps({ children }));
    expect(load).toHaveBeenCalled();
    expect(load.mock.calls[load.mock.calls.length - 1][0]).toMatch(/\|deploy$/);
    load.mockClear();
    await renderGraph({ nodes: [appNode("X", null)] });
    expect(load.mock.calls[load.mock.calls.length - 1][0]).not.toMatch(/deploy/);
  });

  it("onSelectionChange: id выделенных блоков (рамки не в счёт); без колбэка RF его не получает", async () => {
    const onSelectionChange = vi.fn<(ids: string[]) => void>();
    await renderGraph({
      ...deployProps({ children }),
      drill: { ...baseProps().drill, onSelectionChange },
    });
    const handler = rfProps.current.onSelectionChange as (p: { nodes: RFNode[]; edges: unknown[] }) => void;
    expect(typeof handler).toBe("function");
    act(() => {
      handler({ nodes: [rfBlock("deploy:A@S2"), { ...rfBlock(S1), type: "frame" }, rfBlock("deploy:B@S1")], edges: [] });
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith(["deploy:A@S2", "deploy:B@S1"]);
    act(() => { handler({ nodes: [], edges: [] }); });
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);

    await renderGraph({ nodes: [appNode("X", null)] });
    expect(rfProps.current.onSelectionChange).toBeUndefined();
  });

  it("groupOf: близнецы выделенной карточки получают lg-linked-node, сама карточка — нет", async () => {
    const groupOf = (id: string) => (id.startsWith("deploy:A@") ? "A" : id.startsWith("deploy:B@") ? "B" : undefined);
    await renderGraph(deployProps({ children, groupOf }));
    const aS2 = addDomNode("deploy:A@S2");
    const aT = addDomNode("deploy:A@T");
    const bS1 = addDomNode("deploy:B@S1");
    await act(async () => {
      rfHandles.setNodes?.([rfBlock("deploy:A@S2", true), rfBlock("deploy:A@T"), rfBlock("deploy:B@S1")]);
    });
    await flushRaf();
    expect(aT.classList.contains("lg-linked-node")).toBe(true);
    expect(aS2.classList.contains("lg-linked-node")).toBe(false);
    expect(bS1.classList.contains("lg-linked-node")).toBe(false);
    // выделение снято — подсветка близнецов уходит
    await act(async () => {
      rfHandles.setNodes?.([rfBlock("deploy:A@S2"), rfBlock("deploy:A@T"), rfBlock("deploy:B@S1")]);
    });
    await flushRaf();
    expect(aT.classList.contains("lg-linked-node")).toBe(false);
  });

  it("свёрнутость: дефолт раскрыто, персистное expanded: false сворачивает только свой ключ", async () => {
    await renderGraph({ ...deployProps({ children }), viewLayout: { [S2]: { expanded: false } } });
    expect([...lastInput().expanded].sort()).toEqual([S1, T].sort());
  });

  it("сворачивание площадки пишет {expanded: false} поверх сохранённой позиции", async () => {
    const { props } = await renderGraph({ ...deployProps({ children }), viewLayout: { [S1]: { x: 10, y: 20 } } });
    await act(async () => { getCb().collapseContainer(S1); });
    await settle();
    expect(layoutAnimMock.noteCollapse).toHaveBeenCalledWith(S1);
    // Сервер заменяет payload строки целиком — в запрос уходит слитая строка с позицией.
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ [S1]: { x: 10, y: 20, expanded: false } });
    expect(apiNodesMock.viewsApi.saveLayout).toHaveBeenCalledWith(
      null, { [S1]: { x: 10, y: 20, expanded: false } }, undefined,
    );
    expect(lastInput().expanded.has(S1)).toBe(false);
  });

  it("раскрытие свёрнутой площадки — без догрузки, поле expanded сбрасывается (null)", async () => {
    const { props } = await renderGraph({
      ...deployProps({ children }),
      viewLayout: { [S1]: { x: 10, y: 20, expanded: false } },
    });
    expect(lastInput().expanded.has(S1)).toBe(false);
    await act(async () => { getCb().expandLocalContainer(S1); });
    await settle();
    expect(apiNodesMock.nodesApi.list).not.toHaveBeenCalled();
    expect(layoutAnimMock.noteExpand).toHaveBeenCalledWith(S1);
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ [S1]: { x: 10, y: 20, expanded: null } });
    expect(lastInput().expanded.has(S1)).toBe(true);
  });

  it("читатель: сворачивание живёт в сессии, раскладка не пишется", async () => {
    await renderGraph({ ...deployProps({ children }), isArchitect: false, persistence: undefined });
    await act(async () => { getCb().collapseContainer(T); });
    await settle();
    expect(apiNodesMock.viewsApi.saveLayout).not.toHaveBeenCalled();
    expect(lastInput().expanded.has(T)).toBe(false);
    expect(lastInput().expanded.has(S1)).toBe(true);
  });

  it("двойной клик по карточке площадки — то же, что лупа; по пустой — ничего", async () => {
    await renderGraph(deployProps({ children }));
    const dbl = rfProps.current.onNodeDoubleClick as (e: unknown, n: RFNode) => void;
    const onExpand = vi.fn();
    dbl({}, { id: S1, type: "site", position: { x: 0, y: 0 }, data: { name: S1, icon: "vm", count: 2, onExpand } } as RFNode);
    expect(onExpand).toHaveBeenCalledWith(S1);
    // пустая площадка: колбэка нет — ничего не падает
    dbl({}, { id: T, type: "site", position: { x: 0, y: 0 }, data: { name: T, icon: "vm", count: 0 } } as RFNode);
  });

  it("clearSelectionToken: рост токена снимает RF-выделение со всех узлов", async () => {
    const { rerenderWith } = await renderGraph(deployProps({ children }));
    await act(async () => {
      rfHandles.setNodes?.([rfBlock("deploy:A@S2", true), rfBlock("deploy:B@S1", true), rfBlock("deploy:A@T")]);
    });
    const selectedNow = () => (rfProps.current.nodes as RFNode[]).filter((n) => n.selected).map((n) => n.id);
    await flushRaf();
    expect(selectedNow().sort()).toEqual(["deploy:A@S2", "deploy:B@S1"]);
    await act(async () => { rerenderWith(deployProps({ children, clearSelectionToken: 1 })); });
    await flushRaf();
    expect(selectedNow()).toEqual([]);
  });

  it("pickFrame: сборка в режиме выбора, щелчок зовёт свежий колбэк хозяина с id узла холста", async () => {
    const first = vi.fn<(id: string) => void>();
    const { rerenderWith } = await renderGraph(deployProps({ children, pickFrame: first }));
    expect(captured.picking).toBe(true);
    getCb().pickFrame?.(S2);
    expect(first).toHaveBeenCalledWith(S2);
    // колбэк читается в момент щелчка (latest-ref), а не при сборке
    const second = vi.fn<(id: string) => void>();
    await act(async () => { rerenderWith(deployProps({ children, pickFrame: second })); });
    getCb().pickFrame?.("deploy:B@S1");
    expect(second).toHaveBeenCalledWith("deploy:B@S1");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("pickFrame: выделение, драг и рамка выделения выключены; вне режима — как были", async () => {
    const { rerenderWith } = await renderGraph(deployProps({ children, pickFrame: vi.fn() }));
    expect(rfProps.current.elementsSelectable).toBe(false);
    expect(rfProps.current.nodesDraggable).toBe(false);
    expect(rfProps.current.selectionOnDrag).toBe(false);
    await act(async () => { rerenderWith(deployProps({ children })); });
    await settle();
    expect(captured.picking).toBe(false);
    expect(rfProps.current.elementsSelectable).toBe(true);
    expect(rfProps.current.nodesDraggable).toBe(true);
    expect(rfProps.current.selectionOnDrag).toBe(true);
  });

  it("pickFrame: двойной щелчок не раскрывает площадку и не открывает объект", async () => {
    const { props } = await renderGraph(deployProps({ children, pickFrame: vi.fn() }));
    const dbl = rfProps.current.onNodeDoubleClick as (e: unknown, n: RFNode) => void;
    const onExpand = vi.fn();
    dbl({}, { id: S1, type: "site", position: { x: 0, y: 0 }, data: { name: S1, icon: "vm", count: 2, onExpand } } as RFNode);
    dbl({}, { ...rfBlock("deploy:B@S1"), data: { appNode: appNode("deploy:B@S1", S1) } } as RFNode);
    expect(onExpand).not.toHaveBeenCalled();
    expect(props.drill.onEditNode).not.toHaveBeenCalled();
  });

  it("selectRequest: рост токена выделяет ровно перечисленные узлы", async () => {
    const { rerenderWith } = await renderGraph(deployProps({ children }));
    await act(async () => {
      rfHandles.setNodes?.([rfBlock("deploy:A@S2", true), rfBlock("deploy:B@S1"), rfBlock("deploy:A@T")]);
    });
    const selectedNow = () => (rfProps.current.nodes as RFNode[]).filter((n) => n.selected).map((n) => n.id).sort();
    await act(async () => {
      rerenderWith(deployProps({ children, selectRequest: { ids: ["deploy:A@S2", "deploy:A@T"], token: 1 } }));
    });
    await flushRaf();
    expect(selectedNow()).toEqual(["deploy:A@S2", "deploy:A@T"]);
    // тот же токен не переигрывается: ручное выделение после запроса живёт
    await act(async () => {
      rfHandles.setNodes?.([rfBlock("deploy:A@S2"), rfBlock("deploy:B@S1", true), rfBlock("deploy:A@T")]);
    });
    await flushRaf();
    expect(selectedNow()).toEqual(["deploy:B@S1"]);
  });

  it("selectRequest: узлов ещё нет — ждёт их появления (раскладка асинхронна)", async () => {
    const { rerenderWith } = await renderGraph(deployProps({ children }));
    await act(async () => { rfHandles.setNodes?.([rfBlock("deploy:B@S1", true)]); });
    const selectedNow = () => (rfProps.current.nodes as RFNode[]).filter((n) => n.selected).map((n) => n.id);
    await act(async () => {
      rerenderWith(deployProps({ children, selectRequest: { ids: ["deploy:C@T"], token: 1 } }));
    });
    await flushRaf();
    expect(selectedNow()).toEqual(["deploy:B@S1"]);
    await act(async () => { rfHandles.setNodes?.([rfBlock("deploy:B@S1", true), rfBlock("deploy:C@T")]); });
    await flushRaf();
    expect(selectedNow()).toEqual(["deploy:C@T"]);
  });
});
