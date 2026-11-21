// Шапка процесса (редизайн, фаза 3а): одна строка, название и действия. Читателю — только
// название и переключатели вида; редактору в правке — отмена и повтор значками,
// «Добавить участника», «Фрагмент» с меню из четырёх видов и «Готово». Надписи
// «сохранено» и пилюли области нет: область — подсказкой у названия, и только когда
// она не вся схема.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ProcessToolbar from "../processes/ProcessToolbar";

const HISTORY = { undo: vi.fn(), redo: vi.fn(), canUndo: true, canRedo: false, busy: false };

function renderHead(over: Partial<Parameters<typeof ProcessToolbar>[0]> = {}) {
  const props = {
    name: "Оформление заказа",
    scopeName: null,
    isArchitect: true,
    editing: false,
    onToggleEditing: vi.fn(),
    onRename: vi.fn(),
    danglingCount: 0,
    onReattach: vi.fn(),
    fragSelect: null,
    onFragSelect: vi.fn(),
    canFragment: true,
    onAddParticipant: vi.fn(),
    history: HISTORY,
    hasStatus: false,
    view: "asis" as const,
    onViewChange: vi.fn(),
    fit: null,
    ...over,
  };
  render(<ProcessToolbar {...props} />);
  return props;
}

describe("шапка процесса", () => {
  it("читателю — название текстом, без кнопок правки", () => {
    renderHead({ isArchitect: false });
    expect(screen.getByRole("heading", { name: "Оформление заказа" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Редактировать" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить участника" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Фрагмент" })).toBeNull();
  });

  it("редактор в чтении: «Редактировать», инструментов правки нет", () => {
    renderHead();
    expect(screen.getByRole("button", { name: "Редактировать" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Отменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Добавить участника" })).toBeNull();
  });

  it("в правке: отмена, повтор, участник, фрагмент и «Готово»; «сохранено» нет", () => {
    renderHead({ editing: true });
    expect(screen.getByRole("button", { name: "Отменить" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Добавить участника" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Готово" })).toHaveClass("ds-btn--primary");
    expect(screen.queryByText(/сохранено/)).toBeNull();
  });

  it("«Фрагмент» — одна кнопка с меню из четырёх видов", async () => {
    const props = renderHead({ editing: true });
    await userEvent.click(screen.getByRole("button", { name: "Фрагмент" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
      "Условие (alt)", "Необязательно (opt)", "Цикл (loop)", "Параллельно (par)",
    ]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Цикл (loop)" }));
    expect(props.onFragSelect).toHaveBeenCalledWith("loop");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("область — подсказкой у названия и только когда она не вся схема", () => {
    renderHead({ isArchitect: false });
    expect(screen.getByRole("heading").getAttribute("title")).toBeNull();
    expect(screen.queryByText(/Вся схема/)).toBeNull();
  });

  it("область задана — подсказка у названия", () => {
    renderHead({ isArchitect: false, scopeName: "Сервис оплат" });
    expect(screen.getByRole("heading")).toHaveAttribute("title", "Область: Сервис оплат");
  });

  it("«Восстановить связи» — только в правке и только когда есть шаги без связи", () => {
    renderHead({ editing: true, danglingCount: 2 });
    expect(screen.getByRole("button", { name: "Восстановить связи (2)" })).toBeInTheDocument();
  });

  it("название правится по месту: Enter пишет, Escape возвращает прежнее", async () => {
    const props = renderHead();
    const field = screen.getByRole("textbox", { name: "Название процесса" });
    await userEvent.clear(field);
    await userEvent.type(field, "Оформление{Escape}");
    expect(props.onRename).not.toHaveBeenCalled();
    expect((field as HTMLInputElement).value).toBe("Оформление заказа");

    await userEvent.clear(field);
    await userEvent.type(field, "Оформление покупки{Enter}");
    expect(props.onRename).toHaveBeenCalledWith("Оформление покупки");
  });
});
