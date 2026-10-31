// Выбор участников процесса: глиф строки — тот же вид узла, что в дереве объектов
// (treeNesting). Пустая система (Р39) — глиф системы, хотя вложенных у неё нет.
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ParticipantPicker from "../processes/ParticipantPicker";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({ nodesApi: { getAll: vi.fn() } }));

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id, name: id, description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "container", container_name: null,
    version: 1, created_at: "", updated_at: "", sites: [], ...over,
  };
}

const nestingOf = (name: string) =>
  screen.getByText(name).parentElement?.querySelector(".nt-glyph")?.getAttribute("data-nesting");

describe("ParticipantPicker: глиф строки", () => {
  it("пустая система — глиф системы, лист — глиф листа, система с детьми — системы", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      node("Склад", { element: "system", element_effective: "system" }),
      node("orders"),
      node("Торговля", { has_children: true, child_count: 1, element_effective: "system" }),
      node("api", { parent_id: "Торговля" }),
    ]);
    render(<ParticipantPicker added={new Set()} onAdd={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Склад")).toBeInTheDocument());
    expect(nestingOf("Склад")).toBe("system");
    expect(nestingOf("orders")).toBe("leaf");
    expect(nestingOf("Торговля")).toBe("system");
  });
});
