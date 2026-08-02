// Поведенческие тесты useLevelSchema (рендер-хук): загрузка графа уровня,
// маппинг рёбер, fence-курсор, фоновая перезагрузка (reload), смена контейнера.
// Хук read-only — редактирующая инфраструктура (undo/relayout/персист) убрана.
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useLevelSchema } from "../useLevelSchema";
import { nodesApi } from "../../api/nodes";
import type { GraphResponse } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    getGraph: vi.fn(),
  },
}));

function makeGraph(over: Partial<GraphResponse> = {}): GraphResponse {
  return {
    nodes: [
      { id: "a", name: "A", shape: "service", is_external: false, status: "existing",
        has_children: false, child_count: 0, version: 1 },
    ],
    endpoints: [{ id: "x", name: "Гость X", ancestors: [] }],
    edges: [
      { id: "e1", label: "зовёт", technology: null, source_id: "a", target_id: "x", version: 1 },
    ],
    layout: { a: { x: 10, y: 20 } },
    version: 5,
    graph_rev: 3,
    ...over,
  } as unknown as GraphResponse;
}

describe("useLevelSchema", () => {
  beforeEach(() => vi.clearAllMocks());

  it("загружает граф: узлы, концы, раскладку, маппинг рёбер, курсор", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    const { result } = renderHook(() => useLevelSchema({ containerId: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.nodes).toHaveLength(1);
    expect(result.current.endpoints).toHaveLength(1);
    expect(result.current.viewLayout).toEqual({ a: { x: 10, y: 20 } });
    // toLevelEdges: синтез original_* имён из локалов и реестра
    expect(result.current.edges[0]).toMatchObject({
      id: "e1",
      source_id: "a",
      target_id: "x",
      original_source_name: "A",
      original_target_name: "Гость X",
    });
    // fence-курсор из ответа
    expect(result.current.viewMetaRef.current).toEqual({ version: 5, graphRev: 3 });
  });

  it("reload: фоновая перезагрузка — getGraph зовётся повторно", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    const { result } = renderHook(() => useLevelSchema({ containerId: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    // reload возвращает промис (ресинк персиста ждёт свежих данных) — act awaited,
    // чтобы асинхронная перезагрузка корректно завершилась до следующего теста.
    await act(async () => { await result.current.reload(); });
    await waitFor(() => expect(nodesApi.getGraph).toHaveBeenCalledTimes(2));
  });

  it("смена containerId: перезагрузка с новым контейнером (foreground)", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    const { result, rerender } = renderHook(
      ({ containerId }) => useLevelSchema({ containerId }),
      { initialProps: { containerId: null as string | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(nodesApi.getGraph).toHaveBeenCalledWith(null);
    // Смена контейнера → повторный вызов getGraph с новым id
    rerender({ containerId: "c1" });
    await waitFor(() => expect(nodesApi.getGraph).toHaveBeenCalledWith("c1"));
    expect(nodesApi.getGraph).toHaveBeenCalledTimes(2);
  });
});
