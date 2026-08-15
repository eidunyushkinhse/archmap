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
import type { BrokerChannel, ChannelField, ChannelUsage } from "../../types";

// Окно дозаливки тянет за собой весь BYOA-обвес — здесь важно лишь, что его
// открывает пункт меню (у самого окна свои тесты).
vi.mock("../docsImport/ChannelsAgentModal", () => ({
  default: () => <div data-testid="channels-agent" />,
}));
vi.mock("../../api/nodes", () => ({
  brokerChannelsApi: {
    list: vi.fn(),
    usage: vi.fn(),
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

function setup(channels: BrokerChannel[], isArchitect = true, usage: ChannelUsage[] = []) {
  vi.mocked(brokerChannelsApi.list).mockResolvedValue(channels);
  vi.mocked(brokerChannelsApi.usage).mockResolvedValue(usage);
  return render(
    <BrokerChannelsSection nodeId="n1" nodeName="Шина" isArchitect={isArchitect} />,
  );
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
    // Кнопка одна, способы — пункты меню (как у «Логики» и структуры базы).
    await userEvent.click(screen.getByText("+ Канал"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
    expect(brokerChannelsApi.create).toHaveBeenCalledWith("n1", {
      name: "канал_2", group_name: "", kind: "", partition_key: "", delivery: "", retention: "",
    });
  });

  it("дозаливка от агента — второй пункт того же меню, а не своя кнопка", async () => {
    // Заводить каналы руками для брокера с полусотней топиков непригодно, но и второй
    // кнопкой рядом путь не выносим: способ завести сущность — не отдельная сущность.
    setup([channel()]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    // Пока меню не раскрыто, отдельного входа к агенту на странице нет — и самого
    // окна тоже: смонтированное «на всякий случай», оно ходило бы в превью само.
    expect(screen.queryByText("Через ИИ-агента")).toBeNull();
    expect(screen.queryByTestId("channels-agent")).toBeNull();
    await userEvent.click(screen.getByText("+ Канал"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
    expect(screen.getByTestId("channels-agent")).toBeInTheDocument();
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
  it("обратный индекс: кто публикует и кто потребляет — в теле канала", async () => {
    // Ради этого ответа структура каналов и заводилась: перечень говорит, ЧТО брокер
    // переносит, индекс — кто кладёт событие и кто его ждёт. Записей у него нет:
    // строки собраны из пометок в текстах схем логики вызывающих.
    setup([channel()], true, [
      {
        channel_id: "ch1", channel_name: "orders.created",
        field_id: "f1", field_name: "order_id", mode: "publish",
        doc_id: "d1", doc_name: "POST /orders", node_id: "n2", node_name: "Заказы",
      },
      {
        channel_id: "ch1", channel_name: "orders.created",
        field_id: null, field_name: null, mode: "consume",
        doc_id: "d2", doc_name: "Обработчик", node_id: "n3", node_name: "Склад",
      },
    ]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    // Индекс живёт в теле раскрывашки — как мета доставки и поля.
    expect(screen.queryByText("публикует")).toBeNull();

    await userEvent.click(screen.getByLabelText("Развернуть канал"));

    expect(screen.getByText("Кто публикует / кто потребляет")).toBeInTheDocument();
    expect(screen.getByText("публикует")).toBeInTheDocument();
    expect(screen.getByText("потребляет")).toBeInTheDocument();
    // Глубина «канал.поле» видна: вопрос «откуда в событии значение» без неё не закрыт.
    expect(screen.getByText("orders.created.order_id")).toBeInTheDocument();
    expect(screen.getByText("Заказы · POST /orders")).toBeInTheDocument();
    expect(screen.getByText("Склад · Обработчик")).toBeInTheDocument();
  });

  it("пометок на канал нет — говорим это конкретно, а не молчим", async () => {
    // Молчание читалось бы как «событие никому не нужно», а «обращений не описано»
    // отправляло бы искать форму ввода, которой нет.
    setup([channel()]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Развернуть канал"));

    expect(
      screen.getByText("Пометок «публикует:/потребляет:» на этот канал в схемах логики нет"),
    ).toBeInTheDocument();
  });

  it("строки чужого канала в карточку не попадают", async () => {
    setup([channel(), channel({ id: "ch2", name: "audit" })], true, [
      {
        channel_id: "ch2", channel_name: "audit", field_id: null, field_name: null,
        mode: "publish", doc_id: "d1", doc_name: "POST /orders",
        node_id: "n2", node_name: "Заказы",
      },
    ]);
    await waitFor(() => expect(screen.getByDisplayValue("orders.created")).toBeInTheDocument());
    const [первый] = screen.getAllByLabelText("Развернуть канал");
    await userEvent.click(первый);

    expect(
      screen.getByText("Пометок «публикует:/потребляет:» на этот канал в схемах логики нет"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Заказы · POST /orders")).toBeNull();
  });
});
