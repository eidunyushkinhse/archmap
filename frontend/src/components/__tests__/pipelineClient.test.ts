// Клиент воркера конвейера.
// Аудит R-17: у воркера не было сторожа — патологический прогон держал очередь до
// перезагрузки страницы (бейдж «Расставляем объекты» навсегда).
// Эпик render-scale, шаг «быстрый ELK и один прогон»: очередь живёт в клиенте (воркеру —
// одна задача за раз), внутри холста-владельца структурно равный вход склеивается, свежий
// запрос вытесняет ожидающий, устаревшая задача в полёте обрывается пересозданием воркера;
// уборка не вытесняет прогон действия пользователя; прогрев.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({ list: [] as FakeWorker[] }));
type Posted =
  | { kind: "warm" }
  | { kind: "run"; runId: number; input: unknown }
  | { kind: "seed"; entries: [string, unknown][] };
interface FakeWorker {
  posted: Posted[];
  terminated: boolean;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onmessageerror: (() => void) | null;
}

vi.mock("../graph/layout/pipeline.worker.ts?worker", () => ({
  default: class {
    posted: Posted[] = [];
    terminated = false;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    constructor() { workers.list.push(this as unknown as FakeWorker); }
    postMessage(msg: Posted) { this.posted.push(msg); }
    terminate() { this.terminated = true; }
  },
}));
vi.mock("../graph/layout/pipeline", () => ({
  computeViewLayout: vi.fn(async () => ({ layout: "главный поток" })),
}));

const input = {} as never;
// Разные по содержимому входы; одинаковые по содержимому — разные объекты.
const scene = (tag: string) => ({ nodes: [{ id: tag }], sizes: new Map([[tag, 1]]) }) as never;

const runsOf = (w: FakeWorker) =>
  w.posted.filter((m): m is Extract<Posted, { kind: "run" }> => m.kind === "run");
/** Ответить на последнюю задачу, отправленную воркеру. */
function reply(w: FakeWorker, out: unknown): void {
  const runs = runsOf(w);
  w.onmessage?.({ data: { runId: runs[runs.length - 1].runId, ok: true, out } });
}
const lastWorker = () => workers.list[workers.list.length - 1];
// Исход обещания без падения теста: значение или ошибка.
const settled = (p: Promise<unknown>) => p.then((v) => ({ v }), (e: unknown) => ({ e }));

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

const load = () => import("../graph/layout/pipelineClient");

describe("computeViewLayoutOffThread: сторож и деградации", () => {
  it("зависший прогон отклоняется сторожем, воркер пересоздаётся, очередь уходит в новый", async () => {
    const { computeViewLayoutOffThread, RUN_TIMEOUT_MS } = await load();
    const stuck = computeViewLayoutOffThread(input);
    const queued = computeViewLayoutOffThread(input);
    const stuckErr = stuck.catch((e: unknown) => e);
    const [first] = workers.list;
    expect(runsOf(first)).toHaveLength(1); // одна задача за раз: вторая ждёт в клиенте

    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS);
    expect(await stuckErr).toBeInstanceOf(Error);
    expect(first.terminated).toBe(true);
    const second = workers.list[1];
    expect(second.posted[0]).toEqual({ kind: "warm" }); // свежий воркер прогревается сам
    expect(runsOf(second)).toHaveLength(1); // очередь ушла в свежий воркер

    reply(second, { layout: "воркер" });
    expect(await queued).toEqual({ layout: "воркер" });
  });

  it("ответ не разобрать (onmessageerror) — ожидающее досчитывается на главном потоке", async () => {
    const { computeViewLayoutOffThread } = await load();
    const run = computeViewLayoutOffThread(input);
    workers.list[0].onmessageerror?.();
    expect(await run).toEqual({ layout: "главный поток" });
  });

  it("воркер упал: устаревшая задача отклоняется, нужная досчитывается на главном", async () => {
    const { computeViewLayoutOffThread, LayoutSupersededError } = await load();
    const owner = {};
    const old = settled(computeViewLayoutOffThread(scene("a"), { owner }));
    const fresh = computeViewLayoutOffThread(scene("b"), { owner });
    workers.list[0].onerror?.();
    expect((await old as { e: unknown }).e).toBeInstanceOf(LayoutSupersededError);
    expect(await fresh).toEqual({ layout: "главный поток" });
  });
});

