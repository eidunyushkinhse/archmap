// Окно «Выберите связь» само по себе (вызывают его движок холста — useEdgeChoice — и
// таблица «Связи» страницы объекта): выбор строки отдаёт ровно тот объект, что пришёл в
// edges (со всеми полями вызывающего), «Добавить связь» есть только с onAdd и не выбирает
// связь, крестик закрывает окно. Тексты строк и шапки — useEdgeChoice.test и NodePage.test.
//
// Страховочные тесты фазы 9б редизайна: зелёные на прежнем виде окна. Modal настоящий
// (test-setup открывает <dialog> атрибутом open).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import EdgeChoiceModal from "../EdgeChoiceModal";

interface RowEdge { id: string; label: string | null; technology: string | null; inner: string }

const EDGES: RowEdge[] = [
  { id: "e1", label: "читает", technology: "HTTP", inner: "Каталог" },
  { id: "e2", label: null, technology: "Kafka", inner: "Корзина" },
  { id: "e3", label: null, technology: null, inner: "Оплата" },
];

function setup(onAdd?: () => void) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <EdgeChoiceModal edges={EDGES} sourceLabel="Пользователь" targetLabel="Заказы"
      endOf={(e) => `→ ${e.inner}`} onPick={onPick} onAdd={onAdd} onClose={onClose} />,
  );
  return { onPick, onClose };
}
// Строка связи — кнопка, в тексте которой есть её конец (вторая строчка).
const row = (end: string) => screen.getAllByRole("button").find((b) => b.textContent?.includes(end))!;

describe("EdgeChoiceModal — выбор, добавление, закрытие", () => {
  it("выбор строки отдаёт ровно тот объект, что пришёл в edges", async () => {
    const { onPick, onClose } = setup();
    await userEvent.click(row("→ Корзина"));
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][0]).toBe(EDGES[1]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("строка без описания и технологии называется «связь»", async () => {
    const { onPick } = setup();
    expect(row("→ Оплата").textContent).toContain("связь");
    await userEvent.click(row("→ Оплата"));
    expect(onPick.mock.calls[0][0]).toBe(EDGES[2]);
  });

  it("«Добавить связь» с onAdd: зовёт его один раз и не выбирает связь", async () => {
    const onAdd = vi.fn();
    const { onPick } = setup(onAdd);
    await userEvent.click(screen.getByRole("button", { name: /Добавить связь/ }));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("без onAdd кнопки «Добавить связь» нет", () => {
    setup();
    expect(screen.queryByRole("button", { name: /Добавить связь/ })).toBeNull();
  });

  it("крестик закрывает окно без выбора", async () => {
    const { onPick, onClose } = setup(vi.fn());
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("шапка называет пару концов", () => {
    setup();
    expect(screen.getByText("Пользователь → Заказы")).toBeInTheDocument();
  });
});
