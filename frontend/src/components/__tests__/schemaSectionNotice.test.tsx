// Раздел «Схема» страницы объекта: чужая правка схемы (graph_rev) показывает тост внутри
// рамки схемы. Сам тост рисует блок схемы (EmbeddedSchemaBlock, проп notice), раздел лишь
// передаёт текст и держит срок: ровно 4 с (редизайн, фаза 13б, хвост приёмки 13а). Блок
// схемы и поллинг заглушены: здесь проверяется оркестрация раздела.
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SchemaSection from "../nodePage/SchemaSection";
import { nodesApi } from "../../api/nodes";
import { useRemoteSync } from "../../pages/useRemoteSync";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({ nodesApi: { getContextGraph: vi.fn() } }));
vi.mock("../../pages/useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
vi.mock("../EmbeddedSchemaBlock", () => ({
  default: ({ title, notice }: { title: string; notice?: string | null }) => (
    <div data-testid="schema" data-title={title} data-notice={notice ?? ""} />
  ),
}));

const TEXT = "Схему только что изменили в другом окне";
const node = (id: string, name: string) => ({ id, name, shape: "service", parent_id: null, has_children: false, element_effective: "container" }) as Node;

describe("SchemaSection: тост чужой правки схемы", () => {
  it("graph_rev вырос: блок схемы получает текст тоста, через 4 с — пусто; своей разметки тоста нет", async () => {
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue({
      nodes: [node("n1", "Заказы"), node("x", "Шлюз")], endpoints: [],
      edges: [{ id: "e1", label: "зовёт", technology: null, source_id: "n1", target_id: "x", version: 1 }],
      layout: {}, version: 1, graph_rev: 1, meta_rev: 1,
    } as never);
    render(
      <SchemaSection
        node={node("n1", "Заказы")} ancestors={[]} isArchitect={false} onNavigateNode={vi.fn()}
        viewMeta={{ current: { version: 1, graphRev: 1, metaRev: 1 } }} mutationToken={0}
      />,
    );
    const schema = await screen.findByTestId("schema");
    expect(schema).toHaveAttribute("data-title", "Схема");
    expect(schema).toHaveAttribute("data-notice", "");
    const sync = vi.mocked(useRemoteSync).mock.calls.at(-1)?.[0] as { onRemoteChange: () => void };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => { sync.onRemoteChange(); });
      expect(screen.getByTestId("schema")).toHaveAttribute("data-notice", TEXT);
      expect(document.querySelector(".ds-toast")).toBeNull();
      act(() => { vi.advanceTimersByTime(3999); });
      expect(screen.getByTestId("schema")).toHaveAttribute("data-notice", TEXT);
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByTestId("schema")).toHaveAttribute("data-notice", "");
    } finally {
      vi.useRealTimers();
    }
  });
});
