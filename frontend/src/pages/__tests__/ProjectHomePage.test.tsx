// ProjectHomePage: отказ загрузки меты проекта или схемы корня — экран с причиной и
// «Повторить», а не вечная «Загрузка» (аудит R-2, R-10). Тяжёлый блок схемы и
// поллинг замоканы: проверяется оркестрация загрузки страницы.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectHomePage from "../ProjectHomePage";
import { projectsApi } from "../../api/projects";
import { processesApi } from "../../api/processes";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import { ProjectRoleContext } from "../projectRole";
import { useRemoteSync } from "../useRemoteSync";

vi.mock("../../api/projects", () => ({ projectsApi: { get: vi.fn() } }));
vi.mock("../../api/processes", () => ({ processesApi: { list: vi.fn() } }));
vi.mock("../../api/nodes", () => ({ nodesApi: { getGraph: vi.fn(), relayoutLevel: vi.fn() } }));
vi.mock("../useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
vi.mock("../../components/EmbeddedSchemaBlock", () => ({
  default: ({ title }: { title?: string }) => <div data-testid="schema" data-title={title} />,
}));
// Панель версий — маркер с пропсами: здесь проверяется вход из ⋯-меню проекта, сама
// панель покрыта своим тестом (VersionsPanel.test).
vi.mock("../../components/nodePage/versions/VersionsPanel", () => ({
  default: ({ nodeId, title, canEdit, canDelete }: {
    nodeId: string | null; title: string; canEdit: boolean; canDelete: boolean;
  }) => (
    <div
      data-testid="versions-panel"
      data-node-id={nodeId === null ? "null" : nodeId}
      data-title={title}
      data-can-edit={String(canEdit)}
      data-can-delete={String(canDelete)}
    />
  ),
}));

const props = { projectId: "p1", isArchitect: false, onNavigateNode: vi.fn(), onNavigateMap: vi.fn() };
const graph = { nodes: [], endpoints: [], edges: [], layout: {}, version: 1, graph_rev: 1, meta_rev: 1, has_status_info: false };

describe("ProjectHomePage: отказ загрузки", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Ярмарка", description: null } as never);
    vi.mocked(processesApi.list).mockResolvedValue([]);
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph as never);
  });

  it("мета не загрузилась: экран с причиной, повтор открывает страницу", async () => {
    vi.mocked(projectsApi.get).mockRejectedValueOnce(new ApiError(403, "Нет доступа"));
    render(<ProjectHomePage {...props} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось загрузить проект");
    expect(alert).toHaveTextContent("Нет доступа к этому проекту");

    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.getByTestId("schema")).toBeInTheDocument());
    expect(projectsApi.get).toHaveBeenCalledTimes(2);
  });

  it("схема корня не загрузилась: тот же экран, повтор перечитывает только схему", async () => {
    vi.mocked(nodesApi.getGraph).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<ProjectHomePage {...props} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Нет связи с сервером");
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.getByTestId("schema")).toBeInTheDocument());
    expect(nodesApi.getGraph).toHaveBeenCalledTimes(2);
    expect(projectsApi.get).toHaveBeenCalledTimes(1);
  });
});

// ⋯-меню страницы проекта: единственный пункт — версии документации всего проекта
// (корень дерева, nodeId = null); права — как на странице объекта.
describe("ProjectHomePage: версии документации проекта", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Ярмарка", description: null } as never);
    vi.mocked(processesApi.list).mockResolvedValue([]);
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph as never);
  });

  it("читатель: пункт меню открывает панель корня без права правки", async () => {
    render(
      <ProjectRoleContext.Provider value="reader">
        <ProjectHomePage {...props} />
      </ProjectRoleContext.Provider>,
    );
    await userEvent.click(await screen.findByTitle("Действия"));
    await userEvent.click(screen.getByRole("button", { name: "Версии документации" }));
    const panel = screen.getByTestId("versions-panel");
    expect(panel).toHaveAttribute("data-node-id", "null");
    expect(panel).toHaveAttribute("data-title", "Ярмарка");
    expect(panel).toHaveAttribute("data-can-edit", "false");
    expect(panel).toHaveAttribute("data-can-delete", "false");
  });

  it("владелец: панель с фиксацией и удалением версий", async () => {
    render(
      <ProjectRoleContext.Provider value="owner">
        <ProjectHomePage {...props} isArchitect />
      </ProjectRoleContext.Provider>,
    );
    await userEvent.click(await screen.findByTitle("Действия"));
    await userEvent.click(screen.getByRole("button", { name: "Версии документации" }));
    const panel = screen.getByTestId("versions-panel");
    expect(panel).toHaveAttribute("data-can-edit", "true");
    expect(panel).toHaveAttribute("data-can-delete", "true");
  });
});

