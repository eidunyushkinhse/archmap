// Регрессия «визуальный откат узла при отпускании драга на СТРАНИЧНЫХ схемах».
//
// Симптом (2026-08-02): на странице объекта и на главной странице проекта узел по
// отпускании драга на долю секунды возвращался на позицию ДО жеста и только затем
// вставал на целевую. В редакторе-карте отката нет.
//
// Механика: эффект-сборщик RF применяет СНИМОК раскладки (стейт layout). Пока
// конвейер считает новую, layout — прежний, а RF-узлы держат позицию, доехавшую
// драгом. Любой лишний прогон сборщика в этом промежутке возвращает узел на
// позицию из старого layout — это и есть откат.
// Триггером был relevantCounts (гейт лупы/бейджа read-only схем): он пересчитывался
// от edges/endpoints/expanded, а зеркало раскладки на драг-стопе даёт НОВЫЕ ссылки
// (setGraph/setViewLayout в хозяине страницы) при том же содержимом → новая Map →
// зависимость сборщика изменилась. В редакторе (isReadOnly=false) relevantCounts
// всегда undefined, поэтому там сборщик и не срабатывал лишний раз.
//
// Тест держит контракт: пересборка сцены — только по НОВОЙ раскладке или по
// реально изменившемуся составу, но не по идентичности зеркала.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import type { Edge as AppEdge, GhostNode, ViewLayout } from "../../types";
import LevelGraph from "../LevelGraph";
import { resetHarness, layoutAnimMock, pipeline, pipelineClientMock, settle } from "./levelGraphHarness";
import { baseProps } from "./levelGraphRender";

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

// Сосед-гость с цепочкой предков: даёт непустой relevantCounts (счётчик по
// предку c1) — тот самый гейт лупы/бейджа read-only схемы.
const ghost = (id: string): GhostNode => ({
  id, name: id.toUpperCase(), role: null, technology: null, is_external: false,
  shape: "service", status: "existing", node_depth: 2, has_children: false,
  child_count: 0, ancestors: [{ id: "c1", name: "C1", is_external: false }],
  is_ghost: true,
});
const edge = (id: string, source: string, target: string): AppEdge => ({
  id, label: null, technology: null, source_id: source, target_id: target,
  is_synchronous: true, version: 1, created_at: "2026-08-02T00:00:00.000Z",
});

// Страничная схема архитектора: структура read-only, расстановка (драг+персист)
// разрешена — ровно режим EmbeddedSchemaBlock с бандлом персиста.
const pageGraph = (viewLayout: ViewLayout, endpoints: GhostNode[], edges: AppEdge[]) => (
  <LevelGraph
    {...baseProps()}
    endpoints={endpoints}
    edges={edges}
    viewLayout={viewLayout}
    mode={{ readOnly: true, arrangeOnly: true }}
  />
);

describe("LevelGraph orchestration: сборка RF после драга (откат узла)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHarness();
    // Каждый прогон отдаёт СВЕЖИЙ объект раскладки (как настоящий конвейер):
    // дефолт harness возвращает один и тот же result, и setLayout бейлаутил бы
    // по ссылке — «применение свежей раскладки» тогда не наблюдаемо.
    pipelineClientMock.computeViewLayoutOffThread.mockImplementation(() =>
      Promise.resolve({ ...pipeline.result, layout: { ...pipeline.result.layout } }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("зеркало раскладки (новые ссылки при том же составе) не пере-применяет старый layout", async () => {
    const endpoints = [ghost("g1")];
    const edges = [edge("e1", "n1", "g1")];
    const { rerender } = render(pageGraph({}, endpoints, edges));
    await settle();
    const applied = layoutAnimMock.apply.mock.calls.length;
    expect(applied).toBeGreaterThan(0);

    // Драг-стоп: хозяин страницы зеркалит записанную позицию — НОВЫЙ объект
    // viewLayout и НОВЫЙ массив edges (toLevelEdges от нового graph) при прежнем
    // содержимом. Конвейер только стартовал, новой раскладки ещё нет.
    rerender(pageGraph({ n1: { x: 10, y: 20 } }, [...endpoints], [...edges]));
    expect(layoutAnimMock.apply).toHaveBeenCalledTimes(applied);

    // Прогон досчитан — свежая раскладка применяется (узел встаёт на целевую).
    await settle();
    expect(layoutAnimMock.apply.mock.calls.length).toBeGreaterThan(applied);
  });

  it("реально изменившийся состав (новый сосед и ребро) пересобирает сцену сразу", async () => {
    const endpoints = [ghost("g1")];
    const edges = [edge("e1", "n1", "g1")];
    const { rerender } = render(pageGraph({}, endpoints, edges));
    await settle();
    const applied = layoutAnimMock.apply.mock.calls.length;

    // Второй релевантный ребёнок предка c1 → счётчик у c1 стал 2: содержимое
    // изменилось, пересборка законна (гейт лупы/бейджа обязан обновиться).
    rerender(pageGraph(
      {},
      [...endpoints, ghost("g2")],
      [...edges, edge("e2", "n2", "g2")],
    ));
    expect(layoutAnimMock.apply.mock.calls.length).toBeGreaterThan(applied);
  });
});
