// ПЕРСИСТНЫЙ КЭШ МАРШРУТОВ ВИДА — хранилище (Ф2 эпика router-opt, спека perf.md P11,
// пункт ревью 3.4 «LRU/квота/версия формата»). Здесь проверяется САМО хранилище:
// политика записи живёт в LevelGraph (routeCache.integration.test.tsx), а равенство
// «кэш = полный прогон» — в pipeline.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LocalStorageRouteCache, viewCacheKey, toCacheEntry, fromCacheEntry,
  MAX_ENTRIES, MAX_TOTAL_BYTES, FORMAT_VERSION, type RouteCacheEntry,
} from "../graph/layout/routeCacheStore";
import { ROUTER_VERSION } from "../graph/layout/routerVersion";

const PREFIX = "archmap.routeCache:";
const INDEX_KEY = "archmap.routeCache.index";

// Мини-Storage в памяти: квота — суммарные байты (throwAt = 0 → без ограничения),
// broken — «хранилище отвалилось» (приватный режим/политика браузера).
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  private limit: number;
  private broken: boolean;
  constructor(limit = 0, broken = false) {
    this.limit = limit;
    this.broken = broken;
  }
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null {
    if (this.broken) throw new Error("storage disabled");
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.broken) throw new Error("storage disabled");
    if (this.limit > 0) {
      let total = v.length;
      for (const [kk, vv] of this.map) if (kk !== k) total += vv.length;
      if (total > this.limit) {
        const e = new Error("quota") as Error & { name: string };
        e.name = "QuotaExceededError";
        throw e;
      }
    }
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    if (this.broken) throw new Error("storage disabled");
    this.map.delete(k);
  }
  clear(): void { this.map.clear(); }
  /** Ключи записей кэша (без реестра) — для ассертов вытеснения. */
  cacheKeys(): string[] {
    return [...this.map.keys()].filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
  }
  raw(k: string): string | undefined { return this.map.get(k); }
  put(k: string, v: string): void { this.map.set(k, v); }
}

// Запись заданного размера: вес несёт sig (строка) — так тест не строит сотни тысяч
// точек ради проверки байтовой крышки.
function entry(sig: string, at: number, padBytes = 0): RouteCacheEntry {
  return toCacheEntry(
    sig + "x".repeat(padBytes),
    new Map([["e1", [{ x: 0, y: 0 }, { x: 40, y: 0 }]]]),
    new Map([["e1", { sourceHandle: "right-1", targetHandle: "left-1" }]]),
    new Map([["e1", {
      mode: "online" as const,
      center: { x: 20, y: 0 }, anchor: { x: 20, y: 0 }, leaderEnd: { x: 20, y: 0 },
    }]]),
    at,
  );
}

let store: LocalStorageRouteCache;
let fake: FakeStorage;

function useStorage(s: FakeStorage): void {
  fake = s;
  vi.stubGlobal("localStorage", s);
  store = new LocalStorageRouteCache();
}

