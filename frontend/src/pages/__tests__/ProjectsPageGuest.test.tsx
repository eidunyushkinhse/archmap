// «Все проекты» у гостя демо-стенда (docs/tasks/demo-mode.md, экран 2 прототипа):
// пилюля «Обучение» вместо меню профиля (метки «Песочница» в шапке нет), плашка
// песочницы, «Новый проект» активна, пока есть только «Ярмарка», и гаснет с
// подсказкой, когда свой проект создан.
// «Доступа» у гостя нет. Обычный пользователь всего этого не видит.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ProjectsPage from "../ProjectsPage";
import { getCanCreateProject, getIsGuest } from "../../api/auth";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/auth", () => ({
  fetchMe: vi.fn(async () => ({})),
  getUserRole: vi.fn(() => "architect"),
  getIsAdmin: vi.fn(() => false),
  getIsGuest: vi.fn(() => true),
  getCanCreateProject: vi.fn(() => true),
  getMe: vi.fn(() => ({ username: "guest-1a2b3c4d" })),
}));
vi.mock("../../api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("../../components/project/SchemaPreview", () => ({ default: () => <div /> }));
vi.mock("../../components/project/CreateProjectDialog", () => ({
  default: () => <div data-testid="create-dialog" />,
}));

const BANNER = "Это песочница. Она удалится через сутки бездействия. Не вносите сюда рабочие данные.";
const HINT = "В демо можно создать один свой проект. Удалите его, чтобы создать другой.";

const проект = (id: string, name: string): Project => ({
  id, name, description: null, archived_at: null,
  created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z",
  object_count: 35, edge_count: 39, updated_by: "guest-1a2b3c4d", preview: { nodes: [], edges: [] },
  my_role: "owner", owner_username: "guest-1a2b3c4d", visible_to_all: false,
});
const ЯРМАРКА = проект("p1", "Маркетплейс «Ярмарка»");
const СВОЙ = проект("p2", "Мой сервис доставки");

function список(active: Project[]) {
  vi.mocked(projectsApi.list).mockImplementation(async (archived?: boolean) => (archived ? [] : active));
}

async function открыть() {
  render(<ProjectsPage onOpenProject={vi.fn()} onLogout={vi.fn()} onOpenUsers={vi.fn()} />);
  await screen.findByText("Маркетплейс «Ярмарка»");
}

describe("ProjectsPage: гость демо-стенда", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIsGuest).mockReturnValue(true);
    vi.mocked(getCanCreateProject).mockReturnValue(true);
  });

  it("только «Ярмарка»: метка, плашка, кнопка активна и открывает окно", async () => {
    список([ЯРМАРКА]);
    await открыть();
    expect(screen.getByRole("button", { name: "Обучение" })).toBeInTheDocument();
    expect(screen.queryByText("Песочница")).toBeNull();
    expect(screen.queryByRole("button", { name: "Профиль" })).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent(BANNER);
    const кнопка = screen.getByRole("button", { name: /Новый проект/ });
    expect(кнопка).not.toHaveAttribute("aria-disabled");
    await userEvent.click(кнопка);
    expect(screen.getByTestId("create-dialog")).toBeInTheDocument();
    // Карточка подписана «Гость», а не логином guest-…
    expect(screen.getAllByText("Гость").length).toBeGreaterThan(0);
    expect(screen.queryByText("guest-1a2b3c4d")).toBeNull();
  });

  it("свой проект создан: кнопка неактивна, клик ничего не открывает", async () => {
    vi.mocked(getCanCreateProject).mockReturnValue(false);
    список([ЯРМАРКА, СВОЙ]);
    await открыть();
    const кнопка = screen.getByRole("button", { name: /Новый проект/ });
    expect(кнопка).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(кнопка);
    expect(screen.queryByTestId("create-dialog")).toBeNull();
  });

  it("наведение на неактивную кнопку: подсказка", async () => {
    vi.mocked(getCanCreateProject).mockReturnValue(false);
    список([ЯРМАРКА, СВОЙ]);
    await открыть();
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: /Новый проект/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(HINT);
    await userEvent.unhover(screen.getByRole("button", { name: /Новый проект/ }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("в меню карточки нет «Доступа»", async () => {
    список([ЯРМАРКА]);
    await открыть();
    await userEvent.click(screen.getByRole("button", { name: "Меню проекта" }));
    const пункты = within(screen.getByRole("menu")).getAllByRole("button").map((b) => b.textContent);
    expect(пункты).toEqual(["Открыть", "Редактировать", "Архивировать"]);
  });

  it("обычный пользователь: ни метки, ни плашки, «Доступ» на месте", async () => {
    vi.mocked(getIsGuest).mockReturnValue(false);
    список([ЯРМАРКА]);
    await открыть();
    expect(screen.queryByRole("button", { name: "Обучение" })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: "Профиль" })).toBeInTheDocument();
    expect(screen.getByText("guest-1a2b3c4d")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Меню проекта" }));
    expect(within(screen.getByRole("menu")).getByRole("button", { name: "Доступ" })).toBeInTheDocument();
  });
});
