// Раздел «Логика» по элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md, Р34):
// схемы логики описывают код, поэтому у узла с вложенными объектами своих схем быть не
// должно (предупреждение и «Перенести документацию», меню «Добавить» нет). Система
// документацию потомков не собирает; контейнер с компонентами и составной компонент
// показывают схемы компонентов подгруппами. Три элемента × (пусто / свои схемы / схемы
// потомков).
//
// Видимость (редизайн, направление А): раздел, которому нечего показать и нечего
// предложить, не рисуется вовсе. Подходит объекту и пуст — у редактора заголовок и
// «Добавить», у читателя ничего; не подходит и пуст — раздела нет ни у кого.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import LogicSection from "../nodePage/LogicSection";
import type { PageElement } from "../element/elementView";
import type { ContainerDocGroup } from "../../pages/useContainerChildren";
import type { Node, NodeDocMeta } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodeDocsApi: { usage: vi.fn(() => Promise.resolve([])) },
}));

const doc = (over: Partial<NodeDocMeta> = {}): NodeDocMeta =>
  ({ id: "d1", name: "Оформление заказа", kind: "operation", operation: null, version: 1, described: true, ...over });

function node(over: Partial<Node> = {}): Node {
  return {
    id: "n1", name: "orders", description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 2, has_children: true, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "system", container_name: null,
    version: 1, created_at: "", updated_at: "", sites: [],
    ...over,
  };
}

const kid = node({ id: "k1", name: "api", has_children: false, child_count: 0, parent_id: "n1" });
const groups: ContainerDocGroup[] = [{ child: kid, own: [doc({ id: "dk", name: "Схема api" })], deep: [] }];

function renderSection(element: PageElement, over: { docs?: NodeDocMeta[]; groups?: ContainerDocGroup[]; isArchitect?: boolean; onNavigateNode?: (id: string) => void } = {}) {
  return render(
    <LogicSection
      node={node({ docs: over.docs ?? [] })}
      element={element}
      isArchitect={over.isArchitect ?? true}
      allowed
      legacy={false}
      groups={over.groups ?? []}
      onOpen={vi.fn()}
      onTransfer={vi.fn()}
      onDocsAgent={vi.fn()}
      onReconAgent={vi.fn()}
      onNavigateNode={over.onNavigateNode ?? vi.fn()}
    />,
  );
}

const SYSTEM: PageElement = { kind: "system" };
const CONTAINER: PageElement = { kind: "container" };
const COMPOSITE: PageElement = { kind: "composite", container: { id: "c", name: "orders" } };

