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

vi.mock("../../api/projects", () => ({ projectsApi: { get: vi.fn() } }));
vi.mock("../../api/processes", () => ({ processesApi: { list: vi.fn() } }));
vi.mock("../../api/nodes", () => ({ nodesApi: { getGraph: vi.fn(), relayoutLevel: vi.fn() } }));
vi.mock("../useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
vi.mock("../../components/EmbeddedSchemaBlock", () => ({ default: () => <div data-testid="schema" /> }));

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
