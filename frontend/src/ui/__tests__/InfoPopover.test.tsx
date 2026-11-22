// Тесты ⓘ-поповера (ui/InfoPopover.tsx).
//
// Пояснение у поля имеет смысл, только если открывается и — главное — уходит
// без следа: тремя способами (повторный клик, Escape, клик вне). Панель лежит
// fixed-слоем поверх всего, и «залипший» поповер закрывал бы собой работу.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import InfoPopover from "../InfoPopover";

const открыть = () => fireEvent.click(screen.getByRole("button", { name: "Что такое источник" }));

function отрисовать() {
  return render(
    <div>
      <button type="button">снаружи</button>
      <InfoPopover label="Что такое источник"><p>Пояснение</p></InfoPopover>
    </div>,
  );
}

describe("InfoPopover", () => {
  it("клик по кнопке раскрывает панель, повторный — прячет", () => {
    отрисовать();
    const btn = screen.getByRole("button", { name: "Что такое источник" });
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

  it("Escape панели погашен: окно под ней (нативный <dialog>) не закрывается", () => {
    // Нативный <dialog> закрывается по непогашенному Escape событием cancel; всплытие
    // тут ни при чём, поэтому одного stopPropagation мало.
    отрисовать();
    открыть();
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(false);
    // Панель закрыта — следующий Escape уже не её.
    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(true);
  });

  it("вид один, нового языка: кнопка и панель на токенах, прежнего вида нет", () => {
    // jsdom стили не считает: стережём сам файл стилей (CSS читаем с диска, импорт
    // «?raw» у стилей vitest отдаёт пустым).
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "popover.css"), "utf8");
    expect(css).not.toMatch(/--ds\b/);
    expect(css).not.toMatch(/#94a3b8|#2563eb|#eff6ff|#334155/);
    expect(css).toMatch(/\.ipop-btn \{[^}]*color: var\(--c-fg-faint\)/);
    expect(css).toMatch(/\.ipop-panel \{[^}]*font-size: var\(--fs-ui\)/);
  });

  it("клик вне закрывает панель, клик внутри — нет", () => {
    отрисовать();
    открыть();

    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.mouseDown(screen.getByText("снаружи"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("прокрутка ВНУТРИ панели её не закрывает, прокрутка снаружи — закрывает", () => {
    // Пояснение бывает длиннее окна. Слушатель прокрутки стоит в capture-фазе и
    // без разбора цели ловил бы колесо над самой панелью — тогда хвост текста
    // прочитать нельзя вовсе (находка приёмки Ф1).
    отрисовать();
    открыть();

    fireEvent.scroll(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.scroll(document);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("высота панели ограничена окном, а не своей константой", () => {
    отрисовать();
    открыть();
    expect(screen.getByRole("dialog").style.maxHeight).toBe(`${window.innerHeight - 12}px`);
  });

  it("панель не забирает фокус себе", () => {
    // Пояснение — не модальный шаг: человек читает его, не теряя места в форме.
    отрисовать();
    открыть();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(false);
  });
});
