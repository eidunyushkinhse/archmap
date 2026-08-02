// Оркестрационные тесты ПЕРСИСТА раскладки LevelGraphInner (Фаза 3а, страховочная
// сетка перед декомпозицией). Фиксируют контракт единого канала записи вида:
//   • commitLayout → дедуп повторов + merge поверх зеркала → onLayoutChanged(items)
//     и батч-PUT viewsApi.saveLayout(containerId, items, fence-версия);
//   • политика 409 (planPersistFailure): user-интент → onPersistConflict(патч),
//     derived/повтор/не-конфликт → onPersistError;
//   • канал переигровки retryPatch → одноразовый (по token) коммит исходного патча;
//   • производные интенты конвейера (intents) → commitLayout("derived");
//   • гейты: не-архитектор и read-only гасят запись.
// Зависимости (RF/конвейер/хуки) замоканы через levelGraphHarness; тестируются
// настоящие commitLayout/persistFenced из LevelGraphInner (через getCb).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { ViewLayoutPayload } from "../../types";
import { ApiError } from "../../api/client";
import LevelGraph from "../LevelGraph";
import {
  resetHarness, apiNodesMock, pipeline, settle,
} from "./levelGraphHarness";
import { renderGraph, getCb, baseProps } from "./levelGraphRender";

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

// Живой снимок версий (fence) — как useRef<ViewMetaState> в MapEditorPage.
function viewMeta(version = 5) {
  return { current: { version, graphRev: 0 } };
}

// Слить микрозадачи: persistFenced кладёт saveLayout в .then цепочку персиста.
async function flushPersist(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await settle(1);
}

type Items = Record<string, ViewLayoutPayload | null>;

