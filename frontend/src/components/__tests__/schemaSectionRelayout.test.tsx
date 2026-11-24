// Раздел «Схема» страницы объекта: «Переразложить» (кнопка в углу холста). Блок схемы
// и поллинг заглушены: здесь проверяется оркестрация раздела.
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SchemaSection from "../nodePage/SchemaSection";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({ nodesApi: { getContextGraph: vi.fn(), relayoutContext: vi.fn() } }));
vi.mock("../../pages/useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
const schemaProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../EmbeddedSchemaBlock", () => ({
  default: (p: Record<string, unknown>) => { schemaProps.current = p; return <div data-testid="schema" />; },
}));

const node = (id: string, name: string) => ({ id, name, shape: "service", parent_id: null, has_children: false, element_effective: "container" }) as Node;

describe("SchemaSection: «Переразложить»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue({
      nodes: [node("n1", "Заказы"), node("x", "Шлюз")], endpoints: [],
      edges: [{ id: "e1", label: "зовёт", technology: null, source_id: "n1", target_id: "x", version: 1 }],
      layout: { n1: { x: 0, y: 0 } }, version: 1, graph_rev: 1, meta_rev: 1,
    } as never);
    vi.mocked(nodesApi.relayoutContext).mockResolvedValue(undefined);
  });

  it("архитектор: сброс вида фокуса, токен блоку схемы, контекст перечитан", async () => {
    render(
      <SchemaSection
        node={node("n1", "Заказы")} ancestors={[]} isArchitect onNavigateNode={vi.fn()}
        viewMeta={{ current: { version: 1, graphRev: 1, metaRev: 1 } }} mutationToken={0}
      />,
    );
    await screen.findByTestId("schema");
    expect(schemaProps.current?.relayoutToken).toBe(0);
    const relayout = schemaProps.current?.onRelayout as () => void;
    await act(async () => { relayout(); });
    expect(nodesApi.relayoutContext).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(schemaProps.current?.relayoutToken).toBe(1));
    expect(nodesApi.getContextGraph).toHaveBeenCalledTimes(2);
  });
});