// Редизайн (направление А «Документ»): шапка — название, ⋯ справа и описание, без
// подписи «Проект», глифа и чипов-счётчиков; раздел «Схема»; «Процессы» строками и
// только когда процессы есть.
describe("ProjectHomePage: шапка и разделы", () => {
  const proc = (id: string, name: string) => ({
    id, name, scope_node_id: null, scope_name: null, message_count: 7, statuses: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.get).mockResolvedValue({
      id: "p1", name: "Ярмарка", description: "Маркетплейс для продавцов и покупателей",
      object_count: 12, edge_count: 30,
    } as never);
    vi.mocked(processesApi.list).mockResolvedValue([]);
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph as never);
  });

  it("шапка: название заголовком и описание; ни «Проект», ни счётчиков", async () => {
    render(<ProjectHomePage {...props} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Ярмарка" })).toBeInTheDocument();
    expect(screen.getByText("Маркетплейс для продавцов и покупателей")).toHaveClass("np-desc");
    expect(screen.queryByText("Проект")).toBeNull();
    expect(screen.queryByText(/12 объектов/)).toBeNull();
    expect(screen.queryByText(/30 связей/)).toBeNull();
    expect(screen.getByTestId("schema")).toHaveAttribute("data-title", "Схема");
  });

  it("без процессов раздела «Процессы» нет", async () => {
    render(<ProjectHomePage {...props} />);
    await screen.findByTestId("schema");
    expect(screen.queryByRole("heading", { name: "Процессы" })).toBeNull();
  });

  it("процессы — строками с именем; клик ведёт в процесс", async () => {
    vi.mocked(processesApi.list).mockResolvedValue([proc("a", "Оформление заказа"), proc("b", "Оплата")] as never);
    const onNavigateProcesses = vi.fn();
    render(<ProjectHomePage {...props} onNavigateProcesses={onNavigateProcesses} />);
    expect(await screen.findByRole("heading", { name: "Процессы" })).toBeInTheDocument();
    expect(screen.queryByText(/сообщени/)).toBeNull();
    expect(screen.queryByText(/открыть/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Оплата" }));
    expect(onNavigateProcesses).toHaveBeenCalledWith("b");
  });
});

// Страховка механики тоста чужой правки (редизайн, фаза 13а, меняется только вид): тост
// стоит в обёртке блока схемы (её правый верхний угол), без роли, гаснет ровно через 4 с.
describe("ProjectHomePage: тост «Схему только что изменили в другом окне»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Ярмарка", description: null } as never);
    vi.mocked(processesApi.list).mockResolvedValue([]);
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph as never);
  });

  it("чужая правка схемы: тост в блоке схемы без роли, гаснет через 4 с", async () => {
    render(<ProjectHomePage {...props} />);
    await screen.findByTestId("schema");
    const sync = vi.mocked(useRemoteSync).mock.calls.at(-1)?.[0] as { onRemoteChange: () => void };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => { sync.onRemoteChange(); });
      const тост = screen.getByText("Схему только что изменили в другом окне");
      expect(тост).toHaveClass("ds-toast", "ds-toast--corner");
      expect(тост).not.toHaveClass("legacy-root");
      expect(тост).not.toHaveAttribute("style");
      expect(тост).not.toHaveAttribute("role");
      expect(тост).not.toHaveAttribute("aria-live");
      expect(тост.parentElement).toContainElement(screen.getByTestId("schema"));
      act(() => { vi.advanceTimersByTime(3999); });
      expect(screen.getByText("Схему только что изменили в другом окне")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByText("Схему только что изменили в другом окне")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
