// Карточка «Свойства» страницы объекта по элементу архитектуры (Ф8 эпика
// docs/plan-c4-elements.md): у узла с детьми строки «Тип» нет (Р24), у термина «Элемент
// архитектуры» — справка «?», у компонента имя контейнера — ссылка на его страницу
// (контейнер берётся из крошек страницы), у внешнего листа — «Внешняя система»; сводная
// технология только у системы (Р15), у остальных своя и правится; плейсхолдер роли без
// слов форм. Хук правки свойств — настоящий (useNodePatch).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NodeProperties from "../nodePage/NodeProperties";
import { useNodePatch } from "../../pages/useNodePatch";
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

describe("NodeProperties: элемент архитектуры", () => {
  beforeEach(() => vi.clearAllMocks());

  it("у узла с детьми строки «Тип» нет, элемент — первой строкой; у листа «Тип» над элементом", () => {
    const { unmount } = setup(GROUP);
    expect(terms()[0]).toBe("Элемент архитектуры");
    expect(terms()).not.toContain("Тип");
    unmount();
    setup();
    expect(terms().slice(0, 2)).toEqual(["Тип", "Элемент архитектуры"]);
  });

  it("«?» у термина — справка о системе, контейнере и компоненте", async () => {
    setup({}, { isArchitect: false });
    await userEvent.click(screen.getByRole("button", { name: "Что такое система, контейнер и компонент" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Компонент. Вложенный объект контейнера");
  });

  it("компонент: «Компонент контейнера «orders»», имя ведёт на страницу контейнера", async () => {
    setup(
      { element_effective: "component", container_name: "orders", parent_id: "c" },
      { ancestors: [ancestor("s", "Торговля", "system"), ancestor("c", "orders", "container")] },
    );
    const link = screen.getByRole("button", { name: "«orders»" });
    expect(link.parentElement).toHaveTextContent("Компонент контейнера «orders»");
    await userEvent.click(link);
    expect(onNavigateNode).toHaveBeenCalledWith("c");
  });

  it("лист — «Контейнер», внешний лист — «Внешняя система»", () => {
    const { unmount } = setup({}, { isArchitect: false });
    expect(screen.getByText("Контейнер")).toBeInTheDocument();
    unmount();
    setup({ is_external: true }, { isArchitect: false });
    expect(screen.getByText("Внешняя система")).toBeInTheDocument();
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
