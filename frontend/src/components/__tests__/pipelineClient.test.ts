// Клиент воркера конвейера (аудит R-17): у воркера не было сторожа — патологический
// прогон держал очередь до перезагрузки страницы («Считаю раскладку…» навсегда).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({ list: [] as FakeWorker[] }));
interface FakeWorker {
  posted: { runId: number }[];
  terminated: boolean;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onmessageerror: (() => void) | null;
}

vi.mock("../graph/layout/pipeline.worker.ts?worker", () => ({
  default: class {
    posted: { runId: number }[] = [];
    terminated = false;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor() { workers.list.push(this as unknown as FakeWorker); }
    postMessage(msg: { runId: number }) { this.posted.push(msg); }
    terminate() { this.terminated = true; }
  },
}));
vi.mock("../graph/layout/pipeline", () => ({
  computeViewLayout: vi.fn(async () => ({ layout: "главный поток" })),
}));

const input = {} as never;

beforeEach(() => {
  vi.resetModules();
  workers.list = [];
  vi.useFakeTimers();
  vi.stubGlobal("Worker", function Worker() {}); // есть ли Worker — проверка typeof
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("computeViewLayoutOffThread", () => {
  it("зависший прогон отклоняется сторожем, воркер пересоздаётся, очередь уходит в новый", async () => {
    const { computeViewLayoutOffThread, RUN_TIMEOUT_MS } = await import("../graph/layout/pipelineClient");
    const stuck = computeViewLayoutOffThread(input);
    const queued = computeViewLayoutOffThread(input);
    const stuckErr = stuck.catch((e: unknown) => e);
    const [first] = workers.list;
    expect(first.posted).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS);
    expect(await stuckErr).toBeInstanceOf(Error);
    expect(first.terminated).toBe(true);
    const second = workers.list[1];
    expect(second.posted).toHaveLength(1); // очередь переотправлена в свежий воркер

    second.onmessage?.({ data: { runId: second.posted[0].runId, ok: true, out: { layout: "воркер" } } });
    expect(await queued).toEqual({ layout: "воркер" });
  });

  it("ответ не разобрать (onmessageerror) — ожидающее досчитывается на главном потоке", async () => {
    const { computeViewLayoutOffThread } = await import("../graph/layout/pipelineClient");
    const run = computeViewLayoutOffThread(input);
    workers.list[0].onmessageerror?.();
    expect(await run).toEqual({ layout: "главный поток" });
  });
});
