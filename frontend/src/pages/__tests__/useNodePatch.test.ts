// Поведенческие тесты useNodePatch (рендер-хук): CAS-коммиты, trim-guard,
// 409-ресинк, applyDocEvent, refresh.
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useNodePatch } from "../useNodePatch";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { Node, NodeDoc } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    update: vi.fn(),
    get: vi.fn(),
  },
}));

function makeNode(over: Partial<Node> = {}): Node {
  return {
    id: "n1",
    name: "Сервис",
    description: null,
    role: null,
    technology: null,
    parent_id: null,
    shape: "service",
    is_external: false,
    status: "existing",
    openapi_spec: null,
    version: 1,
    docs: [],
    has_children: false,
    child_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as Node;
}

function makeDoc(over: Partial<NodeDoc> = {}): NodeDoc {
  return {
    id: "d1",
    node_id: "n1",
    name: "Обзор",
    kind: "overview",
    operation: null,
    content: "graph TD",
    version: 1,
    ...over,
  } as NodeDoc;
}

describe("useNodePatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("инициализирует стейты из узла", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "API", role: "ядро", is_external: true })));
    expect(result.current.name).toBe("API");
    expect(result.current.role).toBe("ядро");
    expect(result.current.isExternal).toBe(true);
    expect(result.current.node.id).toBe("n1");
  });

  it("commitName: пустое имя откатывается, без запроса", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "Было" })));
    act(() => result.current.setName("   "));
    act(() => result.current.commitName());
    expect(result.current.name).toBe("Было");
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("commitName: неизменное имя — без запроса", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "То же" })));
    act(() => result.current.commitName());
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("commitName: сохранение с CAS base_version", async () => {
    const saved = makeNode({ name: "Новое", version: 2 });
    vi.mocked(nodesApi.update).mockResolvedValue(saved);
    const onSaved = vi.fn();
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "Старое", version: 3 }), onSaved));
    act(() => result.current.setName("Новое"));
    act(() => result.current.commitName());
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    const [id, payload] = vi.mocked(nodesApi.update).mock.calls[0];
    expect(id).toBe("n1");
    expect(payload.name).toBe("Новое");
    expect(payload.base_version).toBe(3);
    await waitFor(() => expect(result.current.node.version).toBe(2));
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it("409 конфликт: рефреш + баннер, конфликт гасится при следующем успехе", async () => {
    const fresh = makeNode({ name: "Чужое", version: 9 });
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(409, "conflict"));
    vi.mocked(nodesApi.get).mockResolvedValue(fresh);
    const { result } = renderHook(() => useNodePatch(makeNode({ version: 1 })));
    act(() => result.current.setName("Моё"));
    act(() => result.current.commitName());
    await waitFor(() => expect(result.current.conflict).toBeTruthy());
    // Данные освежены из БД
    expect(result.current.name).toBe("Чужое");
    expect(result.current.node.version).toBe(9);
    // Следующий успешный коммит гасит баннер (меняем имя, иначе commitName — no-op)
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ name: "Моё2", version: 10 }));
    act(() => result.current.setName("Моё2"));
    act(() => result.current.commitName());
    await waitFor(() => expect(result.current.conflict).toBeNull());
  });

  it("applyDocEvent: create/edit/delete обновляют мету доков в стейте", () => {
    const d1 = makeDoc({ id: "d1", name: "Обзор", version: 1 });
    const { result } = renderHook(() => useNodePatch(makeNode({ docs: [{ id: "d1", name: "Обзор", kind: "overview", operation: null, version: 1 }] })));

    // create
    const d2 = makeDoc({ id: "d2", name: "Операция", kind: "operation", version: 1 });
    act(() => result.current.applyDocEvent({ type: "create", nodeId: "n1", doc: d2 }));
    expect(result.current.node.docs).toHaveLength(2);
    expect(result.current.node.docs[1]).toMatchObject({ id: "d2", name: "Операция", kind: "operation" });

    // edit (правка контента → новая версия)
    const d1v2 = makeDoc({ id: "d1", name: "Обзор", version: 2 });
    act(() => result.current.applyDocEvent({ type: "edit", nodeId: "n1", before: d1, after: d1v2 }));
    expect(result.current.node.docs[0]).toMatchObject({ id: "d1", version: 2 });

    // delete
    act(() => result.current.applyDocEvent({ type: "delete", nodeId: "n1", doc: d2 }));
    expect(result.current.node.docs).toHaveLength(1);
    expect(result.current.node.docs[0].id).toBe("d1");
  });

  it("refresh: применяет свежий узел целиком (стейты + CAS-база)", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "Старое", role: null, version: 1 })));
    const fresh = makeNode({ name: "Свежее", role: "шлюз", version: 7 });
    act(() => result.current.refresh(fresh));
    expect(result.current.name).toBe("Свежее");
    expect(result.current.role).toBe("шлюз");
    expect(result.current.node.version).toBe(7);
  });

  it("toggleExternal: инвертирует и коммитит", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ is_external: true, version: 2 }));
    const { result } = renderHook(() => useNodePatch(makeNode({ is_external: false })));
    act(() => result.current.toggleExternal());
    expect(result.current.isExternal).toBe(true);
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1].is_external).toBe(true);
  });
});
