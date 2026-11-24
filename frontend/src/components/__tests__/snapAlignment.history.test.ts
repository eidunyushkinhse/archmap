// Связка «жест → команда истории» у перемещений (history.md U5, U23): отпускание драга
// и клавиатурная серия пишут позицию через канал раскладки и кладут ОДНУ команду, чьи
// undo/redo переигрывают commitLayout со старой и новой абсолютной позицией. Раньше это
// держалось только кодом (известное ограничение history.md) — страховка перед правкой
// канала (задание П2). Роли хук не знает (с задания П2): пишет ли канал на сервер или
// кладёт слой читателя, решает useLevelPersistence. Хук настоящий, канал и история — vi.fn.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Node as RFNode } from "@xyflow/react";
import { useSnapAlignment } from "../graph/interaction/useSnapAlignment";
import type { HistoryCommand } from "../graph/interaction/useHistory";

const block = (id: string, x: number, y: number): RFNode => ({ id, type: "block", position: { x, y }, data: {} });

function setup(rfNodes: RFNode[], over: { disabled?: boolean } = {}) {
  const commitLayout = vi.fn((_items: Record<string, { x: number; y: number }>) => true);
  const push = vi.fn((_cmd: HistoryCommand) => {});
  const onNodesChange = vi.fn();
  const { result } = renderHook(() => useSnapAlignment({
    rfNodes, onNodesChange, setGuides: vi.fn(),
    disabled: over.disabled ?? false, ancestorIds: [], ancestorNames: [], commitLayout, push,
  }));
  return { result, commitLayout, push };
}

describe("useSnapAlignment: перемещение — одна команда истории", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("драг одного узла: запись новой позиции и команда «Перемещение» со старой и новой", () => {
    const a = block("a", 0, 0);
    const { result, commitLayout, push } = setup([a]);
    act(() => { result.current.noteDragStart([a]); });
    const moved = { ...a, position: { x: 120, y: 40 } };
    let wrote = false;
    act(() => { wrote = result.current.handleNodeDragStop(null, moved, [moved]); });
    expect(wrote).toBe(true);
    expect(commitLayout).toHaveBeenCalledWith({ a: { x: 120, y: 40 } });
    expect(push).toHaveBeenCalledOnce();
    const cmd = push.mock.calls[0][0];
    expect(cmd.label).toBe("Перемещение");
    commitLayout.mockClear();
    cmd.undo();
    expect(commitLayout).toHaveBeenLastCalledWith({ a: { x: 0, y: 0 } });
    cmd.redo();
    expect(commitLayout).toHaveBeenLastCalledWith({ a: { x: 120, y: 40 } });
  });

  it("групповой драг — одна команда «Перемещение группы» на весь жест", () => {
    const a = block("a", 0, 0);
    const b = block("b", 400, 0);
    const { result, commitLayout, push } = setup([a, b]);
    act(() => { result.current.noteDragStart([a, b]); });
    const ma = { ...a, position: { x: 50, y: 60 } };
    const mb = { ...b, position: { x: 450, y: 60 } };
    act(() => { result.current.handleSelectionDragStop(null, [ma, mb]); });
    expect(commitLayout).toHaveBeenCalledWith({ a: { x: 50, y: 60 }, b: { x: 450, y: 60 } });
    expect(push).toHaveBeenCalledOnce();
    const cmd = push.mock.calls[0][0];
    expect(cmd.label).toBe("Перемещение группы");
    cmd.undo();
    expect(commitLayout).toHaveBeenLastCalledWith({ a: { x: 0, y: 0 }, b: { x: 400, y: 0 } });
  });

  it("жест без сдвига команды не кладёт", () => {
    const a = block("a", 10, 10);
    const { result, push } = setup([a]);
    act(() => { result.current.noteDragStart([a]); });
    act(() => { result.current.handleNodeDragStop(null, a, [a]); });
    expect(push).not.toHaveBeenCalled();
  });

  it("клавиатурная серия: один батч и одна команда по паузе KB_FLUSH_MS", () => {
    const a = block("a", 0, 0);
    const { result, commitLayout, push } = setup([a]);
    act(() => { result.current.handleNodesChange([{ id: "a", type: "position", position: { x: 5, y: 0 } }]); });
    expect(commitLayout).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); });
    expect(commitLayout).toHaveBeenCalledWith({ a: { x: 5, y: 0 } });
    expect(push).toHaveBeenCalledOnce();
    const cmd = push.mock.calls[0][0];
    expect(cmd.label).toBe("Перемещение");
    cmd.undo();
    expect(commitLayout).toHaveBeenLastCalledWith({ a: { x: 0, y: 0 } });
  });

  it("расстановка выключена (disabled): ни записи, ни команды", () => {
    const a = block("a", 0, 0);
    const { result, commitLayout, push } = setup([a], { disabled: true });
    act(() => { result.current.noteDragStart([a]); });
    const moved = { ...a, position: { x: 120, y: 40 } };
    act(() => { result.current.handleNodeDragStop(null, moved, [moved]); });
    expect(commitLayout).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
