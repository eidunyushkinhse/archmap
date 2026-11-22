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
    { id: "u1", username: "owner", can_edit: true },
    { id: "u2", username: "editor", can_edit: true },
    { id: "u3", username: "stranger", can_edit: true },
    // «Пользователь»: бывает только читателем
    { id: "u4", username: "viewer", can_edit: false },
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
    // Пояснение — подсказкой строки флажка (редизайн, фаза 9г), а не второй строкой текста.
    expect(screen.getByTitle("Остальные пользователи смогут только смотреть")).toContainElement(screen.getByRole("checkbox"));
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
      ).toEqual(["stranger", "viewer"]),
    );

    await userEvent.type(screen.getByPlaceholderText("Логин"), "stranger");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Роль нового участника" }), "reader");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(projectsApi.putMember).toHaveBeenCalledWith("p1", "u3", "reader");
    await waitFor(() => expect(screen.getByPlaceholderText("Логин")).toHaveValue(""));
  });

  it("«Пользователя» — только читателем: «Редактор» закрыт, уходит reader", async () => {
    открыть();
    await waitFor(() => expect(usersApi.list).toHaveBeenCalled());
    const роль = screen.getByRole("combobox", { name: "Роль нового участника" });
    expect(роль).toHaveValue("editor");
    await userEvent.type(screen.getByPlaceholderText("Логин"), "viewer");
    expect(роль).toHaveValue("reader");
    expect(within(роль).getByRole("option", { name: "Редактор" })).toBeDisabled();
    expect(screen.getByText("«Пользователь» может быть только читателем")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(projectsApi.putMember).toHaveBeenCalledWith("p1", "u4", "reader");
  });

  it("у участника-«Пользователя» «Редактор» в выборе роли закрыт", async () => {
    vi.mocked(projectsApi.members).mockResolvedValue([...участники, { user_id: "u4", username: "viewer", role: "reader" }]);
    открыть();
    const роль = await screen.findByRole("combobox", { name: "Роль viewer" });
    await waitFor(() => expect(within(роль).getByRole("option", { name: "Редактор" })).toBeDisabled());
    expect(within(screen.getByTestId("member-editor")).getByRole("option", { name: "Редактор" })).toBeEnabled();
  });

  it("Enter в поле логина добавляет с ролью по умолчанию «Редактор»", async () => {
    открыть();
    await waitFor(() => expect(usersApi.list).toHaveBeenCalled());
    await userEvent.type(screen.getByPlaceholderText("Логин"), "stranger{Enter}");
    expect(projectsApi.putMember).toHaveBeenCalledWith("p1", "u3", "editor");
    await waitFor(() => expect(screen.getByPlaceholderText("Логин")).toHaveValue(""));
  });

  it("уже участник: отказ текстом, запроса нет", async () => {
    открыть();
    await waitFor(() => expect(usersApi.list).toHaveBeenCalled());
    await screen.findByTestId("member-editor");
    await userEvent.type(screen.getByPlaceholderText("Логин"), "editor{Enter}");
    expect(screen.getByText("Пользователь уже в проекте")).toBeInTheDocument();
    expect(projectsApi.putMember).not.toHaveBeenCalled();
  });

  it("после правки список участников перечитывается, затем зовётся onChanged", async () => {
    открыть();
    await userEvent.click(await screen.findByRole("button", { name: "Удалить editor" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(projectsApi.members).toHaveBeenCalledTimes(2);
    const удаление = vi.mocked(projectsApi.removeMember).mock.invocationCallOrder[0];
    const перечитать = vi.mocked(projectsApi.members).mock.invocationCallOrder[1];
    expect(удаление).toBeLessThan(перечитать);
    expect(перечитать).toBeLessThan(onChanged.mock.invocationCallOrder[0]);
  });

  it("отказ правки показывается текстом, onChanged не зовётся", async () => {
    vi.mocked(projectsApi.putMember).mockRejectedValue(new Error("Нет прав на проект"));
    открыть();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Роль editor" }), "reader");
    expect(await screen.findByText("Нет прав на проект")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("передача владения: «Отмена» в подтверждении ничего не передаёт", async () => {
    открыть();
    await userEvent.click(await screen.findByRole("button", { name: "Передать владение" }));
    await waitFor(() => expect(usersApi.list).toHaveBeenCalled());
    const выбор = screen.getByLabelText("Новый владелец");
    await waitFor(() => expect(within(выбор).getAllByRole("option")).toHaveLength(3));
    // Пока никто не выбран, «Передать» заперта.
    expect(screen.getByRole("button", { name: "Передать" })).toBeDisabled();
    await userEvent.selectOptions(выбор, "u2");
    await userEvent.click(screen.getByRole("button", { name: "Передать" }));
    expect(screen.getByText("Передать проект «Ярмарка» пользователю editor?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByText("Передать проект «Ярмарка» пользователю editor?")).not.toBeInTheDocument();
    expect(projectsApi.transfer).not.toHaveBeenCalled();
    // Строка выбора остаётся открытой с выбранным пользователем.
    expect(screen.getByLabelText("Новый владелец")).toHaveValue("u2");
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
    // Себе передать нельзя: текущего владельца в выборе нет; «Пользователя» — тоже.
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

// Вид (редизайн, фаза 9г): каркас окна нового языка, тихие строки участников.
describe("ProjectAccessDialog: вид", () => {
  it("владелец: заголовок h2, имя проекта строкой, флажок, блок «Участники», подвал «Закрыть»", async () => {
    открыть();
    await screen.findByTestId("member-owner");
    expect(screen.getByRole("heading", { level: 2, name: "Доступ к проекту" })).toHaveClass("ds-win-title");
    expect(screen.getByText("Ярмарка")).toHaveClass("ds-win-lead");
    expect(screen.getByRole("checkbox", { name: "Виден всем пользователям" }).closest("label")).toHaveClass("ds-check");
    expect(screen.getByRole("heading", { level: 3, name: "Участники" })).toHaveClass("ds-win-block-title");
    // Кнопок с текстом в окне: действия строк, строка добавления и одна «Закрыть» в подвале.
    const подвал = screen.getAllByRole("button").filter((b) => b.textContent === "Закрыть");
    expect(подвал).toHaveLength(1);
    expect(подвал[0].className).toBe("ds-btn");
    expect(screen.getAllByRole("button", { name: "Закрыть" }).filter((b) => b.classList.contains("ds-win-close"))).toHaveLength(1);
    // Инлайн-стилей у разметки окна нет; свой отступ несёт только общий шеврон списков
    // (ui/icons, ChevronDownIcon): роль участника editor и роль нового участника.
    expect([...document.querySelectorAll("[style]")].map((e) => e.tagName.toLowerCase())).toEqual(["svg", "svg"]);
  });

  it("строки участников: у владельца слово «Владелец» и «Передать владение», у остальных список роли и «Удалить»", async () => {
    открыть();
    const владелец = await screen.findByTestId("member-owner");
    expect(владелец).toHaveClass("pa-member");
    expect(within(владелец).getByText("Владелец")).toHaveClass("pa-role");
    expect(within(владелец).getByRole("button", { name: "Передать владение" })).toHaveClass("ds-add");
    const редактор = screen.getByTestId("member-editor");
    expect(within(редактор).getByRole("combobox", { name: "Роль editor" }).parentElement).toHaveClass("ds-select");
    expect(within(редактор).getByRole("button", { name: "Удалить editor" })).toHaveClass("pa-del");
  });

  it("строка добавления: поле логина без видимой подписи, роль списком, «Добавить» не главная", async () => {
    открыть();
    await waitFor(() => expect(usersApi.list).toHaveBeenCalled());
    const поле = screen.getByLabelText("Добавить участника");
    expect(поле).toBe(screen.getByPlaceholderText("Логин"));
    expect(поле).toHaveClass("ds-input");
    expect(screen.getByText("Добавить участника")).toHaveClass("ds-sr");
    expect(screen.getByRole("combobox", { name: "Роль нового участника" }).parentElement).toHaveClass("ds-select");
    expect(screen.getByRole("button", { name: "Добавить" }).className).toBe("ds-btn");
    await userEvent.type(поле, "viewer");
    expect(screen.getByText("«Пользователь» может быть только читателем")).toHaveClass("pa-hint");
  });

  it("передача владения: подпись «Новый владелец» слева от списка, «Передать» не главная", async () => {
    открыть();
    await userEvent.click(await screen.findByRole("button", { name: "Передать владение" }));
    expect(screen.getByRole("button", { name: "Передать владение" })).toHaveAttribute("aria-expanded", "true");
    const выбор = screen.getByLabelText("Новый владелец");
    expect(выбор.parentElement).toHaveClass("ds-select");
    expect(screen.getByText("Новый владелец")).toHaveClass("pa-line-cap");
    expect(screen.getByRole("button", { name: "Передать" }).className).toBe("ds-btn");
  });

  it("отказ правки — строкой опасности", async () => {
    vi.mocked(projectsApi.removeMember).mockRejectedValue(new Error("Нет прав на проект"));
    открыть();
    await userEvent.click(await screen.findByRole("button", { name: "Удалить editor" }));
    expect(await screen.findByText("Нет прав на проект")).toHaveClass("ds-danger");
  });

  it("не владелец: роли словами тихим цветом, заметка тихим текстом", async () => {
    открыть({ my_role: "editor" });
    const редактор = await screen.findByTestId("member-editor");
    expect(within(редактор).getByText("Редактор")).toHaveClass("pa-role");
    expect(within(screen.getByTestId("member-owner")).getByText("Владелец")).toHaveClass("pa-role");
    expect(screen.getByText("Менять доступ может владелец проекта.")).toHaveClass("pa-note");
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
    expect(screen.queryByRole("button", { name: /^Удалить/ })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Логин")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("member-owner")).getByText("Владелец")).toBeInTheDocument();
    expect(screen.getByText("Менять доступ может владелец проекта.")).toBeInTheDocument();
    // Список пользователей не-владельцу не нужен.
    expect(usersApi.list).not.toHaveBeenCalled();
  });
});
