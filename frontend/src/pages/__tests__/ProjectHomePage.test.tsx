// ProjectHomePage: отказ загрузки меты проекта или схемы корня — экран с причиной и
// «Повторить», а не вечная «Загрузка…» (аудит R-2, R-10). Тяжёлый блок схемы и
// поллинг замоканы: проверяется оркестрация загрузки страницы.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectHomePage from "../ProjectHomePage";
import { projectsApi } from "../../api/projects";
import { processesApi } from "../../api/processes";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import { ProjectRoleContext } from "../projectRole";

vi.mock("../../api/projects", () => ({ projectsApi: { get: vi.fn() } }));
vi.mock("../../api/processes", () => ({ processesApi: { list: vi.fn() } }));
vi.mock("../../api/nodes", () => ({ nodesApi: { getGraph: vi.fn(), relayoutLevel: vi.fn() } }));
vi.mock("../useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
vi.mock("../../components/EmbeddedSchemaBlock", () => ({ default: () => <div data-testid="schema" /> }));
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
