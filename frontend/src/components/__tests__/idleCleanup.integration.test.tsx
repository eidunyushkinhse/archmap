// НЕВИДИМАЯ УБОРКА СКОУПНОЙ ГРЯЗИ в LevelGraph (раунд 3 полевой находки приёмки №1
// эпика router-opt, спека perf.md P14). Защёлка и таймер покрыты юнит-тестом хука
// (useIdleCleanup.test.ts); здесь — ОРКЕСТРАЦИЯ: с каким входом холст зовёт уборочный
// прогон, что уборка кладёт (кэш вида P11 + снимок гистерезиса) и чего она НЕ делает
// (не трогает экран).
//
// ГЛАВНЫЙ ИНВАРИАНТ (аксиома продукта): ЭКРАН МЕНЯЕТСЯ ТОЛЬКО ОТ ДЕЙСТВИЯ
// ПОЛЬЗОВАТЕЛЯ. Уборка считает полный прогон с гистерезисом от экрана, но НЕ
// применяет его: чистая геометрия приезжает следующим действием — тот прогон возьмёт
// чистый prev, записанный уборкой.
//
// Конвейер замокан (общий harness) — только так можно задать исход прогона
// (scoped/authoritative) явно. Хранилище НЕ мокается: настоящий localStorage jsdom.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "@testing-library/react";
import {
  resetHarness, pipeline, pipelineClientMock, layoutAnimMock, assembleCalls, settle,
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

/** «Грязная» линия скоупного прогона (лежит на экране) и чистая — от полного. */
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

const lastCall = (): PipelineInput => {
  const all = calls();
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
};

function storedAt(key: string): RouteCacheEntry | null {
  const raw = localStorage.getItem(KEY_PREFIX + key);
  return raw ? (JSON.parse(raw) as RouteCacheEntry) : null;
}

/** Маршруты последнего ПРИМЕНЁННОГО на экран layout (журнал сборок RF-графа). */
function onScreenRoutes(): EdgePoint[] | undefined {
  const last = assembleCalls[assembleCalls.length - 1];
  return last?.autoRoutes?.get("e1");
}

/** Пауза бездействия при фейковых таймерах (прогон уборки — async). */
async function idle(ms = CLEANUP_IDLE_MS): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await settle();
}

