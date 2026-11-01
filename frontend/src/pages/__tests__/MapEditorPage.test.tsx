// Рендер/поведенческие тесты MapEditorPage: breadcrumb (корень «Контекст» и путь
// по узлу), диспетчеры undo/redo (включая навигацию на уровень команды), кнопки
// «Готово» и Esc. Тяжёлый холст LevelGraph (@xyflow/react), инспектор, дерево,
// модалки и поллинг замоканы — тестируем оболочку редактора и её диспетчеры.
import { render as rtlRender, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import MapEditorPage from "../MapEditorPage";
import { nodesApi } from "../../api/nodes";
import { ProjectRoleContext } from "../projectRole";
import type { Node, ProjectRole } from "../../types";

// Право правки — роль в проекте, её раздаёт гейт маршрутов (ProjectAccessGate)
// контекстом. Тесты рендерят редактор внутри провайдера с ролью role.current.
const role = { current: "owner" as ProjectRole | null };
function render(ui: ReactElement) {
  return rtlRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ProjectRoleContext.Provider value={role.current}>{children}</ProjectRoleContext.Provider>
    ),
  });
}
vi.mock("../../api/nodes", () => ({
  nodesApi: {
    get: vi.fn(),
    getGraph: vi.fn(),
    getAll: vi.fn(),
    deletionSnapshot: vi.fn(),
    moveSnapshot: vi.fn(),
    movePreview: vi.fn(),
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
    alerts: { disconnected_nodes: [], intermediate_edges: [], isolated_groups: [], container_own_docs: [] },
    loaded: true,
    reload: vi.fn(),
  }),
  resolveAlertLocate: vi.fn(() => ({ level: null, request: { kind: "node", ids: [], token: 1 } })),
  PENDING_ALERT_LOCATE_KEY: "archmap.pendingAlertLocate",
  PENDING_PROCESS_KEY: "archmap.pendingProcess",
}));
// Выбор связи: модалка не нужна.
vi.mock("../../components/graph/interaction/useEdgeChoice", () => ({
  useEdgeChoice: () => ({ onEdgesChoice: vi.fn(), choiceModal: null }),
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
// Дерево: заглушка, отдающая наружу колбэк переноса — жест сам покрыт тестами
// панели, здесь проверяется оркестрация редактора (снимок → PATCH → история).
const treeProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../components/NodeTreePanel", () => ({
  default: (props: Record<string, unknown>) => {
    treeProps.current = props;
    return <div data-testid="tree-panel" />;
  },
}));
// Инспектор: заглушка, отдающая наружу свои колбэки — сама панель покрыта
// NodeInspector.test.tsx, здесь проверяется оркестрация редактора (история правки).
const inspectorProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../components/inspector/ObjectInspector", () => ({
  default: (props: Record<string, unknown>) => {
    inspectorProps.current = props;
    return <div data-testid="object-inspector" />;
  },
}));
vi.mock("../../components/CrossLevelEdgePicker", () => ({ default: () => null }));
vi.mock("../../components/EdgeQuickCreate", () => ({ default: () => null }));
// Окно «Новый объект»: заглушка показывает, с каким родителем и шаблоном его открыли.
vi.mock("../../components/NodeModal", () => ({
  default: ({ parentId, type }: { parentId: string | null; type?: string }) => (
    <div data-testid="node-modal" data-parent={parentId ?? ""} data-type={type ?? ""} />
  ),
}));
vi.mock("../../components/NodeDeleteConfirm", () => ({ default: () => null }));
vi.mock("../../components/NodesDeleteConfirm", () => ({ default: () => null }));
vi.mock("../../components/RelayoutConfirm", () => ({ default: () => null }));
// Кнопка «Рекомендации» (алерты): метка присутствия + кнопка, дёргающая
// onOpenProcess — как строка процессного класса (AL26/AL27) в настоящей панели.
vi.mock("../../components/SchemaAlerts", () => ({
  default: ({ onOpenProcess }: { onOpenProcess?: (id: string) => void }) => (
    <>
      <span data-testid="recs-button" />
      {onOpenProcess && (
        <button data-testid="alert-proc" onClick={() => onOpenProcess("proc-7")}>алерт-процесс</button>
      )}
    </>
  ),
}));
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
    element: null,
    element_effective: "container",
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
  onAllProjects: vi.fn(),
  onNavigateNode: vi.fn(),
};

