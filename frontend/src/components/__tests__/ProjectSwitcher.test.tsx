// Название проекта в шапке оболочки и список проектов под ним (редизайн, фаза 5): имя без
// прежнего ограничения 160px, список на новом языке, поведение прежнее — поиск, Escape и
// клик мимо закрывают, выбор переключает проект, «Новый проект» — тому, кто может создавать.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectSwitcher from "../ProjectSwitcher";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("../project/CreateProjectDialog", () => ({
  default: () => <div data-testid="create-dialog" />,
}));

const LONG = "Маркетплейс «Ярмарка» v2 для проверки очень длинного названия на шапке";

function проект(id: string, name: string): Project {
  return {
    id, name, description: null, archived_at: null,
    created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
    object_count: 1, edge_count: 0, updated_by: null, preview: { nodes: [], edges: [] },
    my_role: "owner", owner_username: "admin", visible_to_all: false,
  };
}

const ПРОЕКТЫ = [проект("p1", LONG), проект("p2", "Sentry Эталон v2"), проект("p3", "Zulip Эталон v2")];

const nav = { onAllProjects: vi.fn(), onSwitchProject: vi.fn() };

async function setup(isArchitect = true) {
  render(<ProjectSwitcher projectId="p1" isArchitect={isArchitect} {...nav} />);
  // Имя текущего приходит со списком проектов.
  return screen.findByText(LONG);
}

const trigger = () => screen.getByRole("button", { name: LONG });

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.list).mockResolvedValue(ПРОЕКТЫ);
  });

  it("название без ограничения ширины и без значка перед ним, полное имя в подсказке", async () => {
    const name = await setup();
    const btn = trigger();
    // Прежде кнопка держала maxWidth 240, а имя 160: «Маркетплейс «Яр…» при свободном месте.
    expect(btn.getAttribute("style")).toBeNull();
    expect(name.getAttribute("style")).toBeNull();
    expect(name).toHaveClass("ps-name");
    expect(name).toHaveAttribute("title", LONG);
    // Значка перед именем нет: первый ребёнок кнопки — само имя, за ним шеврон.
    expect(btn.firstElementChild).toBe(name);
    expect(btn).toHaveClass("ps-trigger");
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("список на новом языке: поле поиска, пункты, текущий с галочкой, черта и два пункта", async () => {
    await setup();
    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu");
    expect(menu).toHaveClass("ds-menu");
    expect(screen.getByPlaceholderText("Поиск проекта")).toHaveClass("ds-input");

    const items = screen.getAllByRole("menuitem");
    expect(items.map((b) => b.textContent)).toEqual([LONG, "Sentry Эталон v2", "Zulip Эталон v2", "Новый проект", "Все проекты"]);
    for (const it of items) expect(it).toHaveClass("ds-menu-item");
    // Текущий — галочкой справа, остальные без неё.
    expect(items[0]).toHaveAttribute("aria-current", "true");
    expect(items[0].querySelector(".ps-check svg")).not.toBeNull();
    expect(items[1]).not.toHaveAttribute("aria-current");
    expect(items[1].querySelector("svg")).toBeNull();
    // Длинное имя в списке обрезается многоточием, полное — в подсказке.
    expect(items[0].querySelector(".ps-item-name")).toHaveAttribute("title", LONG);
    // «Новый проект» без значка «+».
    expect(items[3].querySelector("svg")).toBeNull();
    expect(menu.querySelector(".ds-menu-sep")).not.toBeNull();
  });

  it("поиск по имени, «Ничего не найдено»", async () => {
    await setup();
    await userEvent.click(trigger());
    await userEvent.type(screen.getByPlaceholderText("Поиск проекта"), "sentry");
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Sentry Эталон v2", "Новый проект", "Все проекты"]);
    await userEvent.clear(screen.getByPlaceholderText("Поиск проекта"));
    await userEvent.type(screen.getByPlaceholderText("Поиск проекта"), "zzz");
    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("выбор другого проекта переключает его и закрывает список; текущий — только закрывает", async () => {
    await setup();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: "Sentry Эталон v2" }));
    expect(nav.onSwitchProject).toHaveBeenCalledWith("p2");
    expect(screen.queryByRole("menu")).toBeNull();

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: LONG }));
    expect(nav.onSwitchProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape и клик мимо закрывают список", async () => {
    await setup();
    await userEvent.click(trigger());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await userEvent.click(trigger());
    await userEvent.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("«Новый проект» — только тому, кто может создавать; «Все проекты» — всем", async () => {
    await setup(false);
    await userEvent.click(trigger());
    expect(screen.queryByRole("menuitem", { name: "Новый проект" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: "Все проекты" }));
    expect(nav.onAllProjects).toHaveBeenCalledTimes(1);
  });

  it("«Новый проект» открывает окно создания", async () => {
    await setup();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitem", { name: "Новый проект" }));
    expect(screen.getByTestId("create-dialog")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
