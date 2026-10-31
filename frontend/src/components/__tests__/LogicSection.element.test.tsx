// Секция «Логика» по элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md, Р34):
// схемы логики описывают код, поэтому у узла с вложенными объектами своих схем быть не
// должно (предупреждение и «Перенести документацию», меню «+ Добавить» нет). Система
// документацию потомков не собирает; контейнер с компонентами и составной компонент
// показывают схемы компонентов группами. Лист — как раньше. Три элемента × (пусто / свои
// схемы / схемы потомков).
import { render, screen } from "@testing-library/react";
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

function renderSection(element: PageElement, over: { docs?: NodeDocMeta[]; groups?: ContainerDocGroup[]; isArchitect?: boolean } = {}) {
  return render(
    <LogicSection
      node={node({ docs: over.docs ?? [] })}
      element={element}
      isArchitect={over.isArchitect ?? true}
      allowed
      legacy={false}
      groups={over.groups ?? []}
      loading={false}
      onOpen={vi.fn()}
      onTransfer={vi.fn()}
      onDocsAgent={vi.fn()}
      onReconAgent={vi.fn()}
      onNavigateNode={vi.fn()}
    />,
  );
}

const SYSTEM: PageElement = { kind: "system" };
const CONTAINER: PageElement = { kind: "container" };
const COMPOSITE: PageElement = { kind: "composite", container: { id: "c", name: "orders" } };

describe("LogicSection: система", () => {
  it("пусто — система, своих схем нет; меню «+ Добавить» нет", () => {
    renderSection(SYSTEM);
    expect(screen.getByText(
      "Это система, своих схем логики у неё нет. Схемы логики описывают у её контейнеров и компонентов",
    )).toBeInTheDocument();
    expect(screen.queryByText("+ Добавить")).not.toBeInTheDocument();
  });

  it("свои схемы — предупреждение, список и «Перенести документацию»", () => {
    renderSection(SYSTEM, { docs: [doc()] });
    expect(screen.getByText(
      "У системы остались собственные схемы логики. Схемы описывают код, их место у контейнеров и компонентов",
    )).toBeInTheDocument();
    expect(screen.getByText("Оформление заказа")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Перенести документацию" })).toBeInTheDocument();
  });

  it("схемы потомков страница системы не показывает (Р34)", () => {
    // Страница групп системе не отдаёт; секция их и не ждёт — пустое состояние системы.
    renderSection(SYSTEM, { groups: [] });
    expect(screen.queryByText("Схема api")).not.toBeInTheDocument();
    expect(screen.queryByText("Схемы компонентов")).not.toBeInTheDocument();
  });
});

describe("LogicSection: контейнер с компонентами", () => {
  it("пусто — схемы компонентов появятся, когда их опишут", () => {
    renderSection(CONTAINER);
    expect(screen.getByText("Схемы логики компонентов появятся здесь, когда их опишут")).toBeInTheDocument();
    expect(screen.queryByText("+ Добавить")).not.toBeInTheDocument();
  });

  it("свои схемы — предупреждение «их место у компонентов» и «Перенести документацию»", () => {
    renderSection(CONTAINER, { docs: [doc()], groups });
    expect(screen.getByText(
      "У контейнера есть свои схемы логики. Схемы описывают код, их место у компонентов",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Перенести документацию" })).toBeInTheDocument();
    expect(screen.getByText("Схемы компонентов")).toBeInTheDocument();
  });

  it("схемы компонентов — группами по детям, без пустого пояснения", () => {
    renderSection(CONTAINER, { groups });
    expect(screen.getByText("Схема api")).toBeInTheDocument();
    expect(screen.getByText("от api →")).toBeInTheDocument();
    expect(screen.queryByText(/появятся здесь/)).not.toBeInTheDocument();
  });
});

describe("LogicSection: составной компонент", () => {
  it("пусто, свои схемы и схемы вложенных — как у контейнера, словами компонента", () => {
    const { unmount } = renderSection(COMPOSITE);
    expect(screen.getByText("Схемы логики компонентов появятся здесь, когда их опишут")).toBeInTheDocument();
    unmount();
    renderSection(COMPOSITE, { docs: [doc()], groups });
    expect(screen.getByText(
      "У компонента есть свои схемы логики. Схемы описывают код, их место у вложенных компонентов",
    )).toBeInTheDocument();
    expect(screen.getByText("Схема api")).toBeInTheDocument();
  });
});

describe("LogicSection: объект без вложенных — как раньше", () => {
  it("контейнер без компонентов, компонент и внешняя система: свои схемы, меню «+ Добавить»", () => {
    const elements = [
      { kind: "leaf" }, { kind: "component", container: { id: "c", name: "orders" } }, { kind: "external" },
    ] as PageElement[];
    for (const element of elements) {
      const { unmount } = renderSection(element);
      expect(screen.getByText("Схемы логики не заданы")).toBeInTheDocument();
      expect(screen.getByText("+ Добавить")).toBeInTheDocument();
      unmount();
    }
  });
});

describe("LogicSection: внешняя система (Р42)", () => {
  it("свои схемы без предупреждения и без «Перенести документацию»: чёрный ящик описывают у него", () => {
    renderSection({ kind: "external" }, { docs: [doc()] });
    expect(screen.queryByText("Схемы логики не заданы")).toBeNull();
    expect(screen.getByText("+ Добавить")).toBeInTheDocument();
    expect(screen.queryByText(/остались собственные схемы/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Перенести документацию" })).toBeNull();
  });
});
