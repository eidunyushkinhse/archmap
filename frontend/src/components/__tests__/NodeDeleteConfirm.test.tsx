// Подтверждение удаления узла: что именно человек видит перед удалением.
// Ключевое — задокументированный узел БЕЗ связей и детей больше не уезжает молча:
// прежде «терять нечего» считалось только по связям и детям, и база с таблицами
// удалялась вообще без вопроса.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeDeleteConfirm from "../NodeDeleteConfirm";
import { nodesApi } from "../../api/nodes";
import type { DeletionSnapshot, Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { getEdges: vi.fn(), deletionSnapshot: vi.fn(), delete: vi.fn() },
}));

function node(over: Partial<Node> = {}): Node {
  return {
    id: "n1", name: "orders-db", description: null, role: null, technology: null,
    parent_id: null, shape: "database", is_external: false, status: "existing",
    openapi_spec: null, source_ref: null, version: 1, docs: [], has_children: false,
    child_count: 0, created_at: "", updated_at: "", ...over,
  } as Node;
}

function snapshot(over: Partial<DeletionSnapshot> = {}): DeletionSnapshot {
  return {
    nodes: [], edges: [], layout_items: [], node_docs: [],
    db_tables: [], db_columns: [], broker_channels: [], channel_fields: [],
    ...over,
  } as DeletionSnapshot;
}

describe("NodeDeleteConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.delete).mockResolvedValue(undefined);
  });

  it("перечисляет документацию, которая уедет вместе с узлом", async () => {
    const snap = snapshot({
      db_tables: [{ id: "t1" }, { id: "t2" }],
      db_columns: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
      node_docs: [{ id: "d1" }],
    } as Partial<DeletionSnapshot>);
    vi.mocked(nodesApi.deletionSnapshot).mockResolvedValue(snap);
    const onDeleted = vi.fn();

    render(<NodeDeleteConfirm node={node()} onCancel={() => {}} onDeleted={onDeleted} />);

    // Узел без связей и детей, но с документацией — спрашиваем, а не удаляем молча.
    const line = await screen.findByText(/удалится документация/);
    expect(line.textContent).toContain("1 схема логики");
    expect(line.textContent).toContain("2 таблицы БД, в них 3 колонки");
    expect(nodesApi.delete).not.toHaveBeenCalled();

    // Кнопка доступна, когда окно открыто: showModal зовётся в эффекте после рендера, и
    // под нагрузкой текст уже найден, а закрытый <dialog> кнопку ещё прячет. Поэтому findByRole.
    await userEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(nodesApi.delete).toHaveBeenCalledWith("n1"));
    // В историю уходит ТОТ ЖЕ снимок, что показали: вернётся ровно показанное.
    expect(onDeleted).toHaveBeenCalledWith("n1", snap);
  });

  it("перечень связей: строка с подсказкой; связь без подписи и технологии — без кавычек", async () => {
    vi.mocked(nodesApi.getEdges).mockResolvedValue([
      { id: "e1", label: "Оформление заказов", technology: "REST", direction: "incoming", other_node_id: "g", other_node_name: "API Gateway", inner_node_id: "n1", inner_node_name: "orders-db" },
      { id: "e2", label: null, technology: "Kafka", direction: "outgoing", other_node_id: "k", other_node_name: "Kafka", inner_node_id: "n1", inner_node_name: "orders-db" },
      { id: "e3", label: null, technology: null, direction: "outgoing", other_node_id: "b", other_node_name: "БД заказов", inner_node_id: "n1", inner_node_name: "orders-db" },
      { id: "e4", label: "", technology: "", direction: "incoming", other_node_id: "w", other_node_name: "Витрина", inner_node_id: "n1", inner_node_name: "orders-db" },
    ] as Awaited<ReturnType<typeof nodesApi.getEdges>>);
    vi.mocked(nodesApi.deletionSnapshot).mockResolvedValue(snapshot({ node_docs: [{ id: "d1" }] } as Partial<DeletionSnapshot>));

    render(<NodeDeleteConfirm node={node()} onCancel={() => {}} onDeleted={vi.fn()} />);

    const list = await screen.findByRole("list");
    expect(list).toHaveClass("ds-confirm-list");
    const rows = within(list).getAllByRole("listitem").map((li) => [li.textContent, li.getAttribute("title")]);
    expect(rows).toEqual([
      ["«Оформление заказов» от API Gateway", "«Оформление заказов» от API Gateway"],
      ["«Kafka» к Kafka", "«Kafka» к Kafka"],
      ["связь к БД заказов", "связь к БД заказов"],
      ["связь от Витрина", "связь от Витрина"],
    ]);
    expect(screen.getByText("Его связи будут удалены вместе с ним:")).toHaveClass("ds-confirm-lead");
    expect(screen.getByText("Вместе с ним удалится документация: 1 схема логики.")).toHaveClass("ds-confirm-note");
    expect(nodesApi.delete).not.toHaveBeenCalled();
  });

  it("узел без связей, детей и документации удаляется без подтверждения", async () => {
    vi.mocked(nodesApi.deletionSnapshot).mockResolvedValue(snapshot());
    const onDeleted = vi.fn();

    render(<NodeDeleteConfirm node={node()} onCancel={() => {}} onDeleted={onDeleted} />);

    await waitFor(() => expect(nodesApi.delete).toHaveBeenCalledWith("n1"));
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(onDeleted).toHaveBeenCalled();
  });
});
