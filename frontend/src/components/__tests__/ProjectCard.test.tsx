// Карточка проекта на лендинге: пункты меню ⋯ по роли в проекте и метка
// «Только чтение» у читателя. Глобальная роль здесь ни при чём.
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

  it("редактору и читателю — только «Открыть» и «Доступ»", async () => {
    expect(await пункты("editor")).toEqual(["Открыть", "Доступ"]);
  });

  it("читателю в архиве тоже без управления", async () => {
    expect(await пункты("reader", true)).toEqual(["Открыть", "Доступ"]);
  });

  it("«Доступ» открывает окно доступа", async () => {
    await пункты("reader");
    await userEvent.click(screen.getByRole("button", { name: "Доступ" }));
    expect(колбэки.onAccess).toHaveBeenCalledOnce();
  });
});

describe("ProjectCard: метка «Только чтение»", () => {
  it("есть у читателя", () => {
    render(<ProjectCard project={проект("reader")} archivedTab={false} {...колбэки} />);
    expect(screen.getByText("Только чтение")).toBeInTheDocument();
  });

  it("нет у редактора и владельца", () => {
    const { unmount } = render(<ProjectCard project={проект("editor")} archivedTab={false} {...колбэки} />);
    expect(screen.queryByText("Только чтение")).not.toBeInTheDocument();
    unmount();
    render(<ProjectCard project={проект("owner")} archivedTab={false} {...колбэки} />);
    expect(screen.queryByText("Только чтение")).not.toBeInTheDocument();
  });
});
