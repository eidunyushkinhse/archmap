// Достраивание связи из композитора процессов.
//
// Находка приёмки 2026-08-08: кнопка «достроить схему» создавала связь безымянной,
// без технологии и всегда синхронной, после чего за правкой приходилось уходить в
// редактор-карту — из того самого процесса, ради которого всё и затевалось.
// Тест держит контракт: что ввели в окне, то и уехало в edgesApi.create.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MessageComposer from "../MessageComposer";
import { edgesApi } from "../../api/nodes";
import { processesApi } from "../../api/processes";
import { ApiError } from "../../api/client";
import type { Channel, ProcessParticipant } from "../../types";

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

function renderComposer(over: { onClose?: () => void; onAdded?: () => void } = {}) {
  return render(
    <MessageComposer
      processId="proc-1"
      participants={[participant("buyer", 0), participant("orders", 1)]}
      fromNode="buyer"
      toNode="orders"
      defaultOrder={0}
      onClose={over.onClose ?? vi.fn()}
      onAdded={over.onAdded ?? vi.fn()}
    />,
  );
}

// Кнопки окна с текстом в порядке разметки (значки-кнопки без текста не считаются).
const textButtons = (root: HTMLElement) =>
  within(root).getAllByRole("button").map((b) => b.textContent?.trim() ?? "").filter(Boolean);

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

// Связь между парой есть (страховочная сетка перевода окна на новый язык, фаза 13г): шаг
// берётся из её плеч, «Добавить шаг» заперта до выбора, выбранное плечо уходит в addMessage;
// тип связи меняется прямо в шапке связи и сразу пишется; кнопки окна — главная, за ней
// «Отмена».
const CHANNEL: Channel = {
  edge_id: "e1", source_id: "buyer", target_id: "orders", technology: "REST", label: "создать заказ",
  synchronous: true,
  legs: [
    { leg: "forward", kind: "forward", from_id: "buyer", to_id: "orders", default_caption: "создать заказ" },
    { leg: "return", kind: "return", from_id: "orders", to_id: "buyer", default_caption: "заказ создан" },
  ],
} as Channel;

describe("MessageComposer: шаг из связи", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processesApi.channels).mockResolvedValue([CHANNEL]);
    vi.mocked(processesApi.addMessage).mockResolvedValue({ id: "m1" } as never);
    vi.mocked(edgesApi.update).mockResolvedValue({} as never);
  });

  it("пока связи грузятся — «Загрузка связей»", () => {
    vi.mocked(processesApi.channels).mockReturnValue(new Promise(() => {}));
    renderComposer();
    expect(screen.getByText("Загрузка связей")).toBeInTheDocument();
  });

  it("шапка связи и варианты шага; «Добавить шаг» заперта до выбора, за ней «Отмена»", async () => {
    const { container } = renderComposer();
    await screen.findByText("Шаг можно взять из связей между ними:");
    expect(screen.getByText("Покупатель → Сервис заказов")).toBeInTheDocument();
    expect(screen.getByText("REST")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /«создать заказ»/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /«заказ создан»/ })).toBeInTheDocument();
    expect(textButtons(container).slice(-2)).toEqual(["Добавить шаг", "Отмена"]);
    expect(screen.getByRole("button", { name: "Добавить шаг" })).toBeDisabled();
  });

  it("выбранное плечо уходит в addMessage, окно закрывается", async () => {
    const onClose = vi.fn();
    const onAdded = vi.fn();
    renderComposer({ onClose, onAdded });
    await userEvent.click(await screen.findByRole("button", { name: /«заказ создан»/ }));
    await userEvent.click(screen.getByRole("button", { name: "Добавить шаг" }));
    const payload = {
      edge_id: "e1", leg: "return", from_participant_id: "p-orders", to_participant_id: "p-buyer",
      caption: null, order: 0,
    };
    await waitFor(() => expect(processesApi.addMessage).toHaveBeenCalledWith("proc-1", payload));
    expect(onAdded).toHaveBeenCalledWith({ id: "m1" }, payload);
    expect(onClose).toHaveBeenCalled();
  });

  it("«Отмена» закрывает без записи", async () => {
    const onClose = vi.fn();
    renderComposer({ onClose });
    await screen.findByText("Шаг можно взять из связей между ними:");
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalled();
    expect(processesApi.addMessage).not.toHaveBeenCalled();
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("смена типа в шапке связи пишется сразу и перечитывает связи пары", async () => {
    renderComposer();
    await screen.findByText("Шаг можно взять из связей между ними:");
    await userEvent.click(screen.getByRole("button", { name: "асинхр." }));
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledWith("e1", { is_synchronous: false }));
    await waitFor(() => expect(processesApi.channels).toHaveBeenCalledTimes(2));
  });
});

describe("MessageComposer: связи нет", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processesApi.channels).mockResolvedValue([]);
  });

  it("предупреждение, подписи полей, фокус в первом поле; кнопки «Добавить связь в схему» и «Отмена»", async () => {
    const { container } = renderComposer();
    expect(await screen.findByText("Между ними нет задокументированной связи")).toBeInTheDocument();
    expect(screen.getByText(/Шаг процесса идёт только по связи из схемы/)).toBeInTheDocument();
    expect(screen.getByLabelText("Что передаётся")).toHaveFocus();
    expect(screen.getByLabelText("Технология")).toBeInTheDocument();
    expect(screen.getByText("Тип связи")).toBeInTheDocument();
    expect(textButtons(container).slice(-2)).toEqual(["Добавить связь в схему", "Отмена"]);
  });

  it("отказ по пределу демо — сообщением с role=alert", async () => {
    vi.mocked(edgesApi.create).mockRejectedValue(
      new ApiError(409, "Демо-проект поддерживает до 120 связей.", "demo_limit"));
    renderComposer();
    await screen.findByText("Между ними нет задокументированной связи");
    await userEvent.click(screen.getByRole("button", { name: /Добавить связь в схему/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Демо-проект поддерживает до 120 связей.");
  });

  it("прочий отказ — текстом ошибки", async () => {
    vi.mocked(edgesApi.create).mockRejectedValue(new Error("Связь уже есть"));
    renderComposer();
    await screen.findByText("Между ними нет задокументированной связи");
    await userEvent.click(screen.getByRole("button", { name: /Добавить связь в схему/ }));
    expect(await screen.findByText("Связь уже есть")).toBeInTheDocument();
  });
});
