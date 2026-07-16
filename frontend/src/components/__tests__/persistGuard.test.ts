import { describe, it, expect, vi } from "vitest";
import { guardPersist, planPersistFailure } from "../graph/interaction/persistGuard";
import { ApiError, isConflict } from "../../api/client";

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

// Политика отказа фенсированной записи раскладки (этап 0 конкурентности, V51):
// переигровка — ТОЛЬКО для тройки «конфликт + user-интент + не ретрай».
describe("planPersistFailure", () => {
  it("409 у user-интента → ресинк и переигровка", () => {
    expect(planPersistFailure(true, "user", false)).toBe("retry-after-resync");
  });

  it("409 у derived-интента → только ресинк (конвейер пересчитает сиды сам)", () => {
    expect(planPersistFailure(true, "derived", false)).toBe("resync-only");
  });

  it("повторный 409 ретрая → только ресинк (не зацикливаемся)", () => {
    expect(planPersistFailure(true, "user", true)).toBe("resync-only");
  });

  it("не-конфликт (сеть/5xx) → только ресинк независимо от происхождения", () => {
    expect(planPersistFailure(false, "user", false)).toBe("resync-only");
    expect(planPersistFailure(false, "derived", false)).toBe("resync-only");
  });
});

// ApiError: фронт различает статусы (раньше коды терялись в new Error(detail)).
describe("ApiError / isConflict", () => {
  it("isConflict — только ApiError со статусом 409", () => {
    expect(isConflict(new ApiError(409, "Вид изменён в другой сессии"))).toBe(true);
    expect(isConflict(new ApiError(500, "boom"))).toBe(false);
    expect(isConflict(new Error("409"))).toBe(false);
    expect(isConflict(undefined)).toBe(false);
  });

  it("сохраняет message (detail бэка) и статус", () => {
    const e = new ApiError(409, "Узел изменён в другой сессии");
    expect(e.message).toBe("Узел изменён в другой сессии");
    expect(e.status).toBe(409);
    expect(e).toBeInstanceOf(Error);
  });
});
