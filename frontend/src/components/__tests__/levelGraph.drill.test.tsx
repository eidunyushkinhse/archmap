// Оркестрационные тесты DRILL/EXPAND LevelGraphInner (Фаза 3а). Фиксируют контракт
// навигации и инлайн-раскрытия контейнеров:
//   • drillWithPath: прямой узел уровня → onDrillDown; узел из раскрытого контейнера
//     → onEnterNode с ПОЛНЫМ путём (предки breadcrumb + промежуточные контейнеры + сам
//     узел); невосстановимая цепочка → fallback onDrillDown;
//   • expandContainer/collapseContainer (гость) → commitLayout({expanded}) →
//     onLayoutChanged + анимационная нота (noteExpand/noteCollapse);
//   • own-on-expand: нерасположенный контейнер закрепляет текущую позицию из раскладки;
//   • expandLocalContainer (локал): ленивая догрузка детей (nodesApi.list) → раскрытие;
//     пустое раскрытие в read-only (дети нерелевантны) → НЕ раскрываем;
//   • ОТКАЗ ДОГРУЗКИ (Н1 внешнего аудита эпика router-opt): повтор → деградация
//     состава до пустого (конвейер перестаёт считать сцену недогруженной) → warn;
//     чтение уровня и повторное раскрытие дают новую попытку.
// RF/конвейер замоканы; колбэки оркестрации — через getCb.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import type { Node as AppNode, AncestorRef } from "../../types";
import {
  resetHarness, layoutAnimMock, apiNodesMock, pipeline, pipelineClientMock, settle,
} from "./levelGraphHarness";
import { renderGraph, getCb, baseProps } from "./levelGraphRender";

// Кэш детей раскрытых рамок наружу не торчит — читаем его через вход конвейера.
function lastLocalChildren(): Record<string, AppNode[]> {
  const calls = pipelineClientMock.computeViewLayoutOffThread.mock.calls;
  const last = calls[calls.length - 1][0] as { localChildren: Record<string, AppNode[]> };
  return last.localChildren;
}

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

function appNode(id: string, over: Partial<AppNode> = {}): AppNode {
  return {
    id,
    name: id.toUpperCase(),
    parent_id: null,
    shape: "service",
    is_external: false,
    ...over,
  } as AppNode;
}

