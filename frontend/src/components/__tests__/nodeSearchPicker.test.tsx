// Поиск узла для конца связи (NodeSearchPicker): ответ устаревшего запроса не
// перетирает результаты свежего (аудит F-53 — очистка эффекта снимала только таймер).
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import NodeSearchPicker from "../NodeSearchPicker";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({ nodesApi: { search: vi.fn() } }));

const node = (id: string, name: string): Node =>
  ({ id, name, role: null, shape: "service", has_children: false }) as Node;

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("NodeSearchPicker", () => {
  it("поздний ответ прежнего запроса результаты свежего не перетирает", async () => {
    let ответПрежнего: (ns: Node[]) => void = () => {};
    vi.mocked(nodesApi.search)
      .mockImplementationOnce(() => new Promise((r) => { ответПрежнего = r; }))
      .mockResolvedValueOnce([node("n2", "Заказы")]);
    render(<NodeSearchPicker value="" onChange={vi.fn()} />);
    const поле = screen.getByPlaceholderText("Поиск по имени...");

    fireEvent.change(поле, { target: { value: "Зак" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // ушёл первый запрос
    fireEvent.change(поле, { target: { value: "Заказы" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // второй ответил сразу
    expect(screen.getByText("Заказы")).toBeInTheDocument();

    await act(async () => { ответПрежнего([node("n1", "Заказчик")]); });
    expect(screen.getByText("Заказы")).toBeInTheDocument();
    expect(screen.queryByText("Заказчик")).toBeNull();
  });
});
