// Оркестрационные тесты команды «Переразложить уровень» (history.md U26, решение владельца
// 2026-11-24, задание П2): запрос хозяина → сброс расстановки тем же каналом раскладки,
// что перемещения (fence, зеркало, политика 409), переезд и шаг истории; отмена
// возвращает позиции до сброса, повтор раскладывает снова; запись, окончательно не
// прошедшая, снимает команду. Зависимости — levelGraphHarness; канал настоящий.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { ViewLayout } from "../../types";
import type { HistoryCommand } from "../graph/interaction/useHistory";
import { ApiError } from "../../api/client";
import { resetHarness, apiNodesMock, historyMock, layoutAnimMock, settle } from "./levelGraphHarness";
import { renderGraph, baseProps } from "./levelGraphRender";

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

// Слить микрозадачи: запись раскладки идёт цепочкой промисов очереди персиста.
async function flushPersist(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  await settle(1);
}

// Сохранённая расстановка уровня: объект и раскрытый контейнер.
const SAVED: ViewLayout = { a: { x: 10, y: 20 }, box: { x: 5, y: 6, expanded: true } };

async function mount(over: Parameters<typeof renderGraph>[0] = {}) {
  const viewMeta = { current: { version: 7, graphRev: 0 } };
  const onPersistConflict = vi.fn();
  const onLayoutChanged = vi.fn();
  const r = await renderGraph({
    viewLayout: SAVED,
    persistence: { ...baseProps().persistence, viewMeta, onPersistConflict, onLayoutChanged },
    ...over,
  });
  return { ...r, onPersistConflict, onLayoutChanged };
}

function pushed(): HistoryCommand {
  const cmd = historyMock.push.mock.calls.at(-1)?.[0] as HistoryCommand | undefined;
  if (!cmd) throw new Error("команда не положена в историю");
  return cmd;
}

