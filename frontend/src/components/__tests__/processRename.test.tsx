// Переименование процесса в рейле: двойной клик по имени открывает поле, Enter или уход
// из поля сохраняют, Escape отменяет. Пустое и неизменённое имя не сохраняются, у
// читателя поля нет.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProcessRail from "../processes/ProcessRail";
import type { ProcessListItem } from "../../types";

const PROCESS = {
  id: "p1",
  name: "Оформление заказа",
  scope_node_id: null,
  scope_name: null,
  message_count: 0,
  participant_count: 0,
  statuses: [],
} as unknown as ProcessListItem;

function renderRail(isArchitect = true) {
  const onRename = vi.fn();
  const onSelect = vi.fn();
  render(
    <ProcessRail
      processes={[PROCESS]}
      selectedId="p1"
      onSelect={onSelect}
      onNew={() => {}}
      onImport={() => {}}
      expanded
      onToggle={() => {}}
      isArchitect={isArchitect}
      onDuplicate={() => {}}
      onDelete={() => {}}
      onRename={onRename}
    />,
  );
  return { onRename, onSelect };
}

function openField(): HTMLInputElement {
  fireEvent.doubleClick(screen.getByText("Оформление заказа"));
  return screen.getByRole("textbox", { name: "Имя процесса" }) as HTMLInputElement;
}

describe("ProcessRail: переименование", () => {
  it("Enter сохраняет новое имя без пробелов по краям", () => {
    const { onRename } = renderRail();
    const input = openField();
    fireEvent.change(input, { target: { value: "  Оплата заказа " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("p1", "Оплата заказа");
    expect(screen.queryByRole("textbox", { name: "Имя процесса" })).toBeNull();
  });

  it("уход из поля тоже сохраняет", () => {
    const { onRename } = renderRail();
    const input = openField();
    fireEvent.change(input, { target: { value: "Возврат" } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith("p1", "Возврат");
  });

  it("Escape отменяет правку", () => {
    const { onRename } = renderRail();
    const input = openField();
    fireEvent.change(input, { target: { value: "Возврат" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Оформление заказа")).toBeTruthy();
  });

  it("пустое и прежнее имя не сохраняются", () => {
    const { onRename } = renderRail();
    let input = openField();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    input = openField();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("клик по полю не переключает процесс", () => {
    const { onSelect } = renderRail();
    fireEvent.click(openField());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("у читателя двойной клик поле не открывает", () => {
    renderRail(false);
    fireEvent.doubleClick(screen.getByText("Оформление заказа"));
    expect(screen.queryByRole("textbox", { name: "Имя процесса" })).toBeNull();
  });
});
