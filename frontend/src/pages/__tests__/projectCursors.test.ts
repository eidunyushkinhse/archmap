// Курсоры проекта из обычного опроса (находка 6, 2026-11-24): pollViewState отдаёт курсоры
// ответа GET /views/{id}/state слушателям, useProjectCursorMove зовёт колбэк, когда они
// сдвинулись с прошлого замера. Своего таймера нет: опрашивают страницы (useRemoteSync).
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollViewState, useProjectCursorMove } from "../projectCursors";
import { POLL_MS, useRemoteSync } from "../useRemoteSync";
import { viewsApi } from "../../api/nodes";

vi.mock("../../api/nodes", () => ({ viewsApi: { state: vi.fn() } }));

const state = (graph_rev: number, meta_rev: number, process_rev = 0) => ({ version: 0, graph_rev, meta_rev, process_rev });

describe("useProjectCursorMove", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("первый замер запоминается, сдвиг любого курсора зовёт колбэк, тот же — нет", async () => {
    const onMove = vi.fn();
    const { unmount } = renderHook(() => useProjectCursorMove(onMove));
    for (const [s, calls] of [
      [state(5, 7), 0], // первый замер
      [state(5, 7), 0], // покой
      [state(5, 8), 1], // мета: сигнал CI, снятие напоминания, чужая правка документации
      [state(6, 8), 2], // схема
      [state(6, 8, 1), 3], // процессы
      [state(6, 8, 1), 3],
    ] as const) {
      vi.mocked(viewsApi.state).mockResolvedValueOnce(s);
      await act(() => pollViewState(null));
      expect(onMove).toHaveBeenCalledTimes(calls);
    }
    unmount();
    vi.mocked(viewsApi.state).mockResolvedValueOnce(state(9, 9));
    await pollViewState(null);
    expect(onMove).toHaveBeenCalledTimes(3);
  });

  it("свежий колбэк: зовётся последний из переданных", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useProjectCursorMove(cb), { initialProps: { cb: first } });
    vi.mocked(viewsApi.state).mockResolvedValueOnce(state(1, 1));
    await act(() => pollViewState(null));
    rerender({ cb: second });
    vi.mocked(viewsApi.state).mockResolvedValueOnce(state(1, 2));
    await act(() => pollViewState(null));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("опрос страницы отдаёт курсоры оболочке", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("тик useRemoteSync — тот же запрос, без лишних: сдвиг меты виден слушателю", async () => {
    const onMove = vi.fn();
    renderHook(() => useProjectCursorMove(onMove));
    vi.mocked(viewsApi.state).mockResolvedValue(state(3, 4));
    renderHook(() => useRemoteSync({
      currentParentId: null,
      viewMeta: { current: { version: 0, graphRev: 3, metaRev: 4 } },
      gestureActiveRef: { current: false },
      onRemoteChange: vi.fn(),
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    vi.mocked(viewsApi.state).mockResolvedValue(state(3, 5));
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(viewsApi.state).toHaveBeenCalledTimes(2);
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});
