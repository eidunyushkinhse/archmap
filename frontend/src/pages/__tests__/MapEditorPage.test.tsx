// Рендер/поведенческие тесты MapEditorPage: breadcrumb (корень «Контекст» и путь
// по узлу), диспетчеры undo/redo (включая навигацию на уровень команды), кнопки
// «Готово» и Esc. Тяжёлый холст LevelGraph (@xyflow/react), инспектор, дерево,
// модалки и поллинг замоканы — тестируем оболочку редактора и её диспетчеры.
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MapEditorPage from "../MapEditorPage";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/auth", () => ({ getUserRole: vi.fn(() => "architect") }));
vi.mock("../../api/nodes", () => ({
  nodesApi: {
    getGraph: vi.fn(),
    getAll: vi.fn(),
    deletionSnapshot: vi.fn(),
    delete: vi.fn(),
    restore: vi.fn(),
    update: vi.fn(),
    getDescendants: vi.fn(),
  },
  nodeDocsApi: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  edgesApi: { update: vi.fn(), delete: vi.fn(), deletionSnapshot: vi.fn() },
}));

// История: контролируемый стаб (undo/redo-диспетчеры тестируют wiring, а не саму
// историю — она покрыта отдельно в useHistory.test.ts).
const historyMock = vi.hoisted(() => ({
  canUndo: vi.fn(() => false),
  canRedo: vi.fn(() => false),
  peekUndo: vi.fn(() => undefined as unknown),
  peekRedo: vi.fn(() => undefined as unknown),
  undo: vi.fn(),
  redo: vi.fn(),
  push: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("../../components/graph/interaction/useHistory", () => ({
  useHistory: () => historyMock,
}));

// Поллинг и алерты: без сети и таймеров.
vi.mock("../useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
vi.mock("../useSchemaAlerts", () => ({
  useSchemaAlerts: () => ({
    alerts: { disconnected_nodes: [], intermediate_edges: [], isolated_groups: [] },
    loaded: true,
    reload: vi.fn(),
  }),
  resolveAlertLocate: vi.fn(() => ({ level: null, request: { kind: "node", ids: [], token: 1 } })),
  PENDING_ALERT_LOCATE_KEY: "archmap.pendingAlertLocate",
}));
// Выбор связи: модалка не нужна.
vi.mock("../../components/graph/interaction/useEdgeChoice", () => ({
  useEdgeChoice: () => ({ onEdgesChoice: vi.fn(), onTrunkChoice: vi.fn(), choiceModal: null }),
}));

// Тяжёлые/условные потомки — заглушки. Холст ловит пропсы: undo/redo-диспетчеры
// редактора передаются в LevelGraph (бандл undo), а не рисуются в топбаре — тесты
// вызывают их отсюда.
const levelGraphProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../components/LevelGraph", () => ({
  default: (props: Record<string, unknown>) => {
    levelGraphProps.current = props;
    return <div data-testid="level-graph" />;
  },
}));
vi.mock("../../components/NodeTreePanel", () => ({
  default: () => <div data-testid="tree-panel" />,
}));
vi.mock("../../components/inspector/ObjectInspector", () => ({
  default: () => <div data-testid="object-inspector" />,
}));
vi.mock("../../components/CrossLevelEdgePicker", () => ({ default: () => null }));
vi.mock("../../components/EdgeQuickCreate", () => ({ default: () => null }));
vi.mock("../../components/NodeModal", () => ({ default: () => null }));
vi.mock("../../components/NodeDeleteConfirm", () => ({ default: () => null }));
vi.mock("../../components/NodesDeleteConfirm", () => ({ default: () => null }));
vi.mock("../../components/RelayoutConfirm", () => ({ default: () => null }));
vi.mock("../../components/SchemaAlerts", () => ({ default: () => null }));
vi.mock("../../components/SchemaViewFilter", () => ({ SchemaViewFilter: () => null }));

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id,
    name: id.toUpperCase(),
    description: null,
    role: null,
    technology: null,
    parent_id: null,
    shape: "service",
    is_external: false,
    status: "existing",
    openapi_spec: null,
    version: 1,
    docs: [],
    has_children: false,
    child_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as Node;
}

