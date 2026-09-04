// Тесты ⓘ-поповера (ui/InfoPopover.tsx).
//
// Пояснение у поля имеет смысл, только если открывается и — главное — уходит
// без следа: тремя способами (повторный клик, Escape, клик вне). Панель лежит
// fixed-слоем поверх всего, и «залипший» поповер закрывал бы собой работу.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import InfoPopover from "../InfoPopover";

const открыть = () => fireEvent.click(screen.getByRole("button", { name: "Что такое якорь" }));

function отрисовать() {
  return render(
    <div>
      <button type="button">снаружи</button>
      <InfoPopover label="Что такое якорь"><p>Пояснение</p></InfoPopover>
    </div>,
  );
}

describe("InfoPopover", () => {
  it("клик по кнопке раскрывает панель, повторный — прячет", () => {
    отрисовать();
    const btn = screen.getByRole("button", { name: "Что такое якорь" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();

    открыть();
    expect(screen.getByRole("dialog")).toHaveTextContent("Пояснение");
    expect(btn).toHaveAttribute("aria-expanded", "true");

    открыть();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape закрывает панель", () => {
    отрисовать();
    открыть();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("клик вне закрывает панель, клик внутри — нет", () => {
    отрисовать();
    открыть();

    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.mouseDown(screen.getByText("снаружи"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("панель не забирает фокус себе", () => {
    // Пояснение — не модальный шаг: человек читает его, не теряя места в форме.
    отрисовать();
    открыть();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(false);
  });
});
