import { describe, it, expect, vi } from "vitest";
import { createRemoteSyncTick } from "../../pages/useRemoteSync";

// Ядро тика поллинга (этап 1 конкурентности, view.md V52): сверка graph_rev с
// известным курсором; рефетч — только при росте; гарды и inflight-замок.
// meta_rev (мета узла) сверяется тем же тиком (2026-08-01): курсор ещё не
// инициализирован (undefined) → тик меты пропускается (базовая точка).

function makeDeps(over: Partial<Parameters<typeof createRemoteSyncTick>[0]> = {}) {
  const onRemoteChange = vi.fn();
  const deps = {
    fetchState: () => Promise.resolve({ graph_rev: 0, meta_rev: 0 }),
    knownRev: () => 0,
    canRefetch: () => true,
    onRemoteChange,
    ...over,
  };
  return { deps, onRemoteChange };
}

describe("createRemoteSyncTick", () => {
  it("курсор вырос → refetch (колбэк дёрнут)", async () => {
    const { deps, onRemoteChange } = makeDeps({
      fetchState: () => Promise.resolve({ graph_rev: 5, meta_rev: 0 }),
      knownRev: () => 3,
    });
    const tick = createRemoteSyncTick(deps);
    expect(await tick()).toBe("refetch");
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it("курсор совпал → quiet (echo-suppression: свои записи уже обновили known)", async () => {
    const { deps, onRemoteChange } = makeDeps({
      fetchState: () => Promise.resolve({ graph_rev: 7, meta_rev: 0 }),
      knownRev: () => 7,
    });
    expect(await createRemoteSyncTick(deps)()).toBe("quiet");
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("гард (жест/модалка/hidden) → skipped, запрос НЕ уходит", async () => {
    const fetchState = vi.fn(() => Promise.resolve({ graph_rev: 99, meta_rev: 0 }));
    const { deps, onRemoteChange } = makeDeps({ fetchState, canRefetch: () => false });
    expect(await createRemoteSyncTick(deps)()).toBe("skipped");
    expect(fetchState).not.toHaveBeenCalled();
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("ошибка сети → error, наружу не бросает, колбэк молчит", async () => {
    const { deps, onRemoteChange } = makeDeps({
      fetchState: () => Promise.reject(new Error("net")),
    });
    expect(await createRemoteSyncTick(deps)()).toBe("error");
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("inflight-замок: наложившийся тик пропускается, после завершения — работает", async () => {
    let release!: (v: { graph_rev: number; meta_rev: number }) => void;
    const first = new Promise<{ graph_rev: number; meta_rev: number }>((r) => { release = r; });
    let call = 0;
    const { deps } = makeDeps({
      fetchState: () => (call++ === 0 ? first : Promise.resolve({ graph_rev: 0, meta_rev: 0 })),
    });
    const tick = createRemoteSyncTick(deps);
    const p1 = tick(); // висит на медленной сети
    expect(await tick()).toBe("skipped"); // второй тик не накладывается
    release({ graph_rev: 0, meta_rev: 0 });
    expect(await p1).toBe("quiet");
    expect(await tick()).toBe("quiet"); // замок снят
  });

  it("meta_rev вырос → onMetaChange (новая ревизия), схема-колбэк молчит", async () => {
    const onMetaChange = vi.fn();
    const { deps, onRemoteChange } = makeDeps({
      fetchState: () => Promise.resolve({ graph_rev: 0, meta_rev: 4 }),
      knownMeta: () => 2,
      onMetaChange,
    });
    expect(await createRemoteSyncTick(deps)()).toBe("refetch");
    expect(onMetaChange).toHaveBeenCalledWith(4);
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("meta-курсор не инициализирован (undefined) → базовая точка, колбэк меты молчит", async () => {
    const onMetaChange = vi.fn();
    const { deps } = makeDeps({
      fetchState: () => Promise.resolve({ graph_rev: 0, meta_rev: 9 }),
      knownMeta: () => undefined,
      onMetaChange,
    });
    expect(await createRemoteSyncTick(deps)()).toBe("quiet");
    expect(onMetaChange).not.toHaveBeenCalled();
  });

  it("выросли оба курсора → оба колбэка за один тик", async () => {
    const onMetaChange = vi.fn();
    const { deps, onRemoteChange } = makeDeps({
      fetchState: () => Promise.resolve({ graph_rev: 6, meta_rev: 3 }),
      knownRev: () => 5,
      knownMeta: () => 2,
      onMetaChange,
    });
    expect(await createRemoteSyncTick(deps)()).toBe("refetch");
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(onMetaChange).toHaveBeenCalledWith(3);
  });
});
