// Перечни в подтверждениях нового вида: список без маркеров и коробки (ds-confirm-list),
// строка в одну линию с полным текстом в подсказке. Удаление нескольких объектов, участника
// процесса (вид card) и список «объект: площадки» размещения контейнера целиком.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import NodesDeleteConfirm from "../NodesDeleteConfirm";
import ParticipantDeleteConfirm from "../processes/ParticipantDeleteConfirm";
import PlacementConflictList from "../deployment/PlacementConflictList";
import type { Node } from "../../types";
import type { PlacementConflict } from "../deployment/placementConflicts";

vi.mock("../../api/nodes", () => ({ nodesApi: { deletionSnapshot: vi.fn(), delete: vi.fn() } }));

const node = (id: string, name: string) => ({ id, name } as Node);
const rows = (list: HTMLElement) => within(list).getAllByRole("listitem");

describe("перечни подтверждений", () => {
  it("удаление нескольких объектов: имена перечнем с подсказкой, кнопки нового вида", async () => {
    const onCancel = vi.fn();
    render(<NodesDeleteConfirm nodes={[node("a", "Order API"), node("b", "БД заказов")]} onCancel={onCancel} onDeleted={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2, name: "Удалить 2 объекта?" })).toBeInTheDocument();
    const list = screen.getByRole("list");
    expect(list).toHaveClass("ds-confirm-list");
    expect(rows(list).map((li) => [li.textContent, li.getAttribute("title")]))
      .toEqual([["Order API", "Order API"], ["БД заказов", "БД заказов"]]);
    expect(screen.getByRole("button", { name: "Удалить" }).className).toBe("ds-btn ds-btn--danger");
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("участник процесса: карточка без <dialog>, шаги перечнем с подсказкой", () => {
    const { container } = render(
      <ParticipantDeleteConfirm
        name="Payment API"
        links={[
          { id: "m1", label: "находит платёж", dir: "к", other: "БД платежей" },
          { id: "m2", label: "вердикт и скор", dir: "от", other: "Антифрод" },
        ]}
        deleting={false}
        error={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.firstElementChild).toHaveClass("ds", "ds-win", "ds-confirm", "ds-confirm--card");
    const list = screen.getByRole("list");
    expect(list).toHaveClass("ds-confirm-list");
    expect(rows(list).map((li) => [li.textContent, li.getAttribute("title")])).toEqual([
      ["«находит платёж» к БД платежей", "«находит платёж» к БД платежей"],
      ["«вердикт и скор» от Антифрод", "«вердикт и скор» от Антифрод"],
    ]);
    expect(screen.getByRole("button", { name: "Убрать" }).className).toBe("ds-btn ds-btn--danger");
  });

  it("участник без шагов: ни пояснения, ни перечня", () => {
    render(<ParticipantDeleteConfirm name="Kafka" links={[]} deleting={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("Вместе с ним из процесса уйдут его шаги:")).toBeNull();
  });

  it("размещение контейнера целиком: «объект: площадки» перечнем, подпись списка прежняя", () => {
    const items = [
      { node: { id: "x", name: "Каталог" }, siteNames: ["vm1"] },
      { node: { id: "y", name: "Order API" }, siteNames: ["Кластер prod", "Кластер резерв"] },
    ] as unknown as PlacementConflict[];
    render(<PlacementConflictList items={items} />);
    const list = screen.getByRole("list", { name: "Объекты с другим размещением" });
    expect(list).toHaveClass("ds-confirm-list");
    expect(rows(list).map((li) => [li.textContent, li.getAttribute("title")])).toEqual([
      ["Каталог: vm1", "Каталог: vm1"],
      ["Order API: Кластер prod, Кластер резерв", "Order API: Кластер prod, Кластер резерв"],
    ]);
    expect(list).not.toHaveAttribute("style");
  });
});
