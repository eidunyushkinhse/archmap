import { afterEach, describe, expect, it, vi } from "vitest";
import { safeLocal } from "../safeStorage";

afterEach(() => {
  vi.restoreAllMocks();
  safeLocal.removeItem("k");
  localStorage.clear();
});

describe("safeStorage (аудит R-8)", () => {
  it("обычный режим — пишет и читает настоящее хранилище", () => {
    safeLocal.setItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
    expect(safeLocal.getItem("k")).toBe("v");
    expect(safeLocal.keys()).toContain("k");
    safeLocal.removeItem("k");
    expect(localStorage.getItem("k")).toBeNull();
  });

  it("квота: запись остаётся в памяти вкладки и читается", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => safeLocal.setItem("k", "v")).not.toThrow();
    expect(safeLocal.getItem("k")).toBe("v");
    expect(safeLocal.keys()).toContain("k");
  });

  it("хранилище заблокировано целиком: ни чтение, ни запись не бросают", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(safeLocal.getItem("k")).toBeNull();
    safeLocal.setItem("k", "v");
    expect(safeLocal.getItem("k")).toBe("v");
    expect(() => safeLocal.removeItem("k")).not.toThrow();
    expect(safeLocal.getItem("k")).toBeNull();
  });

  it("projectScope, читающий хранилище при импорте, грузится и без него", async () => {
    // Раньше прямой localStorage.getItem на уровне модуля бросал SecurityError, и
    // приложение не стартовало вовсе.
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.resetModules();
    const scope = await import("../../api/projectScope");
    expect(scope.getCurrentProjectId()).toBeNull();
    scope.setCurrentProjectId("p1");
    expect(scope.getCurrentProjectId()).toBe("p1");
  });
});
