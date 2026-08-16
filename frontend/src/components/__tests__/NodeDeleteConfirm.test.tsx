// Подтверждение удаления узла: что именно человек видит перед удалением.
// Ключевое — задокументированный узел БЕЗ связей и детей больше не уезжает молча:
// прежде «терять нечего» считалось только по связям и детям, и база с таблицами
// удалялась вообще без вопроса.
import { render, screen, waitFor } from "@testing-library/react";
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

    await userEvent.click(screen.getByText("Да, удалить"));
    await waitFor(() => expect(nodesApi.delete).toHaveBeenCalledWith("n1"));
    // В историю уходит ТОТ ЖЕ снимок, что показали: вернётся ровно показанное.
    expect(onDeleted).toHaveBeenCalledWith("n1", snap);
  });

  it("узел без связей, детей и документации удаляется без подтверждения", async () => {
    vi.mocked(nodesApi.deletionSnapshot).mockResolvedValue(snapshot());
    const onDeleted = vi.fn();

    render(<NodeDeleteConfirm node={node()} onCancel={() => {}} onDeleted={onDeleted} />);

    await waitFor(() => expect(nodesApi.delete).toHaveBeenCalledWith("n1"));
    expect(screen.queryByText("Да, удалить")).toBeNull();
    expect(onDeleted).toHaveBeenCalled();
  });
});
