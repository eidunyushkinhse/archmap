// Окно «Доступ к проекту»: владелец управляет видимостью, участниками и владением;
// остальным то же окно только для чтения. API замокан — проверяем, какие вызовы
// делает окно и что показывает.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ProjectAccessDialog from "../project/ProjectAccessDialog";
import { projectsApi, usersApi } from "../../api/projects";
import type { Project, ProjectMember } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    members: vi.fn(), putMember: vi.fn(), removeMember: vi.fn(), transfer: vi.fn(), update: vi.fn(),
  },
  usersApi: { list: vi.fn() },
}));
vi.mock("../../api/auth", () => ({ getMe: () => ({ id: "u1", username: "owner", role: "architect", is_admin: false }) }));
// Нативный <dialog> в jsdom не открывается — прозрачная обёртка (паттерн соседних тестов).
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const проект = (over: Partial<Project> = {}): Project => ({
  id: "p1", name: "Ярмарка", description: null, archived_at: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  object_count: 1, edge_count: 0, updated_by: null, preview: { nodes: [], edges: [] },
  my_role: "owner", owner_username: "owner", visible_to_all: false,
  ...over,
});

const участники: ProjectMember[] = [
  { user_id: "u1", username: "owner", role: "owner" },
  { user_id: "u2", username: "editor", role: "editor" },
];

const onChanged = vi.fn();

function открыть(over: Partial<Project> = {}) {
  return render(<ProjectAccessDialog project={проект(over)} onClose={vi.fn()} onChanged={onChanged} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.members).mockResolvedValue(участники);
  vi.mocked(usersApi.list).mockResolvedValue([
    { id: "u1", username: "owner" },
    { id: "u2", username: "editor" },
    { id: "u3", username: "stranger" },
  ]);
  vi.mocked(projectsApi.putMember).mockResolvedValue({ user_id: "u3", username: "stranger", role: "editor" });
  vi.mocked(projectsApi.removeMember).mockResolvedValue(undefined);
});

describe("ProjectAccessDialog: владелец", () => {
  it("список участников: у владельца метка и передача, у остальных роль и удаление", async () => {
    открыть();
    const владелец = await screen.findByTestId("member-owner");
    expect(within(владелец).getByText("Владелец")).toBeInTheDocument();
    expect(within(владелец).getByRole("button", { name: "Передать владение" })).toBeInTheDocument();
    const редактор = screen.getByTestId("member-editor");
    expect(within(редактор).getByRole("combobox", { name: "Роль editor" })).toHaveValue("editor");
    expect(within(редактор).getByRole("button", { name: "Удалить editor" })).toBeInTheDocument();
  });

  it("флажок «Виден всем пользователям» шлёт PATCH проекта", async () => {
    vi.mocked(projectsApi.update).mockResolvedValue(проект({ visible_to_all: true }));
    открыть();
    expect(screen.getByText("Остальные пользователи смогут только смотреть")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Виден всем пользователям/ }));
    expect(projectsApi.update).toHaveBeenCalledWith("p1", { visible_to_all: true });
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    expect(onChanged).toHaveBeenCalled();
  });

  it("смена роли и удаление участника", async () => {
    открыть();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Роль editor" }), "reader");
    expect(projectsApi.putMember).toHaveBeenCalledWith("p1", "u2", "reader");
    await userEvent.click(screen.getByRole("button", { name: "Удалить editor" }));
    expect(projectsApi.removeMember).toHaveBeenCalledWith("p1", "u2");
  });

  it("добавление по логину из подсказок, с выбранной ролью", async () => {
    открыть();
    await screen.findByTestId("member-owner");
    await waitFor(() => expect(usersApi.list).toHaveBeenCalled());
    // В подсказках только те, кого в проекте ещё нет.
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll("#member-candidates option")).map((o) => (o as HTMLOptionElement).value),
      ).toEqual(["stranger"]),
    );

    await userEvent.type(screen.getByPlaceholderText("Логин"), "stranger");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Роль нового участника" }), "reader");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(projectsApi.putMember).toHaveBeenCalledWith("p1", "u3", "reader");
    await waitFor(() => expect(screen.getByPlaceholderText("Логин")).toHaveValue(""));
  });

  it("незнакомый логин не отправляется", async () => {
    открыть();
    await waitFor(() => expect(usersApi.list).toHaveBeenCalled());
    await userEvent.type(screen.getByPlaceholderText("Логин"), "никто");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(screen.getByText("Нет такого пользователя")).toBeInTheDocument();
    expect(projectsApi.putMember).not.toHaveBeenCalled();
  });

  it("передача владения: выбор, подтверждение, окно становится только для чтения", async () => {
    vi.mocked(projectsApi.transfer).mockResolvedValue(
      проект({ my_role: "editor", owner_username: "stranger" }),
    );
    открыть();
    await userEvent.click(await screen.findByRole("button", { name: "Передать владение" }));
    await waitFor(() => expect(usersApi.list).toHaveBeenCalled());
    const выбор = screen.getByLabelText("Новый владелец");
    // Себе передать нельзя: текущего владельца в выборе нет.
    await waitFor(() =>
      expect(within(выбор).getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Выберите пользователя", "editor", "stranger",
      ]),
    );
    await userEvent.selectOptions(выбор, "u3");
    await userEvent.click(screen.getByRole("button", { name: "Передать" }));

    expect(screen.getByText("Передать проект «Ярмарка» пользователю stranger?")).toBeInTheDocument();
    expect(screen.getByText("Вы останетесь редактором.")).toBeInTheDocument();
    expect(projectsApi.transfer).not.toHaveBeenCalled();
    // В подтверждении своя кнопка «Передать» — последняя по порядку.
    const кнопки = screen.getAllByRole("button", { name: "Передать" });
    await userEvent.click(кнопки[кнопки.length - 1]);

    expect(projectsApi.transfer).toHaveBeenCalledWith("p1", "u3");
    expect(await screen.findByText("Менять доступ может владелец проекта.")).toBeInTheDocument();
    expect(screen.queryByText("Передать проект «Ярмарка» пользователю stranger?")).not.toBeInTheDocument();
  });
});

describe("ProjectAccessDialog: не владелец", () => {
  it("редактор видит участников и видимость, но ничего не меняет", async () => {
    открыть({ my_role: "editor" });
    const редактор = await screen.findByTestId("member-editor");
    expect(within(редактор).getByText("Редактор")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Передать владение" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить" })).not.toBeInTheDocument();
    expect(screen.getByText("Менять доступ может владелец проекта.")).toBeInTheDocument();
    // Список пользователей не-владельцу не нужен.
    expect(usersApi.list).not.toHaveBeenCalled();
  });
});