beforeEach(() => { useStorage(new FakeStorage()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ключ вида", () => {
  it("различает проект, уровень и ПОВЕРХНОСТЬ (карта против контекст-схемы страницы)", () => {
    // карта корня, карта уровня X, страница объекта X (containerId = его parent)
    const mapRoot = viewCacheKey("P", null, undefined);
    const mapLevelX = viewCacheKey("P", "X", undefined);
    const pageX = viewCacheKey("P", "PARENT", "X");
    expect(new Set([mapRoot, mapLevelX, pageX]).size).toBe(3);
    // страница объекта X и карта уровня X НЕ схлопываются в один ключ
    expect(pageX).not.toBe(mapLevelX);
    // разные проекты — разные ключи; отсутствие проекта не роняет ключ
    expect(viewCacheKey("Q", null, undefined)).not.toBe(mapRoot);
    expect(viewCacheKey(null, null, undefined)).toContain("__root__");
  });
});

describe("круг записи и чтения", () => {
  it("сохранённая запись читается и разворачивается в Map'ы конвейера", () => {
    store.save("k", entry("s1", 10));
    const got = store.load("k");
    expect(got).not.toBeNull();
    const view = fromCacheEntry(got!);
    expect(view.sig).toBe("s1");
    expect(view.routes.get("e1")).toEqual([{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    expect(view.handles.get("e1")).toEqual({ sourceHandle: "right-1", targetHandle: "left-1" });
    expect(view.labels.get("e1")?.mode).toBe("online");
  });

  it("отсутствующий ключ — null, без побочных записей", () => {
    expect(store.load("нет-такого")).toBeNull();
    expect(fake.cacheKeys()).toEqual([]);
  });

  it("ДЕДУП ПО SIG: повторная запись той же сцены не переписывает хранилище", () => {
    store.save("k", entry("s1", 10));
    const before = fake.raw(PREFIX + "k");
    // тот же sig, но другие маршруты и другое время — запись пропускается целиком
    const dup = toCacheEntry("s1", new Map([["e1", [{ x: 9, y: 9 }, { x: 99, y: 9 }]]]),
      new Map(), new Map(), 999);
    store.save("k", dup);
    expect(fake.raw(PREFIX + "k")).toBe(before);
    // другая сцена (другой sig) — запись проходит
    store.save("k", entry("s2", 20));
    expect(store.load("k")?.sig).toBe("s2");
  });
});

describe("версия роутера и формата", () => {
  it("чужая ROUTER_VERSION отвергается И удаляется из хранилища", () => {
    store.save("k", entry("s1", 10));
    const raw = JSON.parse(fake.raw(PREFIX + "k")!) as RouteCacheEntry;
    fake.put(PREFIX + "k", JSON.stringify({ ...raw, v: ROUTER_VERSION + 7 }));
    expect(store.load("k")).toBeNull();
    expect(fake.cacheKeys()).not.toContain("k");
    expect(JSON.parse(fake.raw(INDEX_KEY) ?? "[]")).toEqual([]);
  });

  it("чужая версия ФОРМАТА отвергается и удаляется", () => {
    store.save("k", entry("s1", 10));
    const raw = JSON.parse(fake.raw(PREFIX + "k")!) as RouteCacheEntry;
    fake.put(PREFIX + "k", JSON.stringify({ ...raw, fmt: FORMAT_VERSION + 1 }));
    expect(store.load("k")).toBeNull();
    expect(fake.cacheKeys()).not.toContain("k");
  });

  it("битый JSON не роняет чтение — запись выбрасывается", () => {
    fake.put(PREFIX + "k", "{это не json");
    expect(store.load("k")).toBeNull();
    expect(fake.cacheKeys()).not.toContain("k");
  });
});

describe("LRU и крышки", () => {
  it("крышка по КОЛИЧЕСТВУ: старейшая запись вытесняется", () => {
    for (let i = 0; i <= MAX_ENTRIES; i++) store.save(`k${i}`, entry(`s${i}`, i + 1));
    const keys = fake.cacheKeys();
    expect(keys.length).toBe(MAX_ENTRIES);
    expect(keys).not.toContain("k0");                    // старейшая ушла
    expect(keys).toContain(`k${MAX_ENTRIES}`);           // свежайшая на месте
    expect((JSON.parse(fake.raw(INDEX_KEY)!) as unknown[]).length).toBe(MAX_ENTRIES);
  });

  it("крышка по БАЙТАМ: суммарный объём держится под потолком", () => {
    const big = Math.round(MAX_TOTAL_BYTES * 0.4); // три такие не влезут
    store.save("k1", entry("s1", 1, big));
    store.save("k2", entry("s2", 2, big));
    store.save("k3", entry("s3", 3, big));
    const keys = fake.cacheKeys();
    expect(keys.length).toBe(2);
    expect(keys).not.toContain("k1");
    const idx = JSON.parse(fake.raw(INDEX_KEY)!) as { bytes: number }[];
    expect(idx.reduce((s, r) => s + r.bytes, 0)).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  it("LRU по ОБРАЩЕНИЮ: прочитанная запись переживает вытеснение", () => {
    const big = Math.round(MAX_TOTAL_BYTES * 0.4);
    store.save("k1", entry("s1", 1, big));
    store.save("k2", entry("s2", 2, big));
    expect(store.load("k1")).not.toBeNull();  // k1 «использована» — она свежее k2
    store.save("k3", entry("s3", 3, big));
    const keys = fake.cacheKeys();
    expect(keys).toContain("k1");
    expect(keys).toContain("k3");
    expect(keys).not.toContain("k2");
  });
});

describe("деградации хранилища", () => {
  it("QuotaExceededError: вытесняем старейшую чужую запись и повторяем ОДИН раз", () => {
    useStorage(new FakeStorage(2400));
    store.save("k1", entry("s1", 1, 1000));
    expect(fake.cacheKeys()).toEqual(["k1"]);
    // вторая запись в лимит не влезает: срабатывает ретрай после вытеснения k1
    store.save("k2", entry("s2", 2, 1000));
    expect(fake.cacheKeys()).toEqual(["k2"]);
    expect(store.load("k2")?.sig.startsWith("s2")).toBe(true);
  });

  it("localStorage НЕТ (приватный режим): load — null, save — no-op без исключений", () => {
    vi.stubGlobal("localStorage", undefined);
    const s = new LocalStorageRouteCache();
    expect(() => s.save("k", entry("s1", 1))).not.toThrow();
    expect(s.load("k")).toBeNull();
  });

  it("хранилище бросает на КАЖДОЙ операции: тихая деградация и ровно один console.warn", async () => {
    vi.resetModules(); // свежий модуль — сбросить «уже предупреждали»
    vi.stubGlobal("localStorage", new FakeStorage(0, true));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../graph/layout/routeCacheStore");
    const s = new mod.LocalStorageRouteCache();
    expect(() => s.save("k", entry("s1", 1))).not.toThrow();
    expect(() => s.save("k2", entry("s2", 2))).not.toThrow();
    expect(s.load("k")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
