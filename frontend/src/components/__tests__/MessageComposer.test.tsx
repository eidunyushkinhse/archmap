// Достраивание связи из композитора процессов.
//
// Находка приёмки 2026-08-08: кнопка «достроить схему» создавала связь безымянной,
// без технологии и всегда синхронной, после чего за правкой приходилось уходить в
// редактор-карту — из того самого процесса, ради которого всё и затевалось.
// Тест держит контракт: что ввели в окне, то и уехало в edgesApi.create.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MessageComposer from "../MessageComposer";
import { edgesApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";
import type { ProcessParticipant } from "../../types";

vi.mock("../../api/nodes", () => ({ edgesApi: { create: vi.fn(), update: vi.fn() } }));
vi.mock("../../api/processes", () => ({
  processesApi: { channels: vi.fn(), addMessage: vi.fn() },
}));

function participant(nodeId: string, order: number): ProcessParticipant {
  return {
    id: `p-${nodeId}`,
    node_id: nodeId,
    name: nodeId === "buyer" ? "Покупатель" : "Сервис заказов",
    order,
    shape: nodeId === "buyer" ? "person" : "service",
    is_external: false,
    status: "existing",
    role: null,
    technology: null,
  } as ProcessParticipant;
}

function renderComposer() {
  return render(
    <MessageComposer
      processId="proc-1"
      participants={[participant("buyer", 0), participant("orders", 1)]}
      fromNode="buyer"
      toNode="orders"
      defaultOrder={0}
      onClose={vi.fn()}
      onAdded={vi.fn()}
    />,
  );
}

describe("MessageComposer: достраивание связи", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processesApi.channels).mockResolvedValue([]); // связи между парой нет
    vi.mocked(edgesApi.create).mockResolvedValue({ id: "e1" } as never);
  });

  it("отправляет подпись, технологию и тип канала", async () => {
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText(/нет задокументированной связи/i);

    await user.type(screen.getByLabelText("Что передаётся"), "создать заказ");
    await user.type(screen.getByLabelText("Технология"), "REST");
    await user.click(screen.getByRole("button", { name: /асинхронная|асинхр\./i }));
    await user.click(screen.getByRole("button", { name: /Добавить связь в схему/i }));

    await waitFor(() => expect(edgesApi.create).toHaveBeenCalledWith({
      source_id: "buyer",
      target_id: "orders",
      label: "создать заказ",
      technology: "REST",
      is_synchronous: false,
    }));
  });

  it("пустые поля уезжают как null, канал по умолчанию синхронный", async () => {
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText(/нет задокументированной связи/i);

    await user.click(screen.getByRole("button", { name: /Добавить связь в схему/i }));

    await waitFor(() => expect(edgesApi.create).toHaveBeenCalledWith({
      source_id: "buyer",
      target_id: "orders",
      label: null,
      technology: null,
      is_synchronous: true,
    }));
  });

  it("пробелы не превращаются в подпись", async () => {
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText(/нет задокументированной связи/i);

    await user.type(screen.getByLabelText("Что передаётся"), "   ");
    await user.click(screen.getByRole("button", { name: /Добавить связь в схему/i }));

    await waitFor(() => expect(vi.mocked(edgesApi.create).mock.calls[0][0].label).toBeNull());
  });

  it("после создания перечитывает каналы пары", async () => {
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText(/нет задокументированной связи/i);

    await user.click(screen.getByRole("button", { name: /Добавить связь в схему/i }));

    // Первый вызов — загрузка при открытии, второй — после создания связи:
    // плечо должно появиться в списке сразу, не закрывая окно.
    await waitFor(() => expect(processesApi.channels).toHaveBeenCalledTimes(2));
  });
});
