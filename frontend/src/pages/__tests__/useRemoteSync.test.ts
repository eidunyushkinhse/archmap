// Поведенческие тесты хука useRemoteSync (обёртка над чистым ядром тика):
// поллинг по интервалу POLL_MS, немедленная сверка по фокусу окна, гарды
// (жест драга, открытая модалка <dialog open>, фоновая вкладка), латест-колбэк,
// перезапуск эффекта при смене уровня и снятие интервала при unmount.
// Ядро (createRemoteSyncTick) покрыто отдельно в components/__tests__/remoteSync.test.ts.
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRemoteSync, POLL_MS } from "../useRemoteSync";
import { viewsApi } from "../../api/nodes";

vi.mock("../../api/nodes", () => ({ viewsApi: { state: vi.fn() } }));

// Ссылка на курсоры версии (как useRef<ViewMetaState> в хозяине).
function makeViewMeta(graphRev = 0, metaRev?: number) {
  return { current: { version: 0, graphRev, metaRev } };
}

describe("useRemoteSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 0, graph_rev: 0, meta_rev: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(over: {
    currentParentId?: string | null;
    viewMeta?: { current: { version: number; graphRev: number; metaRev?: number } };
    gestureActiveRef?: { current: boolean };
    onRemoteChange?: () => void;
    onMetaChange?: (rev: number) => void;
  } = {}) {
    const onRemoteChange = over.onRemoteChange ?? vi.fn();
    const gestureActiveRef = over.gestureActiveRef ?? { current: false };
    const viewMeta = over.viewMeta ?? makeViewMeta();
    const utils = renderHook(
      ({ pid }: { pid: string | null }) =>
        useRemoteSync({
          currentParentId: pid,
          viewMeta,
          gestureActiveRef,
          onRemoteChange,
          onMetaChange: over.onMetaChange,
        }),
      { initialProps: { pid: over.currentParentId ?? null } },
    );
    return { ...utils, onRemoteChange, gestureActiveRef, viewMeta };
  }

  // Продвинуть таймеры и слить микрозадачи (тик внутри — async).
  async function tick(ms = POLL_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("поллит по интервалу: курсор вырос → onRemoteChange", async () => {
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 0, graph_rev: 5, meta_rev: 0 });
    const { onRemoteChange } = setup({ viewMeta: makeViewMeta(0) });
    await tick();
    expect(viewsApi.state).toHaveBeenCalled();
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it("курсор не вырос → запрос уходит, но onRemoteChange молчит", async () => {
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 0, graph_rev: 3, meta_rev: 0 });
    const { onRemoteChange } = setup({ viewMeta: makeViewMeta(3) });
    await tick();
    expect(viewsApi.state).toHaveBeenCalled();
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("фокус окна сверяет немедленно (без ожидания интервала)", async () => {
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 0, graph_rev: 9, meta_rev: 0 });
    const { onRemoteChange } = setup();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(viewsApi.state).toHaveBeenCalledTimes(1);
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it("гард: активен жест драга → запрос не уходит", async () => {
    setup({ gestureActiveRef: { current: true } });
    await tick();
    expect(viewsApi.state).not.toHaveBeenCalled();
  });

  it("гард: открытая модалка <dialog open> → запрос не уходит", async () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    try {
      setup();
      await tick();
      expect(viewsApi.state).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it("гард: фоновая вкладка (document.hidden) → запрос не уходит", async () => {
    // document.hidden — геттер на прототипе; ставим собственное теневое значение
    // и снимаем его удалением (иначе прототипный геттер не восстановить).
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      setup();
      await tick();
      expect(viewsApi.state).not.toHaveBeenCalled();
    } finally {
      delete (document as { hidden?: unknown }).hidden;
    }
  });

  it("рост meta_rev дёргает onMetaChange (схема-колбэк молчит)", async () => {
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 0, graph_rev: 0, meta_rev: 7 });
    const onMetaChange = vi.fn();
    const { onRemoteChange } = setup({ viewMeta: makeViewMeta(0, 2), onMetaChange });
    await tick();
    expect(onMetaChange).toHaveBeenCalledWith(7);
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("латест-колбэк: после rerender тик зовёт свежий onRemoteChange", async () => {
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 0, graph_rev: 5, meta_rev: 0 });
    const first = vi.fn();
    const second = vi.fn();
    const viewMeta = makeViewMeta(0);
    const gestureActiveRef = { current: false };
    // Перерендер с новым колбэком: effect deps не меняются, обновляется только ref.
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) =>
        useRemoteSync({ currentParentId: null, viewMeta, gestureActiveRef, onRemoteChange: cb }),
      { initialProps: { cb: first } },
    );
    rerender({ cb: second });
    await tick();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("смена уровня перезапускает эффект: запрос уходит с новым currentParentId", async () => {
    const { rerender } = setup({ currentParentId: "a" });
    rerender({ pid: "b" });
    await tick();
    expect(viewsApi.state).toHaveBeenCalledWith("b");
  });

  it("после unmount интервал снят — тики не идут", async () => {
    const { unmount } = setup();
    unmount();
    await tick(POLL_MS * 3);
    expect(viewsApi.state).not.toHaveBeenCalled();
  });
});