describe("очередь холста-владельца", () => {
  it("без владельца: одна задача за раз, следующая уходит по ответу", async () => {
    const { computeViewLayoutOffThread } = await load();
    const a = computeViewLayoutOffThread(scene("a"));
    const b = computeViewLayoutOffThread(scene("b"));
    const w = workers.list[0];
    expect(runsOf(w)).toHaveLength(1);
    reply(w, "A");
    expect(await a).toBe("A");
    expect(runsOf(w)).toHaveLength(2);
    expect(runsOf(w)[1].input).toEqual(scene("b"));
    reply(w, "B");
    expect(await b).toBe("B");
  });

  it("склейка: структурно равный вход в полёте не считается заново — оба получают один результат", async () => {
    const { computeViewLayoutOffThread } = await load();
    const owner = {};
    const a = computeViewLayoutOffThread(scene("x"), { owner });
    const b = computeViewLayoutOffThread(scene("x"), { owner }); // другой объект, то же содержимое
    const w = workers.list[0];
    expect(runsOf(w)).toHaveLength(1);
    reply(w, "X");
    expect(await a).toBe("X");
    expect(await b).toBe("X");
    expect(runsOf(w)).toHaveLength(1);
  });

  it("разный вход не склеивается: свежий считается после текущего, текущий тоже получает свой результат", async () => {
    const { computeViewLayoutOffThread } = await load();
    const owner = {};
    const a = computeViewLayoutOffThread(scene("x"), { owner });
    const b = computeViewLayoutOffThread(scene("y"), { owner });
    const w = workers.list[0];
    reply(w, "X");
    expect(await a).toBe("X");
    expect(runsOf(w)).toHaveLength(2);
    expect(runsOf(w)[1].input).toEqual(scene("y"));
    reply(w, "Y");
    expect(await b).toBe("Y");
  });

  it("порядок вставки в Map — часть входа: те же пары в другом порядке не склеиваются", async () => {
    const { inputKey } = await load();
    const ab = { sizes: new Map([["a", 1], ["b", 2]]) } as never;
    const ba = { sizes: new Map([["b", 2], ["a", 1]]) } as never;
    expect(inputKey(ab)).not.toBe(inputKey(ba));
    expect(inputKey({ w: Infinity } as never)).not.toBe(inputKey({ w: null } as never));
  });

  it("вытеснение: у холста ждёт одна задача, более свежий запрос вытесняет ожидающий («устарел»)", async () => {
    const { computeViewLayoutOffThread, LayoutSupersededError } = await load();
    const owner = {};
    const x = computeViewLayoutOffThread(scene("x"), { owner });
    const y = settled(computeViewLayoutOffThread(scene("y"), { owner }));
    const z = computeViewLayoutOffThread(scene("z"), { owner });
    expect((await y as { e: unknown }).e).toBeInstanceOf(LayoutSupersededError);
    const w = workers.list[0];
    reply(w, "X");
    await x;
    expect(runsOf(w).map((r) => r.input)).toEqual([scene("x"), scene("z")]);
    reply(w, "Z");
    expect(await z).toBe("Z");
  });

  it("склейка с ожидающей: равный вход ждёт ту же задачу", async () => {
    const { computeViewLayoutOffThread } = await load();
    const owner = {};
    void computeViewLayoutOffThread(scene("x"), { owner });
    const y1 = computeViewLayoutOffThread(scene("y"), { owner });
    const y2 = computeViewLayoutOffThread(scene("y"), { owner });
    const w = workers.list[0];
    reply(w, "X");
    await vi.advanceTimersByTimeAsync(0);
    reply(w, "Y");
    expect(await y1).toBe("Y");
    expect(await y2).toBe("Y");
    expect(runsOf(w)).toHaveLength(2);
  });

  it("запросы разных холстов друг друга не вытесняют", async () => {
    const { computeViewLayoutOffThread } = await load();
    const one = {}, two = {};
    void computeViewLayoutOffThread(scene("x"), { owner: one });
    const y = computeViewLayoutOffThread(scene("y"), { owner: two });
    const z = computeViewLayoutOffThread(scene("z"), { owner: one });
    const w = workers.list[0];
    reply(w, "X");
    await vi.advanceTimersByTimeAsync(0);
    reply(w, "Y");
    expect(await y).toBe("Y");
    reply(w, "Z");
    expect(await z).toBe("Z");
  });
});

