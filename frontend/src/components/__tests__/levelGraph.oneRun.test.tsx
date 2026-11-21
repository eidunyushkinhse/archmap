// ЛИШНИЕ ПРОГОНЫ КОНВЕЙЕРА (эпик render-scale, шаг «быстрый ELK и один прогон»).
//
// 1. МАУНТ ХОЛСТА. Полевая находка: на каждом маунте (вход на уровень, возврат, страница
//    объекта) первые два входа конвейера совпадали побитово — сброс эфемерных состояний «на
//    смену уровня» срабатывал и на маунте и пересоздавал их пустыми копиями, отчего
//    computeNow пересоздавался при том же содержимом входа.
// 2. ОДИН ПОЛНЫЙ ПРОГОН ВМЕСТО «ЧЕРНОВОЙ, ЗАМЕР, ПОЛНЫЙ» (спека perf.md P10). На типовой
//    сцене конвейер считает стрелки первым же прогоном (незамеренный узел — узел
//    NODE_W×NODE_H), и этот прогон авторитетен. Прогон после замера остаётся страховкой:
//    здесь проверяется ОРКЕСТРАЦИЯ этой страховки в LevelGraph — с тем же комплектом
//    габаритов он получает prev из кэша вида (ветка sameSizes === false → cached), то есть
//    кэш-хит по routeSig в конвейере, экран не трогает (layoutSig тот же → "skipped") и
//    гистерезис не сбрасывает.
//
// Конвейер замокан (общий harness) и отвечает так, как отвечает настоящий: совпал
// prevRouteSig — prev целиком. Сигнатура раскладки (layoutSig) НАСТОЯЩАЯ: только так
// «применение не понадобилось» проверяется на деле, а не по счётчику мока.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import {
  resetHarness, pipeline, pipelineClientMock, assembleCalls, rfProps, settle,
} from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";
import { setCurrentProjectId } from "../../api/projectScope";
import { NODE_W, NODE_H } from "../graph/constants";
import type { PipelineInput, PipelineOutput } from "../graph/layout/pipeline";
import type { EdgePoint } from "../../types";
import type { LabelPlacement } from "../graph/layout/labelLayout";
import type { NodeChange, Node as RFNode } from "@xyflow/react";

// --- vi.mock: зависимости LevelGraph → реализации из общего harness (layoutSig — настоящий) ---
vi.mock("@xyflow/react", async () => (await import("./levelGraphHarness")).xyflowMock);
vi.mock("../../api/nodes", async () => (await import("./levelGraphHarness")).apiNodesMock);
vi.mock("../graph/layout/pipelineClient", async () => (await import("./levelGraphHarness")).pipelineClientMock);
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

const SIG = "sig-типовой-сцены";
const ROUTE: EdgePoint[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 60 }];
const HANDLES = { sourceHandle: "right-1", targetHandle: "top-1" };
const LABEL: LabelPlacement = {
  mode: "online",
  center: { x: 40, y: 30 }, anchor: { x: 40, y: 30 }, leaderEnd: { x: 40, y: 30 },
};

/** Результат «полного» прогона: стрелки, плашки, авторитетен. */
function fullResult(routes: Map<string, EdgePoint[]>): PipelineOutput {
  const base = pipeline.result;
  return {
    ...base,
    layout: {
      ...base.layout,
      positions: new Map([["n1", { x: 0, y: 0 }]]),
      edgeHandles: new Map([["e1", HANDLES]]),
      autoRoutes: routes,
      labelPlacements: new Map([["e1", LABEL]]),
    },
    routeSig: SIG,
    authoritative: true,
  };
}

const calls = (): PipelineInput[] =>
  pipelineClientMock.computeViewLayoutOffThread.mock.calls.map((c) => c[0] as PipelineInput);
const lastCall = (): PipelineInput => {
  const all = calls();
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
};

/** RF отдаёт замер узла — тот же путь, что 'dimensions'-событие живого холста. */
function measure(id: string, width: number, height: number): void {
  const onNodesChange = rfProps.current.onNodesChange as (ch: NodeChange<RFNode>[]) => void;
  act(() => { onNodesChange([{ type: "dimensions", id, dimensions: { width, height } }]); });
}

describe("LevelGraph × лишние прогоны и один полный прогон на типовой сцене (P10, render-scale)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setCurrentProjectId("P1");
    resetHarness();
    pipelineClientMock.computeViewLayoutOffThread.mockReset();
    // Мок отвечает, как настоящий конвейер на неизменной сцене: совпал prevRouteSig —
    // кэш-хит (prev целиком), иначе — полный прогон с той же геометрией.
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation((input: unknown) => {
      const inp = input as PipelineInput;
      if (inp.prevRouteSig === SIG && inp.prevRoutes && inp.prevEdgeHandles && inp.prevLabelPlacements) {
        return Promise.resolve(fullResult(new Map(inp.prevRoutes)));
      }
      return Promise.resolve(fullResult(new Map([["e1", ROUTE]])));
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("маунт со статичными пропсами — ровно один прогон конвейера (без идентичного второго)", async () => {
    // Полевая находка шага: на каждом маунте холста (вход на уровень, возврат, страница
    // объекта) первые два входа конвейера совпадали побитово — сброс эфемерных состояний
    // «на смену уровня» срабатывал и на маунте и пересоздавал их пустыми копиями.
    await renderGraph({});
    expect(calls(), "статичный маунт без замеров — один прогон").toHaveLength(1);
  });

  it("прогон после замера в NODE_W×NODE_H: prev из кэша вида, экран не применяется заново", async () => {
    await renderGraph({});
    const runs0 = calls().length;
    const applies0 = assembleCalls.length;
    expect(applies0, "первый прогон уже полный — сцена на экране со стрелками").toBeGreaterThan(0);
    expect(assembleCalls[applies0 - 1].autoRoutes?.get("e1")).toEqual(ROUTE);

    measure("n1", NODE_W, NODE_H);
    await settle();

    expect(calls(), "замер даёт ровно один прогон-страховку").toHaveLength(runs0 + 1);
    const after = lastCall();
    expect(after.sizes).toEqual({ n1: { w: NODE_W, h: NODE_H } });
    // ветка sameSizes === false: prev — авторитетная запись первого прогона (кэш вида),
    // её sig совпадёт с сигнатурой сцены → конвейер возьмёт результат без стадий
    expect(after.prevRouteSig).toBe(SIG);
    expect(after.prevRoutes?.get("e1")).toEqual(ROUTE);
    // снимок сцены из кэша не приезжает (авто-скоуп E84 только со своим prev)
    expect(after.prevScene).toBeUndefined();
    // результат тот же — layoutSig совпал, применения не было (экран не мигает)
    expect(assembleCalls, "прогон-страховка не пересобирает RF-граф").toHaveLength(applies0);
  });

  it("гистерезис после прогона-страховки не сброшен: следующий прогон идёт со своим prev и снимком", async () => {
    const { rerenderWith } = await renderGraph({});
    measure("n1", NODE_W, NODE_H);
    await settle();
    const runs = calls().length;

    // действие пользователя: данные уровня сменились по ссылке
    act(() => { rerenderWith({ edges: [] }); });
    await settle();
    expect(calls().length).toBeGreaterThan(runs);
    const next = lastCall();
    expect(next.prevRouteSig).toBe(SIG);
    expect(next.prevRoutes?.get("e1")).toEqual(ROUTE);
    // снимок сцены — признак СВОЕГО prev (ветка sameSizes): гистерезис жив
    expect(next.prevScene).toBeDefined();
  });
});
