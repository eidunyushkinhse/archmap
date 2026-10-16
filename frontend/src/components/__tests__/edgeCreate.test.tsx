// Создание связи из поповеров жеста: прямой (EdgeQuickCreate — концы заданы жестом) и
// межуровневой (CrossLevelEdgePicker — дальний конец выбирают в дереве).
//
// Страховка перед выносом общей машинерии в useEdgeCreate (аудит F-15): что уходит в
// запрос, куда смотрит направление и что видно при отказе. Предел демо-стенда
// проверяет demoEditLimits.test.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import EdgeQuickCreate from "../EdgeQuickCreate";
import CrossLevelEdgePicker from "../CrossLevelEdgePicker";
import { edgesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { Edge, Node } from "../../types";

vi.mock("../../api/nodes", () => ({ edgesApi: { create: vi.fn() } }));
// Modal настоящий (test-setup открывает <dialog> атрибутом open): подтверждение по Enter
// идёт через него.

const created = { id: "e1", source_id: "a", target_id: "b", version: 1 } as Edge;

const node = (id: string, name: string, parent_id: string | null = null): Node =>
  ({ id, name, parent_id, role: null, shape: "service", has_children: false }) as Node;

describe("EdgeQuickCreate", () => {
  beforeEach(() => vi.clearAllMocks());

  function open() {
    const onCreated = vi.fn();
    render(
      <EdgeQuickCreate sourceId="a" targetId="b" sourceLabel="Заказы" targetLabel="Оплата"
        onClose={vi.fn()} onCreated={onCreated} />,
    );
    return onCreated;
  }

  it("создаёт связь между концами жеста с заполненными полями", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await userEvent.type(screen.getByPlaceholderText("запрос, событие..."), "оплата заказа");
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    // Пустая технология уходит null, а не пустой строкой.
    expect(edgesApi.create).toHaveBeenCalledWith({
      source_id: "a", target_id: "b", label: "оплата заказа", technology: null,
    });
  });

  it("отказ сервера показан текстом, кнопка снова доступна", async () => {
    vi.mocked(edgesApi.create).mockRejectedValue(new ApiError(400, "Связь между этими объектами уже есть"));
    const onCreated = open();
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    expect(await screen.findByText("Связь между этими объектами уже есть")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать связь" })).toBeEnabled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("Enter в поле подтверждает, как «Создать связь»", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await userEvent.type(screen.getByPlaceholderText("REST, gRPC, Kafka..."), "gRPC{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(edgesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      source_id: "a", target_id: "b", technology: "gRPC",
    }));
  });
});

describe("CrossLevelEdgePicker", () => {
  beforeEach(() => vi.clearAllMocks());

  function open() {
    const onCreated = vi.fn();
    render(
      <CrossLevelEdgePicker
        title="Связь с объектом вне уровня"
        sourceId="a"
        sourceLabel="Заказы"
        loadNodes={() => Promise.resolve([node("a", "Заказы"), node("b", "Оплата")])}
        scopeKey="root"
        rootParentId={null}
        excludeIds={new Set(["a"])}
        slotPlaceholder="выберите объект"
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );
    return onCreated;
  }

  it("без выбранного конца создать нельзя", async () => {
    open();
    await screen.findByText("Оплата");
    expect(screen.getByRole("button", { name: "Создать связь" })).toBeDisabled();
  });

  it("по умолчанию связь идёт от источника к выбранному", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await userEvent.click(await screen.findByText("Оплата"));
    await userEvent.type(screen.getByPlaceholderText("REST, Kafka…"), "gRPC");
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(edgesApi.create).toHaveBeenCalledWith({
      source_id: "a", target_id: "b", label: null, technology: "gRPC",
    });
  });

  it("⇄ разворачивает направление: выбранный → источник", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    open();
    await userEvent.click(await screen.findByText("Оплата"));
    await userEvent.click(screen.getByTitle("Поменять направление"));
    await userEvent.click(screen.getByRole("button", { name: "Создать связь" }));
    await waitFor(() => expect(edgesApi.create).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.create).mock.calls[0][0]).toMatchObject({ source_id: "b", target_id: "a" });
  });

  it("Enter: без выбранного конца молчит, с выбранным — создаёт", async () => {
    vi.mocked(edgesApi.create).mockResolvedValue(created);
    const onCreated = open();
    await screen.findByText("Оплата");
    const tech = () => screen.getByPlaceholderText("REST, Kafka…");
    await userEvent.type(tech(), "gRPC{Enter}");
    expect(edgesApi.create).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Оплата"));
    await userEvent.type(tech(), "{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(edgesApi.create).toHaveBeenCalledWith(expect.objectContaining({
      source_id: "a", target_id: "b", technology: "gRPC",
    }));
  });
});
