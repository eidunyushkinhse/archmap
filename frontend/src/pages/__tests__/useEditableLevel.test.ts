// Поведенческие тесты useEditableLevel (рендер-хук): загрузка графа, маппинг
// рёбер, fence-курсор, зеркалирование раскладки, перераскладка, конфликт персиста.
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEditableLevel } from "../useEditableLevel";
import { nodesApi } from "../../api/nodes";
import type { GraphResponse } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    getGraph: vi.fn(),
    relayoutLevel: vi.fn(),
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

describe("useEditableLevel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("загружает граф: узлы, концы, раскладку, маппинг рёбер, курсор", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    const { result } = renderHook(() => useEditableLevel({ containerId: null, isArchitect: true }));
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

  it("handleLayoutChanged: добавляет и удаляет записи раскладки", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    const { result } = renderHook(() => useEditableLevel({ containerId: null, isArchitect: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.handleLayoutChanged({ b: { x: 100, y: 200 }, a: null }));
    expect(result.current.viewLayout).toEqual({ b: { x: 100, y: 200 } });
  });

  it("relayout: архитектор — сброс на сервере + перезагрузка", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    vi.mocked(nodesApi.relayoutLevel).mockResolvedValue(undefined as never);
    const { result } = renderHook(() => useEditableLevel({ containerId: "c1", isArchitect: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.relayout(); });
    expect(nodesApi.relayoutLevel).toHaveBeenCalledWith("c1");
    // getGraph звался дважды: первичная загрузка + после relayout
    expect(nodesApi.getGraph).toHaveBeenCalledTimes(2);
  });

  it("relayout: наблюдатель — ничего не делает", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    const { result } = renderHook(() => useEditableLevel({ containerId: null, isArchitect: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.relayout(); });
    expect(nodesApi.relayoutLevel).not.toHaveBeenCalled();
  });

  it("onPersistConflict: ресинк уровня + переигровка патча (retryPatch)", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    const { result } = renderHook(() => useEditableLevel({ containerId: null, isArchitect: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const patch = { a: { x: 50, y: 60 } };
    act(() => result.current.onPersistConflict(patch));
    await waitFor(() => expect(result.current.retryPatch).not.toBeNull());
    expect(result.current.retryPatch!.patch).toEqual(patch);
    expect(result.current.retryPatch!.token).toBe(1);
  });

  it("reload перечитывает уровень", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(makeGraph());
    const { result } = renderHook(() => useEditableLevel({ containerId: null, isArchitect: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.reload());
    await waitFor(() => expect(nodesApi.getGraph).toHaveBeenCalledTimes(2));
  });
});
