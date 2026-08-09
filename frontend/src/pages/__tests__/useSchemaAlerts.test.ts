// Тесты алертов незавершённости: чистый resolveAlertLocate (уровень + LocateRequest)
// и хук useSchemaAlerts (загрузка, гейт архитектора).
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSchemaAlerts, resolveAlertLocate } from "../useSchemaAlerts";
import { nodesApi } from "../../api/nodes";
import type { Node, SchemaAlerts as Alerts } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { getAlerts: vi.fn() },
}));

// Дерево: root(null) ⊃ A ⊃ A1; root ⊃ B.
function node(id: string, parent_id: string | null): Node {
  return { id, name: id, parent_id, shape: "service", is_external: false, status: "existing" } as Node;
}
const ALL: Node[] = [node("A", null), node("A1", "A"), node("B", null)];

const EMPTY_ALERTS: Alerts = { disconnected_nodes: [], intermediate_edges: [], isolated_groups: [], container_own_docs: [], persons_inside: [] };

describe("resolveAlertLocate", () => {
  it("узел: уровень = родитель, запрос node", () => {
    const { level, request } = resolveAlertLocate(ALL, { kind: "node", id: "A1" }, EMPTY_ALERTS, 7);
    expect(level).toBe("A"); // родитель A1
    expect(request).toEqual({ kind: "node", ids: ["A1"], token: 7 });
  });

  it("корневой узел: уровень = null (корень)", () => {
    const { level } = resolveAlertLocate(ALL, { kind: "node", id: "A" }, EMPTY_ALERTS, 1);
    expect(level).toBeNull();
  });

  it("связь: уровень = общий предок концов, запрос с endIds из алерта", () => {
    const alerts: Alerts = {
      ...EMPTY_ALERTS,
      intermediate_edges: [{
        edge_id: "e1", label: null, source_id: "A1", source_name: "A1",
        target_id: "B", target_name: "B", source_is_intermediate: false, target_is_intermediate: true,
      }],
    };
    const { level, request } = resolveAlertLocate(ALL, { kind: "edge", id: "e1" }, alerts, 3);
    // общий предок A1 (цепочка A→null) и B (цепочка null) = null (корень)
    expect(level).toBeNull();
    expect(request).toEqual({ kind: "edge", ids: ["e1"], endIds: ["A1", "B"], token: 3 });
  });

  it("связь не найдена в алертах: фолбэк без endIds", () => {
    const { level, request } = resolveAlertLocate(ALL, { kind: "edge", id: "missing" }, EMPTY_ALERTS, 2);
    expect(level).toBeNull();
    expect(request).toEqual({ kind: "edge", ids: ["missing"], token: 2 });
  });

  it("группа: уровень = общий предок узлов группы", () => {
    // Группа из A1 и A → общий предок A (A1⊂A, A сам в своей цепочке как null-предок…
    // цепочка A1 = [A, null], цепочка A = [null]; общий = null). Возьмём A1 + A1-подобное.
    const all2 = [...ALL, node("A2", "A")];
    const { level, request } = resolveAlertLocate(all2, { kind: "group", ids: ["A1", "A2"] }, EMPTY_ALERTS, 5);
    expect(level).toBe("A"); // оба ребёнка A
    expect(request).toEqual({ kind: "group", ids: ["A1", "A2"], token: 5 });
  });
});

describe("useSchemaAlerts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("архитектор: загружает алерты", async () => {
    const alerts: Alerts = {
      disconnected_nodes: [{ node_id: "x", node_name: "X" }],
      intermediate_edges: [],
      isolated_groups: [],
      container_own_docs: [], persons_inside: [],
    } as Alerts;
    vi.mocked(nodesApi.getAlerts).mockResolvedValue(alerts);
    const { result } = renderHook(() => useSchemaAlerts(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.alerts.disconnected_nodes).toHaveLength(1);
    expect(nodesApi.getAlerts).toHaveBeenCalledOnce();
  });

  it("наблюдатель: алерты пустые, запроса нет", async () => {
    const { result } = renderHook(() => useSchemaAlerts(false));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.alerts.disconnected_nodes).toHaveLength(0);
    expect(nodesApi.getAlerts).not.toHaveBeenCalled();
  });

  it("ошибка загрузки: loaded всё равно выставляется (алерты — некритичный фон)", async () => {
    vi.mocked(nodesApi.getAlerts).mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useSchemaAlerts(true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.alerts.disconnected_nodes).toHaveLength(0);
  });
});