describe("MapEditorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role.current = "owner";
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

  // Аудит R-9/R-10: ошибка загрузки уровня раньше глоталась — пустой холст без причины.
  it("отказ первичной загрузки — экран с причиной и «Повторить», повтор открывает холст", async () => {
    vi.mocked(nodesApi.getGraph).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<MapEditorPage {...props} nodeId={null} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось загрузить уровень схемы");
    expect(alert).toHaveTextContent("Нет связи с сервером");
    expect(screen.queryByTestId("level-graph")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByTestId("level-graph")).toBeInTheDocument();
    expect(nodesApi.getGraph).toHaveBeenCalledTimes(2);
  });

  it("ответ фонового чтения, пришедший после перехода, не подменяет уровень", async () => {
    const { useRemoteSync } = await import("../useRemoteSync");
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");

    // Фоновый тик поллинга читает корень — медленно.
    let finishRoot: (g: unknown) => void = () => {};
    vi.mocked(nodesApi.getGraph).mockImplementationOnce(
      () => new Promise((resolve) => { finishRoot = resolve; }) as never,
    );
    const sync = vi.mocked(useRemoteSync).mock.calls.at(-1)?.[0] as { onRemoteChange: () => void };
    act(() => { sync.onRemoteChange(); });

    // Тем временем человек входит в контейнер — этот ответ приходит первым.
    vi.mocked(nodesApi.getGraph).mockResolvedValueOnce(graph({ nodes: [node("inner", { parent_id: "box" })] }) as never);
    const drill = levelGraphProps.current?.drill as { onDrillDown: (n: Node) => void };
    act(() => { drill.onDrillDown(node("box")); });
    await waitFor(() => expect((levelGraphProps.current?.nodes as Node[]).map((n) => n.id)).toEqual(["inner"]));

    // Опоздавший ответ корня отброшен: под крошками контейнера — его дети.
    await act(async () => { finishRoot(graph({ nodes: [node("root-a")] })); });
    expect((levelGraphProps.current?.nodes as Node[]).map((n) => n.id)).toEqual(["inner"]);
  });

  // Кнопки жили только в шапке ОБОЛОЧКИ, а редактор — отдельный роут мимо неё:
  // в пивоте они тут просто исчезли (находка ручной проверки 2026-08-08).
  it("в шапке есть меню действий: экспорт, синк и архив проекта", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");

    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    expect(screen.getByRole("menuitem", { name: "Экспорт схемы" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Импорт схемы" })).toBeInTheDocument();
    // Архив проекта доступен и из редактора (корень = скоуп «вся схема»)
    expect(screen.getByRole("menuitem", { name: "Экспорт проекта (zip)" })).toBeInTheDocument();
    // Догрузка архива к живому проекту (Ф4 «единого импорта») — пункт активен
    expect(screen.getByRole("menuitem", { name: "Импорт проекта (zip)" })).toBeEnabled();
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

  // Процессные классы алертов (AL26/AL27) на холсте чинить нечем: у повисшего
  // сообщения связь удалена, у непривязанного участника узла нет. До 2026-08-11
  // строка тут вовсе не была кликабельной — замечание видно, а починить нельзя.
  it("строка процессного алерта закрывает редактор и передаёт процесс оболочке", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");

    await act(async () => { screen.getByTestId("alert-proc").click(); });

    expect(sessionStorage.getItem("archmap.pendingProcess")).toBe("proc-7");
    expect(props.onDone).toHaveBeenCalledOnce();
  });

  // Рекомендации — только тем, кто правит проект (AL10): у читателя кнопки на холсте нет.
  it("кнопка «Рекомендации» на холсте есть у владельца и нет у читателя проекта", async () => {
    const { unmount } = render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    expect(screen.getByTestId("recs-button")).toBeInTheDocument();
    unmount();

    // Роль возвращаем в finally: у соседних describe свои beforeEach без сброса роли.
    role.current = "reader";
    try {
      render(<MapEditorPage {...props} nodeId={null} />);
      await screen.findByTestId("level-graph");
      expect(screen.queryByTestId("recs-button")).not.toBeInTheDocument();
    } finally {
      role.current = "owner";
    }
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

// ── Создание объекта (Р38 раздела 13 docs/plan-c4-elements.md) ──────────────────
// «+» дерева и бросок шаблона открывают окно «Новый объект» сразу: родителя окно
// загружает само и, если он лист, задаёт его тем же запросом. Редактор ничего не
// спрашивает и не пишет — окна первого вложенного объекта на этих путях нет.
describe("MapEditorPage: создание объекта", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
  });

  it("«+» у листа в дереве — окно с этим родителем, без запросов и окна первого вложенного", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const onCreateChild = treeProps.current.onCreateChild as (parentId: string) => void;
    act(() => { onCreateChild("leaf1"); });
    expect(screen.getByTestId("node-modal")).toHaveAttribute("data-parent", "leaf1");
    expect(nodesApi.get).not.toHaveBeenCalled();
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("бросок шаблона на уровень — окно с родителем уровня и шаблоном как типом", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const drop = levelGraphProps.current!.drop as { onDropNode: (s: string, p: { x: number; y: number }, d: string | null) => void };
    act(() => { drop.onDropNode("database", { x: 10, y: 20 }, null); });
    const modal = screen.getByTestId("node-modal");
    expect(modal).toHaveAttribute("data-parent", "");
    expect(modal).toHaveAttribute("data-type", "database");
    expect(nodesApi.get).not.toHaveBeenCalled();
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("бросок в раскрытую рамку — родитель рамки, тип плитки уходит в окно", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const drop = levelGraphProps.current!.drop as { onDropNode: (s: string, p: { x: number; y: number }, d: string | null) => void };
    act(() => { drop.onDropNode("component", { x: 10, y: 20 }, "box"); });
    const modal = screen.getByTestId("node-modal");
    expect(modal).toHaveAttribute("data-parent", "box");
    expect(modal).toHaveAttribute("data-type", "component");
  });

  it("драг плитки палитры — тип уходит холсту для превью", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const onTemplateDrag = treeProps.current.onTemplateDrag as (type: string | null) => void;
    act(() => { onTemplateDrag("system"); });
    expect((levelGraphProps.current!.drop as { dragType: string | null }).dragType).toBe("system");
    act(() => { onTemplateDrag(null); });
    expect((levelGraphProps.current!.drop as { dragType: string | null }).dragType).toBeNull();
  });
});

// ── Палитра и бросок по месту назначения (приёмка Ф12 2026-10-31) ─────────────
// Цель броска проверяет тип: родителя уровня страница грузит сама (один GET на уровень и
// мутацию), раскрытые рамки сообщает холст. Бросок туда, где тип невозможен, — тост с
// причиной, окна нет; в принимающую рамку — окно с этим типом.
describe("MapEditorPage: палитра и бросок по месту назначения", () => {
  const sys = node("s1", { has_children: true, child_count: 1, element: null, element_effective: "system" });
  const ordersFrame = {
    id: "orders", name: "orders",
    subject: { name: "orders", shape: "service", element: "container", element_effective: "container", has_children: true, container_name: null },
  };
  type Tile = { type: string; enabled: boolean; reason?: string };
  const tileOf = (type: string) => (treeProps.current.paletteTiles as Tile[] | null)?.find((t) => t.type === type);
  type Drop = {
    onDropNode: (t: string, p: { x: number; y: number }, d: string | null) => void;
    onDropFrames: (frames: unknown[]) => void;
    onDropRefused: (t: string, d: string | null) => void;
    dropEligible: { levelOk: boolean; frameIds: ReadonlySet<string> } | null;
  };
  const drop = () => levelGraphProps.current!.drop as Drop;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([sys]);
    vi.mocked(nodesApi.get).mockResolvedValue(sys as never);
  });

  async function openSystemLevel() {
    render(<MapEditorPage {...props} nodeId="s1" />);
    await screen.findByTestId("level-graph");
    await waitFor(() => expect(tileOf("component")?.enabled).toBe(false));
  }

  it("уровень системы: родитель — одним запросом, «Компонент» серый с причиной", async () => {
    await openSystemLevel();
    expect(nodesApi.get).toHaveBeenCalledTimes(1);
    expect(nodesApi.get).toHaveBeenCalledWith("s1");
    expect(tileOf("component")?.reason).toBe(
      "Компонентом объект бывает только внутри контейнера. Чтобы вложить компонент, сделайте «S1» контейнером в его свойствах.",
    );
    expect(tileOf("container")).toEqual({ type: "container", enabled: true });
  });

  it("раскрытая рамка контейнера делает «Компонент» активным; бросок мимо рамок — тост, окна нет", async () => {
    await openSystemLevel();
    act(() => { drop().onDropFrames([ordersFrame]); });
    expect(tileOf("component")).toEqual({
      type: "component", enabled: true, reason: "Положите «Компонент» в раскрытую рамку: «orders»",
    });
    const onTemplateDrag = treeProps.current.onTemplateDrag as (type: string | null) => void;
    act(() => { onTemplateDrag("component"); });
    expect(drop().dropEligible?.levelOk).toBe(false);
    expect([...drop().dropEligible!.frameIds]).toEqual(["orders"]);

    act(() => { drop().onDropRefused("component", null); });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Компонентом объект бывает только внутри контейнера. Чтобы вложить компонент, сделайте «S1» контейнером "
      + "в его свойствах. Положите «Компонент» в раскрытую рамку: «orders».",
    );
    expect(screen.queryByTestId("node-modal")).toBeNull();
  });

  it("бросок «Компонента» в рамку контейнера — окно «Новый объект» с «Компонентом»", async () => {
    await openSystemLevel();
    act(() => { drop().onDropFrames([ordersFrame]); });
    act(() => { drop().onDropNode("component", { x: 10, y: 20 }, "orders"); });
    const modal = screen.getByTestId("node-modal");
    expect(modal).toHaveAttribute("data-parent", "orders");
    expect(modal).toHaveAttribute("data-type", "component");
  });

  it("«База данных» в рамку контейнера — причина этой рамки", async () => {
    await openSystemLevel();
    act(() => { drop().onDropFrames([ordersFrame]); });
    act(() => { drop().onDropRefused("database", "orders"); });
    expect(screen.getByRole("alert")).toHaveTextContent("База данных не входит в состав контейнера, создайте её рядом с «orders».");
  });

  it("смена типа в свойствах перечитывает дерево и родителя уровня", async () => {
    await openSystemLevel();
    const reloadBefore = treeProps.current.reloadToken;
    const onNodeSaved = inspectorProps.current.onNodeSaved as (saved: Node, isCreate: boolean, before?: Node) => void;
    act(() => { onNodeSaved(node("a", { element: "system" }), false, node("a", { element: null })); });
    expect(treeProps.current.reloadToken).not.toBe(reloadBefore);
    await waitFor(() => expect(nodesApi.get).toHaveBeenCalledTimes(2));
  });

  it("родитель уровня не загрузился — тост с причиной, палитра ничего не гасит", async () => {
    vi.mocked(nodesApi.get).mockRejectedValue(new TypeError("Failed to fetch"));
    render(<MapEditorPage {...props} nodeId="s1" />);
    await screen.findByTestId("level-graph");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось проверить, какие объекты можно добавить в «S1»: Нет связи с сервером",
    );
    expect(treeProps.current.paletteTiles).toBeNull();
    expect(drop().dropEligible ?? null).toBeNull();
  });
});

