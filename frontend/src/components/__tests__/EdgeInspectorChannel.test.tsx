// Панель связи редактора-карты (редизайн, фаза 4а) и её поле «Канал» (Ф3 документации
// брокеров).
//
// Стрелка «сервис → брокер» обязана назвать топик/очередь (решение пользователя №4):
// поле появляется, только если хотя бы один конец связи — брокер, коммитится по blur
// тем же CAS-путём, что описание и технология, и несёт МЯГКОЕ предупреждение, когда
// канала нет в структуре брокера-конца (сохранение оно не гейтит — истина шва в алерте
// AL31). Найденный канал ничем не помечается: «✓ имя» повторяло значение поля.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import EdgeInspector from "../inspector/EdgeInspector";
import { brokerChannelsApi, edgesApi, nodesApi } from "../../api/nodes";
import type { BrokerChannel, LevelEdge, Node } from "../../types";

// Поиск конца: заглушка с полем и кнопкой выбора (сам поиск покрыт своими тестами).
vi.mock("../NodeSearchPicker", () => ({
  default: ({ onChange }: { onChange: (id: string, label?: string) => void }) => (
    <>
      <input aria-label="Поиск по имени" />
      <button type="button" onClick={() => onChange("n3", "Payments")}>выбрать Payments</button>
    </>
  ),
}));
vi.mock("../../api/nodes", () => ({
  edgesApi: { update: vi.fn(), get: vi.fn(), delete: vi.fn(), deletionSnapshot: vi.fn() },
  nodesApi: { get: vi.fn() },
  brokerChannelsApi: { list: vi.fn() },
}));

function node(over: Partial<Node> = {}): Node {
  return {
    id: "n1", name: "orders", description: null, role: null, technology: null,
    parent_id: null, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, version: 1, docs: [], has_children: false, child_count: 0,
    created_at: "", updated_at: "", ...over,
  } as Node;
}

function channel(over: Partial<BrokerChannel> = {}): BrokerChannel {
  return {
    id: "c1", node_id: "n2", name: "orders.created", group_name: "", kind: "topic",
    partition_key: "", delivery: "", retention: "", description: null, version: 1,
    fields: [], created_at: "", updated_at: "", ...over,
  } as BrokerChannel;
}

function edge(over: Partial<LevelEdge> = {}): LevelEdge {
  return {
    id: "e1", label: "событие", technology: null, channel: null,
    source_id: "n1", target_id: "n2", version: 2, created_at: "",
    original_source_id: "n1", original_target_id: "n2",
    original_source_name: "orders", original_target_name: "Kafka",
    ...over,
  } as LevelEdge;
}

const cb = { onEdgeSaved: vi.fn(), onEdgeDeleted: vi.fn(), onClose: vi.fn() };

// Концы: source — сервис, target — брокер (если не сказано иное).
function setEnds(targetShape: Node["shape"] = "broker") {
  vi.mocked(nodesApi.get).mockImplementation((id: string) =>
    Promise.resolve(id === "n1" ? node() : node({ id: "n2", name: "Kafka", shape: targetShape })),
  );
}

function setup(e: LevelEdge = edge(), isArchitect = true) {
  return render(<EdgeInspector edge={e} isArchitect={isArchitect} {...cb} />);
}

const channelField = () => screen.getByRole("textbox", { name: "Канал" });
const WARN = "Канала нет в структуре брокера";

beforeEach(() => {
  vi.clearAllMocks();
  setEnds();
  vi.mocked(brokerChannelsApi.list).mockResolvedValue([]);
});

