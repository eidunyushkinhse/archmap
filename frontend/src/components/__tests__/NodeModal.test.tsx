// Окно «Новый объект»: подтверждение клавишей Enter — то же, что кнопка «Создать»
// (ui/Modal.onSubmit): пустое название даёт ту же подсказку, что и кнопка, и запроса нет.
// События тура из этого окна — NodeModal.tourEvents.test.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeModal from "../NodeModal";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { create: vi.fn() },
  viewsApi: { saveLayout: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

// Поле «Название» — первое в окне.
const nameField = () => document.querySelector<HTMLInputElement>("dialog input")!;

describe("NodeModal — подтверждение по Enter", () => {
  it("Enter в поле «Название» создаёт объект, как кнопка", async () => {
    vi.mocked(nodesApi.create).mockResolvedValue({ id: "c1", name: "Склад", shape: "service", parent_id: null } as Node);
    const onSaved = vi.fn();
    render(<NodeModal parentId={null} shape="service" onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(nameField(), { target: { value: "Склад" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(nodesApi.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Склад", shape: "service" }));
  });

  it("Enter при пустом названии — подсказка, запроса нет", () => {
    render(<NodeModal parentId={null} shape="service" onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.keyDown(nameField(), { key: "Enter" });

    expect(screen.getByText("Название обязательно")).toBeInTheDocument();
    expect(nodesApi.create).not.toHaveBeenCalled();
  });
});
