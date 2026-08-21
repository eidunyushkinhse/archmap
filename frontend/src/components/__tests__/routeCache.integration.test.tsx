// ПОЛИТИКА ПЕРСИСТНОГО КЭША МАРШРУТОВ в LevelGraph (Ф2 эпика router-opt, спека
// perf.md P11; пять тестов записи из ревью 3.1). Само хранилище покрыто
// routeCacheStore.test.ts, равенство «кэш = полный прогон» — pipeline.test.ts;
// здесь — ОРКЕСТРАЦИЯ: когда холст пишет кэш, когда не пишет, и что он отдаёт
// конвейеру на маунте вида.
//
// Конвейер замокан (общий harness) — это позволяет задавать routeSig и authoritative
// прогона явно. Хранилище НЕ мокается: работает настоящий localStorage jsdom и
// настоящий routeCache — так проверяется и связка с версией роутера.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resetHarness, pipeline, pipelineClientMock, settle,
} from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";
import { setCurrentProjectId } from "../../api/projectScope";
import {
  viewCacheKey, toCacheEntry, type RouteCacheEntry,
} from "../graph/layout/routeCacheStore";
import { ROUTER_VERSION } from "../graph/layout/routerVersion";
import type { PipelineInput, PipelineOutput } from "../graph/layout/pipeline";
import type { EdgePoint } from "../../types";
import type { LabelPlacement } from "../graph/layout/labelLayout";

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

const PROJECT = "P1";
const KEY_PREFIX = "archmap.routeCache:";
const ROOT_KEY = viewCacheKey(PROJECT, null, undefined);

const ROUTE: EdgePoint[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 60 }];
const HANDLES = { sourceHandle: "right-1", targetHandle: "top-1" };
const LABEL: LabelPlacement = {
  mode: "online",
  center: { x: 40, y: 30 }, anchor: { x: 40, y: 30 }, leaderEnd: { x: 40, y: 30 },
};

/** Результат прогона с готовой геометрией стрелок и заданной авторитетностью. */
function resultWith(routeSig: string, authoritative: boolean): PipelineOutput {
  const base = pipeline.result;
  return {
    ...base,
    layout: {
      ...base.layout,
      edgeHandles: new Map([["e1", HANDLES]]),
      autoRoutes: new Map([["e1", ROUTE]]),
      labelPlacements: new Map([["e1", LABEL]]),
    },
    routeSig,
    authoritative,
  };
}

/** Вход, с которым позвали конвейер (единственный прогон маунта). */
function lastInput(): PipelineInput {
  const calls = pipelineClientMock.computeViewLayoutOffThread.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as PipelineInput;
}

function storedAt(key: string): RouteCacheEntry | null {
  const raw = localStorage.getItem(KEY_PREFIX + key);
  return raw ? (JSON.parse(raw) as RouteCacheEntry) : null;
}

describe("LevelGraph × персистный кэш маршрутов вида (Ф2 router-opt, P11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setCurrentProjectId(PROJECT);
    resetHarness();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("АВТОРИТЕТНЫЙ прогон записывается в кэш вида (ключ проект+вид, sig и геометрия)", async () => {
    pipeline.result = resultWith("sig-полный", true);
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(
      () => Promise.resolve({ ...pipeline.result, layout: { ...pipeline.result.layout } }),
    );
    await renderGraph({});

    const entry = storedAt(ROOT_KEY);
    expect(entry, "авторитетный прогон обязан лечь в кэш").not.toBeNull();
    expect(entry!.v).toBe(ROUTER_VERSION);
    expect(entry!.sig).toBe("sig-полный");
    expect(entry!.routes).toEqual([["e1", ROUTE]]);
    expect(entry!.handles).toEqual([["e1", HANDLES]]);
    expect(entry!.labels).toEqual([["e1", LABEL]]);
  });

  it("НЕавторитетный прогон (пропуск P10 / частичные замеры / скоуп) в кэш не пишется", async () => {
    pipeline.result = resultWith("sig-временный", false);
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(
      () => Promise.resolve({ ...pipeline.result, layout: { ...pipeline.result.layout } }),
    );
    await renderGraph({});

    expect(storedAt(ROOT_KEY), "временный прогон отравил бы кэш").toBeNull();
    expect(localStorage.getItem(KEY_PREFIX + ROOT_KEY)).toBeNull();
  });

  it("маунт вида с готовым кэшем: конвейер получает prev* ИЗ КЭША", async () => {
    // кэш «от прошлой сессии» — тем же ключом вида
    localStorage.setItem(
      KEY_PREFIX + ROOT_KEY,
      JSON.stringify(toCacheEntry(
        "sig-из-кэша",
        new Map([["e1", ROUTE]]),
        new Map([["e1", HANDLES]]),
        new Map([["e1", LABEL]]),
        1000,
      )),
    );
    pipeline.result = resultWith("sig-из-кэша", true);
    await renderGraph({});

    const input = lastInput();
    expect(input.prevRouteSig).toBe("sig-из-кэша");
    expect(input.prevRoutes?.get("e1")).toEqual(ROUTE);
    expect(input.prevEdgeHandles?.get("e1")).toEqual(HANDLES);
    expect(input.prevLabelPlacements?.get("e1")).toEqual(LABEL);
    // скоуп из кэша не приезжает — он живёт только внутри сессии (жест драга)
    expect(input.scopeNodeIds).toBeUndefined();
  });

  it("кэш ЧУЖОЙ версии роутера не читается (и вычищается) — конвейер идёт без prev", async () => {
    const foreign = toCacheEntry(
      "sig-старого-роутера",
      new Map([["e1", ROUTE]]), new Map([["e1", HANDLES]]), new Map([["e1", LABEL]]), 1000,
    );
    localStorage.setItem(
      KEY_PREFIX + ROOT_KEY,
      JSON.stringify({ ...foreign, v: ROUTER_VERSION + 7 }),
    );
    pipeline.result = resultWith("sig-свежий", false); // не авторитетен → не перезапишет
    await renderGraph({});

    const input = lastInput();
    expect(input.prevRouteSig).toBeUndefined();
    expect(input.prevRoutes).toBeUndefined();
    expect(input.prevLabelPlacements).toBeUndefined();
    // протухшая запись удалена чтением, а не оставлена занимать квоту
    expect(localStorage.getItem(KEY_PREFIX + ROOT_KEY)).toBeNull();
  });

  it("смена ВИДА: кэш нового вида читается, чужой не подмешивается", async () => {
    const levelKey = viewCacheKey(PROJECT, "C1", undefined);
    localStorage.setItem(
      KEY_PREFIX + levelKey,
      JSON.stringify(toCacheEntry(
        "sig-уровня-C1",
        new Map([["e1", ROUTE]]), new Map([["e1", HANDLES]]), new Map([["e1", LABEL]]), 1000,
      )),
    );
    pipeline.result = resultWith("sig-любой", false);
    const { rerenderWith } = await renderGraph({});
    // корень: своего кэша нет
    expect(lastInput().prevRouteSig).toBeUndefined();
    // ушли на уровень C1 — читается его запись
    rerenderWith({ containerId: "C1" });
    await settle();
    expect(lastInput().prevRouteSig).toBe("sig-уровня-C1");
  });
});
