// Карточка проекта на экране «Проекты»: пункты меню по роли в проекте (у читателя меню
// нет). Глобальная роль здесь ни при чём.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import ProjectCard from "../project/ProjectCard";
import type { Project } from "../../types";

vi.mock("../project/SchemaPreview", () => ({ default: () => <div data-testid="preview" /> }));

const проект = (my_role: Project["my_role"]): Project => ({
  id: "p1", name: "Ярмарка", description: null, archived_at: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  object_count: 1, edge_count: 0, updated_by: null, preview: { nodes: [], edges: [] },
  my_role, owner_username: "owner", visible_to_all: false,
});

const колбэки = {
  onOpen: vi.fn(), onAccess: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn(), onRestore: vi.fn(), onDelete: vi.fn(),
};

async function пункты(my_role: Project["my_role"], archivedTab = false): Promise<string[]> {
  render(<ProjectCard project={проект(my_role)} archivedTab={archivedTab} {...колбэки} />);
  await userEvent.click(screen.getByRole("button", { name: "Меню проекта" }));
  return Array.from(screen.getByRole("menu").querySelectorAll("button")).map((b) => b.textContent ?? "");
}

describe("ProjectCard: меню по роли в проекте", () => {
  it("владельцу — всё управление (активные)", async () => {
    expect(await пункты("owner")).toEqual(["Открыть", "Доступ", "Редактировать", "Архивировать"]);
  });

  it("владельцу — всё управление (архив)", async () => {
    expect(await пункты("owner", true)).toEqual([
      "Открыть", "Доступ", "Редактировать", "Восстановить", "Удалить навсегда",
    ]);
  });

  it("редактору — только «Открыть» и «Доступ»", async () => {
    expect(await пункты("editor")).toEqual(["Открыть", "Доступ"]);
  });

  it("редактору в архиве тоже без управления", async () => {
    expect(await пункты("editor", true)).toEqual(["Открыть", "Доступ"]);
  });

  it("у читателя меню ⋯ нет: состав участников ему не показываем", () => {
    render(<ProjectCard project={проект("reader")} archivedTab={false} {...колбэки} />);
    expect(screen.queryByRole("button", { name: "Меню проекта" })).not.toBeInTheDocument();
  });

  // Вид нового языка (редизайн, фаза 12а): подвал — кто менял и дата, без чисел; меню —
  // кнопка-значок, «Удалить навсегда» опасным пунктом.
  it("подвал: логин с полным текстом в подсказке и дата, чисел объектов и связей нет", () => {
    render(<ProjectCard project={{ ...проект("owner"), updated_by: "very-long-login-of-the-editor", object_count: 12, edge_count: 7 }} archivedTab={false} {...колбэки} />);
    const кто = screen.getByText("very-long-login-of-the-editor");
    expect(кто).toHaveAttribute("title", "very-long-login-of-the-editor");
    expect(screen.getByText("1 окт.")).toBeInTheDocument();
    expect(screen.queryByText(/объект/)).toBeNull();
    expect(screen.queryByText(/связ/)).toBeNull();
    expect(screen.queryByText("·")).toBeNull();
  });

  it("подвал: подпись вместо логина («Гость»), без логина — прочерк", () => {
    const { unmount } = render(<ProjectCard project={{ ...проект("owner"), updated_by: "guest-1" }} archivedTab={false} updaterLabel="Гость" {...колбэки} />);
    expect(screen.getByText("Гость")).toHaveAttribute("title", "Гость");
    expect(screen.queryByText("guest-1")).toBeNull();
    unmount();
    render(<ProjectCard project={проект("owner")} archivedTab={false} {...колбэки} />);
    expect(screen.getByText("—")).not.toHaveAttribute("title");
  });

  it("меню — кнопка-значок нового языка, опасный пункт «Удалить навсегда»", async () => {
    render(<ProjectCard project={проект("owner")} archivedTab {...колбэки} />);
    const кнопка = screen.getByRole("button", { name: "Меню проекта" });
    expect(кнопка).toHaveClass("ds-icon-btn");
    expect(кнопка).toHaveAttribute("aria-haspopup", "menu");
    expect(кнопка).toHaveAttribute("aria-expanded", "false");
    expect(кнопка.textContent).toBe("");
    await userEvent.click(кнопка);
    expect(кнопка).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toHaveClass("ds-menu", "ds-menu--end");
    expect(screen.getByRole("button", { name: "Удалить навсегда" })).toHaveClass("ds-menu-item", "ds-menu-item--danger");
    expect(screen.getByRole("button", { name: "Восстановить" })).not.toHaveClass("ds-menu-item--danger");
    // Escape закрывает меню.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("щелчок по кнопке меню и по пункту меню (кроме «Открыть») проект не открывает", async () => {
    const onOpen = vi.fn();
    render(<ProjectCard project={проект("owner")} archivedTab={false} {...колбэки} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "Меню проекта" }));
    await userEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    expect(колбэки.onEdit).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTitle("Открыть проект"));
    await userEvent.click(screen.getByText("Ярмарка"));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  // Страховка механики меню перед общим хуком клавиатуры (редизайн, фаза 13в): зелёная и
  // до него, и после.
  it("механика: кнопка открывает и закрывает, Escape и щелчок мимо закрывают, пункт закрывает и зовёт действие", async () => {
    const onEdit = vi.fn();
    render(<><ProjectCard project={проект("owner")} archivedTab={false} {...колбэки} onEdit={onEdit} /><p>снаружи</p></>);
    const кнопка = screen.getByRole("button", { name: "Меню проекта" });
    await userEvent.click(кнопка);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(кнопка);
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(кнопка);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(кнопка);
    await userEvent.click(screen.getByText("снаружи"));
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(кнопка);
    await userEvent.click(screen.getByRole("button", { name: "Редактировать" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("«Доступ» открывает окно доступа", async () => {
    await пункты("editor");
    await userEvent.click(screen.getByRole("button", { name: "Доступ" }));
    expect(колбэки.onAccess).toHaveBeenCalledOnce();
  });
});
