import { describe, expect, it, vi } from "vitest";
import { lazyOnce } from "../lazyOnce";

describe("lazyOnce (аудит R-7)", () => {
  it("удачная загрузка — одна на все обращения", async () => {
    const load = vi.fn(async () => 42);
    const get = lazyOnce(load);
    expect(get.started()).toBe(false);
    expect(await Promise.all([get(), get()])).toEqual([42, 42]);
    expect(await get()).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
    expect(get.ready()).toBe(true);
  });

  it("отказ не кэшируется: следующее обращение пробует снова", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce("mermaid");
    const get = lazyOnce(load);

    await expect(get()).rejects.toThrow("dynamically imported");
    expect(get.started()).toBe(false);
    expect(get.ready()).toBe(false);
    expect(await get()).toBe("mermaid");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
