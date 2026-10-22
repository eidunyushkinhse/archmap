// DeploymentPage (режим «Развёртывание», docs/tasks/deployment-view.md): загрузка графа →
// холст получает проекцию (состав площадок, предел вложенности, пометки), панель
// выделения считает объекты без повторов, «Снять выделение» — токеном холсту,
// «Переразложить» шлёт null-батч ключей deploy:, двойной клик ведёт на страницу объекта.
// Холст и поллинг замоканы: проверяется оркестрация страницы.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeploymentPage from "../DeploymentPage";
import type LevelGraph from "../../components/LevelGraph";
import { deploymentApi } from "../../api/deployment";
import { nodesApi, viewsApi } from "../../api/nodes";
import type { DeploymentGraph, DeploymentNode, Node as AppNode, SiteOut } from "../../types";

type LGProps = ComponentProps<typeof LevelGraph>;
const lg: { current: LGProps | null } = { current: null };

vi.mock("../../components/LevelGraph", () => ({
  default: (p: LGProps) => { lg.current = p; return <div data-testid="level-graph" />; },
}));
vi.mock("../../components/SchemaLegend", () => ({ default: () => null }));
vi.mock("../useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
vi.mock("../../api/deployment", () => ({ deploymentApi: { graph: vi.fn() } }));
vi.mock("../../api/nodes", () => ({
  nodesApi: { getAll: vi.fn() },
  viewsApi: { saveLayout: vi.fn() },
}));

function site(id: string, parent_id: string | null = null): SiteOut {
  return { id, name: id, kind: "vm", technology: null, description: null, parent_id, version: 1, instance_count: 0 };
}
function obj(id: string, places: string[]): DeploymentNode {
  return {
    id, name: id.toUpperCase(), description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    sites: [], version: 1, created_at: "", updated_at: "",
    instances: places, effective: places.map((site_id) => ({ site_id, inherited_from_id: null })),
  };
}
function graph(over: Partial<DeploymentGraph> = {}): DeploymentGraph {
  return {
    sites: [site("s1"), site("t")],
    nodes: [obj("a", ["s1", "t"]), obj("b", ["s1"])],
    edges: [{ id: "e1", label: null, technology: null, source_id: "a", target_id: "b", version: 1 }],
    layout: { "deploy:a@s1": { x: 10, y: 20 }, "deploy:site:s1": { x: 0, y: 0 } },
    version: 7, graph_rev: 3, meta_rev: 2,
    ...over,
  };
}

async function setup(isArchitect = true, g: DeploymentGraph = graph()) {
  vi.mocked(deploymentApi.graph).mockResolvedValue(g);
  const onOpenNode = vi.fn();
  render(<DeploymentPage isArchitect={isArchitect} onOpenNode={onOpenNode} />);
  if (g.nodes.length > 0) await screen.findByTestId("level-graph");
  return { onOpenNode };
}
const props = (): LGProps => {
  if (!lg.current) throw new Error("холст не отрисован");
  return lg.current;
};

describe("DeploymentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lg.current = null;
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      { id: "c1", name: "Витрина", parent_id: null, has_children: true } as AppNode,
      { id: "c2", name: "Каталог", parent_id: "c1", has_children: true } as AppNode,
      { id: "l1", name: "Лист", parent_id: "c1", has_children: false } as AppNode,
    ]);
    vi.mocked(viewsApi.saveLayout).mockResolvedValue({ version: 8, graph_rev: 4 });
  });

  it("загрузка → холст получает проекцию: площадки, состав, пометки, без предела вложенности", async () => {
    await setup();
    expect(deploymentApi.graph).toHaveBeenCalledWith(null);
    const p = props();
    expect(p.nodes.map((n) => n.id)).toEqual(["deploy:site:s1", "deploy:site:t"]);
    expect(p.containerId).toBeNull();
    expect(p.viewLayout).toEqual(graph().layout);
    expect(p.projection?.inlineDepth).toBe(Infinity);
    expect(Object.keys(p.projection?.children ?? {}).sort()).toEqual(["deploy:site:s1", "deploy:site:t"]);
    expect(p.projection?.marks).toEqual({ "deploy:a@s1": "1/2", "deploy:a@t": "2/2" });
    expect(p.mode).toMatchObject({ readOnly: true, arrangeOnly: true, edgesInspectable: false });
    expect(p.persistence?.viewMeta?.current).toEqual({ version: 7, graphRev: 3, metaRev: 2 });
  });

  it("выбор уровня: контейнеры с путём, смена уровня перечитывает граф этого уровня", async () => {
    await setup();
    const select = screen.getByRole("combobox", { name: "Уровень" });
    await waitFor(() => expect(screen.getByRole("option", { name: "Витрина / Каталог" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: /Лист/ })).toBeNull();
    await userEvent.selectOptions(select, "c2");
    await waitFor(() => expect(deploymentApi.graph).toHaveBeenLastCalledWith("c2"));
  });

  it("панель выделения считает объекты без повторов; «Снять выделение» — токеном холсту", async () => {
    await setup();
    act(() => { props().drill.onSelectionChange?.(["deploy:a@s1", "deploy:a@t", "deploy:b@s1", "deploy:site:t"]); });
    expect(screen.getByRole("status")).toHaveTextContent("Выбрано 2 объекта");
    expect(props().projection?.clearSelectionToken).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Снять выделение" }));
    expect(props().projection?.clearSelectionToken).toBe(1);
    act(() => { props().drill.onSelectionChange?.(["deploy:b@s1"]); });
    expect(screen.getByRole("status")).toHaveTextContent("Выбран 1 объект");
  });

  it("«Переразложить» шлёт null-батч всех ключей deploy: вида с версией и перечитывает граф", async () => {
    await setup();
    await userEvent.click(screen.getByRole("button", { name: "Переразложить" }));
    await waitFor(() => expect(viewsApi.saveLayout).toHaveBeenCalledWith(
      null, { "deploy:a@s1": null, "deploy:site:s1": null }, 7,
    ));
    await waitFor(() => expect(deploymentApi.graph).toHaveBeenCalledTimes(2));
    expect(props().relayoutToken).toBe(1);
  });

  it("двойной клик по карточке → страница объекта; по площадке — ничего", async () => {
    const { onOpenNode } = await setup();
    const card = props().projection?.children?.["deploy:site:t"]?.[0] as AppNode;
    props().drill.onEditNode(card);
    expect(onOpenNode).toHaveBeenCalledWith("a");
    props().drill.onEditNode(props().nodes[0]);
    expect(onOpenNode).toHaveBeenCalledTimes(1);
  });

  it("читатель: ни панели выделения, ни «Переразложить», расстановки нет", async () => {
    await setup(false);
    expect(props().mode).toMatchObject({ readOnly: true, arrangeOnly: false });
    expect(props().persistence).toBeUndefined();
    act(() => { props().drill.onSelectionChange?.(["deploy:a@s1"]); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Переразложить" })).toBeNull();
  });

  it("нет листьев — заглушка вместо холста", async () => {
    await setup(true, graph({ nodes: [], edges: [], layout: {} }));
    expect(await screen.findByText("Нет объектов для размещения")).toBeInTheDocument();
    expect(screen.queryByTestId("level-graph")).toBeNull();
  });
});
