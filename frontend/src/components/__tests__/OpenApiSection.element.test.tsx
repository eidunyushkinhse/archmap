// Секция «OpenAPI» по элементу архитектуры (Ф8 эпика docs/plan-c4-elements.md, Р34): API
// отдаёт контейнер. У контейнера своя спецификация без предупреждения, спецификации
// компонентов — с пометкой «не на месте» и «Собрать с компонентов»; у системы своего API
// нет (старая спецификация — с предупреждением и «Перенести документацию», групп нет); у
// компонента — где его API, кнопка на страницу контейнера и «Операции компонента». Три
// элемента × (пусто / своя спецификация / спецификации потомков).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import OpenApiSection from "../nodePage/OpenApiSection";
import type { PageElement } from "../element/elementView";
import type { ContainerSpecGroup } from "../../pages/useContainerChildren";
import type { Node, NodeDocMeta } from "../../types";

const doc = (over: Partial<NodeDocMeta> = {}): NodeDocMeta =>
  ({ id: "d1", name: "Создать заказ", kind: "operation", operation: null, version: 1, described: true, ...over });

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

function renderSection(element: PageElement, over: {
  spec?: string | null; docs?: NodeDocMeta[]; groups?: ContainerSpecGroup[]; containerHasSpec?: boolean | null;
  isArchitect?: boolean; collect?: boolean;
} = {}) {
  return render(
    <OpenApiSection
      spec={over.spec ?? null}
      docs={over.docs ?? []}
      element={element}
      containerHasSpec={over.containerHasSpec ?? null}
      isArchitect={over.isArchitect ?? true}
      allowed
      legacy={false}
      groups={over.groups ?? []}
      loading={false}
      onOpen={vi.fn()}
      onOpenChildSpec={vi.fn()}
      onTransfer={element.kind === "system" ? onTransfer : undefined}
      onCollect={over.collect ? onCollect : undefined}
      onNavigateNode={onNavigateNode}
    />,
  );
}

const ORDERS = { id: "c", name: "orders" };

describe("OpenApiSection: система", () => {
  it("пусто — своего API у системы нет, меню «+ Добавить» нет", () => {
    renderSection({ kind: "system" });
    expect(screen.getByText("Это система, своего API у неё нет. Спецификации описывают у её контейнеров")).toBeInTheDocument();
    expect(screen.queryByText("+ Добавить")).not.toBeInTheDocument();
  });

  it("своя спецификация — предупреждение, строка и «Перенести документацию»", () => {
    renderSection({ kind: "system" }, { spec: "openapi: 3.0.0" });
    expect(screen.getByText(
      "У системы осталась собственная спецификация. API отдают контейнеры, перенесите её одному из них",
    )).toBeInTheDocument();
    expect(screen.getByText("Спецификация")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Перенести документацию" })).toBeInTheDocument();
  });

  it("спецификации потомков страница системы не показывает (Р34)", () => {
    renderSection({ kind: "system" }, { groups });
    expect(screen.queryByText("Спецификации компонентов")).not.toBeInTheDocument();
    expect(screen.queryByText("от api →")).not.toBeInTheDocument();
  });
});

describe("OpenApiSection: контейнер", () => {
  it("пусто — «Спецификация не задана» и меню «+ Добавить», как у объекта без вложенных", () => {
    renderSection({ kind: "container" });
    expect(screen.getByText("Спецификация не задана")).toBeInTheDocument();
    expect(screen.getByText("+ Добавить")).toBeInTheDocument();
  });

  it("своя спецификация — без предупреждения и без «Перенести документацию»", () => {
    renderSection({ kind: "container" }, { spec: "openapi: 3.0.0" });
    expect(screen.getByText("Спецификация")).toBeInTheDocument();
    expect(document.querySelector(".np-warn")).toBeNull();
    expect(screen.queryByRole("button", { name: "Перенести документацию" })).not.toBeInTheDocument();
  });

  it("спецификации компонентов — с пометкой «не на месте» и «Собрать с компонентов»", async () => {
    renderSection({ kind: "container" }, { spec: "openapi: 3.0.0", groups, collect: true });
    expect(screen.getByText("Спецификации компонентов")).toBeInTheDocument();
    expect(screen.getByText("Спецификацию отдаёт контейнер целиком, у компонентов она не на месте")).toBeInTheDocument();
    expect(screen.getByText("от api →")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Собрать с компонентов" }));
    expect(onCollect).toHaveBeenCalled();
  });

  it("контейнер без компонентов (лист) — то же, без групп", () => {
    renderSection({ kind: "leaf" }, { spec: "openapi: 3.0.0" });
    expect(screen.getByText("Спецификация")).toBeInTheDocument();
    expect(screen.queryByText("Спецификации компонентов")).not.toBeInTheDocument();
  });
});

describe("OpenApiSection: компонент", () => {
  const COMPONENT: PageElement = { kind: "component", container: ORDERS };

  it("у контейнера есть спецификация — текст и «Открыть спецификацию» на его страницу", async () => {
    renderSection(COMPONENT, { containerHasSpec: true });
    expect(screen.getByText("API этого компонента отдаёт контейнер «orders», спецификация описана у него")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Открыть спецификацию" }));
    expect(onNavigateNode).toHaveBeenCalledWith("c");
    expect(screen.queryByText("+ Добавить")).not.toBeInTheDocument();
  });

  it("у контейнера спецификации нет — «пока не описана», кнопки нет; контейнер не загружен — без продолжения", () => {
    const { unmount } = renderSection(COMPONENT, { containerHasSpec: false, isArchitect: false });
    expect(screen.getByText("API этого компонента отдаёт контейнер «orders», спецификация пока не описана")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Открыть спецификацию" })).not.toBeInTheDocument();
    unmount();
    renderSection(COMPONENT, { containerHasSpec: null });
    expect(screen.getByText("API этого компонента отдаёт контейнер «orders»")).toBeInTheDocument();
  });

  it("«Операции компонента» — схемы с привязкой к операции; без привязок — пояснение", () => {
    const { unmount } = renderSection(COMPONENT, {
      docs: [doc({ operation: "POST /orders" }), doc({ id: "d2", name: "Пересчёт", kind: "worker" })],
    });
    expect(screen.getByText("Операции компонента")).toBeInTheDocument();
    expect(screen.getByText("POST /orders")).toBeInTheDocument();
    expect(screen.queryByText("Пересчёт")).not.toBeInTheDocument();
    unmount();
    renderSection(COMPONENT, { docs: [doc()] });
    expect(screen.getByText("Схемы логики этого компонента не привязаны к операциям спецификации")).toBeInTheDocument();
  });

  it("своя спецификация (старые данные) — куда её собрать, строка спецификации", () => {
    renderSection(COMPONENT, { spec: "openapi: 3.0.0", containerHasSpec: false });
    expect(screen.getByText(
      "Спецификацию отдаёт контейнер целиком. Перенесите её в «orders»: на его странице есть кнопка «Собрать с компонентов»",
    )).toBeInTheDocument();
    expect(screen.getByText("Спецификация")).toBeInTheDocument();
  });

  it("составной компонент — спецификации вложенных с пометкой, без «Собрать»", () => {
    renderSection({ kind: "composite", container: ORDERS }, { groups, containerHasSpec: true, collect: true });
    expect(screen.getByText("Спецификацию отдаёт контейнер целиком, у компонентов она не на месте")).toBeInTheDocument();
    expect(screen.getByText("от api →")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Собрать с компонентов" })).not.toBeInTheDocument();
  });
});