describe("LevelGraph × невидимая уборка скоупной грязи (P14)", () => {
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

  it("вход уборки: гистерезис от экрана ЕСТЬ, sig/scene/scope — НЕТ", async () => {
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
    // ГИСТЕРЕЗИС ОТ ЭКРАНА: уборка обязана стартовать с того, что лежит на холсте, —
    // холодный прогон не стабилен к сдвигу позиций и телепортировал бы почти все
    // рёбра при следующем действии пользователя (полевая приёмка, раунд 2).
    expect(cleanup.prevRoutes?.get("e1"), "prevRoutes — экранные маршруты").toEqual(ROUTE);
    expect(cleanup.prevEdgeHandles?.get("e1")).toEqual(HANDLES);
    expect(cleanup.prevLabelPlacements?.get("e1")).toEqual(LABEL);
    // ТРИ ВЫЧЕРКНУТЫХ ПОЛЯ: sig увёл бы конвейер в кэш-хит-ветку (см. отдельный
    // тест-сторож ниже), снимок сцены включил бы авто-скоуп (E84), а скоуп драга
    // уборке не достаётся по построению — она полна.
    expect(cleanup.prevRouteSig, "sig уборке НЕ передаём НИ В КОЕМ СЛУЧАЕ").toBeUndefined();
    expect(cleanup.prevScene).toBeUndefined();
    expect(cleanup.scopeNodeIds).toBeUndefined();
    // результат уборки авторитетен → он и ложится в кэш вида штатным путём (P11)
    const entry = storedAt(ROOT_KEY);
    expect(entry, "уборка обязана прогреть кэш вида").not.toBeNull();
    expect(entry!.sig).toBe("sig-полный");
    expect(entry!.routes).toEqual([["e1", CLEAN_ROUTE]]);
  });

  it("результат уборки НЕ ЕДЕТ НА ЭКРАН: применений не прибавилось, геометрия прежняя", async () => {
    const scopedOut = resultWith("sig-скоуп", ROUTE, { scoped: true, authoritative: false });
    const cleanOut = resultWith("sig-полный", CLEAN_ROUTE, { scoped: false, authoritative: true });
    let out = scopedOut;
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(
      () => Promise.resolve({ ...out, layout: { ...out.layout } }),
    );
    await renderGraph({});
    const appliesBefore = assembleCalls.length;
    const applyBefore = layoutAnimMock.apply.mock.calls.length;
    expect(onScreenRoutes(), "на экране — грязная линия скоупного прогона").toEqual(ROUTE);

    out = cleanOut;
    await idle();

    // «Экран» в этом харнесе — сборка RF-графа (assembleRfGraph) и её применение
    // (applyLayout): rfNodes/rfEdges берутся ровно оттуда. Уборка не делает ни того,
    // ни другого — setLayout она не зовёт вовсе.
    expect(assembleCalls, "уборка не пересобирает RF-граф").toHaveLength(appliesBefore);
    expect(layoutAnimMock.apply.mock.calls, "уборка не применяет раскладку")
      .toHaveLength(applyBefore);
    expect(onScreenRoutes(), "экран остался прежним — грязным, но неподвижным").toEqual(ROUTE);
    // при этом невидимая работа сделана: кэш вида прогрет чистой геометрией
    expect(storedAt(ROOT_KEY)!.routes).toEqual([["e1", CLEAN_ROUTE]]);
  });

  it("следующее действие пользователя стартует с ЧИСТОГО prev (грязь не копится)", async () => {
    const scopedOut = resultWith("sig-скоуп", ROUTE, { scoped: true, authoritative: false });
    const cleanOut = resultWith("sig-полный", CLEAN_ROUTE, { scoped: false, authoritative: true });
    let out = scopedOut;
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(
      () => Promise.resolve({ ...out, layout: { ...out.layout } }),
    );
    const { rerenderWith } = await renderGraph({});
    out = cleanOut;
    await idle();
    const afterCleanup = calls().length;

    // действие пользователя: изменились данные уровня (новая идентичность edges) →
    // штатный прогон. Он обязан взять prev ИЗ РЕЗУЛЬТАТА УБОРКИ.
    act(() => { rerenderWith({ edges: [] }); });
    await settle();
    expect(calls().length, "действие пользователя даёт прогон").toBeGreaterThan(afterCleanup);

    const next = lastCall();
    expect(next.prevRoutes?.get("e1"), "prev — чистая геометрия уборки").toEqual(CLEAN_ROUTE);
    expect(next.prevRouteSig, "sig уборочного результата — обычному прогону можно")
      .toBe("sig-полный");
    // снимок сцены уборки лёг рядом с её маршрутами — дифф следующего жеста честен
    expect(next.prevScene, "уборка обязана оставить снимок сцены").toBeDefined();
  });

  it("СТОРОЖ: sig во входе уборки отравил бы кэш вида грязью (кэш-хит по sig)", async () => {
    // МОДЕЛЬ КОНВЕЙЕРА (pipeline.ts, P11): сверка routeSig стоит ДО стадий качества —
    // пришёл prevRouteSig, равный сигнатуре входов, и результат берётся ЦЕЛИКОМ из
    // prev, а прогон при этом АВТОРИТЕТЕН (кэш-хит доказывает тождественность
    // геометрии) и пишется в кэш вида. Для уборки это отравление: её входы совпадают
    // со входами последнего прогона, и она вернула бы ту самую грязь, законсервировав
    // её в кэше под видом чистой геометрии.
    // ХУДШИЙ СЛУЧАЙ ВОСПРОИЗВЕДЁН НАМЕРЕННО: sig прошлого прогона совпадает с
    // сигнатурой входов уборки (так бывает, когда после скоупного прогона прошёл
    // полный прогон без стадий качества — пропуск P10: грязь на экране осталась, а
    // sig в снимке гистерезиса уже от полного состава).
    // Ветки выбираются ПО ВХОДУ, а не по номеру вызова: маунт двухфазен, и счётчик
    // вызовов молча увёл бы тест мимо уборки.
    const SIG = "sig-этих-входов";
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation((input: unknown) => {
      const inp = input as PipelineInput;
      if (!inp.prevRoutes) {
        // прогоны маунта (prev ещё нет): скоупные, кладут на экран грязную линию,
        // а в снимок гистерезиса — тот самый sig
        return Promise.resolve(resultWith(SIG, ROUTE, { scoped: true, authoritative: false }));
      }
      if (inp.prevRouteSig === SIG && inp.prevEdgeHandles && inp.prevLabelPlacements) {
        // КЭШ-ХИТ: prev возвращается КАК ЕСТЬ (вместе с грязью) и считается авторитетным
        const out = resultWith(SIG, ROUTE, { scoped: false, authoritative: true });
        return Promise.resolve({
          ...out,
          layout: { ...out.layout, autoRoutes: new Map(inp.prevRoutes) },
        });
      }
      // стадии реально отработали — чистая геометрия
      return Promise.resolve(resultWith("sig-полный", CLEAN_ROUTE, { scoped: false, authoritative: true }));
    });
    await renderGraph({});
    const base = calls().length;
    expect(storedAt(ROOT_KEY), "скоупные прогоны маунта кэш не пишут").toBeNull();
    await idle();

    expect(calls(), "уборка обязана уйти — иначе сторож проверяет пустоту")
      .toHaveLength(base + 1);
    const cleanup = lastCall();
    expect(cleanup.prevRoutes?.get("e1"), "уборка идёт с гистерезисом от экрана").toEqual(ROUTE);
    expect(cleanup.prevRouteSig, "sig во входе уборки — прямой путь к отравлению кэша")
      .toBeUndefined();
    const entry = storedAt(ROOT_KEY);
    expect(entry, "уборка обязана прогреть кэш").not.toBeNull();
    expect(entry!.sig, "в кэш легла ЧИСТАЯ геометрия стадий, а не возвращённый prev")
      .toBe("sig-полный");
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
