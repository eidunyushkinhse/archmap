// Поле «Канал» в правой панели редактора-карты (Ф3 документации брокеров).
//
// Стрелка «сервис → брокер» обязана назвать топик/очередь (решение пользователя №4):
// поле появляется, только если хотя бы один конец связи — брокер, коммитится по blur
// тем же CAS-путём, что описание и технология, и несёт МЯГКУЮ подсказку резолва по
// структуре брокера-конца (сохранение она не гейтит — истина шва в алерте AL31).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import EdgeInspector from "../inspector/EdgeInspector";
import { brokerChannelsApi, edgesApi, nodesApi } from "../../api/nodes";
import type { BrokerChannel, LevelEdge, Node } from "../../types";

vi.mock("../NodeSearchPicker", () => ({ default: () => null }));
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

const cb = { onEdgeSaved: vi.fn(), onEdgeDeleted: vi.fn() };

// Концы: source — сервис, target — брокер (если не сказано иное).
function setEnds(targetShape: Node["shape"] = "broker") {
  vi.mocked(nodesApi.get).mockImplementation((id: string) =>
    Promise.resolve(id === "n1" ? node() : node({ id: "n2", name: "Kafka", shape: targetShape })),
  );
}

function setup(e: LevelEdge = edge(), isArchitect = true) {
  return render(<EdgeInspector edge={e} isArchitect={isArchitect} {...cb} />);
}

const channelField = () => screen.getByPlaceholderText("топик / очередь");

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

  it("канал, найденный в структуре брокера, подтверждается галочкой", async () => {
    vi.mocked(brokerChannelsApi.list).mockResolvedValue([channel()]);
    setup(edge({ channel: "orders.created" }));

    expect(await screen.findByText("✓ orders.created")).toBeTruthy();
  });

  it("канал адресуется и как «группа.канал»", async () => {
    vi.mocked(brokerChannelsApi.list).mockResolvedValue([
      channel({ name: "оплаты", group_name: "billing" }),
    ]);
    setup(edge({ channel: "billing.оплаты" }));

    expect(await screen.findByText("✓ billing.оплаты")).toBeTruthy();
  });

  it("неизвестный канал помечается мягким предупреждением, но правку не блокирует", async () => {
    vi.mocked(brokerChannelsApi.list).mockResolvedValue([channel()]);
    vi.mocked(edgesApi.update).mockResolvedValue({ ...edge(), version: 3 } as never);
    setup(edge({ channel: "orders.creted" }));

    expect(await screen.findByText("⚠ канала нет в структуре брокера")).toBeTruthy();
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

    await userEvent.type(screen.getByPlaceholderText("REST, gRPC, Kafka…"), "Kafka");
    await userEvent.tab();

    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.update).mock.calls[0][1].channel).toBe("orders.created");
  });

  it("наблюдателю канал показан строкой без поля ввода", async () => {
    setup(edge({ channel: "orders.created" }), false);

    expect(await screen.findByText("Канал")).toBeTruthy();
    expect(screen.queryByPlaceholderText("топик / очередь")).toBeNull();
    expect(screen.getByText("orders.created")).toBeTruthy();
  });

  it("наблюдателю пустой канал не показывают вовсе", async () => {
    setup(edge(), false);

    expect(await screen.findByText("Куда")).toBeTruthy();
    expect(screen.queryByText("Канал")).toBeNull();
  });
});
