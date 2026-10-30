// Пилюля статуса страницы у имени объекта (docs/tasks/page-status.md).
//
// Что закрепляем: у листа и у контейнера с компонентами (Р14 эпика элементов) редактор
// выбирает статус из выпадашки (выбор зовёт onPick, текущий помечен), читатель видит
// пилюлю без стрелки и без выпадашки; у системы обе роли видят счётчик «N из M» и
// список единиц с точками, клик по строке открывает его страницу; Escape и клик мимо
// закрывают выпадашку. Система — по element_effective, её статус — approval_effective:
// сам компонент правил не знает.
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { Node } from "../../types";
import ApprovalPill from "../nodePage/ApprovalPill";

function makeNode(over: Partial<Node> = {}): Node {
  return {
    id: "n1", name: "Сервис заказов", description: null, role: null, technology: null,
    parent_id: null, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, version: 1, docs: [], has_children: false, child_count: 0,
    approval: "in_progress", approval_effective: "in_progress",
    created_at: "", updated_at: "",
    ...over,
  } as Node;
}

const container = makeNode({
  id: "c", name: "Заказы", has_children: true, child_count: 3, element_effective: "system",
});
const kids = [
  makeNode({ id: "a", name: "Сервис заказов", parent_id: "c", approval: "approved", approval_effective: "approved" }),
  makeNode({ id: "b", name: "База заказов", parent_id: "c", shape: "database" }),
  makeNode({ id: "k", name: "Kafka заказов", parent_id: "c", shape: "broker", approval: "approved", approval_effective: "approved" }),
];

function renderPill(props: Partial<Parameters<typeof ApprovalPill>[0]> = {}) {
  const onPick = vi.fn();
  const onNavigateNode = vi.fn();
  const utils = render(
    <ApprovalPill
      node={makeNode()}
      isArchitect
      units={null}
      onNavigateNode={onNavigateNode}
      onPick={onPick}
      {...props}
    />,
  );
  return { ...utils, onPick, onNavigateNode };
}

describe("ApprovalPill", () => {
  it("лист + редактор: выпадашка из двух статусов, выбор другого зовёт onPick и закрывает", () => {
    const { onPick } = renderPill();
    const pill = screen.getByRole("button", { name: /В работе/ });
    expect(pill.className).toContain("np-approval--work");
    expect(pill.textContent).toContain("▾");

    fireEvent.click(pill);
    expect(screen.getByText("Статус страницы")).toBeTruthy();
    const current = screen.getByRole("button", { name: /^В работе страница ещё правится/ });
    expect(current.className).toContain("is-current");
    expect(current.textContent).toContain("✓");

    fireEvent.click(screen.getByRole("button", { name: /^Согласовано проверено редактором/ }));
    expect(onPick).toHaveBeenCalledWith("approved");
    expect(screen.queryByText("Статус страницы")).toBeNull();
  });

  it("лист + редактор: клик по текущему статусу — без onPick", () => {
    const { onPick } = renderPill({ node: makeNode({ approval: "approved", approval_effective: "approved" }) });
    const pill = screen.getByRole("button", { name: /Согласовано/ });
    expect(pill.className).toContain("np-approval--ok");
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("button", { name: /^Согласовано проверено редактором/ }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("лист + читатель: пилюля без стрелки и без выпадашки", () => {
    const { container: root, onPick } = renderPill({ isArchitect: false });
    expect(screen.queryByRole("button")).toBeNull();
    const pill = root.querySelector(".np-approval") as HTMLElement;
    expect(pill.tagName).toBe("SPAN");
    expect(pill.textContent).toBe("В работе");
    expect(pill.title).toBe("Статус меняет редактор проекта");
    fireEvent.click(pill);
    expect(screen.queryByText("Статус страницы")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("контейнер с компонентами + редактор: свой статус, как у листа", () => {
    const { onPick } = renderPill({
      node: makeNode({ id: "o", name: "orders", has_children: true, child_count: 2, element_effective: "container" }),
      units: null,
    });
    const pill = screen.getByRole("button", { name: /В работе/ });
    expect(pill.textContent).not.toContain("из");
    expect(pill.title).toBe("Статус страницы");
    fireEvent.click(pill);
    expect(screen.getByText("Статус страницы")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Согласовано проверено редактором/ }));
    expect(onPick).toHaveBeenCalledWith("approved");
  });

  it("компонент + читатель: пилюля без выпадашки, как у листа", () => {
    const { container: root } = renderPill({
      node: makeNode({ id: "a", name: "api", parent_id: "o", element_effective: "component" }),
      isArchitect: false,
    });
    expect(screen.queryByRole("button")).toBeNull();
    expect((root.querySelector(".np-approval") as HTMLElement).title).toBe("Статус меняет редактор проекта");
  });

  it("система: счётчик, список единиц с точками, клик по строке открывает его страницу", () => {
    const { onNavigateNode, onPick } = renderPill({ node: container, units: kids, isArchitect: false });
    expect(screen.getByRole("button", { name: /В работе · 2 из 3/ }).title).toBe(
      "Статус системы складывается из вложенных объектов",
    );
    fireEvent.click(screen.getByRole("button", { name: /В работе · 2 из 3/ }));
    expect(screen.getByText("Согласовано 2 из 3")).toBeTruthy();
    const row = screen.getByRole("button", { name: "База заказов" });
    expect(row.querySelector(".np-approval-dot--work")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kafka заказов" }).querySelector(".np-approval-dot--ok")).toBeTruthy();

    fireEvent.click(row);
    expect(onNavigateNode).toHaveBeenCalledWith("b");
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByText("Согласовано 2 из 3")).toBeNull();
  });

  it("система: зелёный по вычисленному статусу сервера, а не по хранимому", () => {
    renderPill({
      node: { ...container, approval: "in_progress", approval_effective: "approved" },
      units: kids.map((k) => ({ ...k, approval: "approved" as const, approval_effective: "approved" as const })),
    });
    const pill = screen.getByRole("button", { name: /Согласовано · 3 из 3/ });
    expect(pill.className).toContain("np-approval--ok");
  });

  it("система: пока вложенные объекты грузятся — без счётчика, в выпадашке «Загрузка…»", () => {
    renderPill({ node: container, units: null });
    const pill = screen.getByRole("button", { name: /В работе/ });
    expect(pill.textContent).not.toContain("из");
    fireEvent.click(pill);
    expect(screen.getByText("Загрузка…")).toBeTruthy();
  });

  it("Escape и клик мимо закрывают выпадашку", () => {
    const { container: root } = renderPill();
    fireEvent.click(screen.getByRole("button", { name: /В работе/ }));
    expect(screen.getByText("Статус страницы")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Статус страницы")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /В работе/ }));
    fireEvent.click(root.querySelector(".np-backdrop") as HTMLElement);
    expect(screen.queryByText("Статус страницы")).toBeNull();
  });
});