describe("обрыв устаревшей задачи", () => {
  it("устаревшая задача, считающаяся дольше порога, обрывается: воркер пересоздан и прогрет, свежая уходит в него", async () => {
    const { computeViewLayoutOffThread, LayoutSupersededError, STALE_KILL_MS } = await load();
    const owner = {};
    const x = settled(computeViewLayoutOffThread(scene("x"), { owner }));
    await vi.advanceTimersByTimeAsync(STALE_KILL_MS + 100);
    const y = computeViewLayoutOffThread(scene("y"), { owner });
    expect((await x as { e: unknown }).e).toBeInstanceOf(LayoutSupersededError);
    const [first, second] = workers.list;
    expect(first.terminated).toBe(true);
    expect(second.posted[0]).toEqual({ kind: "warm" });
    expect(runsOf(second).map((r) => r.input)).toEqual([scene("y")]);
    reply(second, "Y");
    expect(await y).toBe("Y");
  });

  it("свежий воркер после обрыва засевается памятью сцен: авторитетные ответы — да, прочие — нет", async () => {
    const { computeViewLayoutOffThread, STALE_KILL_MS } = await load();
    const owner = {};
    const out = (sig: string, authoritative: boolean) => ({
      routeSig: sig, authoritative,
      layout: { autoRoutes: new Map([[sig, []]]), edgeHandles: new Map(), labelPlacements: new Map() },
    });
    const a = computeViewLayoutOffThread(scene("a"), { owner });
    reply(workers.list[0], out("sig-a", true));
    await a;
    const b = computeViewLayoutOffThread(scene("b"), { owner });
    reply(workers.list[0], out("sig-b", false)); // не авторитетный — в память не шёл
    await b;
    void computeViewLayoutOffThread(scene("c"), { owner }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(STALE_KILL_MS);
    void computeViewLayoutOffThread(scene("d"), { owner });
    const fresh = workers.list[1];
    expect(fresh.posted[0]).toEqual({ kind: "seed", entries: [["sig-a", {
      routes: new Map([["sig-a", []]]), handles: new Map(), labels: new Map(),
    }]] });
    expect(fresh.posted[1]).toEqual({ kind: "warm" });
    expect(runsOf(fresh).map((r) => r.input)).toEqual([scene("d")]);
  });

  it("до порога устаревшая задача досчитывается, если успевает (запасной гасится); не успела — обрывается на пороге, запасной встаёт на её место", async () => {
    const { computeViewLayoutOffThread, LayoutSupersededError, STALE_KILL_MS } = await load();
    const owner = {};
    const x = computeViewLayoutOffThread(scene("x"), { owner });
    await vi.advanceTimersByTimeAsync(100);
    const y = settled(computeViewLayoutOffThread(scene("y"), { owner }));
    // x устарела при ждущей очереди: запасной создан и прогревается заранее
    expect(workers.list).toHaveLength(2);
    expect(workers.list[1].posted).toEqual([{ kind: "warm" }]);
    reply(workers.list[0], "X"); // успела
    expect(await x).toBe("X");
    expect(workers.list[1].terminated).toBe(true); // запасной не понадобился
    expect(workers.list[0].terminated).toBe(false);

    // y в полёте; z её перегоняет сразу, а ответа нет — обрыв ровно на пороге
    const z = computeViewLayoutOffThread(scene("z"), { owner });
    expect(workers.list).toHaveLength(3); // новый запасной
    await vi.advanceTimersByTimeAsync(STALE_KILL_MS - 1);
    expect(workers.list[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers.list[0].terminated).toBe(true);
    expect((await y as { e: unknown }).e).toBeInstanceOf(LayoutSupersededError);
    expect(workers.list).toHaveLength(3); // при обрыве воркер не создаётся: встал запасной
    expect(runsOf(workers.list[2]).map((r) => r.input)).toEqual([scene("z")]);
    reply(workers.list[2], "Z");
    expect(await z).toBe("Z");
  });

  it("сбой запасного гасит только его: действующий считает дальше", async () => {
    const { computeViewLayoutOffThread } = await load();
    const owner = {};
    const x = computeViewLayoutOffThread(scene("x"), { owner });
    const y = computeViewLayoutOffThread(scene("y"), { owner });
    workers.list[1].onerror?.();
    expect(workers.list[1].terminated).toBe(true);
    expect(workers.list[0].terminated).toBe(false);
    reply(workers.list[0], "X");
    expect(await x).toBe("X");
    reply(workers.list[0], "Y");
    expect(await y).toBe("Y");
  });

  it("устаревшую задачу без ждущих в очереди не обрывают: память сцен воркера дороже", async () => {
    const { computeViewLayoutOffThread, releaseLayoutOwner, STALE_KILL_MS } = await load();
    const owner = {};
    const x = computeViewLayoutOffThread(scene("x"), { owner });
    releaseLayoutOwner(owner); // холст ушёл, но очередь пуста
    await vi.advanceTimersByTimeAsync(STALE_KILL_MS * 5);
    expect(workers.list[0].terminated).toBe(false);
    reply(workers.list[0], "X");
    expect(await x).toBe("X");
  });

  it("холст ушёл, следующий холст ждёт: задача ушедшего обрывается после порога", async () => {
    const { computeViewLayoutOffThread, releaseLayoutOwner, LayoutSupersededError, STALE_KILL_MS } = await load();
    const gone = {}, next = {};
    const x = settled(computeViewLayoutOffThread(scene("x"), { owner: gone }));
    await vi.advanceTimersByTimeAsync(STALE_KILL_MS);
    releaseLayoutOwner(gone);
    const y = computeViewLayoutOffThread(scene("y"), { owner: next });
    expect((await x as { e: unknown }).e).toBeInstanceOf(LayoutSupersededError);
    expect(runsOf(lastWorker()).map((r) => r.input)).toEqual([scene("y")]);
    reply(lastWorker(), "Y");
    expect(await y).toBe("Y");
  });

  it("обрывов подряд не больше предела: поток запросов чаще прогона не морит очередь голодом", async () => {
    const { computeViewLayoutOffThread, STALE_KILL_MS, STALE_KILL_STREAK_MAX } = await load();
    const owner = {};
    void computeViewLayoutOffThread(scene("s0"), { owner }).catch(() => undefined);
    for (let i = 1; i <= STALE_KILL_STREAK_MAX + 1; i++) {
      await vi.advanceTimersByTimeAsync(STALE_KILL_MS);
      void computeViewLayoutOffThread(scene(`s${i}`), { owner }).catch(() => undefined);
    }
    expect(workers.list).toHaveLength(1 + STALE_KILL_STREAK_MAX); // третий обрыв не случился
    // досчитанный прогон сбрасывает счётчик: следующий обрыв снова возможен
    reply(lastWorker(), "done");
    await vi.advanceTimersByTimeAsync(STALE_KILL_MS);
    void computeViewLayoutOffThread(scene("again"), { owner }).catch(() => undefined);
    expect(workers.list).toHaveLength(2 + STALE_KILL_STREAK_MAX);
  });
});

describe("уборка (фоновый прогон) и прогон действия", () => {
  it("уборка не вытесняет прогон действия: отклоняется, прогон действия считается дальше", async () => {
    const { computeViewLayoutOffThread, LayoutSupersededError, STALE_KILL_MS } = await load();
    const owner = {};
    const user = computeViewLayoutOffThread(scene("user"), { owner });
    await vi.advanceTimersByTimeAsync(STALE_KILL_MS * 2);
    const clean = settled(computeViewLayoutOffThread(scene("clean"), { owner, background: true }));
    expect((await clean as { e: unknown }).e).toBeInstanceOf(LayoutSupersededError);
    expect(workers.list).toHaveLength(1);
    reply(workers.list[0], "U");
    expect(await user).toBe("U");
    expect(runsOf(workers.list[0])).toHaveLength(1);
  });

  it("прогон действия вытесняет уборку: устаревшая уборка обрывается после порога", async () => {
    const { computeViewLayoutOffThread, LayoutSupersededError, STALE_KILL_MS } = await load();
    const owner = {};
    const clean = settled(computeViewLayoutOffThread(scene("clean"), { owner, background: true }));
    await vi.advanceTimersByTimeAsync(STALE_KILL_MS);
    const user = computeViewLayoutOffThread(scene("user"), { owner });
    expect((await clean as { e: unknown }).e).toBeInstanceOf(LayoutSupersededError);
    reply(lastWorker(), "U");
    expect(await user).toBe("U");
  });
});

describe("прогрев", () => {
  it("создаёт воркер и шлёт ему прогрев один раз; первый прогон уходит тому же воркеру", async () => {
    const { computeViewLayoutOffThread, warmLayoutWorker } = await load();
    warmLayoutWorker();
    warmLayoutWorker();
    expect(workers.list).toHaveLength(1);
    expect(workers.list[0].posted).toEqual([{ kind: "warm" }]);
    const run = computeViewLayoutOffThread(input);
    expect(runsOf(workers.list[0])).toHaveLength(1);
    reply(workers.list[0], "R");
    expect(await run).toBe("R");
  });

  it("без Worker прогрев ничего не делает, прогон идёт на главном потоке", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("Worker", undefined);
    const { computeViewLayoutOffThread, warmLayoutWorker } = await load();
    warmLayoutWorker();
    expect(workers.list).toHaveLength(0);
    expect(await computeViewLayoutOffThread(input)).toEqual({ layout: "главный поток" });
  });
});
