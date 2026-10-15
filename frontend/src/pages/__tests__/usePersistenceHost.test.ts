// Хост персиста раскладки (pages/usePersistenceHost): замок ресинка, переигровка 409 и
// свежий reload из последнего рендера при стабильных колбэках.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePersistenceHost } from "../usePersistenceHost";

describe("usePersistenceHost", () => {
  it("ресинк: один запрос в полёте на серию отказов", async () => {
    let release = (): void => {};
    const reload = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const { result } = renderHook(() => usePersistenceHost(reload));
    let a: Promise<void> = Promise.resolve();
    let b: Promise<void> = Promise.resolve();
    act(() => { a = result.current.resync(); b = result.current.resync(); });
    expect(reload).toHaveBeenCalledOnce();
    expect(a).toBe(b);
    await act(async () => { release(); await a; });
    // Серия закончилась — следующий отказ перечитывает заново.
    act(() => { void result.current.resync(); });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("409: ресинк, затем переигровка патча с новым токеном", async () => {
    const reload = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => usePersistenceHost(reload));
    expect(result.current.retryPatch).toBeNull();
    act(() => { result.current.onConflict({ n1: { x: 10, y: 20 } }); });
    await waitFor(() => expect(result.current.retryPatch?.token).toBe(1));
    expect(reload).toHaveBeenCalledOnce();
    expect(result.current.retryPatch?.patch).toEqual({ n1: { x: 10, y: 20 } });
    act(() => { result.current.onConflict({ n2: null }); });
    await waitFor(() => expect(result.current.retryPatch?.token).toBe(2));
  });

  it("колбэки стабильны, а ресинк зовёт reload последнего рендера", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const { result, rerender } = renderHook(({ reload }) => usePersistenceHost(reload), {
      initialProps: { reload: first },
    });
    const { resync, onConflict } = result.current;
    rerender({ reload: second });
    expect(result.current.resync).toBe(resync);
    expect(result.current.onConflict).toBe(onConflict);
    await act(async () => { await result.current.resync(); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("usePersistenceHost: снятие переигровки", () => {
  it("dropRetry снимает отложенный патч (переход на другой уровень)", async () => {
    const { result } = renderHook(() => usePersistenceHost(() => Promise.resolve()));
    act(() => { result.current.onConflict({ n1: null }); });
    await waitFor(() => expect(result.current.retryPatch).not.toBeNull());
    act(() => { result.current.dropRetry(); });
    expect(result.current.retryPatch).toBeNull();
  });
});
