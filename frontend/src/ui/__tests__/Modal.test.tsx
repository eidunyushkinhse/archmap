// Тесты общей модалки (ui/Modal.tsx).
//
// Главное, что здесь закрепляется, — РАЗБОР ЦЕЛИ события `cancel`. Его шлёт не
// только сам <dialog> по Escape: <input type=file> стреляет тем же событием (и
// оно всплывает) при отмене системного выбора файлов. Пока обработчик не смотрел
// на цель, отмена выбора файлов закрывала всё окно — во всех окнах с загрузкой
// (находка ручной проверки 2026-08-08).
//
// Грабля приходит уже во второй раз с разных сторон: до этого всплывающий
// `cancel` запретил вложенные <dialog> (см. память проекта). Поэтому тест, а не
// комментарий.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Modal from "../Modal";

/** Отправить нативный cancel так, как это делает браузер: всплывающим. */
function fireCancel(el: Element) {
  el.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
}

describe("Modal", () => {
  it("отмена системного выбора файлов не закрывает окно", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose}>
        <input type="file" data-testid="picker" />
      </Modal>,
    );

    fireCancel(screen.getByTestId("picker"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape в самом диалоге закрывает окно", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal onClose={onClose}>
        <input type="file" />
      </Modal>,
    );
    const dialog = container.querySelector("dialog");

    expect(dialog).not.toBeNull();
    fireCancel(dialog!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("крестик закрывает окно", () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose}>содержимое</Modal>);

    screen.getByLabelText("Закрыть").click();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
