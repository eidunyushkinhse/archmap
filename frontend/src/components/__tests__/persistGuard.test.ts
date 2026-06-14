import { describe, it, expect, vi } from "vitest";
import { guardPersist } from "../graph/interaction/persistGuard";

// guardPersist: оптимистичная/компенсирующая запись. Успех — onError НЕ зовётся; отказ —
// onError зовётся (ресинк уровня) и ошибка логируется, наружу не пробрасывается.

describe("guardPersist", () => {
  it("при успехе onError не вызывается", async () => {
    const onError = vi.fn();
    guardPersist(Promise.resolve("ok"), onError);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it("при отказе зовёт onError с ошибкой и логирует", async () => {
    const onError = vi.fn();
    const err = new Error("network");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    guardPersist(Promise.reject(err), onError);
    // даём микротаскам .catch отработать
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(err);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("без onError отказ не падает наружу (только лог)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => guardPersist(Promise.reject(new Error("x")))).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
