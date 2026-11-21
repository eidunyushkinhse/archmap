// Строка «Размещение» по элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md):
// площадки хранятся у контейнера. Контейнер (лист или с компонентами) правит их сам
// (значение — кнопка окна); у системы — площадки её контейнеров, частичная поясняется
// подсказкой; компонент размещается вместе с контейнером: площадки контейнера без
// правки, контейнер назван в подсказке строки. Читателю строка без площадок не рисуется.
import { render, screen } from "@testing-library/react";
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

function renderRow(element: PageElement, over: { n?: Partial<Node>; containerSites?: Site[] | null; isArchitect?: boolean } = {}) {
  return render(
    <div>
      <PlacementRow
        node={node(over.n)}
        element={element}
        containerSites={over.containerSites === undefined ? null : over.containerSites}
        isArchitect={over.isArchitect ?? true}
        onChanged={vi.fn()}
      />
    </div>,
  );
}

const COMPONENT: PageElement = { kind: "component", container: { id: "c", name: "orders" } };
const editButton = () => screen.queryByRole("button", { name: "Изменить размещение" });

describe("PlacementRow: элемент архитектуры", () => {
  it("компонент — площадки контейнера без правки, контейнер назван в подсказке строки", () => {
    renderRow(COMPONENT, { containerSites: [EU, RU] });
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
    expect(screen.getByText("prod-ru")).toBeInTheDocument();
    expect(screen.getByText("Размещение").closest(".np-prop")).toHaveAttribute(
      "title", "Как у контейнера «orders»: компонент размещается вместе с ним",
    );
    expect(editButton()).toBeNull();
    expect(screen.queryByText(/как у контейнера/)).toBeNull();
  });

  it("компонент, контейнер без площадок: редактору «не указано», читателю строки нет", () => {
    const { unmount } = renderRow(COMPONENT, { containerSites: [], isArchitect: false });
    expect(screen.queryByText("Размещение")).toBeNull();
    unmount();
    renderRow(COMPONENT, { containerSites: [] });
    expect(screen.getByText("не указано")).toBeInTheDocument();
  });

  it("контейнер с компонентами — свои площадки и «Изменить», как у листа", () => {
    renderRow({ kind: "container" }, {
      n: { name: "orders", has_children: true, child_count: 2, element: "container", element_effective: "container", sites: [EU] },
    });
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
    expect(editButton()).not.toBeNull();
    expect(screen.getByText("Размещение").closest(".np-prop")).not.toHaveAttribute("title");
  });

  it("внешняя система (Р42) — размещение не ведётся, без «Изменить»; читателю строки нет", () => {
    const n = { name: "Банк", parent_id: null, is_external: true, element_effective: "system" as const, container_name: null };
    const { unmount } = renderRow({ kind: "external" }, { n, isArchitect: false });
    expect(screen.queryByText("Размещение")).toBeNull();
    unmount();
    renderRow({ kind: "external" }, { n });
    expect(screen.getByText("не ведётся у внешней системы")).toBeInTheDocument();
    expect(editButton()).toBeNull();
  });

  it("система — площадки её контейнеров; частичная поясняется подсказкой, цвет обычный", () => {
    renderRow({ kind: "system" }, {
      n: { name: "Торговля", has_children: true, child_count: 2, element_effective: "system", sites: [EU, { ...RU, partial: true }] },
    });
    expect(screen.getByText("prod-ru")).toHaveClass("np-site", { exact: true });
    expect(screen.getByText("prod-ru")).toHaveAttribute("title", "Здесь размещена часть контейнеров системы");
    expect(screen.getByText("prod-eu")).toHaveClass("np-site", { exact: true });
    expect(screen.queryByText(/часть контейнеров/)).toBeNull();
    expect(editButton()).not.toBeNull();
  });
});