describe("EdgeInspector: канал связи", () => {
  it("поле есть у связи с брокером на конце", async () => {
    setup();

    expect(await screen.findByText("Канал")).toBeTruthy();
    // Структуру брокера-конца спрашиваем только у него (у сервиса каналов нет).
    await waitFor(() => expect(brokerChannelsApi.list).toHaveBeenCalledWith("n2"));
    expect(vi.mocked(brokerChannelsApi.list).mock.calls).toEqual([["n2"]]);
  });

  it("у связи без брокера поля нет вовсе", async () => {
    setEnds("database");
    setup();

    // Дожидаемся загрузки концов: иначе «нет поля» было бы правдой просто потому,
    // что формы концов ещё не приехали.
    expect(await screen.findByText("Технология")).toBeTruthy();
    expect(screen.queryByText("Канал")).toBeNull();
    expect(brokerChannelsApi.list).not.toHaveBeenCalled();
  });

  it("правка уходит PATCH-ем по blur вместе с CAS-версией", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue(
      { ...edge({ channel: "orders.created" }), version: 3 } as never,
    );
    setup();
    await screen.findByText("Канал");

    await userEvent.type(channelField(), "orders.created");
    await userEvent.tab(); // blur — коммит

    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
    const [id, payload] = vi.mocked(edgesApi.update).mock.calls[0];
    expect(id).toBe("e1");
    expect(payload.channel).toBe("orders.created");
    expect(payload.base_version).toBe(2);
  });

  it("канал, найденный в структуре брокера, без пометок: ни галочки, ни предупреждения", async () => {
    vi.mocked(brokerChannelsApi.list).mockResolvedValue([channel()]);
    setup(edge({ channel: "orders.created" }));

    await waitFor(() => expect(brokerChannelsApi.list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/✓/)).toBeNull();
    expect(screen.queryByText(WARN)).toBeNull();
  });

  it("канал адресуется и как «группа.канал»", async () => {
    vi.mocked(brokerChannelsApi.list).mockResolvedValue([
      channel({ name: "оплаты", group_name: "billing" }),
    ]);
    setup(edge({ channel: "billing.оплаты" }));

    await waitFor(() => expect(brokerChannelsApi.list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(WARN)).toBeNull();
  });

  it("неизвестный канал помечается мягким предупреждением, но правку не блокирует", async () => {
    vi.mocked(brokerChannelsApi.list).mockResolvedValue([channel()]);
    vi.mocked(edgesApi.update).mockResolvedValue({ ...edge(), version: 3 } as never);
    setup(edge({ channel: "orders.creted" }));

    expect(await screen.findByText(WARN)).toBeTruthy();
    // Поле остаётся редактируемым, коммит проходит: подсказка сообщает, а не запрещает.
    await userEvent.click(channelField());
    await userEvent.tab();
    expect(screen.queryByText(/Ошибка/)).toBeNull();
  });

  it("канал едет в обе стороны истории (undo/redo), а не теряется молча", async () => {
    // Поле, забытое в списке полей коммита, история теряет БЕЗ единого симптома:
    // Ctrl+Z вернул бы связь с обнулённым каналом (урок «nodeFields без status»).
    vi.mocked(edgesApi.update).mockResolvedValue(
      { ...edge({ channel: "orders.v2" }), version: 3 } as never,
    );
    setup(edge({ channel: "orders.created" }));
    await screen.findByText("Канал");

    await userEvent.clear(channelField());
    await userEvent.type(channelField(), "orders.v2");
    await userEvent.tab();

    await waitFor(() => expect(cb.onEdgeSaved).toHaveBeenCalledOnce());
    const [, undoPayload, redoPayload] = vi.mocked(cb.onEdgeSaved).mock.calls[0];
    expect(undoPayload.channel).toBe("orders.created");
    expect(redoPayload.channel).toBe("orders.v2");
  });

  it("правка соседнего поля канал не затирает", async () => {
    // Коммит шлёт ВСЕ поля разом: канал, не попавший в payload, ушёл бы null'ом.
    vi.mocked(edgesApi.update).mockResolvedValue(
      { ...edge({ channel: "orders.created", technology: "Kafka" }), version: 3 } as never,
    );
    setup(edge({ channel: "orders.created" }));
    await screen.findByText("Канал");

    await userEvent.type(screen.getByRole("textbox", { name: "Технология" }), "Kafka");
    await userEvent.tab();

    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.update).mock.calls[0][1].channel).toBe("orders.created");
  });

  it("наблюдателю канал показан строкой без поля ввода", async () => {
    setup(edge({ channel: "orders.created" }), false);

    expect(await screen.findByText("Канал")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Канал" })).toBeNull();
    expect(screen.getByText("orders.created")).toBeTruthy();
  });

  it("наблюдателю пустой канал не показывают вовсе", async () => {
    setup(edge(), false);

    expect(await screen.findByText("Куда")).toBeTruthy();
    expect(screen.queryByText("Канал")).toBeNull();
  });
});