describe("LevelGraph orchestration: персист раскладки", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commitLayout пишет новый payload: onLayoutChanged + saveLayout с fence-версией", async () => {
    const meta = viewMeta(7);
    const { props } = await renderGraph({ viewMeta: meta });

    const committed = getCb().commitLayout({ n1: { x: 10, y: 20 } });
    expect(committed).toBe(true);

    // Зеркало родителю — нормализованный payload (без null-полей).
    expect(props.onLayoutChanged).toHaveBeenCalledOnce();
    expect(props.onLayoutChanged).toHaveBeenCalledWith({ n1: { x: 10, y: 20 } });

    // Батч-PUT идёт с fence-версией вида из viewMeta.
    await flushPersist();
    expect(apiNodesMock.viewsApi.saveLayout).toHaveBeenCalledOnce();
    expect(apiNodesMock.viewsApi.saveLayout).toHaveBeenCalledWith(
      null,
      { n1: { x: 10, y: 20 } },
      7,
    );
    // Ответ сервера обновляет живой снимок версий.
    expect(meta.current.version).toBe(2); // mock saveLayout → version: 2
  });

  it("дедуп: патч, идентичный зеркалу, не пишет и не дёргает родителя", async () => {
    const mirror: Record<string, ViewLayoutPayload> = { n1: { x: 10, y: 20 } };
    const { props } = await renderGraph({ viewLayout: mirror, viewMeta: viewMeta() });

    const committed = getCb().commitLayout({ n1: { x: 10, y: 20 } });
    expect(committed).toBe(false);
    expect(props.onLayoutChanged).not.toHaveBeenCalled();
    await flushPersist();
    expect(apiNodesMock.viewsApi.saveLayout).not.toHaveBeenCalled();
  });

  it("дедуп игнорирует null-поля: {x,y,expanded:null} эквивалентно {x,y}", async () => {
    const mirror: Record<string, ViewLayoutPayload> = { n1: { x: 10, y: 20 } };
    const { props } = await renderGraph({ viewLayout: mirror, viewMeta: viewMeta() });

    const committed = getCb().commitLayout({ n1: { x: 10, y: 20, expanded: null } });
    expect(committed).toBe(false);
    expect(props.onLayoutChanged).not.toHaveBeenCalled();
  });

  it("merge: частичный патч дополняется из зеркала (сервер заменяет строку целиком)", async () => {
    const mirror: Record<string, ViewLayoutPayload> = { n1: { x: 10, y: 20 } };
    const { props } = await renderGraph({ viewLayout: mirror, viewMeta: viewMeta() });

    getCb().commitLayout({ n1: { y: 99 } });
    expect(props.onLayoutChanged).toHaveBeenCalledWith({ n1: { x: 10, y: 99 } });
  });

  it("null-патч строки (сброс в авто) проходит как items=null, даже если зеркала нет", async () => {
    const mirror: Record<string, ViewLayoutPayload> = { n1: { x: 10, y: 20 } };
    const { props } = await renderGraph({ viewLayout: mirror, viewMeta: viewMeta() });

    getCb().commitLayout({ n1: null });
    expect(props.onLayoutChanged).toHaveBeenCalledWith({ n1: null });
  });

  it("батч из нескольких ключей: изменившиеся пишутся, совпавшие с зеркалом — нет", async () => {
    const mirror: Record<string, ViewLayoutPayload> = { a: { x: 1, y: 1 } };
    const { props } = await renderGraph({ viewLayout: mirror, viewMeta: viewMeta() });

    getCb().commitLayout({ a: { x: 1, y: 1 }, b: { x: 2, y: 2 } });
    // «a» погашен дедупом, «b» — новый.
    expect(props.onLayoutChanged).toHaveBeenCalledWith({ b: { x: 2, y: 2 } });
  });

  it("409 на user-интент → onPersistConflict с исходным патчем (не onPersistError)", async () => {
    const onPersistConflict = vi.fn<(patch: Items) => void>();
    const { props } = await renderGraph({ viewMeta: viewMeta(), onPersistConflict });
    apiNodesMock.viewsApi.saveLayout.mockRejectedValueOnce(new ApiError(409, "stale view"));

    getCb().commitLayout({ n1: { x: 10, y: 20 } });
    await flushPersist();

    expect(onPersistConflict).toHaveBeenCalledOnce();
    expect(onPersistConflict).toHaveBeenCalledWith({ n1: { x: 10, y: 20 } });
    expect(props.onPersistError).not.toHaveBeenCalled();
  });

  it("409 на derived-интент → только onPersistError (конвейер пересчитает сам)", async () => {
    const onPersistConflict = vi.fn<(patch: Items) => void>();
    const { props } = await renderGraph({ viewMeta: viewMeta(), onPersistConflict });
    apiNodesMock.viewsApi.saveLayout.mockRejectedValueOnce(new ApiError(409, "stale view"));

    getCb().commitLayout({ n1: { x: 10, y: 20 } }, "derived");
    await flushPersist();

    expect(onPersistConflict).not.toHaveBeenCalled();
    expect(props.onPersistError).toHaveBeenCalledOnce();
  });

  it("повторный 409 на ретрай (isRetry) → resync-only, не переигрывается снова", async () => {
    const onPersistConflict = vi.fn<(patch: Items) => void>();
    const { props } = await renderGraph({ viewMeta: viewMeta(), onPersistConflict });
    apiNodesMock.viewsApi.saveLayout.mockRejectedValueOnce(new ApiError(409, "stale view"));

    getCb().commitLayout({ n1: { x: 10, y: 20 } }, "user", true);
    await flushPersist();

    expect(onPersistConflict).not.toHaveBeenCalled();
    expect(props.onPersistError).toHaveBeenCalledOnce();
  });

  it("не-конфликтная ошибка записи → onPersistError (ресинк), не onPersistConflict", async () => {
    const onPersistConflict = vi.fn<(patch: Items) => void>();
    const { props } = await renderGraph({ viewMeta: viewMeta(), onPersistConflict });
    apiNodesMock.viewsApi.saveLayout.mockRejectedValueOnce(new Error("network down"));

    getCb().commitLayout({ n1: { x: 10, y: 20 } });
    await flushPersist();

    expect(onPersistConflict).not.toHaveBeenCalled();
    expect(props.onPersistError).toHaveBeenCalledOnce();
  });

  it("retryPatch переигрывает исходный патч (user) поверх зеркала", async () => {
    const { props } = await renderGraph({
      viewMeta: viewMeta(),
      retryPatch: { patch: { n1: { x: 42, y: 43 } }, token: 1 },
    });

    // Эффект retryPatch коммитит патч → зеркало + PUT.
    expect(props.onLayoutChanged).toHaveBeenCalledWith({ n1: { x: 42, y: 43 } });
    await flushPersist();
    expect(apiNodesMock.viewsApi.saveLayout).toHaveBeenCalledOnce();
  });

  it("retryPatch одноразов по token: смена зеркала с тем же token не повторяет коммит", async () => {
    const retry = { patch: { n1: { x: 42, y: 43 } }, token: 1 };
    const onLayoutChanged = vi.fn<(items: Items) => void>();
    const meta = viewMeta();
    const el = (vl: Record<string, ViewLayoutPayload>) => (
      <LevelGraph
        {...baseProps()}
        viewMeta={meta}
        retryPatch={retry}
        viewLayout={vl}
        onLayoutChanged={onLayoutChanged}
      />
    );
    const { rerender } = render(el({}));
    await settle();
    expect(onLayoutChanged).toHaveBeenCalledTimes(1);

    // Новое зеркало → commitLayout пересоздаётся → эффект retryPatch перезапускается,
    // но тот же token (retryDoneRef) гасит повторный коммит.
    rerender(el({ other: { x: 9, y: 9 } }));
    await settle();
    expect(onLayoutChanged).toHaveBeenCalledTimes(1);
  });

  it("производный интент конвейера (seeds) коммитится как derived → onLayoutChanged", async () => {
    pipeline.result.intents = [{ kind: "seed-positions", seeds: [{ id: "g1", x: 5, y: 6 }] }];
    const { props } = await renderGraph({ viewMeta: viewMeta() });

    // computeNow применил интент через cbRef.commitLayout(..., "derived").
    expect(props.onLayoutChanged).toHaveBeenCalledWith({ g1: { x: 5, y: 6 } });
  });

  it("не-архитектор: commitLayout гасится (нет зеркала и PUT)", async () => {
    const { props } = await renderGraph({ isArchitect: false, viewMeta: viewMeta() });

    const committed = getCb().commitLayout({ n1: { x: 10, y: 20 } });
    expect(committed).toBe(false);
    expect(props.onLayoutChanged).not.toHaveBeenCalled();
    await flushPersist();
    expect(apiNodesMock.viewsApi.saveLayout).not.toHaveBeenCalled();
  });

  it("read-only (canArrange=false): commitLayout гасится", async () => {
    const { props } = await renderGraph({ readOnly: true, viewMeta: viewMeta() });

    const committed = getCb().commitLayout({ n1: { x: 10, y: 20 } });
    expect(committed).toBe(false);
    expect(props.onLayoutChanged).not.toHaveBeenCalled();
  });

  it("arrangeOnly разрешает персист раскладки даже при структурном read-only", async () => {
    // arrangeOnly: canArrange = arrangeOnly || !readOnly → true при readOnly+arrangeOnly.
    const { props } = await renderGraph({ readOnly: true, arrangeOnly: true, viewMeta: viewMeta() });

    const committed = getCb().commitLayout({ n1: { x: 10, y: 20 } });
    expect(committed).toBe(true);
    expect(props.onLayoutChanged).toHaveBeenCalledWith({ n1: { x: 10, y: 20 } });
  });

  it("очередь персиста: два батча идут строго последовательно (один PUT за раз)", async () => {
    const { props } = await renderGraph({ viewMeta: viewMeta() });

    getCb().commitLayout({ a: { x: 1, y: 1 } });
    getCb().commitLayout({ b: { x: 2, y: 2 } });
    await flushPersist();

    // Оба батча записаны (цепочка persistChainRef не потеряла второй).
    expect(apiNodesMock.viewsApi.saveLayout).toHaveBeenCalledTimes(2);
    expect(props.onLayoutChanged).toHaveBeenCalledTimes(2);
  });
});