describe("LogicSection: система", () => {
  it("пусто — раздела нет ни у редактора, ни у читателя", () => {
    const { container, unmount } = renderSection(SYSTEM);
    expect(container).toBeEmptyDOMElement();
    unmount();
    const reader = renderSection(SYSTEM, { isArchitect: false });
    expect(reader.container).toBeEmptyDOMElement();
  });

  it("свои схемы — предупреждение, список и «Перенести документацию»", () => {
    renderSection(SYSTEM, { docs: [doc()] });
    expect(screen.getByText(
      "У системы остались собственные схемы логики. Схемы описывают код, их можно перенести контейнерам и компонентам",
    )).toBeInTheDocument();
    expect(screen.getByText("Оформление заказа")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Перенести документацию" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });

  it("схемы потомков страница системы не показывает (Р34)", () => {
    renderSection(SYSTEM, { groups: [] });
    expect(screen.queryByText("Схема api")).not.toBeInTheDocument();
  });
});

describe("LogicSection: контейнер с компонентами", () => {
  it("пусто — раздела нет: новую логику заводят у компонентов", () => {
    const { container } = renderSection(CONTAINER);
    expect(container).toBeEmptyDOMElement();
  });

  it("свои схемы — предупреждение «их можно перенести компонентам» и «Перенести документацию»", () => {
    renderSection(CONTAINER, { docs: [doc()], groups });
    expect(screen.getByText(
      "У контейнера есть свои схемы логики. Схемы описывают код, их можно перенести компонентам",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Перенести документацию" })).toBeInTheDocument();
    expect(screen.getByText("Схема api")).toBeInTheDocument();
  });

  it("схемы компонентов — подгруппами по детям: подпись ведёт на страницу ребёнка", async () => {
    const onNavigateNode = vi.fn();
    renderSection(CONTAINER, { groups, onNavigateNode });
    expect(screen.getByRole("heading", { name: "Логика" })).toBeInTheDocument();
    expect(screen.getByText("Схема api")).toBeInTheDocument();
    // Подгруппа без рамки и счётчика: подпись — имя ребёнка.
    await userEvent.click(screen.getByRole("button", { name: "api" }));
    expect(onNavigateNode).toHaveBeenCalledWith("k1");
    expect(screen.queryByText(/появятся здесь/)).not.toBeInTheDocument();
  });

  it("у читателя схемы компонентов видны так же", () => {
    renderSection(CONTAINER, { groups, isArchitect: false });
    expect(screen.getByText("Схема api")).toBeInTheDocument();
  });
});

describe("LogicSection: составной компонент", () => {
  it("пусто — раздела нет; свои схемы и схемы вложенных — как у контейнера, словами компонента", () => {
    const { container, unmount } = renderSection(COMPOSITE);
    expect(container).toBeEmptyDOMElement();
    unmount();
    renderSection(COMPOSITE, { docs: [doc()], groups });
    expect(screen.getByText(
      "У компонента есть свои схемы логики. Схемы описывают код, их можно перенести вложенным компонентам",
    )).toBeInTheDocument();
    expect(screen.getByText("Схема api")).toBeInTheDocument();
  });
});

describe("LogicSection: объект без вложенных", () => {
  it("пусто у редактора — заголовок и «Добавить», без пустой строки", () => {
    const elements = [
      { kind: "leaf" }, { kind: "component", container: { id: "c", name: "orders" } }, { kind: "external" },
    ] as PageElement[];
    for (const element of elements) {
      const { unmount } = renderSection(element);
      expect(screen.getByRole("heading", { name: "Логика" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Добавить" })).toBeInTheDocument();
      expect(screen.queryByText("Схемы логики не описаны")).toBeNull();
      unmount();
    }
  });

  it("пусто у читателя — раздела нет", () => {
    const { container } = renderSection({ kind: "leaf" }, { isArchitect: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("одни заглушки — свёрнутый «Не описано» со счётчиком, а не «описанных пока нет»", () => {
    renderSection({ kind: "leaf" }, { docs: [doc({ described: false }), doc({ id: "d2", name: "GET /x", described: false })] });
    expect(screen.getByRole("button", { name: /Не описано/ })).toHaveTextContent("(2)");
    expect(screen.queryByText("Описанных схем логики пока нет")).toBeNull();
  });

  it("строка схемы: имя и операция моноширинным, без пилюли вида и «открыть →»", () => {
    renderSection({ kind: "leaf" }, { docs: [doc({ operation: "POST /orders" })] });
    const row = screen.getByRole("button", { name: /Оформление заказа/ });
    expect(row).toHaveTextContent("POST /orders");
    expect(screen.getByText("POST /orders")).toHaveClass("ds-mono");
    expect(screen.getByText("Операции")).toHaveClass("ds-sub");
    expect(screen.queryByText("операция")).toBeNull();
    expect(screen.queryByText(/открыть/)).toBeNull();
  });
});

describe("LogicSection: схемы у формы без кода", () => {
  it("база данных со схемами — предупреждение словами типов, без «сервиса»", () => {
    render(
      <LogicSection
        node={node({ docs: [doc()], shape: "database", has_children: false, child_count: 0, element_effective: null })}
        element={{ kind: "leaf" }}
        isArchitect
        allowed={false}
        legacy
        groups={[]}
        onOpen={vi.fn()}
        onTransfer={vi.fn()}
        onDocsAgent={vi.fn()}
        onReconAgent={vi.fn()}
        onNavigateNode={vi.fn()}
      />,
    );
    expect(screen.getByText(
      "Схемы логики описывают код контейнера или компонента, а у этого объекта его нет. Перенесите их объекту, который с ним работает.",
    )).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });

  it("база данных без схем — раздела нет", () => {
    const { container } = render(
      <LogicSection
        node={node({ docs: [], shape: "database", has_children: false, child_count: 0, element_effective: null })}
        element={{ kind: "leaf" }}
        isArchitect
        allowed={false}
        legacy={false}
        groups={[]}
        onOpen={vi.fn()}
        onTransfer={vi.fn()}
        onDocsAgent={vi.fn()}
        onReconAgent={vi.fn()}
        onNavigateNode={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("LogicSection: внешняя система (Р42)", () => {
  it("свои схемы без предупреждения и без «Перенести документацию»: чёрный ящик описывают у него", () => {
    renderSection({ kind: "external" }, { docs: [doc()] });
    expect(screen.getByRole("button", { name: "Добавить" })).toBeInTheDocument();
    expect(screen.queryByText(/остались собственные схемы/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Перенести документацию" })).toBeNull();
  });
});