// Панель связи: заголовок «Связь» с крестиком, строки тем же видом, что строки свойств
// объекта, «Удалить связь» внизу. Читатель видит только строки со значением.
describe("EdgeInspector: панель связи", () => {
  const terms = () => [...document.querySelectorAll(".np-term")].map((t) => t.textContent);
  const row = (term: string) => {
    const dd = [...document.querySelectorAll(".np-prop")].find((p) => p.querySelector(".np-term")?.textContent === term)?.querySelector("dd");
    if (!(dd instanceof HTMLElement)) throw new Error(`нет строки «${term}»`);
    return dd;
  };

  it("заголовок «Связь», крестик закрывает; строки по порядку", async () => {
    setup();
    expect(screen.getByRole("heading", { name: "Связь" })).toBeInTheDocument();
    await screen.findByText("Канал");
    expect(terms()).toEqual(["Откуда", "Куда", "Описание", "Канал", "Технология"]);
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(cb.onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Открыть страницу объекта" })).toBeNull();
  });

  it("читатель видит только строки со значением и не видит удаления", async () => {
    setup(edge({ label: null }), false);
    await screen.findByText("Куда");
    await waitFor(() => expect(nodesApi.get).toHaveBeenCalledTimes(2));
    expect(terms()).toEqual(["Откуда", "Куда"]);
    expect(document.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(screen.queryByRole("button")?.getAttribute("aria-label")).toBe("Закрыть");
    expect(screen.queryByRole("button", { name: "Удалить связь" })).toBeNull();
  });

  it("конец связи: значение открывает поиск, выбор записывает конец и закрывает поиск", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...edge({ source_id: "n3", original_source_id: "n3" }), version: 3 } as never);
    setup();
    const from = within(row("Откуда")).getByRole("button", { name: "Откуда: orders" });
    await userEvent.click(from);
    await userEvent.click(screen.getByRole("button", { name: "выбрать Payments" }));
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.update).mock.calls[0][1]).toMatchObject({ source_id: "n3", base_version: 2 });
    expect(screen.queryByRole("button", { name: "выбрать Payments" })).toBeNull();
    expect(within(row("Откуда")).getByRole("button")).toHaveTextContent("Payments");
  });

  it("Escape в поиске конца закрывает только поиск, не панель", async () => {
    const onWindowKey = vi.fn();
    const listener = (e: KeyboardEvent) => { if (e.key === "Escape") onWindowKey(); };
    window.addEventListener("keydown", listener);
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Куда: Kafka" }));
    const pick = screen.getByRole("button", { name: "выбрать Payments" });
    fireEvent.keyDown(pick, { key: "Escape" });
    window.removeEventListener("keydown", listener);
    expect(screen.queryByRole("button", { name: "выбрать Payments" })).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("Escape в поиске конца возвращает фокус на значение строки", async () => {
    setup();
    const value = screen.getByRole("button", { name: "Куда: Kafka" });
    await userEvent.click(value);
    screen.getByRole("textbox", { name: "Поиск по имени" }).focus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("group", { name: "Куда" })).toBeNull();
    expect(document.activeElement).toBe(value);
  });

  it("Escape в описании с правкой возвращает записанное и дальше не уходит", async () => {
    const onWindowKey = vi.fn();
    const listener = (e: KeyboardEvent) => { if (e.key === "Escape") onWindowKey(); };
    window.addEventListener("keydown", listener);
    setup();
    const описание = screen.getByRole("textbox", { name: "Описание" });
    await userEvent.type(описание, " и ещё");
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listener);
    expect(описание).toHaveValue("событие");
    expect(onWindowKey).not.toHaveBeenCalled();
  });

  it("«Удалить связь» — снимок для Undo, удаление, колбэк со снимком", async () => {
    const snapshot = { nodes: [], edges: [], layout_items: [] };
    vi.mocked(edgesApi.deletionSnapshot).mockResolvedValue(snapshot as never);
    vi.mocked(edgesApi.delete).mockResolvedValue(undefined as never);
    setup();
    const del = screen.getByRole("button", { name: "Удалить связь" });
    expect(del).toHaveClass("ip-delete");
    await userEvent.click(del);
    await waitFor(() => expect(cb.onEdgeDeleted).toHaveBeenCalledWith("e1", snapshot));
    expect(edgesApi.delete).toHaveBeenCalledWith("e1");
  });
});
