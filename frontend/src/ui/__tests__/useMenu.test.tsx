// Хук меню у кнопки (редизайн, фаза 13в): Escape и выбор пункта возвращают фокус на кнопку,
// стрелки ходят по незапертым пунктам по кругу, Home и End — к краям, Tab с пункта закрывает
// меню, щелчок мимо закрывает и фокус не трогает.
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { useMenu } from "../useMenu";

function Demo({ onPick }: { onPick: (focusedLabel: string) => void }) {
  const [open, setOpen] = useState(false);
  const { wrapRef, triggerRef, menuRef, onKeyDown, pick } = useMenu(open, setOpen);
  // Пункт сообщает, где был фокус в момент действия: окно, открытое пунктом, запомнит его.
  const act = (label: string) => () =>
    pick(() => onPick((document.activeElement as HTMLElement | null)?.textContent ?? label));
  return (
    <>
      <button type="button">до меню</button>
      <div ref={wrapRef}>
        <button type="button" ref={triggerRef} onClick={() => setOpen((o) => !o)} onKeyDown={onKeyDown}>
          Меню
        </button>
        {open && (
          <div ref={menuRef} role="menu" onKeyDown={onKeyDown}>
            <input aria-label="Поиск" />
            <button type="button" className="ds-menu-item" role="menuitem" onClick={act("Первый")}>Первый</button>
            <button type="button" className="ds-menu-item" role="menuitem" disabled>Запертый</button>
            <button type="button" className="ds-menu-item" role="menuitem" onClick={act("Второй")}>Второй</button>
            <button type="button" className="ds-menu-item" role="menuitem" onClick={act("Третий")}>Третий</button>
          </div>
        )}
      </div>
      <button type="button">после меню</button>
      <p>снаружи</p>
    </>
  );
}

const кнопка = () => screen.getByRole("button", { name: "Меню" });
const пункт = (name: string) => screen.getByRole("menuitem", { name });

describe("useMenu", () => {
  it("стрелка вниз на кнопке — первый пункт; стрелки по кругу мимо запертого; Home и End", async () => {
    render(<Demo onPick={vi.fn()} />);
    await userEvent.click(кнопка());
    await userEvent.keyboard("{ArrowDown}");
    expect(пункт("Первый")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(пункт("Второй")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(пункт("Первый")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(пункт("Третий")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(пункт("Первый")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(пункт("Третий")).toHaveFocus();
    // Стрелка вверх на кнопке открытого меню — последний пункт.
    кнопка().focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(пункт("Третий")).toHaveFocus();
  });

  it("в поле меню стрелка вниз ведёт к первому пункту, Home и End остаются полю", async () => {
    render(<Demo onPick={vi.fn()} />);
    await userEvent.click(кнопка());
    const поле = screen.getByRole("textbox", { name: "Поиск" });
    await userEvent.type(поле, "ярм");
    await userEvent.keyboard("{Home}");
    expect(поле).toHaveFocus();
    expect((поле as HTMLInputElement).selectionStart).toBe(0);
    await userEvent.keyboard("{ArrowDown}");
    expect(пункт("Первый")).toHaveFocus();
  });

  it("Escape с пункта закрывает меню и ставит фокус на кнопку", async () => {
    render(<Demo onPick={vi.fn()} />);
    await userEvent.click(кнопка());
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(кнопка()).toHaveFocus();
  });

  it("выбор пункта (щелчок и Enter): фокус на кнопке ДО действия, меню закрыто", async () => {
    const onPick = vi.fn();
    render(<Demo onPick={onPick} />);
    await userEvent.click(кнопка());
    await userEvent.click(пункт("Второй"));
    expect(onPick).toHaveBeenLastCalledWith("Меню");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(кнопка()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{ArrowDown}{End}{Enter}");
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenLastCalledWith("Меню");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(кнопка()).toHaveFocus();
  });

  it("Tab с пункта закрывает меню, фокус идёт дальше от кнопки; Shift+Tab — назад от кнопки", async () => {
    render(<Demo onPick={vi.fn()} />);
    await userEvent.click(кнопка());
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.tab();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "после меню" })).toHaveFocus();
    await userEvent.click(кнопка());
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.tab({ shift: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "до меню" })).toHaveFocus();
  });

  it("щелчок мимо закрывает меню и фокус насильно не переставляет", async () => {
    render(<Demo onPick={vi.fn()} />);
    await userEvent.click(кнопка());
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.click(screen.getByText("снаружи"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(кнопка()).not.toHaveFocus();
  });
});
