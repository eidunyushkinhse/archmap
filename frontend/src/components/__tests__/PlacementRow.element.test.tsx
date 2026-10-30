// Строка «Размещение» по элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md):
// площадки хранятся у контейнера. Контейнер (лист или с компонентами) правит их сам
// («Изменить»); у системы — площадки её контейнеров, частичная — «часть контейнеров»;
// компонент размещается вместе с контейнером: площадки контейнера, серым «как у
// контейнера «orders»» со ссылкой на его страницу, без «Изменить», редактору — пометка.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PlacementRow from "../nodePage/PlacementRow";
import type { PageElement } from "../element/elementView";
import type { Node } from "../../types";

vi.mock("../../api/deployment", () => ({ deploymentApi: { sites: vi.fn() } }));

type Site = Node["sites"][number];
const EU: Site = { id: "eu", name: "prod-eu", kind: "kubernetes", partial: false };
const RU: Site = { id: "ru", name: "prod-ru", kind: "kubernetes", partial: false };

function node(over: Partial<Node> = {}): Node {
  return {
    id: "n1", name: "api", description: null, role: null, technology: null, parent_id: "c",
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "component", container_name: "orders",
    version: 1, created_at: "", updated_at: "", sites: [],
    ...over,
  };
}

const onNavigateNode = vi.fn();

function renderRow(element: PageElement, over: { n?: Partial<Node>; containerSites?: Site[] | null; isArchitect?: boolean } = {}) {
  return render(
    <div>
      <PlacementRow
        node={node(over.n)}
        element={element}
        containerSites={over.containerSites === undefined ? null : over.containerSites}
        isArchitect={over.isArchitect ?? true}
        onChanged={vi.fn()}
        onNavigateNode={onNavigateNode}
      />
    </div>,
  );
}

const COMPONENT: PageElement = { kind: "component", container: { id: "c", name: "orders" } };
const editButton = () => screen.queryByRole("button", { name: "Изменить размещение" });

describe("PlacementRow: элемент архитектуры", () => {
  it("компонент — площадки контейнера и «как у контейнера «orders»» ссылкой, без «Изменить»", async () => {
    renderRow(COMPONENT, { containerSites: [EU, RU] });
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
    expect(screen.getByText("prod-ru")).toBeInTheDocument();
    expect(screen.getByText(/как у контейнера/)).toHaveTextContent("как у контейнера «orders»");
    expect(editButton()).toBeNull();
    expect(screen.getByText("Компонент размещается вместе с контейнером")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "«orders»" }));
    expect(onNavigateNode).toHaveBeenCalledWith("c");
  });

  it("компонент у читателя — без пометки; контейнер без площадок — «не указано»", () => {
    renderRow(COMPONENT, { containerSites: [], isArchitect: false });
    expect(screen.getByText("не указано")).toBeInTheDocument();
    expect(screen.queryByText("Компонент размещается вместе с контейнером")).toBeNull();
  });

  it("контейнер компонента не найден в крошках — имя текстом, без ссылки", () => {
    renderRow({ kind: "component", container: { id: null, name: "orders" } }, { containerSites: null });
    expect(screen.getByText(/как у контейнера/)).toHaveTextContent("как у контейнера «orders»");
    expect(screen.queryByRole("button", { name: "«orders»" })).toBeNull();
  });

  it("контейнер с компонентами — свои площадки и «Изменить», как у листа", () => {
    renderRow({ kind: "container" }, {
      n: { name: "orders", has_children: true, child_count: 2, element: "container", element_effective: "container", sites: [EU] },
    });
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
    expect(editButton()).not.toBeNull();
    expect(screen.queryByText(/как у контейнера/)).toBeNull();
  });

  it("система — площадки её контейнеров, частичная — «часть контейнеров»", () => {
    renderRow({ kind: "system" }, {
      n: { name: "Торговля", has_children: true, child_count: 2, element_effective: "system", sites: [EU, { ...RU, partial: true }] },
    });
    expect(screen.getAllByText("часть контейнеров")).toHaveLength(1);
    expect(editButton()).not.toBeNull();
  });
});
