// Раздел «OpenAPI» по элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md, Р34): API
// отдаёт контейнер. У контейнера своя спецификация без предупреждения, спецификации
// компонентов — с пометкой «не на месте» и «Собрать с компонентов»; у системы своего API
// нет (старая спецификация — с предупреждением и «Перенести документацию», групп нет); у
// компонента раздела нет, кроме старых данных. Три элемента × (пусто / своя спецификация /
// спецификации потомков).
//
// Видимость (редизайн, направление А): раздел, которому нечего показать и нечего
// предложить, не рисуется вовсе. Подходит объекту и пуст — у редактора заголовок и
// «Добавить», у читателя ничего; не подходит и пуст — раздела нет ни у кого.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import OpenApiSection from "../nodePage/OpenApiSection";
import type { PageElement } from "../element/elementView";
import type { ContainerSpecGroup } from "../../pages/useContainerChildren";
import type { Node } from "../../types";

const kid = {
  id: "k1", name: "api", description: null, role: null, technology: null, parent_id: "n1",
  openapi_spec: "openapi: 3.0.0", docs: [], is_external: false, shape: "service", status: "existing",
  child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
  element: null, element_effective: "component", container_name: "orders",
  version: 1, created_at: "", updated_at: "", sites: [],
} satisfies Node;
const groups: ContainerSpecGroup[] = [{ child: kid, own: true, deep: [] }];

const onNavigateNode = vi.fn();
const onCollect = vi.fn();
const onTransfer = vi.fn();
const onOpenChildSpec = vi.fn();

function renderSection(element: PageElement, over: {
  spec?: string | null; groups?: ContainerSpecGroup[]; isArchitect?: boolean; collect?: boolean;
} = {}) {
  return render(
    <OpenApiSection
      spec={over.spec ?? null}
      element={element}
      isArchitect={over.isArchitect ?? true}
      allowed
      legacy={false}
      groups={over.groups ?? []}
      onOpen={vi.fn()}
      onOpenChildSpec={onOpenChildSpec}
      onTransfer={element.kind === "system" ? onTransfer : undefined}
      onCollect={over.collect ? onCollect : undefined}
      onNavigateNode={onNavigateNode}
    />,
  );
}

const ORDERS = { id: "c", name: "orders" };

