// Экран «Проекты» глазами обычного пользователя (гость демо-стенда — ProjectsPageGuest.test,
// пункты меню по роли — components/__tests__/ProjectCard.test): вкладки и поиск, три пустых
// состояния, «Загрузка» и отказ загрузки, какие окна открывают пункты меню карточки и что
// после них (тост, перезагрузка списков, переход в проект). Окна заменены заглушками с
// кнопками их колбэков: здесь проверяется страница, а не окна.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ProjectsPage from "../ProjectsPage";
import { getUserRole } from "../../api/auth";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/auth", () => ({
  fetchMe: vi.fn(async () => ({})),
  getUserRole: vi.fn(() => "architect"),
  getIsAdmin: vi.fn(() => false),
  getIsGuest: vi.fn(() => false),
  getCanCreateProject: vi.fn(() => true),
  getMe: vi.fn(() => ({ username: "anna" })),
}));
vi.mock("../../api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("../../components/project/SchemaPreview", () => ({ default: () => <div data-testid="preview" /> }));
vi.mock("../../components/project/CreateProjectDialog", () => ({
  default: ({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) => (
    <div data-testid="create-dialog">
      <button onClick={() => onCreated("p-new")}>создан</button>
      <button onClick={onClose}>закрыть окно</button>
    </div>
  ),
}));
vi.mock("../../components/project/EditProjectDialog", () => ({
  default: ({ project, onSaved }: { project: Project; onSaved: () => void }) => (
    <div data-testid="edit-dialog">{project.name}<button onClick={onSaved}>сохранено</button></div>
  ),
}));
vi.mock("../../components/project/ProjectAccessDialog", () => ({
  default: ({ project, onChanged, onClose }: { project: Project; onChanged: () => void; onClose: () => void }) => (
    <div data-testid="access-dialog">
      {project.name}
      <button onClick={onChanged}>доступ изменён</button>
      <button onClick={onClose}>закрыть окно</button>
    </div>
  ),
}));
vi.mock("../../components/project/ProjectDialogs", () => {
  const stub = (testId: string) => ({ project, onDone }: { project: Project; onDone: () => void }) => (
    <div data-testid={testId}>{project.name}<button onClick={onDone}>готово</button></div>
  );
  return {
    ArchiveDialog: stub("archive-dialog"),
    RestoreDialog: stub("restore-dialog"),
    DeleteForeverDialog: stub("delete-dialog"),
  };
});

const проект = (id: string, name: string, fields: Partial<Project> = {}): Project => ({
  id, name, description: null, archived_at: null,
  created_at: "2026-10-02T00:00:00Z", updated_at: "2026-11-11T09:00:00Z",
  object_count: 12, edge_count: 7, updated_by: "anna", preview: { nodes: [], edges: [] },
  my_role: "owner", owner_username: "anna", visible_to_all: false,
  ...fields,
});
const ЯРМАРКА = проект("p1", "Маркетплейс «Ярмарка»", { description: "Демо-проект с заказами" });
const ПЛЁНКА = проект("p2", "Плёнка", { description: "Фотосервис" });
const СТАРЫЙ = проект("p3", "Старый биллинг", { archived_at: "2026-11-01T00:00:00Z" });

function списки(active: Project[], archived: Project[] = []) {
  vi.mocked(projectsApi.list).mockImplementation(async (arch?: boolean) => (arch ? archived : active));
}

function открыть() {
  const props = { onOpenProject: vi.fn(), onLogout: vi.fn(), onOpenUsers: vi.fn() };
  render(<ProjectsPage {...props} />);
  return props;
}

const карточка = (name: string) => screen.getByText(name).closest("[data-tour^='project:']") as HTMLElement;

async function пункт(name: string, label: string) {
  await userEvent.click(within(карточка(name)).getByRole("button", { name: "Меню проекта" }));
  await userEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: label }));
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserRole).mockReturnValue("architect");
  });

  it("каркас нового языка: корень .ds, шапка ds-head, главная кнопка без значка", async () => {
    списки([ЯРМАРКА]);
    открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    const заголовок = screen.getByRole("heading", { level: 1, name: "Проекты" });
    expect(заголовок.closest(".ds")).not.toBeNull();
    const шапка = document.querySelector("header.ds-head");
    expect(шапка).not.toBeNull();
    // Логотип на этом экране не ссылка: вести некуда.
    expect(within(шапка as HTMLElement).queryByRole("button", { name: "Все проекты" })).toBeNull();
    const кнопка = screen.getByRole("button", { name: "Новый проект" });
    expect(кнопка).toHaveClass("ds-btn", "ds-btn--primary");
    expect(кнопка.querySelector("svg")).toBeNull();
  });

  it("вкладки: «Активные» и «Архив» показывают свои списки", async () => {
    списки([ЯРМАРКА, ПЛЁНКА], [СТАРЫЙ]);
    открыть();
    expect(await screen.findByText("Маркетплейс «Ярмарка»")).toBeInTheDocument();
    expect(screen.getByText("Плёнка")).toBeInTheDocument();
    expect(screen.queryByText("Старый биллинг")).toBeNull();
    expect(projectsApi.list).toHaveBeenCalledWith(false);
    expect(projectsApi.list).toHaveBeenCalledWith(true);

    await userEvent.click(screen.getByRole("button", { name: /^Архив/ }));
    expect(screen.getByText("Старый биллинг")).toBeInTheDocument();
    expect(screen.queryByText("Плёнка")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /^Активные/ }));
    expect(screen.getByText("Плёнка")).toBeInTheDocument();
    expect(screen.queryByText("Старый биллинг")).toBeNull();
  });

  it("вкладки нового языка: без счётчиков, выбранная нажата и подчёркнута", async () => {
    списки([ЯРМАРКА, ПЛЁНКА], [СТАРЫЙ]);
    открыть();
    await screen.findByText("Плёнка");
    const активные = screen.getByRole("button", { name: "Активные" });
    const архив = screen.getByRole("button", { name: "Архив" });
    expect(активные).toHaveClass("ds-tab", "is-active");
    expect(активные).toHaveAttribute("aria-pressed", "true");
    expect(архив).toHaveAttribute("aria-pressed", "false");
    expect(архив).not.toHaveClass("is-active");
    await userEvent.click(архив);
    expect(архив).toHaveAttribute("aria-pressed", "true");
    expect(архив).toHaveClass("is-active");
    expect(активные).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByPlaceholderText("Поиск по имени или описанию")).toHaveClass("ds-input");
  });

  it("поиск по имени и описанию без учёта регистра; промах — «Ничего не найдено»", async () => {
    списки([ЯРМАРКА, ПЛЁНКА]);
    открыть();
    await screen.findByText("Плёнка");
    const поле = screen.getByPlaceholderText("Поиск по имени или описанию");
    await userEvent.type(поле, "ПЛЁН");
    expect(screen.getByText("Плёнка")).toBeInTheDocument();
    expect(screen.queryByText("Маркетплейс «Ярмарка»")).toBeNull();

    await userEvent.clear(поле);
    await userEvent.type(поле, "заказ");
    expect(screen.getByText("Маркетплейс «Ярмарка»")).toBeInTheDocument();
    expect(screen.queryByText("Плёнка")).toBeNull();

    await userEvent.clear(поле);
    await userEvent.type(поле, "нет такого");
    expect(screen.getByText("Ничего не найдено")).toHaveClass("ds-empty");
    expect(screen.queryByText("Пока нет ни одного проекта")).toBeNull();
  });

  it("пустой архив — «В архиве пусто»", async () => {
    списки([ЯРМАРКА]);
    открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    await userEvent.click(screen.getByRole("button", { name: /^Архив/ }));
    expect(screen.getByText("В архиве пусто")).toHaveClass("ds-empty");
    expect(screen.queryByText("Пока нет ни одного проекта")).toBeNull();
  });

  it("первое открытие: заголовок, пояснение и «Создать первый проект» открывает окно", async () => {
    списки([]);
    const props = открыть();
    expect(await screen.findByRole("heading", { name: "Пока нет ни одного проекта" })).toBeInTheDocument();
    expect(screen.getByText("Создайте первый проект. В каждом проекте своя изолированная схема системы.")).toBeInTheDocument();
    const создать = screen.getByRole("button", { name: "Создать первый проект" });
    expect(создать).toHaveClass("ds-btn", "ds-btn--primary");
    await userEvent.click(создать);
    expect(screen.getByTestId("create-dialog")).toBeInTheDocument();
    // Созданный проект открывается сразу.
    await userEvent.click(screen.getByRole("button", { name: "создан" }));
    expect(props.onOpenProject).toHaveBeenCalledWith("p-new");
    expect(screen.queryByTestId("create-dialog")).toBeNull();
  });

  it("без права создавать: ни «Нового проекта», ни «Создать первый проект»", async () => {
    vi.mocked(getUserRole).mockReturnValue("viewer");
    списки([]);
    открыть();
    expect(await screen.findByText("Пока нет ни одного проекта")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Создать первый проект/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Новый проект/ })).toBeNull();
  });

  it("«Загрузка» до ответа, отказ загрузки — текстом", async () => {
    let отказать: (e: Error) => void = () => {};
    vi.mocked(projectsApi.list).mockImplementation(() => new Promise<Project[]>((_, reject) => { отказать = reject; }));
    открыть();
    expect(screen.getByText("Загрузка")).toBeInTheDocument();
    отказать(new Error("Сервер недоступен"));
    expect(await screen.findByText("Сервер недоступен")).toBeInTheDocument();
    expect(screen.queryByText("Загрузка")).toBeNull();
  });

  it("«Новый проект» открывает окно создания; закрытие ничего не открывает", async () => {
    списки([ЯРМАРКА]);
    const props = открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    const кнопка = screen.getByRole("button", { name: /Новый проект/ });
    expect(кнопка).toHaveAttribute("data-tour", "new-project");
    await userEvent.click(кнопка);
    expect(screen.getByTestId("create-dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "закрыть окно" }));
    expect(screen.queryByTestId("create-dialog")).toBeNull();
    expect(props.onOpenProject).not.toHaveBeenCalled();
  });

  it("карточка открывает проект щелчком по превью и по тексту; кнопка меню — нет", async () => {
    списки([ЯРМАРКА]);
    const props = открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    const card = карточка("Маркетплейс «Ярмарка»");
    expect(card).toHaveAttribute("data-tour", "project:p1");
    await userEvent.click(within(card).getByRole("button", { name: "Меню проекта" }));
    expect(props.onOpenProject).not.toHaveBeenCalled();
    await userEvent.click(within(card).getByRole("button", { name: "Меню проекта" }));
    await userEvent.click(within(card).getByTestId("preview"));
    expect(props.onOpenProject).toHaveBeenLastCalledWith("p1");
    await userEvent.click(screen.getByText("Демо-проект с заказами"));
    expect(props.onOpenProject).toHaveBeenCalledTimes(2);
  });

  it("меню: «Открыть» ведёт в проект", async () => {
    списки([ЯРМАРКА]);
    const props = открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    await пункт("Маркетплейс «Ярмарка»", "Открыть");
    expect(props.onOpenProject).toHaveBeenCalledWith("p1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("меню: «Редактировать» — окно правки, после сохранения тост и перезагрузка", async () => {
    списки([ЯРМАРКА, ПЛЁНКА]);
    открыть();
    await screen.findByText("Плёнка");
    await пункт("Плёнка", "Редактировать");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("edit-dialog")).toHaveTextContent("Плёнка");
    await userEvent.click(screen.getByRole("button", { name: "сохранено" }));
    expect(screen.queryByTestId("edit-dialog")).toBeNull();
    expect(screen.getByText("Проект обновлён")).toBeInTheDocument();
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(4));
  });

  it("меню: «Доступ» — окно доступа, изменение перезагружает список, окно остаётся", async () => {
    списки([ЯРМАРКА]);
    открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    await пункт("Маркетплейс «Ярмарка»", "Доступ");
    expect(screen.getByTestId("access-dialog")).toHaveTextContent("Маркетплейс «Ярмарка»");
    await userEvent.click(screen.getByRole("button", { name: "доступ изменён" }));
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(4));
    expect(screen.getByTestId("access-dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "закрыть окно" }));
    expect(screen.queryByTestId("access-dialog")).toBeNull();
  });

  it("меню: «Архивировать» — окно архива, после него тост и перезагрузка", async () => {
    списки([ЯРМАРКА]);
    открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    await пункт("Маркетплейс «Ярмарка»", "Архивировать");
    expect(screen.getByTestId("archive-dialog")).toHaveTextContent("Маркетплейс «Ярмарка»");
    await userEvent.click(screen.getByRole("button", { name: "готово" }));
    expect(screen.queryByTestId("archive-dialog")).toBeNull();
    expect(screen.getByText("Проект отправлен в архив")).toBeInTheDocument();
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(4));
  });

  it("архив: «Восстановить» и «Удалить навсегда» — свои окна, тосты и перезагрузка", async () => {
    списки([ЯРМАРКА], [СТАРЫЙ]);
    открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    await userEvent.click(screen.getByRole("button", { name: /^Архив/ }));
    await пункт("Старый биллинг", "Восстановить");
    expect(screen.getByTestId("restore-dialog")).toHaveTextContent("Старый биллинг");
    await userEvent.click(screen.getByRole("button", { name: "готово" }));
    expect(screen.getByText("Проект восстановлен")).toBeInTheDocument();
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(4));

    await пункт("Старый биллинг", "Удалить навсегда");
    expect(screen.getByTestId("delete-dialog")).toHaveTextContent("Старый биллинг");
    await userEvent.click(screen.getByRole("button", { name: "готово" }));
    expect(screen.queryByTestId("delete-dialog")).toBeNull();
    expect(screen.getByText("Проект удалён")).toBeInTheDocument();
    await waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(6));
  });

  it("читатель проекта: у карточки нет меню, щелчок открывает проект", async () => {
    vi.mocked(getUserRole).mockReturnValue("viewer");
    списки([{ ...ЯРМАРКА, my_role: "reader" }]);
    const props = открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    expect(screen.queryByRole("button", { name: "Меню проекта" })).toBeNull();
    await userEvent.click(screen.getByText("Маркетплейс «Ярмарка»"));
    expect(props.onOpenProject).toHaveBeenCalledWith("p1");
  });

  // Страховка механики тоста (редизайн, фаза 13а, меняется только вид): тост итога — без
  // роли и без aria-live, гаснет ровно через 2,6 с.
  it("тост итога: без роли, гаснет через 2,6 с", async () => {
    списки([ЯРМАРКА]);
    открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    await пункт("Маркетплейс «Ярмарка»", "Редактировать");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "сохранено" })); });
      const тост = screen.getByText("Проект обновлён");
      expect(тост).toHaveClass("ds-toast", "ds-toast--bottom");
      expect(тост).not.toHaveClass("legacy-root");
      expect(тост).not.toHaveAttribute("style");
      expect(тост).not.toHaveAttribute("role");
      expect(тост).not.toHaveAttribute("aria-live");
      act(() => { vi.advanceTimersByTime(2599); });
      expect(screen.getByText("Проект обновлён")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByText("Проект обновлён")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("подвал карточки: кто менял и дата", async () => {
    списки([ЯРМАРКА]);
    открыть();
    await screen.findByText("Маркетплейс «Ярмарка»");
    const card = within(карточка("Маркетплейс «Ярмарка»"));
    expect(card.getByText("anna")).toBeInTheDocument();
    expect(card.getByText("11 нояб.")).toBeInTheDocument();
  });
});
