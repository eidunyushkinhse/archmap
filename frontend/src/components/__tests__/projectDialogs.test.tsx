// Окна управления проектом: архив, возврат из архива, удаление навсегда, правка.
// Успех зовёт onDone, и кнопка остаётся занятой, пока окно закрывается (второй щелчок
// не повторит запрос); отказ бэка показывается под текстом, и можно повторить.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArchiveDialog, DeleteForeverDialog, RestoreDialog } from "../project/ProjectDialogs";
import EditProjectDialog from "../project/EditProjectDialog";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: { archive: vi.fn(), restore: vi.fn(), remove: vi.fn(), update: vi.fn() },
}));
// Modal настоящий (test-setup открывает <dialog> атрибутом open): подтверждение по Enter
// идёт через него.

const project: Project = {
  id: "p1", name: "Ярмарка", description: null, archived_at: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  object_count: 1, edge_count: 0, updated_by: null, preview: { nodes: [], edges: [] },
  my_role: "owner", owner_username: "owner", visible_to_all: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ArchiveDialog", () => {
  it("успех: onDone один раз, кнопка остаётся занятой до закрытия окна", async () => {
    vi.mocked(projectsApi.archive).mockResolvedValue(project);
    const onDone = vi.fn();
    render(<ArchiveDialog project={project} onClose={vi.fn()} onDone={onDone} />);
    await userEvent.click(screen.getByRole("button", { name: "В архив" }));
    expect(projectsApi.archive).toHaveBeenCalledWith("p1");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
  });

  it("отказ: текст ошибки, onDone не зовётся, кнопка снова доступна", async () => {
    vi.mocked(projectsApi.archive).mockRejectedValue(new Error("Нет прав"));
    const onDone = vi.fn();
    render(<ArchiveDialog project={project} onClose={vi.fn()} onDone={onDone} />);
    await userEvent.click(screen.getByRole("button", { name: "В архив" }));
    expect(await screen.findByText("Нет прав")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "В архив" })).toBeEnabled();
  });
});

describe("RestoreDialog", () => {
  it("успех: возврат из архива и onDone", async () => {
    vi.mocked(projectsApi.restore).mockResolvedValue(project);
    const onDone = vi.fn();
    render(<RestoreDialog project={project} onClose={vi.fn()} onDone={onDone} />);
    await userEvent.click(screen.getByRole("button", { name: "Вернуть" }));
    expect(projectsApi.restore).toHaveBeenCalledWith("p1");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});

describe("DeleteForeverDialog", () => {
  it("кнопка заперта, пока не введено имя; успех уносит имя в API и зовёт onDone", async () => {
    vi.mocked(projectsApi.remove).mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<DeleteForeverDialog project={project} onClose={vi.fn()} onDone={onDone} />);
    const del = screen.getByRole("button", { name: "Удалить навсегда" });
    expect(del).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("Ярмарка"), "Ярмарка");
    await userEvent.click(del);
    expect(projectsApi.remove).toHaveBeenCalledWith("p1", "Ярмарка");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Удаление…" })).toBeDisabled();
  });

  it("отказ: текст ошибки и снова можно удалить", async () => {
    vi.mocked(projectsApi.remove).mockRejectedValue(new Error("Имя не совпало"));
    render(<DeleteForeverDialog project={project} onClose={vi.fn()} onDone={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText("Ярмарка"), "Ярмарка");
    await userEvent.click(screen.getByRole("button", { name: "Удалить навсегда" }));
    expect(await screen.findByText("Имя не совпало")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить навсегда" })).toBeEnabled();
  });

  it("Enter в поле имени: молчит, пока имя не совпало; совпало — удаляет", async () => {
    vi.mocked(projectsApi.remove).mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<DeleteForeverDialog project={project} onClose={vi.fn()} onDone={onDone} />);
    const field = screen.getByPlaceholderText("Ярмарка");
    await userEvent.type(field, "Ярмар{Enter}");
    expect(projectsApi.remove).not.toHaveBeenCalled();
    await userEvent.type(field, "ка{Enter}");
    expect(projectsApi.remove).toHaveBeenCalledWith("p1", "Ярмарка");
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});

describe("EditProjectDialog", () => {
  it("поля предзаполнены; успех уносит обрезанные значения, зовёт onSaved и держит кнопку занятой", async () => {
    vi.mocked(projectsApi.update).mockResolvedValue(project);
    const onSaved = vi.fn();
    render(<EditProjectDialog project={{ ...project, description: "Старое" }} onClose={vi.fn()} onSaved={onSaved} />);
    const name = screen.getByDisplayValue("Ярмарка");
    await userEvent.clear(name);
    await userEvent.type(name, "  Ярмарка v2 ");
    await userEvent.clear(screen.getByDisplayValue("Старое"));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(projectsApi.update).toHaveBeenCalledWith("p1", { name: "Ярмарка v2", description: null });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Сохранение…" })).toBeDisabled();
  });

  it("пустое название — кнопка заперта; отказ бэка показывается, и можно повторить", async () => {
    vi.mocked(projectsApi.update).mockRejectedValue(new Error("Имя занято"));
    render(<EditProjectDialog project={project} onClose={vi.fn()} onSaved={vi.fn()} />);
    const name = screen.getByDisplayValue("Ярмарка");
    await userEvent.clear(name);
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();
    await userEvent.type(name, "Плёнка{Enter}");
    expect(await screen.findByText("Имя занято")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeEnabled();
  });
});
