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
//
// Вторая половина — подтверждение окна клавишей (onSubmit): Enter в однострочном поле,
// Ctrl/Cmd+Enter в многострочном; флажки, кнопки, поле, погасившее Enter само, набор
// через IME и Enter с модификатором окно не подтверждают.
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  // Своего крестика у ui/Modal нет (редизайн, фаза 13б): окна рисуют свой (ds-win-close) и
  // закрываются им через тот же onClose; у подтверждений крестика нет вовсе.
  it("своего крестика нет: в окне только кнопки содержимого, крестик окна закрывает его", () => {
    const onClose = vi.fn();
    const { container } = render(<Modal onClose={onClose}>содержимое</Modal>);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Закрыть")).toBeNull();

    render(
      <Modal onClose={onClose}>
        <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose} />
      </Modal>,
    );
    expect(screen.getAllByLabelText("Закрыть")).toHaveLength(1);
    screen.getByLabelText("Закрыть").click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Modal: подтверждение клавишей", () => {
  function mount(onSubmit?: () => void) {
    render(
      <Modal onClose={vi.fn()} onSubmit={onSubmit}>
        <input aria-label="Имя" />
        <textarea aria-label="Описание" />
        <input type="checkbox" aria-label="Флажок" />
        <input aria-label="Комбобокс" onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />
        <button type="button">Кнопка</button>
      </Modal>,
    );
  }

  it("Enter в однострочном поле зовёт onSubmit один раз", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit);

    await userEvent.type(screen.getByLabelText("Имя"), "Касса{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("в многострочном поле Enter — перенос строки, подтверждает Ctrl+Enter", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit);
    const area = screen.getByLabelText("Описание");

    await userEvent.type(area, "раз{Enter}два");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(area).toHaveValue("раз\nдва");

    await userEvent.type(area, "{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("флажок, кнопка и поле, погасившее Enter само, окно не подтверждают", () => {
    const onSubmit = vi.fn();
    mount(onSubmit);

    fireEvent.keyDown(screen.getByLabelText("Флажок"), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Кнопка" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByLabelText("Комбобокс"), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter с модификатором и Enter при наборе через IME не подтверждают", () => {
    const onSubmit = vi.fn();
    mount(onSubmit);
    const field = screen.getByLabelText("Имя");

    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("без onSubmit Enter в поле ничего не делает", async () => {
    mount();

    await userEvent.type(screen.getByLabelText("Имя"), "Касса{Enter}");

    expect(screen.getByLabelText("Имя")).toHaveValue("Касса");
  });
});

// Возврат фокуса (редизайн, фаза 13в). Окно снимается размонтированием (close() не зовём),
// а нативный <dialog> сам возвращает фокус только при close(): после окна фокус уходил в
// никуда. Теперь — на элемент, который был в фокусе до открытия, если он ещё на странице.
describe("Modal: возврат фокуса", () => {
  function Host({ keepOpener = true }: { keepOpener?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        {(keepOpener || !open) && <button type="button" onClick={() => setOpen(true)}>Открыть окно</button>}
        {open && (
          <Modal onClose={() => setOpen(false)}>
            <button type="button" onClick={() => setOpen(false)}>Готово</button>
          </Modal>
        )}
      </>
    );
  }

  it("закрытое окно возвращает фокус на элемент, бывший в фокусе до открытия", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Открыть окно" });
    await userEvent.click(opener);
    const done = screen.getByText("Готово");
    expect(opener).not.toHaveFocus();
    await userEvent.click(done);
    expect(screen.queryByText("Готово")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("элемента до открытия больше нет — фокус не ставится никуда", async () => {
    render(<Host keepOpener={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Открыть окно" }));
    await userEvent.click(screen.getByText("Готово"));
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });
});
