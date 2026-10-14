// Инверсия связи в панели при отказе записи (аудит R-14): концы и подписи возвращаются
// к сохранённым — иначе панель показывала бы направление, которого в БД нет.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEdgeEdit } from "../inspector/useEdgeEdit";
import { edgesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";

vi.mock("../../api/nodes", () => ({
  edgesApi: { update: vi.fn(), get: vi.fn() },
  nodesApi: { get: vi.fn() },
}));

const initial = {
  id: "e1", label: null, technology: null, channel: null,
  source_id: "a", target_id: "b", version: 1, source_name: "Заказы", target_name: "Оплата",
};

describe("useEdgeEdit: инверсия", () => {
  it("отказ (не 409) — направление и подписи возвращаются, причина видна", async () => {
    vi.mocked(edgesApi.update).mockRejectedValue(new ApiError(400, "Связь с такими концами запрещена"));
    const { result } = renderHook(() => useEdgeEdit(initial, vi.fn()));

    act(() => { result.current.invert(); });
    await waitFor(() => expect(result.current.error).toBe("Связь с такими концами запрещена"));

    expect(result.current.sourceId).toBe("a");
    expect(result.current.targetId).toBe("b");
    expect(result.current.srcLabel).toBe("Заказы");
    expect(result.current.tgtLabel).toBe("Оплата");
  });

  it("удача — концы переставлены", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...initial, source_id: "b", target_id: "a", version: 2 } as never);
    const { result } = renderHook(() => useEdgeEdit(initial, vi.fn()));
    act(() => { result.current.invert(); });
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalled());
    expect(result.current.sourceId).toBe("b");
    expect(result.current.srcLabel).toBe("Оплата");
  });
});