describe("OpenApiSection: система", () => {
  it("пусто — раздела нет: своего API у системы нет", () => {
    const { container } = renderSection({ kind: "system" });
    expect(container).toBeEmptyDOMElement();
  });

  it("своя спецификация — предупреждение, строка и «Перенести документацию»", () => {
    renderSection({ kind: "system" }, { spec: "openapi: 3.0.0" });
    expect(screen.getByText(
      "У системы осталась собственная спецификация. API отдают контейнеры, перенесите её одному из них",
    )).toBeInTheDocument();
    expect(screen.getByText("Спецификация")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Перенести документацию" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });

  it("спецификации потомков страница системы не показывает (Р34)", () => {
    const { container } = renderSection({ kind: "system" }, { groups });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("OpenApiSection: внешняя система (Р42)", () => {
  it("своя спецификация — норма: строка без предупреждения и без «Перенести документацию»", () => {
    renderSection({ kind: "external" }, { spec: "openapi: 3.0.0" });
    expect(screen.getByText("Спецификация")).toBeInTheDocument();
    expect(screen.queryByText(/У системы осталась собственная спецификация/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Перенести документацию" })).toBeNull();
  });

  it("пусто — «Добавить», как у объекта без вложенных", () => {
    renderSection({ kind: "external" });
    expect(screen.getByRole("button", { name: "Добавить" })).toBeInTheDocument();
  });
});

describe("OpenApiSection: контейнер", () => {
  it("пусто у редактора — заголовок и «Добавить», без пустой строки", () => {
    renderSection({ kind: "container" });
    expect(screen.getByRole("heading", { name: "OpenAPI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Добавить" })).toBeInTheDocument();
    expect(screen.queryByText("Спецификация не описана")).toBeNull();
  });

  it("пусто у читателя — раздела нет", () => {
    const { container } = renderSection({ kind: "container" }, { isArchitect: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("своя спецификация — строка «Спецификация» без предупреждения, «Добавить» нет", () => {
    renderSection({ kind: "container" }, { spec: "openapi: 3.0.0" });
    expect(screen.getByRole("button", { name: "Спецификация" })).toBeInTheDocument();
    expect(document.querySelector(".np-warn")).toBeNull();
    expect(screen.queryByRole("button", { name: "Перенести документацию" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });

  it("спецификации компонентов — с пометкой «не на месте» и «Собрать с компонентов»", async () => {
    renderSection({ kind: "container" }, { spec: "openapi: 3.0.0", groups, collect: true });
    expect(screen.getByText("Спецификацию отдаёт контейнер целиком, у компонентов она не на месте")).toBeInTheDocument();
    // Подгруппа — имя компонента (ведёт на его страницу), под ней строка его спецификации.
    await userEvent.click(screen.getByRole("button", { name: "api" }));
    expect(onNavigateNode).toHaveBeenCalledWith("k1");
    // Первая строка «Спецификация» — своя, вторая — компонента: открывается в его контексте.
    const rows = screen.getAllByRole("button", { name: "Спецификация" });
    expect(rows).toHaveLength(2);
    await userEvent.click(rows[1]);
    expect(onOpenChildSpec).toHaveBeenCalledWith(kid);
    await userEvent.click(screen.getByRole("button", { name: "Собрать с компонентов" }));
    expect(onCollect).toHaveBeenCalled();
  });

  it("контейнер без компонентов (лист) — то же, без подгрупп", () => {
    renderSection({ kind: "leaf" }, { spec: "openapi: 3.0.0" });
    expect(screen.getByText("Спецификация")).toBeInTheDocument();
    expect(screen.queryByText(/у компонентов она не на месте/)).not.toBeInTheDocument();
  });
});

describe("OpenApiSection: компонент", () => {
  const COMPONENT: PageElement = { kind: "component", container: ORDERS };

  it("без своей спецификации — раздела нет: API отдаёт контейнер", () => {
    const { container, unmount } = renderSection(COMPONENT);
    expect(container).toBeEmptyDOMElement();
    unmount();
    const reader = renderSection(COMPONENT, { isArchitect: false });
    expect(reader.container).toBeEmptyDOMElement();
  });

  it("своя спецификация (старые данные) — куда её собрать, строка спецификации", () => {
    renderSection(COMPONENT, { spec: "openapi: 3.0.0" });
    expect(screen.getByText(
      "Спецификацию отдаёт контейнер целиком. Её можно перенести в «orders» кнопкой «Собрать с компонентов» на его странице",
    )).toBeInTheDocument();
    expect(screen.getByText("Спецификация")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).toBeNull();
  });

  it("составной компонент — спецификации вложенных с пометкой, без «Собрать»", () => {
    renderSection({ kind: "composite", container: ORDERS }, { groups, collect: true });
    expect(screen.getByText("Спецификацию отдаёт контейнер целиком, у компонентов она не на месте")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "api" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Собрать с компонентов" })).not.toBeInTheDocument();
  });
});

// Ф13а: одно правило с «Логикой» — форме без OpenAPI раздела нет при любом элементе
// (компонент-база и система-база — старые данные: Р6 базу в контейнер не пускает).
describe("OpenApiSection: форма без OpenAPI", () => {
  const renderShape = (element: PageElement, over: { legacy?: boolean; spec?: string | null } = {}) => render(
    <OpenApiSection
      spec={over.spec ?? null} element={element} isArchitect
      allowed={false} legacy={over.legacy ?? false} groups={[]}
      onOpen={vi.fn()} onOpenChildSpec={vi.fn()} onNavigateNode={onNavigateNode}
    />,
  );

  it("компонент, система и лист формы без OpenAPI — раздела нет", () => {
    const { container: c1 } = renderShape({ kind: "component", container: ORDERS });
    expect(c1.textContent).toBe("");
    const { container: c2 } = renderShape({ kind: "system" });
    expect(c2.textContent).toBe("");
    const { container: c3 } = renderShape({ kind: "leaf" });
    expect(c3.textContent).toBe("");
  });

  it("старая спецификация у такого объекта остаётся видна", () => {
    const { unmount } = renderShape({ kind: "component", container: ORDERS }, { legacy: true, spec: "openapi: 3.0.0" });
    expect(screen.getByText("OpenAPI")).toBeInTheDocument();
    unmount();
    renderShape({ kind: "leaf" }, { legacy: true, spec: "openapi: 3.0.0" });
    expect(screen.getByText("OpenAPI описывает HTTP-API, который объект предоставляет сам, а у этого объекта его нет")).toBeInTheDocument();
  });
});