// ── Перенос объекта на другой уровень (Ф4) ───────────────────────────────────
// Сам жест живёт в дереве (его тесты — NodeTreePanel.test.tsx); здесь оркестрация:
// снимок раскладки берётся ДО правки, иначе Undo вернул бы родителя без геометрии.
describe("MapEditorPage: перенос объекта", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
    // Цель переноса — узел с детьми: окна первого вложенного объекта нет.
    vi.mocked(nodesApi.get).mockResolvedValue(
      node("new", { has_children: true, child_count: 1, element_effective: "system" }) as never,
    );
    // Последствий для площадок нет — окна последствий тоже (Р18).
    vi.mocked(nodesApi.movePreview).mockResolvedValue(
      { kind: "none", before: [], after: [], docs_names: [], container_name: null } as never,
    );
  });

  const снимок = { nodes: [], edges: [], layout_items: [{ view_id: null, item_id: "kid", payload: { x: 1, y: 2 } }] };

  async function перенести() {
    vi.mocked(nodesApi.moveSnapshot).mockResolvedValue(снимок as never);
    vi.mocked(nodesApi.update).mockResolvedValue(node("kid") as never);
    vi.mocked(nodesApi.restore).mockResolvedValue(undefined as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const onReparent = treeProps.current.onReparent as (n: Node, p: string | null) => void;
    await act(async () => { onReparent(node("kid", { parent_id: "old" }), "new"); });
  }

  it("снимок берётся до правки, родитель меняется, шаг ложится в историю", async () => {
    await перенести();
    expect(nodesApi.moveSnapshot).toHaveBeenCalledWith("kid");
    expect(nodesApi.update).toHaveBeenCalledWith("kid", { parent_id: "new" });
    expect(vi.mocked(nodesApi.moveSnapshot).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(nodesApi.update).mock.invocationCallOrder[0]);
    expect(historyMock.push).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Перенос объекта", level: null }),
    );
  });

  // Аудит R-14: отказ уходил необработанным отклонением — человек не узнавал причину.
  it("отказ переноса: причина тостом, в историю ничего, дерево перечитывается", async () => {
    vi.mocked(nodesApi.moveSnapshot).mockResolvedValue(снимок as never);
    vi.mocked(nodesApi.update).mockRejectedValue(new TypeError("Failed to fetch"));
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const reloadBefore = treeProps.current.reloadToken;
    const onReparent = treeProps.current.onReparent as (n: Node, p: string | null) => void;
    await act(async () => { onReparent(node("kid", { parent_id: "old" }), "new"); });

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось перенести объект: Нет связи с сервером");
    expect(historyMock.push).not.toHaveBeenCalled();
    expect(treeProps.current.reloadToken).not.toBe(reloadBefore);
  });

  // Р38 раздела 13 плана: цель — лист-сервис без элемента, переносимый — сервис без
  // элемента. Сначала окно со стороны переносимого; «Отмена» — объект остаётся на месте,
  // ни снимка, ни правки.
  it("перенос в лист: сначала окно «что такое переносимый», «Отмена» ничего не делает", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue(node("new", { element: null, element_effective: "container", sites: [] }) as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const onReparent = treeProps.current.onReparent as (n: Node, p: string | null) => void;
    await act(async () => { onReparent(node("kid", { parent_id: "old" }), "new"); });
    expect(await screen.findByText("Что такое «KID» внутри «NEW»?")).toBeInTheDocument();
    await act(async () => { screen.getByText("Отмена").click(); });
    expect(nodesApi.moveSnapshot).not.toHaveBeenCalled();
    expect(nodesApi.update).not.toHaveBeenCalled();
    expect(historyMock.push).not.toHaveBeenCalled();
  });

  // Р18: перенос в контейнер переносит площадки — сначала окно последствий; такой перенос
  // в историю не ложится (обратное действие — тот же перенос назад).
  it("перенос с последствиями: окно, правка после подтверждения и без истории", async () => {
    vi.mocked(nodesApi.movePreview).mockResolvedValue({
      kind: "join_container",
      before: [{ node_id: "new", name: "NEW", sites: ["prod-eu"] }, { node_id: "kid", name: "KID", sites: ["prod-ru"] }],
      after: [{ node_id: "new", name: "NEW", sites: ["prod-eu", "prod-ru"] }],
      docs_names: [], container_name: "NEW",
    } as never);
    vi.mocked(nodesApi.moveSnapshot).mockResolvedValue(снимок as never);
    vi.mocked(nodesApi.update).mockResolvedValue(node("kid") as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const onReparent = treeProps.current.onReparent as (n: Node, p: string | null) => void;
    await act(async () => { onReparent(node("kid", { parent_id: "old" }), "new"); });
    expect(await screen.findByText("Сделать «KID» частью «NEW»?")).toBeInTheDocument();
    expect(nodesApi.movePreview).toHaveBeenCalledWith("kid", "new");
    expect(nodesApi.update).not.toHaveBeenCalled();
    await act(async () => { screen.getByText("Перенести").click(); });
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledWith("kid", { parent_id: "new" }));
    expect(historyMock.push).not.toHaveBeenCalled();
  });

  it("«Отмена» в окне последствий — объект остаётся на месте", async () => {
    vi.mocked(nodesApi.movePreview).mockResolvedValue({
      kind: "leave_container", before: [{ node_id: "old", name: "OLD", sites: ["prod-eu"] }],
      after: [{ node_id: "old", name: "OLD", sites: ["prod-eu"] }, { node_id: "kid", name: "KID", sites: ["prod-eu"] }],
      docs_names: [], container_name: "OLD",
    } as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const onReparent = treeProps.current.onReparent as (n: Node, p: string | null) => void;
    await act(async () => { onReparent(node("kid", { parent_id: "old" }), "new"); });
    await act(async () => { (await screen.findByText("Отмена")).click(); });
    expect(nodesApi.moveSnapshot).not.toHaveBeenCalled();
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("Undo возвращает и родителя, и снятую раскладку — именно в этом порядке", async () => {
    await перенести();
    const cmd = historyMock.push.mock.calls[0][0] as { undo: () => void };
    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.undo(); });
    await waitFor(() => expect(nodesApi.restore).toHaveBeenCalledWith(снимок));
    expect(nodesApi.update).toHaveBeenCalledWith("kid", { parent_id: "old" });
    expect(vi.mocked(nodesApi.update).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(nodesApi.restore).mock.invocationCallOrder[0]);
  });
});

