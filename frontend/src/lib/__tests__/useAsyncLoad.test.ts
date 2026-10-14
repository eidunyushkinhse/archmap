import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAsyncLoad } from "../useAsyncLoad";

describe("useAsyncLoad (аудит R-2)", () => {
  it("загрузка → данные; отказ → error и повтор", async () => {
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce("узел");
    const { result } = renderHook(() => useAsyncLoad("n1", load));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();

    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe("узел"));
    expect(result.current.error).toBeNull();
  });

  it("ответ по прежнему ключу не применяется", async () => {
    let finishFirst: (v: string) => void = () => {};
    const load = vi.fn<(k: string) => Promise<string>>((k) =>
      k === "a" ? new Promise((resolve) => { finishFirst = resolve; }) : Promise.resolve("B"),
    );
    const { result, rerender } = renderHook(({ k }) => useAsyncLoad(k, () => load(k)), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    await waitFor(() => expect(result.current.data).toBe("B"));
    await act(async () => { finishFirst("A"); });
    expect(result.current.data).toBe("B");
  });

  it("update правит загруженное на месте", async () => {
    const { result } = renderHook(() => useAsyncLoad("k", async () => ({ edges: 1 })));
    await waitFor(() => expect(result.current.data).toEqual({ edges: 1 }));
    act(() => result.current.update((d) => ({ ...d, edges: 2 })));
    expect(result.current.data).toEqual({ edges: 2 });
  });
});