function graph(over: Record<string, unknown> = {}) {
  return {
    nodes: [],
    endpoints: [],
    edges: [],
    layout: {},
    version: 1,
    graph_rev: 1,
    meta_rev: 1,
    ...over,
  };
}

const props = {
  projectId: "p1",
  onDone: vi.fn(),
  onNavigateNode: vi.fn(),
};

describe("MapEditorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    levelGraphProps.current = null;
    sessionStorage.clear();
    historyMock.canUndo.mockReturnValue(false);
    historyMock.canRedo.mockReturnValue(false);
    historyMock.peekUndo.mockReturnValue(undefined);
    historyMock.peekRedo.mockReturnValue(undefined);
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
  });

  it("корневой уровень: breadcrumb «Контекст», холст рендерится после загрузки", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    expect(screen.getByRole("button", { name: "Контекст" })).toBeInTheDocument();
    expect(await screen.findByTestId("level-graph")).toBeInTheDocument();
    expect(nodesApi.getGraph).toHaveBeenCalledWith(null);
  });

  it("уровень узла: breadcrumb строит путь «Проект › Корень › Уровень B»", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      node("a", { name: "Корень", parent_id: null }),
      node("b", { name: "Уровень B", parent_id: "a" }),
    ]);
    render(<MapEditorPage {...props} nodeId="b" />);
    expect(await screen.findByRole("button", { name: "Проект" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Корень" })).toBeInTheDocument();
    // Текущий уровень — не ссылка (disabled)
    const current = screen.getByRole("button", { name: "Уровень B" });
    expect(current).toBeDisabled();
  });

  it("кнопка «Готово» вызывает onDone", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(props.onDone).toHaveBeenCalledOnce();
  });

  it("Esc вызывает onDone", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onDone).toHaveBeenCalledOnce();
  });

  it("пустая история: undo-диспетчер ничего не применяет", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const undo = levelGraphProps.current!.undo as { onUndo: () => void };
    await act(async () => { undo.onUndo(); });
    expect(historyMock.undo).not.toHaveBeenCalled();
  });

  it("undo: диспетчер применяет команду текущего уровня (history.undo)", async () => {
    historyMock.canUndo.mockReturnValue(true);
    historyMock.peekUndo.mockReturnValue({ label: "Правка", level: undefined });
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const undo = levelGraphProps.current!.undo as { onUndo: () => void };
    await act(async () => { undo.onUndo(); });
    expect(historyMock.undo).toHaveBeenCalledOnce();
  });

  it("redo: диспетчер применяет команду (history.redo)", async () => {
    historyMock.canRedo.mockReturnValue(true);
    historyMock.peekRedo.mockReturnValue({ label: "Правка", level: undefined });
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const undo = levelGraphProps.current!.undo as { onRedo: () => void };
    await act(async () => { undo.onRedo(); });
    expect(historyMock.redo).toHaveBeenCalledOnce();
  });

  it("undo с командой чужого уровня: сначала навигирует на уровень, потом отменяет", async () => {
    historyMock.canUndo.mockReturnValue(true);
    historyMock.peekUndo.mockReturnValue({ label: "Создание", level: "other" });
    vi.mocked(nodesApi.getAll).mockResolvedValue([node("other", { name: "Другой" })]);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const undo = levelGraphProps.current!.undo as { onUndo: () => void };
    await act(async () => { undo.onUndo(); });
    // Навигация на уровень команды строит путь через getAll и грузит уровень
    await waitFor(() => expect(nodesApi.getGraph).toHaveBeenCalledWith("other"));
    await waitFor(() => expect(historyMock.undo).toHaveBeenCalledOnce());
  });
});
