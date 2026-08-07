// Оркестрационные тесты АВТО-ЦЕНТРИРОВАНИЯ страничных схем (fitOnExpand).
// Фиксируют контракт запроса на анимированное центрирование (autoFitRef):
//   • «Переразложить» (relayoutToken) на странице → фит с анимацией по ПРИШЕДШЕЙ
//     раскладке (не по старой геометрии момента клика);
//   • редактор-карта (без fitOnExpand) тот же токен игнорирует;
//   • протухший запрос (AUTO_FIT_TTL_MS — ожидавшегося прогона не случилось) не
//     центрирует схему на следующей смене раскладки.
// RF/конвейер замоканы; fitView — vi.fn из harness.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import LevelGraph from "../LevelGraph";
import type { Node as AppNode } from "../../types";
import { resetHarness, rf, settle, pipeline } from "./levelGraphHarness";
import { baseProps, type LevelGraphProps } from "./levelGraphRender";

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

const NODE = {
  id: "a", name: "A", parent_id: null, shape: "service", is_external: false,
} as AppNode;

// Дать раскладке осесть и прогнать цепочку попыток фита: тихое окно откладывает
// старт до FIT_QUIET_MS тишины, лимит — FIT_ATTEMPTS × 140мс.
async function runFit(): Promise<void> {
  await settle();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
}

// Следующий прогон конвейера отдаёт ДРУГОЙ объект раскладки. Harness держит один
// результат синглтоном, а setLayout сравнивает по ссылке (Object.is) — без подмены
// «свежий прогон» не доходил бы до стейта и эффект центрирования не перезапускался.
function freshLayout(): void {
  pipeline.result = { ...pipeline.result, layout: { ...pipeline.result.layout } };
}

describe("LevelGraph orchestration: авто-центрирование страничных схем", () => {
  // Базовые пропсы держим ОДНИМ объектом на тест: baseProps() пересоздаёт колбэки,
  // а ререндер с новыми ссылками — лишний шум для конвейера.
  let base: LevelGraphProps;

  beforeEach(() => {
    vi.useFakeTimers();
    // Фейковые таймеры подменяют Date, но НЕ performance.now — а тихое окно и срок
    // годности запроса считаются по нему. Сажаем performance.now на фейковый Date,
    // чтобы виртуальное время двигало и их.
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    resetHarness();
    base = { ...baseProps(), nodes: [NODE], viewLayout: {} };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("«Переразложить» на странице (fitOnExpand): свежая раскладка → анимированный фит", async () => {
    const page: LevelGraphProps = { ...base, mode: { fitOnExpand: true } };
    const { rerender } = render(<LevelGraph {...page} />);
    await runFit();
    // До сброса центрирования нет — запроса никто не взводил.
    expect(rf.fitView).not.toHaveBeenCalled();

    // Сброс раскладки: страница инкрементит токен, следом приходит свежая раскладка
    // (рефетч даёт новый viewLayout → прогон конвейера → applyLayout).
    freshLayout();
    rerender(<LevelGraph {...page} relayoutToken={1} viewLayout={{}} />);
    await runFit();

    expect(rf.fitView).toHaveBeenCalledTimes(1);
    expect(rf.fitView).toHaveBeenCalledWith({ padding: 0.1, maxZoom: 1.0, duration: 420 });
  });

  it("редактор-карта (без fitOnExpand): тот же токен не центрирует", async () => {
    const { rerender } = render(<LevelGraph {...base} />);
    await runFit();

    freshLayout();
    rerender(<LevelGraph {...base} relayoutToken={1} viewLayout={{}} />);
    await runFit();

    expect(rf.fitView).not.toHaveBeenCalled();
  });

  it("протухший запрос (ожидавшегося прогона нет дольше TTL) схему не дёргает", async () => {
    const page: LevelGraphProps = { ...base, mode: { fitOnExpand: true } };
    const { rerender } = render(<LevelGraph {...page} />);
    await runFit();

    // Сброс раскладку не изменил (позиции совпали → скип по layoutSig): прогона,
    // который забрал бы запрос, не пришло — запрос висит.
    rerender(<LevelGraph {...page} relayoutToken={1} />);
    await runFit();
    expect(rf.fitView).not.toHaveBeenCalled();

    // Спустя TTL раскладка меняется по другой причине (драг, ресинк) — протухший
    // запрос центрирование НЕ вызывает.
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    freshLayout();
    rerender(<LevelGraph {...page} relayoutToken={1} viewLayout={{}} />);
    await runFit();

    expect(rf.fitView).not.toHaveBeenCalled();
  });
});
