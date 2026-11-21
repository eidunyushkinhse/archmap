// Меню «Действия со схемой» (редизайн, фаза 5): один вид в шапке оболочки и в шапке
// редактора-карты — тихая кнопка-значок и меню нового языка. Отличие редактора только в
// поведении: сверху его собственные пункты (подписи связей, «Переразложить уровень»).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SchemaActions, { type ExportScope } from "../SchemaActions";

const SCOPE: ExportScope = {
  key: "all",
  title: "Экспорт схемы",
  load: () => Promise.resolve({ content: "" }),
  archive: { filename: "archmap.zip", load: () => Promise.resolve(new Blob()) },
};

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
  return screen.getByRole("menu", { name: "Действия со схемой" });
}

function look(menu: HTMLElement) {
  const btn = screen.getByRole("button", { name: "Действия со схемой" });
  return {
    btn: [btn.className, btn.getAttribute("style")],
    menu: menu.className,
    items: screen.getAllByRole("menuitem").map((b) => b.className),
  };
}

describe("SchemaActions", () => {
  it("в оболочке и в редакторе меню одного вида", async () => {
    const shell = render(<SchemaActions projectId="p" isArchitect exportScope={SCOPE} onSynced={vi.fn()} />);
    const inShell = look(await openMenu());
    shell.unmount();

    render(
      <SchemaActions
        projectId="p" isArchitect exportScope={SCOPE} onSynced={vi.fn()}
        items={[{ label: "Скрыть подписи связей", onSelect: vi.fn() }]}
      />,
    );
    const inEditor = look(await openMenu());

    expect(inShell.btn).toEqual(["ds-icon-btn", null]);
    expect(inEditor.btn).toEqual(inShell.btn);
    expect(inShell.menu).toBe(inEditor.menu);
    expect(inShell.menu).toContain("ds-menu");
    expect(new Set([...inShell.items, ...inEditor.items])).toEqual(new Set(["ds-menu-item"]));
  });

  it("пункты страницы — сверху, отделены чертой", async () => {
    const onSelect = vi.fn();
    render(
      <SchemaActions
        projectId="p" isArchitect exportScope={SCOPE} onSynced={vi.fn()}
        items={[{ label: "Скрыть подписи связей", onSelect }, { label: "Переразложить уровень", onSelect: vi.fn(), disabled: true }]}
      />,
    );
    const menu = await openMenu();
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
      "Скрыть подписи связей", "Переразложить уровень", "Экспорт схемы", "Обновить из кода", "Экспорт проекта (zip)", "Догрузить архив",
    ]);
    expect(screen.getByRole("menuitem", { name: "Переразложить уровень" })).toBeDisabled();
    const sep = menu.querySelector(".ds-menu-sep");
    expect(sep?.previousElementSibling?.textContent).toBe("Переразложить уровень");
    await userEvent.click(screen.getByRole("menuitem", { name: "Скрыть подписи связей" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("без пунктов страницы черты нет; читателю — только экспорт", async () => {
    render(<SchemaActions projectId="p" isArchitect={false} exportScope={SCOPE} onSynced={vi.fn()} />);
    const menu = await openMenu();
    expect(menu.querySelector(".ds-menu-sep")).toBeNull();
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Экспорт схемы", "Экспорт проекта (zip)"]);
  });

  it("в «Процессах» пункта «Обновить из кода» нет; Escape закрывает меню", async () => {
    render(<SchemaActions projectId="p" isArchitect exportScope={null} syncHidden onSynced={vi.fn()} />);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Обновить из кода" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Экспорт" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
