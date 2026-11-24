// Раздел «Схема» страницы объекта: «Переразложить» (кнопка в углу холста) с 2026-11-24 —
// команда самого холста (history.md U26): сброс вида фокуса каналом раскладки по персисту,
// который раздел отдаёт блоку. Своего сброса и перечитывания у раздела нет. Блок схемы и
// поллинг заглушены: здесь проверяется оркестрация раздела.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SchemaSection from "../nodePage/SchemaSection";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({ nodesApi: { getContextGraph: vi.fn() } }));
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
  });

  it("архитектор: блоку схемы — персист вида фокуса, своего сброса у раздела нет", async () => {
    render(
      <SchemaSection
        node={node("n1", "Заказы")} ancestors={[]} isArchitect onNavigateNode={vi.fn()}
        viewMeta={{ current: { version: 1, graphRev: 1, metaRev: 1 } }} mutationToken={0}
      />,
    );
    await screen.findByTestId("schema");
    expect(schemaProps.current?.persistence).toBeDefined();
    expect(schemaProps.current?.layoutViewId).toBe("n1");
    expect(schemaProps.current).not.toHaveProperty("onRelayout");
    expect(schemaProps.current).not.toHaveProperty("relayoutToken");
    expect(nodesApi.getContextGraph).toHaveBeenCalledTimes(1);
  });
});
