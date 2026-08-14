// Секция «Каналы» узла-брокера: каналы и поля сообщений записями.
//
// Проверяется то, что отличает эту секцию от текстового поля: правка идёт поштучно
// (без формы и «Сохранить»), канал правится под CAS, мета доставки живёт в теле
// раскрывашки, группы появляются только там, где они у брокера есть, а наблюдатель
// ничего не редактирует.
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import BrokerChannelsSection from "../BrokerChannelsSection";
import { brokerChannelsApi } from "../../api/nodes";
import type { BrokerChannel, ChannelField } from "../../types";

vi.mock("../../api/nodes", () => ({
  brokerChannelsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    createField: vi.fn(),
    updateField: vi.fn(),
    deleteField: vi.fn(),
  },
}));

function field(over: Partial<ChannelField> = {}): ChannelField {
  return {
    id: "f1", channel_id: "ch1", name: "order_id", type: "uuid",
    required: true, description: null, order: 0, ...over,
  } as ChannelField;
}

function channel(over: Partial<BrokerChannel> = {}): BrokerChannel {
  return {
    id: "ch1", node_id: "n1", name: "orders.created", group_name: "", kind: "topic",
    partition_key: "", delivery: "", retention: "", description: null,
    version: 1, fields: [field()], ...over,
  } as BrokerChannel;
}

function setup(channels: BrokerChannel[], isArchitect = true) {
  vi.mocked(brokerChannelsApi.list).mockResolvedValue(channels);
  return render(<BrokerChannelsSection nodeId="n1" isArchitect={isArchitect} />);
}

describe("BrokerChannelsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("пустая структура предлагает завести канал", async () => {
    setup([]);
    await waitFor(() => expect(screen.getByText("Каналы не описаны")).toBeInTheDocument());
    expect(screen.getByText("+ Канал")).toBeInTheDocument();
  });

  it("поля сообщения и мета доставки видны только после раскрытия канала", async () => {
    // Мета (ключ/гарантия/retention) — ради неё канал отдельная сущность, и живёт она
    // в теле: в шапке она спорила бы за место с именем.
    setup([channel({ partition_key: "user_id", delivery: "at-least-once" })]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("order_id")).toBeNull();
    expect(screen.queryByDisplayValue("user_id")).toBeNull();
    await userEvent.click(screen.getByLabelText("Развернуть канал"));
    expect(screen.getByDisplayValue("order_id")).toBeInTheDocument();
    expect(screen.getByDisplayValue("user_id")).toBeInTheDocument();
    expect(screen.getByDisplayValue("at-least-once")).toBeInTheDocument();
  });

  it("у списка полей есть шапка — иначе тип не отличить от смысла", async () => {
    setup([channel()]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Развернуть канал"));
    for (const заголовок of ["Поле", "Тип", "обяз.", "Смысл значения"]) {
      expect(screen.getByText(заголовок)).toBeInTheDocument();
    }
    // Признак назван ОДИН раз — в шапке; в строке только сам чекбокс.
    expect(screen.getByLabelText("Обязательное поле")).toBeInTheDocument();
  });

  it("группы становятся раскрывашками, но только когда они заданы", async () => {
    // У Kafka уровня группы нет вовсе — лишней вложенности быть не должно.
    setup([channel(), channel({ id: "ch2", name: "orders.paid" })]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    expect(screen.queryByText("без группы")).toBeNull();
  });

  it("с группами каналы группируются", async () => {
    setup([channel(), channel({ id: "ch2", name: "audit", group_name: "billing" })]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    expect(screen.getByText("без группы")).toBeInTheDocument();
    expect(screen.getByText("billing")).toBeInTheDocument();
  });

  it("свёрнутая группа прячет свои каналы", async () => {
    setup([channel(), channel({ id: "ch2", name: "audit", group_name: "billing" })]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    await userEvent.click(screen.getByText("billing"));
    // Высоту ведёт ГОЛАЯ обёртка (.anim-box), а не блок с отступами: иначе измерение
    // врало бы на padding/border, и соседи прыгали бы.
    const box = screen.getByDisplayValue("audit").closest(".anim-box") as HTMLElement;
    expect(box.style.height).toBe("0px");
  });

  it("правка имени канала уходит PATCH-ем с CAS-версией", async () => {
    vi.mocked(brokerChannelsApi.update).mockResolvedValue(channel({ name: "orders.v2" }));
    setup([channel({ version: 7 })]);
    const input = await screen.findByDisplayValue("orders.created");
    fireEvent.blur(input, { target: { value: "orders.v2" } });
    await waitFor(() => expect(brokerChannelsApi.update).toHaveBeenCalledWith(
      "n1", "ch1", { name: "orders.v2", base_version: 7 },
    ));
  });

  it("новый канал получает свободное имя — повторное нажатие не упрётся в 409", async () => {
    vi.mocked(brokerChannelsApi.create).mockResolvedValue(channel());
    setup([channel({ id: "ch1", name: "канал" })]);
    await waitFor(() => expect(screen.getByDisplayValue("канал")).toBeInTheDocument());
    // Кнопка обычная: меню «Вручную | Через ИИ-агента» появится в Ф4 (BYOA).
    await userEvent.click(screen.getByText("+ Канал"));
    expect(brokerChannelsApi.create).toHaveBeenCalledWith("n1", {
      name: "канал_2", group_name: "", kind: "", partition_key: "", delivery: "", retention: "",
    });
  });

  it("«+ Поле» шлёт порядок — иначе поля сообщения встали бы как попало", async () => {
    vi.mocked(brokerChannelsApi.createField).mockResolvedValue(field());
    setup([channel({ fields: [field(), field({ id: "f2", name: "поле", order: 1 })] })]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Развернуть канал"));
    await userEvent.click(screen.getByText("+ Поле"));
    expect(brokerChannelsApi.createField).toHaveBeenCalledWith("n1", "ch1", {
      name: "поле_2", type: "", required: false, order: 2,
    });
  });

  it("счётчиков нет: ни полей у канала, ни каналов в группе", async () => {
    // Число полей и число каналов — шум: масштаб виден по самому списку, а в шапке они
    // спорят за место с именем (решение приёмки эпика БД).
    setup([
      channel({ fields: [field(), field({ id: "f9", name: "total" })] }),
      channel({ id: "ch2", name: "audit", group_name: "billing" }),
    ]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.queryByText("1")).toBeNull();
  });

  it("наблюдатель видит каналы, но не правит", async () => {
    setup([channel({
      partition_key: "user_id", delivery: "at-least-once", retention: "7d",
      fields: [field({ required: true })],
    })], false);
    await waitFor(() => expect(screen.getByText("orders.created")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("orders.created")).toBeNull();
    expect(screen.queryByText("+ Канал")).toBeNull();
    // И тело тоже читается, а не правится: мета текстом, признак чипом, полей ввода нет.
    await userEvent.click(screen.getByLabelText("Развернуть канал"));
    expect(screen.getByText("ключ: user_id")).toBeInTheDocument();
    expect(screen.getByText("доставка: at-least-once")).toBeInTheDocument();
    expect(screen.getByText("хранение: 7d")).toBeInTheDocument();
    expect(screen.getByText("order_id")).toBeInTheDocument();
    expect(screen.getByText("обяз.")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("order_id")).toBeNull();
    expect(screen.queryByText("+ Поле")).toBeNull();
    expect(screen.queryByLabelText("Обязательное поле")).toBeNull();
  });
});