describe("LevelGraph orchestration: «Переразложить уровень» — команда холста", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("запрос хозяина: сброс одним батчем каналом раскладки, переезд и шаг истории", async () => {
    const { props, rerenderWith } = await mount();
    rerenderWith({ relayoutRequest: 1 });
    const items = { a: null, box: { x: null, y: null, expanded: true } };
    expect(props.persistence?.onLayoutChanged).toHaveBeenCalledWith(items);
    await flushPersist();
    expect(apiNodesMock.viewsApi.saveLayout).toHaveBeenCalledWith(null, items, 7);
    expect(layoutAnimMock.noteRelayout).toHaveBeenCalledOnce();
    expect(historyMock.push).toHaveBeenCalledOnce();
    expect(pushed().label).toBe("Переразложить уровень");
    expect(pushed().level).toBeNull();
    // история не чистится
    expect(historyMock.clear).not.toHaveBeenCalled();
  });

  it("токен на маунте не исполняется: заход на уровень его не переразложит", async () => {
    const { props } = await mount({ relayoutRequest: 3 });
    expect(props.persistence?.onLayoutChanged).not.toHaveBeenCalled();
    expect(historyMock.push).not.toHaveBeenCalled();
  });

  it("сбрасывать нечего: ни записи, ни переезда, ни шага истории", async () => {
    const { props, rerenderWith } = await mount({ viewLayout: { box: { expanded: true } } });
    rerenderWith({ viewLayout: { box: { expanded: true } }, relayoutRequest: 1 });
    expect(props.persistence?.onLayoutChanged).not.toHaveBeenCalled();
    expect(layoutAnimMock.noteRelayout).not.toHaveBeenCalled();
    expect(historyMock.push).not.toHaveBeenCalled();
  });

  it("отмена возвращает позиции до сброса и снимает засеянное, повтор сбрасывает снова — с переездом", async () => {
    const { rerenderWith, onLayoutChanged } = await mount();
    rerenderWith({ relayoutRequest: 1 });
    const cmd = pushed();
    // Зеркало после сброса и засева новых авто-позиций конвейером (g — новый на виде).
    const seeded: ViewLayout = { a: { x: 1, y: 1 }, box: { expanded: true, x: 2, y: 2 }, g: { x: 3, y: 3 } };
    rerenderWith({ relayoutRequest: 1, viewLayout: seeded });
    onLayoutChanged.mockClear();
    act(() => { cmd.undo(); });
    expect(onLayoutChanged).toHaveBeenCalledWith({
      a: { x: 10, y: 20 }, box: { expanded: true, x: 5, y: 6 }, g: null,
    });
    expect(layoutAnimMock.noteRelayout).toHaveBeenCalledTimes(2);
    // Зеркало после отмены — исходное; повтор снова сбрасывает позиции.
    rerenderWith({ relayoutRequest: 1, viewLayout: SAVED });
    onLayoutChanged.mockClear();
    act(() => { cmd.redo(); });
    expect(onLayoutChanged).toHaveBeenCalledWith({ a: null, box: { x: null, y: null, expanded: true } });
    expect(layoutAnimMock.noteRelayout).toHaveBeenCalledTimes(3);
  });

  it("запись сброса не прошла: ресинк и снятие команды из истории", async () => {
    apiNodesMock.viewsApi.saveLayout.mockRejectedValueOnce(new Error("network down"));
    const { props, rerenderWith } = await mount();
    rerenderWith({ relayoutRequest: 1 });
    const cmd = pushed();
    await flushPersist();
    expect(props.persistence?.onPersistError).toHaveBeenCalledOnce();
    expect(historyMock.remove).toHaveBeenCalledWith(cmd);
  });

  it("409 у сброса — одна переигровка через хозяина, как у перемещений; команда остаётся", async () => {
    apiNodesMock.viewsApi.saveLayout.mockRejectedValueOnce(new ApiError(409, "stale view"));
    const { rerenderWith, onPersistConflict } = await mount();
    rerenderWith({ relayoutRequest: 1 });
    await flushPersist();
    expect(onPersistConflict).toHaveBeenCalledWith({ a: null, box: { x: null, y: null } });
    expect(historyMock.remove).not.toHaveBeenCalled();
  });

  it("без расстановки (только просмотр) запроса нет", async () => {
    const { props, rerenderWith } = await mount({ mode: { readOnly: true } });
    rerenderWith({ relayoutRequest: 1 });
    expect(props.persistence?.onLayoutChanged).not.toHaveBeenCalled();
    expect(historyMock.push).not.toHaveBeenCalled();
  });

  // Страничные схемы и полноэкранная схема страницы: кнопка в углу холста (relayoutButton)
  // жмёт ту же команду; отмена — своей кнопкой холста (история страницы своя).
  it("кнопка в углу холста страницы: сброс, шаг истории; «Отменить» возвращает расстановку", async () => {
    historyMock.canUndo.mockReturnValue(true); // шаг в истории есть — кнопка отмены активна
    const { rerenderWith, onLayoutChanged } = await mount({
      mode: { readOnly: true, arrangeOnly: true, relayoutButton: true },
    });
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Переразложить" })); });
    expect(onLayoutChanged).toHaveBeenCalledWith({ a: null, box: { x: null, y: null, expanded: true } });
    const cmd = pushed();
    expect(cmd.label).toBe("Переразложить уровень");
    // «Отменить» холста зовёт историю, а команда возвращает позиции до сброса
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(historyMock.undo).toHaveBeenCalledOnce();
    rerenderWith({ mode: { readOnly: true, arrangeOnly: true, relayoutButton: true }, viewLayout: { box: { expanded: true } } });
    onLayoutChanged.mockClear();
    act(() => { cmd.undo(); });
    expect(onLayoutChanged).toHaveBeenCalledWith({ a: { x: 10, y: 20 }, box: { expanded: true, x: 5, y: 6 } });
  });

  it("кнопки в углу нет без флага (редактор, «Развёртывание») и без расстановки", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: "Переразложить" })).toBeNull();
    resetHarness();
    await mount({ mode: { readOnly: true, relayoutButton: true } });
    expect(screen.queryByRole("button", { name: "Переразложить" })).toBeNull();
  });
});
