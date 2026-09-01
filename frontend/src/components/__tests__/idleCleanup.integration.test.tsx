// ФОНОВАЯ УБОРКА СКОУПНОЙ ГРЯЗИ в LevelGraph (раунд 2 полевой находки приёмки №1
// эпика router-opt, спека perf.md P14). Защёлка и таймер покрыты юнит-тестом хука
// (useIdleCleanup.test.ts); здесь — ОРКЕСТРАЦИЯ: чем холст зовёт уборочный прогон,
// что уборка кладёт в кэш вида (P11) и что она НЕ стартует за полным прогоном.
//
// Конвейер замокан (общий harness) — только так можно задать исход прогона
// (scoped/authoritative) явно. Хранилище НЕ мокается: настоящий localStorage jsdom.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import {
  resetHarness, pipeline, pipelineClientMock, settle,
} from "./levelGraphHarness";
import { renderGraph } from "./levelGraphRender";
import { setCurrentProjectId } from "../../api/projectScope";
import { viewCacheKey, type RouteCacheEntry } from "../graph/layout/routeCacheStore";
import { CLEANUP_IDLE_MS } from "../graph/interaction/useIdleCleanup";
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
const CLEAN_ROUTE: EdgePoint[] = [{ x: 0, y: 0 }, { x: 0, y: 60 }, { x: 40, y: 60 }];
const HANDLES = { sourceHandle: "right-1", targetHandle: "top-1" };
const LABEL: LabelPlacement = {
  mode: "online",
  center: { x: 40, y: 30 }, anchor: { x: 40, y: 30 }, leaderEnd: { x: 40, y: 30 },
};

/** Результат прогона с готовой геометрией стрелок, скоупностью и авторитетностью. */
function resultWith(
  routeSig: string, route: EdgePoint[], flags: { scoped: boolean; authoritative: boolean },
): PipelineOutput {
  const base = pipeline.result;
  return {
    ...base,
    layout: {
      ...base.layout,
      edgeHandles: new Map([["e1", HANDLES]]),
      autoRoutes: new Map([["e1", route]]),
      labelPlacements: new Map([["e1", LABEL]]),
    },
    routeSig,
    scoped: flags.scoped,
    authoritative: flags.authoritative,
  };
}

const calls = (): PipelineInput[] =>
  pipelineClientMock.computeViewLayoutOffThread.mock.calls.map((c) => c[0] as PipelineInput);

function storedAt(key: string): RouteCacheEntry | null {
  const raw = localStorage.getItem(KEY_PREFIX + key);
  return raw ? (JSON.parse(raw) as RouteCacheEntry) : null;
}

/** Пауза бездействия при фейковых таймерах (прогон уборки — async). */
async function idle(ms = CLEANUP_IDLE_MS): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await settle();
}

describe("LevelGraph × фоновая уборка скоупной грязи (P14)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setCurrentProjectId(PROJECT);
    resetHarness();
    // история вызовов конвейера НЕ входит в resetHarness (мок не в ALL_MOCK_FNS) —
    // без сброса счёт прогонов утёк бы из теста в тест
    pipelineClientMock.computeViewLayoutOffThread.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("после СКОУПНОГО прогона уборка уходит БЕЗ prev-полей и пишет кэш вида", async () => {
    // прогон маунта — скоупный (на экране замороженный prev-контекст, кэш не обновлён)
    const scopedOut = resultWith("sig-скоуп", ROUTE, { scoped: true, authoritative: false });
    const cleanOut = resultWith("sig-полный", CLEAN_ROUTE, { scoped: false, authoritative: true });
    let out = scopedOut;
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(
      () => Promise.resolve({ ...out, layout: { ...out.layout } }),
    );
    await renderGraph({});
    // маунт двухфазен (фолбэк-габариты → замер) — точное число прогонов не наша тема,
    // важно ЧТО ДОБАВИТ пауза бездействия
    const base = calls().length;
    expect(storedAt(ROOT_KEY), "скоупный прогон кэш не пишет (P11)").toBeNull();

    out = cleanOut; // следующий прогон — уборочный, отвечаем полным результатом
    await idle();

    const all = calls();
    expect(all, "по паузе бездействия обязан уйти РОВНО один прогон").toHaveLength(base + 1);
    const cleanup = all[all.length - 1];
    // ВХОД УБОРКИ — БЕЗ prev-ПОЛЕЙ: иначе гистерезис удержал бы ту самую грязь,
    // а снимок сцены включил бы авто-скоуп (E84)
    expect(cleanup.prevRoutes).toBeUndefined();
    expect(cleanup.prevEdgeHandles).toBeUndefined();
    expect(cleanup.prevRouteSig).toBeUndefined();
    expect(cleanup.prevLabelPlacements).toBeUndefined();
    expect(cleanup.prevScene).toBeUndefined();
    expect(cleanup.scopeNodeIds).toBeUndefined();
    // результат уборки авторитетен → он и ложится в кэш вида штатным путём (P11)
    const entry = storedAt(ROOT_KEY);
    expect(entry, "уборка обязана прогреть кэш вида").not.toBeNull();
    expect(entry!.sig).toBe("sig-полный");
    expect(entry!.routes).toEqual([["e1", CLEAN_ROUTE]]);
  });

  it("уборка НЕ повторяется: за уборочным прогоном второй не идёт", async () => {
    const scopedOut = resultWith("sig-скоуп", ROUTE, { scoped: true, authoritative: false });
    // уборка вернулась НЕ авторитетной (ступень бюджета / незамеренные узлы) —
    // повторной попытки быть не должно
    const poorOut = resultWith("sig-уборка", CLEAN_ROUTE, { scoped: false, authoritative: false });
    let out = scopedOut;
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(
      () => Promise.resolve({ ...out, layout: { ...out.layout } }),
    );
    await renderGraph({});
    const base = calls().length;
    out = poorOut;
    await idle();
    expect(calls()).toHaveLength(base + 1);
    await idle(CLEANUP_IDLE_MS * 3);
    expect(calls(), "уборка одноразова — петли прогонов нет").toHaveLength(base + 1);
  });

  it("за ПОЛНЫМ прогоном уборки нет (убирать нечего)", async () => {
    pipeline.result = resultWith("sig-полный", CLEAN_ROUTE, { scoped: false, authoritative: true });
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(
      () => Promise.resolve({ ...pipeline.result, layout: { ...pipeline.result.layout } }),
    );
    await renderGraph({});
    const base = calls().length;
    await idle(CLEANUP_IDLE_MS * 2);
    expect(calls(), "полный авторитетный прогон уборку не взводит").toHaveLength(base);
  });
});
