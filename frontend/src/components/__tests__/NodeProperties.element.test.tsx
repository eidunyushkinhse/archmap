// Карточка «Свойства» страницы объекта: одна строка «Тип» (Р40 раздела 13
// docs/plan-c4-elements.md) у любого объекта, у термина — справка «?»; у компонента имя
// контейнера — ссылка на его страницу (контейнер берётся из крошек страницы); невозможные
// пункты серые с причиной; сводная технология только у системы (Р15), у остальных своя и
// правится; плейсхолдер роли без слов форм. Хук правки свойств — настоящий (useNodePatch).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NodeProperties from "../nodePage/NodeProperties";
import { useNodePatch } from "../../pages/useNodePatch";
import { nodesApi } from "../../api/nodes";
import type { AncestorRef, Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { update: vi.fn(), get: vi.fn(), getAll: vi.fn(), anchorPreview: vi.fn(), elementPreview: vi.fn() },
}));
vi.mock("../../api/deployment", () => ({
  deploymentApi: { sites: vi.fn(), setPlacements: vi.fn(), createSite: vi.fn() },
}));

function node(over: Partial<Node> = {}): Node {
  return {
    id: "n1", name: "api", description: null, role: null, technology: "Go", parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "container", container_name: null,
    version: 1, created_at: "", updated_at: "", sites: [],
    ...over,
  };
}

const ancestor = (id: string, name: string, element_effective: AncestorRef["element_effective"]): AncestorRef =>
  ({ id, name, is_external: false, element_effective });

const onNavigateNode = vi.fn();

function Harness({ n, ancestors, isArchitect, isSystem, aggTech }: {
  n: Node; ancestors: AncestorRef[]; isArchitect: boolean; isSystem: boolean; aggTech: string;
}) {
  const patch = useNodePatch(n);
  return (
    <NodeProperties
      patch={patch}
      ancestors={ancestors}
      isArchitect={isArchitect}
      isSystem={isSystem}
      techLoading={false}
      aggTech={aggTech}
      containerSites={null}
      onNavigateNode={onNavigateNode}
      onPlacementChanged={vi.fn()}
    />
  );
}

function setup(over: Partial<Node> = {}, opts: {
  ancestors?: AncestorRef[]; isArchitect?: boolean; isSystem?: boolean; aggTech?: string;
} = {}) {
  return render(
    <Harness
      n={node(over)}
      ancestors={opts.ancestors ?? []}
      isArchitect={opts.isArchitect ?? true}
      isSystem={opts.isSystem ?? false}
      aggTech={opts.aggTech ?? ""}
    />,
  );
}

const terms = () => [...document.querySelectorAll(".np-term")].map((t) => t.textContent);
const GROUP: Partial<Node> = { has_children: true, child_count: 2, element: "container", element_effective: "container" };

describe("NodeProperties: строка «Тип»", () => {
  beforeEach(() => vi.clearAllMocks());

  const typeButton = () => screen.getByRole("button", { name: "Тип" });
  const option = (label: string) => screen.getByRole("option", { name: new RegExp(`^${label}`) });

  it("одна строка «Тип» первой — у листа и у узла с детьми; «Элемент архитектуры» нет (Р40)", () => {
    const { unmount } = setup(GROUP);
    expect(terms()[0]).toBe("Тип");
    expect(terms()).not.toContain("Элемент архитектуры");
    expect(typeButton()).toHaveTextContent("Контейнер");
    unmount();
    setup();
    expect(terms()[0]).toBe("Тип");
    expect(terms().filter((t) => t === "Тип")).toHaveLength(1);
  });

  it("«?» у термина — справка о системе, контейнере и компоненте", async () => {
    setup({}, { isArchitect: false });
    await userEvent.click(screen.getByRole("button", { name: "Что такое система, контейнер и компонент" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Компонент. Вложенный объект контейнера");
  });

  it("компонент у архитектора: «Компонент» в выпадашке, имя контейнера ведёт на его страницу", async () => {
    setup(
      { element_effective: "component", container_name: "orders", parent_id: "c" },
      { ancestors: [ancestor("s", "Торговля", "system"), ancestor("c", "orders", "container")] },
    );
    expect(typeButton()).toHaveTextContent("Компонент");
    // Первая ссылка — строка «Тип», вторая — «как у контейнера» в размещении.
    const [link] = screen.getAllByRole("button", { name: "«orders»" });
    expect(link.parentElement).toHaveTextContent("Входит в контейнер «orders»");
    await userEvent.click(link);
    expect(onNavigateNode).toHaveBeenCalledWith("c");
  });

  it("компонент у читателя — «Компонент контейнера «orders»»", () => {
    setup(
      { element_effective: "component", container_name: "orders", parent_id: "c" },
      { isArchitect: false, ancestors: [ancestor("s", "Торговля", "system"), ancestor("c", "orders", "container")] },
    );
    const [link] = screen.getAllByRole("button", { name: "«orders»" });
    expect(link.parentElement).toHaveTextContent("Компонент контейнера «orders»");
  });

  it("лист — «Контейнер», внешний лист тоже, пустая система — «Система»", () => {
    const { unmount } = setup({}, { isArchitect: false });
    expect(screen.getByText("Контейнер")).toBeInTheDocument();
    unmount();
    const external = setup({ is_external: true }, { isArchitect: false });
    expect(screen.getByText("Контейнер")).toBeInTheDocument();
    external.unmount();
    setup({ element: "system", element_effective: "system" }, { isArchitect: false });
    expect(screen.getByText("Система")).toBeInTheDocument();
  });

  it("смена формы — PATCH формы; серый пункт объясняет причину и не выбирается", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(node({ shape: "broker", version: 2 }));
    setup();
    await userEvent.click(typeButton());
    const component = option("Компонент");
    expect(component).toHaveAttribute("aria-disabled", "true");
    expect(component).toHaveTextContent("Компонентом объект бывает только внутри контейнера.");
    await userEvent.click(component);
    expect(nodesApi.update).not.toHaveBeenCalled();
    await userEvent.click(option("Брокер"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({ shape: "broker", base_version: 1 });
  });

  it("технология: у контейнера с компонентами своя полем, у системы сводная без поля", () => {
    const { unmount } = setup(GROUP);
    expect(screen.getByDisplayValue("Go")).toBeInTheDocument();
    unmount();
    setup({ ...GROUP, element: null, element_effective: "system" }, { isSystem: true, aggTech: "Python, Kafka" });
    expect(screen.getByText("Python, Kafka")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Go")).not.toBeInTheDocument();
  });

  it("поле «Роль» подсказывает роли, а не формы", () => {
    setup();
    expect(screen.getByPlaceholderText("API, воркер, шлюз…")).toBeInTheDocument();
  });
});
