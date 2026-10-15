// Подтверждение «Переразложить уровень»: сброс уходит на бэк для своего уровня;
// успех зовёт onDone, и кнопка остаётся занятой, пока родитель закрывает окно;
// отказ показывается в окне, и можно повторить.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import RelayoutConfirm from "../RelayoutConfirm";
import { nodesApi } from "../../api/nodes";

vi.mock("../../api/nodes", () => ({ nodesApi: { relayoutLevel: vi.fn() } }));
// Нативный <dialog> в jsdom не открывается — прозрачная обёртка (паттерн соседних тестов).
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RelayoutConfirm", () => {
  it("заголовок называет уровень; успех — сброс своего уровня, onDone и занятая кнопка", async () => {
    vi.mocked(nodesApi.relayoutLevel).mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<RelayoutConfirm containerId="n1" levelName="Ярмарка" onCancel={vi.fn()} onDone={onDone} />);
    expect(screen.getByText("Переразложить уровень «Ярмарка»?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Да, переразложить" }));
    expect(nodesApi.relayoutLevel).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Сброс..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
  });

  it("корень схемы: containerId null; отказ — текст в окне, onDone не зовётся, можно повторить", async () => {
    vi.mocked(nodesApi.relayoutLevel).mockRejectedValue(new Error("Нет связи"));
    const onDone = vi.fn();
    render(<RelayoutConfirm containerId={null} onCancel={vi.fn()} onDone={onDone} />);
    expect(screen.getByText("Переразложить уровень корневой схемы?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Да, переразложить" }));
    expect(nodesApi.relayoutLevel).toHaveBeenCalledWith(null);
    expect(await screen.findByText("Нет связи")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Да, переразложить" })).toBeEnabled();
  });
});