// ── Правка меты объекта в истории (H2) ───────────────────────────────────────
// Компенсация Undo/Redo — PATCH со снимком полей узла. PATCH на бэке разбирает
// payload с exclude_unset, поэтому поле, не попавшее в снимок, откатывается
// молча-никак: так статус не возвращался по Ctrl+Z, хотя форма возвращалась.
describe("MapEditorPage: правка объекта в истории", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectorProps.current = {};
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
    vi.mocked(nodesApi.update).mockResolvedValue(node("n1") as never);
  });

  // Правка через панель: NodeInspector зовёт onNodeSaved(saved, false, before).
  async function поправить(before: Node, saved: Node) {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("object-inspector");
    const onNodeSaved = inspectorProps.current.onNodeSaved as (s: Node, c: boolean, b?: Node) => void;
    await act(async () => { onNodeSaved(saved, false, before); });
    return historyMock.push.mock.calls[0][0] as { label: string; undo: () => void; redo: () => void };
  }

  it("Undo правки статуса возвращает статус, Redo — применяет заново", async () => {
    const before = node("n1", { status: "existing", version: 1 });
    const saved = node("n1", { status: "planned", version: 2 });
    const cmd = await поправить(before, saved);
    expect(cmd.label).toBe("Правка объекта");

    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.undo(); });
    expect(nodesApi.update).toHaveBeenCalledWith("n1", expect.objectContaining({ status: "existing" }));

    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.redo(); });
    expect(nodesApi.update).toHaveBeenCalledWith("n1", expect.objectContaining({ status: "planned" }));
  });

  // Страховка от повторения бага в других полях: снимок несёт ВСЮ мету, правимую
  // панелью, — а не только те поля, о которых вспомнили.
  it("снимок компенсации несёт всю мету панели (форма, статус, внешность, тексты)", async () => {
    const before = node("n1", {
      name: "Было", description: "опис", role: "ядро", technology: "Python",
      shape: "service", status: "existing", is_external: false, openapi_spec: "openapi: 3.0.0",
    });
    const saved = node("n1", { name: "Стало", shape: "database", status: "deprecated", is_external: true, version: 2 });
    const cmd = await поправить(before, saved);

    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.undo(); });
    expect(nodesApi.update).toHaveBeenCalledWith("n1", {
      name: "Было", description: "опис", role: "ядро", technology: "Python",
      openapi_spec: "openapi: 3.0.0", is_external: false, shape: "service", status: "existing",
      // Якорь у узла без якоря — явный null: не прислать поле значит «не трогать»,
      // и откат правки якоря не вернул бы прежний.
      source: null,
      // Элемент архитектуры — тем же правилом (камень 16 эпика «Элемент архитектуры»).
      element: null,
    });
  });

  it("Undo смены элемента архитектуры возвращает прежний, Redo — новый", async () => {
    // Не присланный элемент сервер не трогает: без него в снимке компенсации Undo
    // смены «не задан → контейнер» тихо оставил бы контейнер.
    const before = node("n1", { element: null, version: 1 });
    const saved = node("n1", { element: "container", has_children: true, version: 2 });
    const cmd = await поправить(before, saved);

    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.undo(); });
    expect(nodesApi.update).toHaveBeenCalledWith("n1", expect.objectContaining({ element: null }));

    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.redo(); });
    expect(nodesApi.update).toHaveBeenCalledWith("n1", expect.objectContaining({ element: "container" }));
  });

  it("Undo правки якоря возвращает прежний якорь, Redo — новый", async () => {
    // Якорь — то, чем объект опознают при обновлениях из кода: если он не попал
    // в снимок компенсации, Undo молча оставил бы объект с чужим отпечатком.
    const before = node("n1", { source: { repo: "github.com/org/repo", path: null, host: null }, version: 1 });
    const saved = node("n1", { source: { repo: null, path: null, host: "kafka" }, version: 2 });
    const cmd = await поправить(before, saved);

    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.undo(); });
    expect(nodesApi.update).toHaveBeenCalledWith("n1", expect.objectContaining({
      source: { repo: "github.com/org/repo", path: null, host: null },
    }));

    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.redo(); });
    expect(nodesApi.update).toHaveBeenCalledWith("n1", expect.objectContaining({
      source: { repo: null, path: null, host: "kafka" },
    }));
  });

  // Двойной клик по ЛЮБОМУ узлу — сплошной фигуре — его панель свойств (решение
  // пользователя 2026-10-05): гость — проекция только для просмотра, свёрнутый контейнер
  // гостя — по id. На страницу узла ведёт лишь «Документация → Открыть» в самой панели.
  describe("двойной клик по узлу — панель свойств", () => {
    type Drill = {
      onInspectGhost: (g: unknown) => void;
      onInspectNodeId: (id: string) => void;
    };
    type Sel = { kind: string; node?: { name: string }; ghost?: { name: string; ancestors: { name: string }[] } } | null;
    const drill = () => levelGraphProps.current?.drill as unknown as Drill;
    const selected = () => inspectorProps.current.selected as Sel;

    it("гость — панель проекции, на страницу не уводит", async () => {
      render(<MapEditorPage {...props} nodeId={null} />);
      await screen.findByTestId("level-graph");
      act(() => drill().onInspectGhost({ id: "g1", name: "Банк", ancestors: [] }));
      expect(selected()).toMatchObject({ kind: "ghost", ghost: { name: "Банк" } });
      expect(props.onNavigateNode).not.toHaveBeenCalled();
    });

    it("узел текущего слоя по id — его панель свойств, без догрузки", async () => {
      vi.mocked(nodesApi.getGraph).mockResolvedValue(graph({ nodes: [node("s1", { name: "Касса" })] }) as never);
      render(<MapEditorPage {...props} nodeId={null} />);
      await screen.findByTestId("level-graph");
      await act(async () => { drill().onInspectNodeId("s1"); });
      expect(selected()).toMatchObject({ kind: "node", node: { name: "Касса" } });
    });

    it("свёрнутый контейнер гостя (вне слоя) — проекция с путём предков, из поддерева слоя — своя панель", async () => {
      vi.mocked(nodesApi.getAll).mockResolvedValue([
        node("sys", { name: "Система" }),
        node("svc", { name: "Сервис", parent_id: "sys" }),
        node("deep", { name: "Модуль", parent_id: "svc" }),
        node("ext", { name: "Партнёр", is_external: true }),
        node("ext-api", { name: "API партнёра", parent_id: "ext", is_external: true }),
      ]);
      render(<MapEditorPage {...props} nodeId="sys" />);
      await screen.findByTestId("level-graph");
      act(() => drill().onInspectNodeId("ext-api"));
      await waitFor(() => expect(selected()?.kind).toBe("ghost"));
      expect(selected()?.ghost).toMatchObject({ name: "API партнёра", ancestors: [{ name: "Партнёр" }] });
      act(() => drill().onInspectNodeId("deep"));
      await waitFor(() => expect(selected()).toMatchObject({ kind: "node", node: { name: "Модуль" } }));
    });
  });
});

