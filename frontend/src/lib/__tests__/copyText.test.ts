import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyFailed, copyText } from "../copyText";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubExec(result: boolean) {
  const exec = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
  return exec;
}

describe("copyText (аудит R-6)", () => {
  it("есть clipboard.writeText — пишет через него", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText(Promise.resolve("промпт"));
    expect(writeText).toHaveBeenCalledWith("промпт");
  });

  it("есть ClipboardItem — запись начинается сразу, текст догружается обещанием", async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal("ClipboardItem", class {
      items: Record<string, Promise<Blob>>;
      constructor(items: Record<string, Promise<Blob>>) { this.items = items; }
    });
    let finish: (t: string) => void = () => {};
    const done = copyText(new Promise<string>((r) => { finish = r; }));
    expect(write).toHaveBeenCalledOnce(); // синхронно, ещё в жесте
    finish("промпт");
    await done;
  });

  it("http без clipboard — textarea и execCommand", async () => {
    vi.stubGlobal("navigator", {});
    const exec = stubExec(true);
    await copyText("замечания");
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("ничего не вышло — CopyFailed с текстом для ручного копирования", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    stubExec(false);
    const err = await copyText("промпт").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CopyFailed);
    expect((err as CopyFailed).text).toBe("промпт");
  });

  it("сам текст не загрузился — отказ запроса, не CopyFailed", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    await expect(copyText(Promise.reject(new Error("500")))).rejects.toThrow("500");
  });
});