describe("LevelGraph orchestration: drill / expand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------- DRILL ----------------

  it("drill без onEnterNode: любой узел → onDrillDown", async () => {
    const { props } = await renderGraph({ containerId: "root" });
    const n = appNode("a", { parent_id: "root" });

    getCb().drillWithPath(n);
    expect(props.drill.onDrillDown).toHaveBeenCalledWith(n);
  });

  it("drill прямого ребёнка уровня (parent_id === containerId) → onDrillDown, не onEnterNode", async () => {
    const onEnterNode = vi.fn<(path: AncestorRef[]) => void>();
    const { props } = await renderGraph({ containerId: "root", drill: { ...baseProps().drill, onEnterNode } });
    const n = appNode("a", { parent_id: "root" });

    getCb().drillWithPath(n);
    expect(props.drill.onDrillDown).toHaveBeenCalledWith(n);
    expect(onEnterNode).not.toHaveBeenCalled();
  });

  it("drill узла из раскрытого контейнера → onEnterNode с полным путём (breadcrumb + цепочка + узел)", async () => {
    const onEnterNode = vi.fn<(path: AncestorRef[]) => void>();
    // Уровень «root» (хлебные крошки), внутри раскрытого p1 лежит целевой n.
    const p1 = appNode("p1", { name: "Промежуточный", parent_id: "root" });
    const n = appNode("n", { name: "Цель", parent_id: "p1" });
    await renderGraph({
      containerId: "root",
      ancestorIds: ["root"],
      ancestorNames: ["Root"],
      nodes: [p1],
      drill: { ...baseProps().drill, onEnterNode },
    });

    getCb().drillWithPath(n);

    expect(onEnterNode).toHaveBeenCalledOnce();
    expect(onEnterNode).toHaveBeenCalledWith([
      { id: "root", name: "Root", is_external: false },
      { id: "p1", name: "Промежуточный", is_external: false },
      { id: "n", name: "Цель", is_external: false },
    ]);
  });

  it("drill: цепочка предков не восстанавливается → fallback onDrillDown", async () => {
    const onEnterNode = vi.fn<(path: AncestorRef[]) => void>();
    // parent_id указывает на узел, которого нет ни в nodes, ни в localChildren.
    const n = appNode("n", { parent_id: "missing" });
    const { props } = await renderGraph({ containerId: "root", drill: { ...baseProps().drill, onEnterNode } });

    getCb().drillWithPath(n);
    expect(props.drill.onDrillDown).toHaveBeenCalledWith(n);
    expect(onEnterNode).not.toHaveBeenCalled();
  });

  // ---------------- EXPAND / COLLAPSE (гость) ----------------

  it("expandContainer: раскрытие гостя → noteExpand + commitLayout({expanded:true})", async () => {
    const { props } = await renderGraph({});

    await act(async () => {
      getCb().expandContainer("g1");
    });

    expect(layoutAnimMock.noteExpand).toHaveBeenCalledWith("g1");
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ g1: { expanded: true } });
  });

  it("collapseContainer: сворачивание → noteCollapse + commitLayout({expanded:null})", async () => {
    const { props } = await renderGraph({});

    await act(async () => {
      getCb().collapseContainer("g1");
    });

    expect(layoutAnimMock.noteCollapse).toHaveBeenCalledWith("g1");
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ g1: { expanded: null } });
  });

  it("own-on-expand: нерасположенный контейнер закрепляет текущую позицию из раскладки", async () => {
    // Конвейер «посчитал» позицию контейнера; в зеркале (viewLayout) её ещё нет.
    pipeline.result.layout.positions = new Map([["c1", { x: 50, y: 60 }]]);
    const { props } = await renderGraph({});

    await act(async () => {
      getCb().expandContainer("c1");
    });

    // Раскрытие идёт ВМЕСТЕ с закреплением позиции (иначе ELK унёс бы рамку).
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ c1: { expanded: true, x: 50, y: 60 } });
  });

  it("own-on-expand не подмешивает позицию раскладки, если контейнер уже владеет ей (owned)", async () => {
    pipeline.result.layout.positions = new Map([["c1", { x: 50, y: 60 }]]);
    const { props } = await renderGraph({ viewLayout: { c1: { x: 1, y: 2 } } });

    await act(async () => {
      getCb().expandContainer("c1");
    });

    // Владеет позицией → координаты из ЗЕРКАЛА (1,2), а не из раскладки (50,60):
    // own-on-expand не перезаписывает уже сохранённое место.
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ c1: { expanded: true, x: 1, y: 2 } });
  });

  // ---------------- EXPAND ЛОКАЛА (ленивая догрузка детей) ----------------

  it("expandLocalContainer: догружает детей (nodesApi.list) и раскрывает", async () => {
    const kid = appNode("kid", { parent_id: "c1" });
    apiNodesMock.nodesApi.list.mockResolvedValueOnce([kid]);
    const { props } = await renderGraph({});

    await act(async () => {
      getCb().expandLocalContainer("c1");
    });
    await settle();

    expect(apiNodesMock.nodesApi.list).toHaveBeenCalledWith("c1");
    expect(layoutAnimMock.noteExpand).toHaveBeenCalledWith("c1");
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith({ c1: { expanded: true } });
  });

  it("childrenRev: перечитывает кэш детей раскрытых рамок — удалённый ребёнок уходит", async () => {
    // Находка 2026-08-09: узел удалили внутри раскрытой рамки, связи с холста ушли,
    // а сам объект остался — кэш детей рамки инвалидировался только при создании.
    // Ответ /graph детей рамок не несёт, поэтому единственный сигнал — childrenRev,
    // который владелец уровня бампает на каждое чтение с сервера.
    const kid = appNode("kid", { parent_id: "c1" });
    apiNodesMock.nodesApi.list.mockResolvedValueOnce([kid]);
    const { rerenderWith } = await renderGraph({});

    await act(async () => { getCb().expandLocalContainer("c1"); });
    await settle();
    expect(lastLocalChildren()).toEqual({ c1: [kid] });

    apiNodesMock.nodesApi.list.mockResolvedValueOnce([]); // ребёнка удалили
    await act(async () => { rerenderWith({ childrenRev: 1 }); });
    await settle();

    expect(apiNodesMock.nodesApi.list).toHaveBeenLastCalledWith("c1");
    expect(lastLocalChildren()).toEqual({ c1: [] });
  });

  it("childrenRev без изменения кэш не трогает (лишних запросов нет)", async () => {
    const kid = appNode("kid", { parent_id: "c1" });
    apiNodesMock.nodesApi.list.mockResolvedValueOnce([kid]);
    const { rerenderWith } = await renderGraph({});

    await act(async () => { getCb().expandLocalContainer("c1"); });
    await settle();
    const calls = apiNodesMock.nodesApi.list.mock.calls.length;

    await act(async () => { rerenderWith({ isArchitect: true }); }); // перерисовка без чтения уровня
    await settle();

    expect(apiNodesMock.nodesApi.list.mock.calls.length).toBe(calls);
  });

  it("expandLocalContainer в read-only: нерелевантные дети (нет рёбер) → не раскрываем", async () => {
    const kid = appNode("kid", { parent_id: "c1" });
    apiNodesMock.nodesApi.list.mockResolvedValueOnce([kid]);
    // read-only: релевантность = связанность рёбрами; рёбер нет → детей в схеме нет.
    const { props } = await renderGraph({ mode: { readOnly: true } });

    await act(async () => {
      getCb().expandLocalContainer("c1");
    });
    await settle();

    expect(apiNodesMock.nodesApi.list).toHaveBeenCalledWith("c1");
    expect(layoutAnimMock.noteExpand).not.toHaveBeenCalled();
    expect(props.persistence?.onLayoutChanged).not.toHaveBeenCalled();
  });

  // ---------- ОТКАЗ ДОГРУЗКИ ДЕТЕЙ (находка Н1 внешнего аудита, 2026-08-22) ----------
  // Сбой фетча детей ПЕРСИСТНО раскрытой рамки оставлял вид без стрелок навсегда:
  // localChildren[id] вечно undefined → конвейер вечно считал состав неполным и
  // пропускал стадии качества (P10 / pipeline.hasPendingChildren). Политика отказа:
  // один повтор → деградация состава до ПУСТОГО (pipeline.test.ts: «загруженный
  // ПУСТОЙ список детей неполнотой не считается» — стадии идут, прогон авторитетен)
  // → предупреждение. Ниже: обе попытки, деградация и оба канала перезапуска.
  // ⚠️ Каждый тест берёт СВОЙ id рамки: история вызовов nodesApi.list между тестами
  // файла не сбрасывается (resetHarness переигрывает только реализацию), а отложенный
  // повтор упавшей цепочки живёт дольше своего теста.
  const listCalls = (id: string): number =>
    apiNodesMock.nodesApi.list.mock.calls.filter((c) => c[0] === id).length;
  const warnsAbout = (warn: { mock: { calls: unknown[][] } }, id: string): number =>
    warn.mock.calls.filter((c) => String(c[0]).includes(id)).length;

  it("сбой догрузки персистного раскрытия: повтор, деградация состава до пустого, предупреждение", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cA = appNode("cA");
    apiNodesMock.nodesApi.list.mockRejectedValue(new Error("сеть недоступна"));

    await renderGraph({ nodes: [cA], viewLayout: { cA: { expanded: true } } });
    await settle();
    // первая попытка провалилась, пауза перед повтором ещё идёт: состав НЕИЗВЕСТЕН —
    // записи нет, врать «детей нет» раньше времени нельзя
    expect(listCalls("cA")).toBe(1);
    expect(lastLocalChildren().cA).toBeUndefined();
    const runsBefore = pipelineClientMock.computeViewLayoutOffThread.mock.calls.length;

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();

    // ровно две попытки (первая + один повтор), затем деградация с предупреждением
    expect(listCalls("cA")).toBe(2);
    expect(warnsAbout(warn, "cA")).toBe(1);
    expect(lastLocalChildren().cA).toEqual([]);
    // и это НЕ мёртвое состояние: деградация запустила НОВЫЙ прогон конвейера — тот
    // самый, который прежде блокировался вечным «состав неполон»
    expect(pipelineClientMock.computeViewLayoutOffThread.mock.calls.length).toBeGreaterThan(runsBefore);
    warn.mockRestore();
  });

  it("после деградации: чтение уровня (childrenRev) даёт новую попытку — состав восстанавливается", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cB = appNode("cB");
    const kid = appNode("kid-b", { parent_id: "cB" });
    apiNodesMock.nodesApi.list.mockRejectedValue(new Error("сеть недоступна"));
    const { rerenderWith } = await renderGraph({ nodes: [cB], viewLayout: { cB: { expanded: true } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();
    expect(lastLocalChildren().cB).toEqual([]);

    apiNodesMock.nodesApi.list.mockResolvedValue([kid]); // сеть вернулась
    await act(async () => { rerenderWith({ childrenRev: 1 }); });
    await settle();

    expect(lastLocalChildren().cB).toEqual([kid]);
    warn.mockRestore();
  });

  it("после деградации: повторное раскрытие рамки — новая попытка", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cC = appNode("cC");
    const kid = appNode("kid-c", { parent_id: "cC" });
    apiNodesMock.nodesApi.list.mockRejectedValue(new Error("сеть недоступна"));
    await renderGraph({ nodes: [cC], viewLayout: { cC: { expanded: true } } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();
    expect(lastLocalChildren().cC).toEqual([]);

    apiNodesMock.nodesApi.list.mockResolvedValue([kid]);
    // Жест пользователя: рамка нарисована свёрнутой, клик по ней — раскрытие. (В UI
    // это вторая половина пары «свернуть → раскрыть»; гвард P5 «защита от
    // прокликивания» снимается применением раскладки от первого жеста и здесь
    // не участвует — его канал проверяется отдельно, levelGraph.busyGuard.)
    await act(async () => { getCb().expandLocalContainer("cC"); });
    await settle();

    expect(listCalls("cC")).toBe(3);          // сбойная пара + новая попытка
    expect(lastLocalChildren().cC).toEqual([kid]);
    warn.mockRestore();
  });

  it("сбой догрузки по КЛИКУ: рамка не раскрывается, состав НЕ подделывается", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiNodesMock.nodesApi.list.mockRejectedValue(new Error("сеть недоступна"));
    const { props } = await renderGraph({});

    await act(async () => { getCb().expandLocalContainer("cD"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();

    // Рамка не раскрыта — клик остался без последствий, о сбое сказано в консоль.
    // Пометки сбоя НЕТ (в отличие от персистного раскрытия): состав СВЁРНУТОЙ рамки
    // конвейер не спрашивает, вечного «pending» тут не бывает — и подделывать
    // «детей нет» не за чем.
    expect(listCalls("cD")).toBe(2);
    expect(warnsAbout(warn, "cD")).toBe(1);
    expect(layoutAnimMock.noteExpand).not.toHaveBeenCalled();
    expect(props.persistence?.onLayoutChanged).not.toHaveBeenCalled();
    expect(lastLocalChildren().cD).toBeUndefined();
    warn.mockRestore();
  });
});