// ── Крошки после правки без навигации (Ф13а) ─────────────────────────────────
// Элемент и внешность звеньев меняются и без перехода: первый вложенный объект задаёт
// элемент родителю уровня (Р38), предку меняют тип или внешность. Холст (рамки) и крошки
// получают свежие звенья тем же сигналом, что дерево.
describe("MapEditorPage: крошки перечитываются после правки", () => {
  const a = node("a", { name: "Торговля", has_children: true, child_count: 1, element_effective: "system" });
  const b = node("b", { name: "orders", parent_id: "a", element: null, element_effective: "container" });
  const getBy = (map: Record<string, Node>) => async (id: string) => map[id] as never;
  const onNodeSaved = () => inspectorProps.current.onNodeSaved as (saved: Node, isCreate: boolean, before?: Node) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    role.current = "owner";
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([a, b]);
    vi.mocked(nodesApi.get).mockImplementation(getBy({ a, b }));
  });

  it("первый вложенный объект задал элемент родителю уровня — холст получает его без навигации", async () => {
    render(<MapEditorPage {...props} nodeId="b" />);
    await screen.findByTestId("level-graph");
    await waitFor(() => expect(levelGraphProps.current?.ancestorElements).toEqual(["system", "container"]));
    const callsBefore = vi.mocked(nodesApi.get).mock.calls.length;

    // Сервер записал родителю элемент вместе с созданием: «orders» теперь система.
    const bSystem = node("b", { name: "orders", parent_id: "a", element: "system", element_effective: "system", has_children: true });
    vi.mocked(nodesApi.get).mockImplementation(getBy({ a, b: bSystem }));
    act(() => { onNodeSaved()(node("c", { parent_id: "b" }), true); });

    await waitFor(() => expect(levelGraphProps.current?.ancestorElements).toEqual(["system", "system"]));
    // Тот же сигнал перечитал и звено выше уровня — по запросу на звено.
    const reread = vi.mocked(nodesApi.get).mock.calls.slice(callsBefore).map((c) => c[0]);
    expect([...new Set(reread)].sort()).toEqual(["a", "b"]);
  });

  it("предку выше уровня сменили внешность — рамка и крошки по свежим звеньям", async () => {
    render(<MapEditorPage {...props} nodeId="b" />);
    await screen.findByTestId("level-graph");
    await waitFor(() => expect(levelGraphProps.current?.ancestorExternals).toEqual([false, false]));

    const aExternal = node("a", { name: "Торговля", is_external: true, has_children: true, element_effective: "system" });
    vi.mocked(nodesApi.get).mockImplementation(getBy({ a: aExternal, b }));
    act(() => { onNodeSaved()(node("x", { shape: "database" }), false, node("x")); });

    await waitFor(() => expect(levelGraphProps.current?.ancestorExternals).toEqual([true, false]));
    expect(screen.getByRole("button", { name: "Торговля" })).toBeInTheDocument();
  });

  it("до первой правки звенья выше уровня не запрашиваются", async () => {
    render(<MapEditorPage {...props} nodeId="b" />);
    await screen.findByTestId("level-graph");
    await waitFor(() => expect(nodesApi.get).toHaveBeenCalledWith("b"));
    expect(nodesApi.get).not.toHaveBeenCalledWith("a");
  });
});
