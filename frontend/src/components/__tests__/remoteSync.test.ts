import { describe, it, expect, vi } from "vitest";
import { createRemoteSyncTick } from "../../pages/useRemoteSync";

// Ядро тика поллинга (этап 1 конкурентности, view.md V52): сверка graph_rev с
// известным курсором; рефетч — только при росте; гарды и inflight-замок.

function makeDeps(over: Partial<Parameters<typeof createRemoteSyncTick>[0]> = {}) {
  const onRemoteChange = vi.fn();
  const deps = {
    fetchState: () => Promise.resolve({ graph_rev: 0 }),
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
      fetchState: () => Promise.resolve({ graph_rev: 5 }),
      knownRev: () => 3,
    });
    const tick = createRemoteSyncTick(deps);
    expect(await tick()).toBe("refetch");
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it("курсор совпал → quiet (echo-suppression: свои записи уже обновили known)", async () => {
    const { deps, onRemoteChange } = makeDeps({
      fetchState: () => Promise.resolve({ graph_rev: 7 }),
      knownRev: () => 7,
    });
    expect(await createRemoteSyncTick(deps)()).toBe("quiet");
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("гард (жест/модалка/hidden) → skipped, запрос НЕ уходит", async () => {
    const fetchState = vi.fn(() => Promise.resolve({ graph_rev: 99 }));
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
    let release!: (v: { graph_rev: number }) => void;
    const first = new Promise<{ graph_rev: number }>((r) => { release = r; });
    let call = 0;
    const { deps } = makeDeps({
      fetchState: () => (call++ === 0 ? first : Promise.resolve({ graph_rev: 0 })),
    });
    const tick = createRemoteSyncTick(deps);
    const p1 = tick(); // висит на медленной сети
    expect(await tick()).toBe("skipped"); // второй тик не накладывается
    release({ graph_rev: 0 });
    expect(await p1).toBe("quiet");
    expect(await tick()).toBe("quiet"); // замок снят
  });
});
