// Меню «Действия со схемой» (редизайн, фаза 5): один вид в шапке оболочки и в шапке
// редактора-карты — тихая кнопка-значок и меню нового языка. Отличие редактора только в
// поведении: сверху его собственные пункты (подписи связей, «Переразложить уровень»).
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SchemaActions, { type ExportScope } from "../SchemaActions";

// Окно «Обновить из кода» — заглушка с кнопкой его колбэка: здесь проверяется тост итога.
vi.mock("../docsImport/SyncRepoModal", () => ({
  default: ({ onApplied }: { onApplied: (message: string) => void }) => (
    <button type="button" onClick={() => onApplied("Схема обновлена из кода")}>применено</button>
  ),
}));

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

  // Страховка механики тоста (редизайн, фаза 13а, меняется только вид): итог «Обновить из
  // кода» и отказ архива — тостом без роли и без aria-live; гаснет ровно через 5 с.
  it("итог «Обновить из кода» — тост без роли, схема ресинкается", async () => {
    const onSynced = vi.fn();
    render(<SchemaActions projectId="p" isArchitect exportScope={SCOPE} onSynced={onSynced} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Обновить из кода" }));
    fireEvent.click(screen.getByRole("button", { name: "применено" }));
    const тост = screen.getByText("Схема обновлена из кода");
    expect(тост).toHaveClass("ds-toast", "ds-toast--bottom-end");
    expect(тост).not.toHaveClass("legacy-root");
    expect(тост).not.toHaveAttribute("style");
    expect(тост).not.toHaveAttribute("role");
    expect(тост).not.toHaveAttribute("aria-live");
    expect(onSynced).toHaveBeenCalledTimes(1);
  });

  it("отказ архива — тост без роли, гаснет через 5 с", async () => {
    const scope: ExportScope = {
      ...SCOPE,
      archive: { filename: "archmap.zip", load: () => Promise.reject(new Error("сеть")) },
    };
    render(<SchemaActions projectId="p" isArchitect exportScope={scope} onSynced={vi.fn()} />);
    await openMenu();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Экспорт проекта (zip)" })); });
      const тост = screen.getByText("Не удалось собрать архив. Попробуйте ещё раз.");
      expect(тост).toHaveClass("ds-toast", "ds-toast--bottom-end");
      expect(тост).not.toHaveClass("legacy-root");
      expect(тост).not.toHaveAttribute("style");
      expect(тост).not.toHaveAttribute("role");
      expect(тост).not.toHaveAttribute("aria-live");
      act(() => { vi.advanceTimersByTime(4999); });
      expect(screen.getByText("Не удалось собрать архив. Попробуйте ещё раз.")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByText("Не удалось собрать архив. Попробуйте ещё раз.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
