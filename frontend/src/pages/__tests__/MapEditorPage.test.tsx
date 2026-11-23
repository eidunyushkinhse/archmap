// Рендер/поведенческие тесты MapEditorPage: breadcrumb (корень «Контекст» и путь
// по узлу), диспетчеры undo/redo (включая навигацию на уровень команды), кнопки
// «Готово» и Esc. Тяжёлый холст LevelGraph (@xyflow/react), инспектор, дерево,
// модалки и поллинг замоканы — тестируем оболочку редактора и её диспетчеры.
import { render as rtlRender, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { flushSync } from "react-dom";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import MapEditorPage from "../MapEditorPage";
import { nodesApi } from "../../api/nodes";
import { ProjectRoleContext } from "../projectRole";
import type { LevelEdge, Node, ProjectRole } from "../../types";
import type { EdgeChoiceEnds, ViewMetaRef } from "../../components/graph/types";

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
    // Полный пустой набор: настоящая панель «Рекомендации» (тест Escape) читает все разделы.
    alerts: {
      disconnected_nodes: [], intermediate_edges: [], isolated_groups: [], container_own_docs: [],
      persons_inside: [], dangling_messages: [], unbound_participants: [], orphan_legs: [],
      unresolved_data_refs: [], unresolved_channel_refs: [], unresolved_config_refs: [],
      broker_edge_channels: [], descendant_edges: [], unlinked_messages: [], undescribed_docs: [],
      component_facts: [], code_changes: [],
    },
    loaded: true,
    reload: vi.fn(),
  }),
  resolveAlertLocate: vi.fn(() => ({ level: null, request: { kind: "node", ids: [], token: 1 } })),
  PENDING_ALERT_LOCATE_KEY: "archmap.pendingAlertLocate",
  PENDING_PROCESS_KEY: "archmap.pendingProcess",
}));
// Выбор связи: модалка не нужна. Аргументы хука ловим — тесты «+ Добавить связь» зовут
// onAddFromChoice так, как его позовёт кнопка окна (сама кнопка — useEdgeChoice.test).
const edgeChoiceArgs = vi.hoisted(() => ({
  current: null as { onAddFromChoice?: (rep: LevelEdge, ends?: EdgeChoiceEnds) => void } | null,
}));
vi.mock("../../components/graph/interaction/useEdgeChoice", () => ({
  useEdgeChoice: (args: { onAddFromChoice?: (rep: LevelEdge, ends?: EdgeChoiceEnds) => void }) => {
    edgeChoiceArgs.current = args;
    return { onEdgesChoice: vi.fn(), choiceModal: null };
  },
}));

// Тяжёлые/условные потомки — заглушки. Холст ловит пропсы: undo/redo-диспетчеры
// редактора передаются в LevelGraph (бандл undo), а не рисуются в топбаре — тесты
// вызывают их отсюда.
const levelGraphProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
// Журнал рендеров холста: какие объекты он получил и какую версию вида в этот момент
// видит очередь записей раскладки (V47б: новые данные не приходят раньше свежей версии).
const canvasLog = vi.hoisted(() => ({ renders: [] as { ids: string[]; version: number }[] }));
vi.mock("../../components/LevelGraph", () => ({
  default: (props: Record<string, unknown>) => {
    levelGraphProps.current = props;
    const p = props as { nodes: { id: string }[]; persistence: { viewMeta: { current: { version: number } } } };
    canvasLog.renders.push({ ids: p.nodes.map((n) => n.id), version: p.persistence.viewMeta.current.version });
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
// Панель есть, только пока что-то выбрано (редизайн, фаза 4а): её открывает двойной клик
// по объекту на холсте (onEditNode). Без выбора заглушки панели нет, а с ней и колбэков.
async function выбрать(n: Node) {
  const drill = levelGraphProps.current?.drill as { onEditNode: (n: Node) => void };
  act(() => { drill.onEditNode(n); });
  await screen.findByTestId("object-inspector");
}
// Окна создания связи: заглушки показывают, с какими концами их открыли.
vi.mock("../../components/CrossLevelEdgePicker", () => ({
  default: (p: { title: string; sourceId: string; sourceLabel: string; rootParentId: string | null }) => (
    <div data-testid="cross-level-picker" data-title={p.title} data-source={p.sourceId}
      data-source-label={p.sourceLabel} data-root={p.rootParentId ?? ""} />
  ),
}));
vi.mock("../../components/EdgeQuickCreate", () => ({
  default: (p: { sourceId: string; targetId: string; sourceLabel: string; targetLabel: string }) => (
    <div data-testid="edge-quick-create" data-source={p.sourceId} data-target={p.targetId}
      data-source-label={p.sourceLabel} data-target-label={p.targetLabel} />
  ),
}));
// Окно «Новый объект»: заглушка показывает, с каким родителем и шаблоном его открыли, и
// отдаёт наружу onSaved (создание без настоящей формы).
const nodeModalProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../../components/NodeModal", () => ({
  default: (p: { parentId: string | null; type?: string }) => {
    nodeModalProps.current = p;
    return <div data-testid="node-modal" data-parent={p.parentId ?? ""} data-type={p.type ?? ""} />;
  },
}));
vi.mock("../../components/NodeDeleteConfirm", () => ({ default: () => null }));
// Подтверждение удаления нескольких: заглушка отдаёт наружу onDeleted (удаление без окна).
const multiDeleteProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../components/NodesDeleteConfirm", () => ({
  default: (p: Record<string, unknown>) => { multiDeleteProps.current = p; return null; },
}));
// Окно «Принять переход»: заглушка отдаёт наружу onApplied (переход без настоящего окна).
const transitionProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../../components/TransitionConfirm", () => ({
  default: (p: Record<string, unknown>) => { transitionProps.current = p; return null; },
}));
vi.mock("../../components/RelayoutConfirm", () => ({ default: () => <div data-testid="relayout-confirm" /> }));
// Кнопка «Рекомендации» (алерты): метка присутствия + кнопка, дёргающая
// onOpenProcess — как строка процессного класса (AL26/AL27) в настоящей панели.
// realAlerts.current — настоящая кнопка с панелью (тест Escape при открытой панели).
const realAlerts = vi.hoisted(() => ({ current: false }));
vi.mock("../../components/SchemaAlerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/SchemaAlerts")>();
  const Real = actual.default;
  return {
    ...actual,
    default: (p: Parameters<typeof Real>[0]) => realAlerts.current ? <Real {...p} /> : (
      <>
        <span data-testid="recs-button" />
        {p.onOpenProcess && (
          <button data-testid="alert-proc" onClick={() => p.onOpenProcess?.("proc-7")}>алерт-процесс</button>
        )}
      </>
    ),
  };
});
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
    realAlerts.current = false;
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
    expect(screen.getByRole("menuitem", { name: "Обновить из кода" })).toBeInTheDocument();
    // Архив проекта доступен и из редактора (корень = скоуп «вся схема»)
    expect(screen.getByRole("menuitem", { name: "Экспорт проекта (zip)" })).toBeInTheDocument();
    // Догрузка архива к живому проекту (Ф4 «единого импорта») — пункт активен
    expect(screen.getByRole("menuitem", { name: "Догрузить архив" })).toBeEnabled();
  });

  // Редизайн, фаза 4б: «Скрыть подписи связей» и «Переразложить уровень» — пункты меню
  // «Действия со схемой», отдельных кнопок в шапке нет.
  it("подписи связей — пунктом меню: текст по состоянию, режим уходит холсту", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    expect(screen.queryByTitle("Скрыть подписи связей")).toBeNull();
    const mode = () => levelGraphProps.current!.mode as { edgeLabelsHidden: boolean };
    const before = mode().edgeLabelsHidden;
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    await userEvent.click(screen.getByRole("menuitem", { name: before ? "Показать подписи связей" : "Скрыть подписи связей" }));
    expect(mode().edgeLabelsHidden).toBe(!before);
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    await userEvent.click(screen.getByRole("menuitem", { name: before ? "Скрыть подписи связей" : "Показать подписи связей" }));
    expect(mode().edgeLabelsHidden).toBe(before);
  });

  it("«Переразложить уровень» — пункт меню редактора проекта: подтверждение, на пустом уровне выключен", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    expect(screen.queryByTitle("Переразложить уровень")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    expect(screen.getByRole("menuitem", { name: "Переразложить уровень" })).toBeDisabled();
  });

  it("«Переразложить уровень» открывает подтверждение", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph({ nodes: [node("a")] }) as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Переразложить уровень" }));
    expect(screen.getByTestId("relayout-confirm")).toBeInTheDocument();
  });

  it("читателю: подписи связей в меню есть, «Переразложить уровень» и «Принять переход» нет", async () => {
    role.current = "reader";
    try {
      vi.mocked(nodesApi.getGraph).mockResolvedValue(graph({ nodes: [node("a")], has_status_info: true }) as never);
      render(<MapEditorPage {...props} nodeId={null} />);
      await screen.findByTestId("level-graph");
      await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
      expect(screen.getByRole("menuitem", { name: /подписи связей/ })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Переразложить уровень" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Принять переход" })).toBeNull();
      expect(screen.getByRole("button", { name: "Готово" })).toBeInTheDocument();
    } finally {
      role.current = "owner";
    }
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
    // Шапка в одну строку: имена звеньев могут обрезаться многоточием, полное — в
    // подсказке. Корневая крошка не обрезается, подсказка ей не нужна.
    expect(current).toHaveAttribute("title", "Уровень B");
    expect(screen.getByRole("button", { name: "Корень" })).toHaveAttribute("title", "Корень");
    expect(screen.getByRole("button", { name: "Проект" })).not.toHaveAttribute("title");
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

  // Escape в два шага (редизайн, фаза 4а): первый закрывает панель объекта, следующий —
  // выход из редактора. Чужой Escape (окно, всплывающее, погашенный ближе к месту) не в счёт.
  it("Esc при открытой панели закрывает панель, следующий — выходит из редактора", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    await выбрать(node("n1"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("object-inspector")).toBeNull();
    expect(props.onDone).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onDone).toHaveBeenCalledOnce();
  });

  it("Esc при открытом окне не закрывает ни панель, ни редактор: окно закрывается само", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    await выбрать(node("n1"));
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    dialog.dispatchEvent(e);
    dialog.remove();
    // Клавишу не гасим: её cancel нужен самому окну.
    expect(e.defaultPrevented).toBe(false);
    expect(screen.getByTestId("object-inspector")).toBeInTheDocument();
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it("Esc не наш, если его погасили ближе к месту нажатия или открыто всплывающее", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    await выбрать(node("n1"));
    const prevented = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(screen.getByTestId("object-inspector")).toBeInTheDocument();
    // Меню «⋮» шапки закрывается своим обработчиком на документе: его кнопка помечена
    // aria-expanded — Escape достаётся меню, а не панели.
    const menuBtn = document.createElement("button");
    menuBtn.setAttribute("aria-expanded", "true");
    screen.getByTestId("level-graph").append(menuBtn);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("object-inspector")).toBeInTheDocument();
    // Раскрытая ветка дерева — не всплывающее.
    menuBtn.className = "nt-chevzone";
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("object-inspector")).toBeNull();
    expect(props.onDone).not.toHaveBeenCalled();
  });

  // Escape при открытом всплывающем шапки (меню «Действия со схемой», панель
  // «Рекомендации»): настоящие компоненты и настоящий ui/useDismiss. В браузере между
  // слушателями одного события проходит контрольная точка микрозадач, и React успевает
  // перерисовать меню, закрытое слушателем на document, ещё до слушателя редактора на
  // window. Когда событие шлёт сам тест, jsdom такой точки не делает. Эмулируем её:
  // слушатель, добавленный после открытия всплывающего (то есть после его собственного),
  // досрочно выполняет отложенную работу React.
  function escapeLikeBrowser(target: Element) {
    const flush = () => { flushSync(() => {}); };
    document.addEventListener("keydown", flush);
    try {
      act(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
    } finally {
      document.removeEventListener("keydown", flush);
    }
  }

  it("Esc при открытом меню «Действия со схемой» закрывает только меню, следующий выходит", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const btn = screen.getByRole("button", { name: "Действия со схемой" });
    await userEvent.click(btn);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    escapeLikeBrowser(btn);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(props.onDone).not.toHaveBeenCalled();
    escapeLikeBrowser(btn);
    expect(props.onDone).toHaveBeenCalledOnce();
  });

  it("Esc при открытой панели «Рекомендации» закрывает только её, следующий выходит", async () => {
    realAlerts.current = true;
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const lamp = screen.getByRole("button", { name: "Рекомендации" });
    await userEvent.click(lamp);
    expect(lamp).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Рекомендации" })).toBeInTheDocument();
    escapeLikeBrowser(lamp);
    expect(screen.queryByRole("dialog", { name: "Рекомендации" })).toBeNull();
    expect(props.onDone).not.toHaveBeenCalled();
    escapeLikeBrowser(lamp);
    expect(props.onDone).toHaveBeenCalledOnce();
  });

  // Панель «Рекомендации» на новом языке (редизайн, фаза 10): лампа прямо в ряду значков
  // шапки рядом с «Действиями со схемой», без обёртки прежнего вида (legacy-root).
  it("лампа «Рекомендации» в ряду значков шапки, панель без обёртки прежнего вида", async () => {
    realAlerts.current = true;
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const lamp = screen.getByRole("button", { name: "Рекомендации" });
    const icons = lamp.closest(".ds-head-icons");
    expect(icons).not.toBeNull();
    expect(lamp.parentElement?.parentElement).toBe(icons);
    expect(icons?.contains(screen.getByRole("button", { name: "Действия со схемой" }))).toBe(true);
    expect(lamp.closest(".legacy-root")).toBeNull();
    await userEvent.click(lamp);
    expect(screen.getByRole("dialog", { name: "Рекомендации" }).closest(".legacy-root")).toBeNull();
  });

  it("Esc при открытом меню и открытой панели объекта: меню, потом панель, потом выход", async () => {
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    await выбрать(node("n1"));
    const btn = screen.getByRole("button", { name: "Действия со схемой" });
    await userEvent.click(btn);
    escapeLikeBrowser(btn);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("object-inspector")).toBeInTheDocument();
    escapeLikeBrowser(btn);
    expect(screen.queryByTestId("object-inspector")).toBeNull();
    expect(props.onDone).not.toHaveBeenCalled();
    escapeLikeBrowser(btn);
    expect(props.onDone).toHaveBeenCalledOnce();
  });

  it("корень, шапка, дерево и окна на новом языке; на прежних метриках только холст", async () => {
    const { container } = render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const root = container.querySelector(".map-editor");
    expect(root).toHaveClass("ds");
    const head = container.querySelector(".ds-head");
    expect(head?.parentElement).toBe(root);
    expect(head?.closest(".legacy-root")).toBeNull();
    const pinned = [...(root?.children ?? [])].filter((el) => el.classList.contains("legacy-root"));
    // Обёртки окон больше нет (фаза 13б): окна на каркасе ds-win. В теле — область холста.
    // Дерево — своя область .ds (NodeTreePanel).
    expect(pinned).toHaveLength(0);
    expect(container.querySelectorAll(".legacy-root")).toHaveLength(1);
    expect(screen.getByTestId("tree-panel").closest(".legacy-root")).toBeNull();
    expect(screen.getByTestId("level-graph").closest(".legacy-root")).not.toBeNull();
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

  // Рекомендации — только тем, кто правит проект (AL10): у читателя кнопки нет. С холста
  // кнопка ушла в шапку (редизайн, фаза 4б), перед меню «Действия со схемой».
  it("кнопка «Рекомендации» в шапке есть у владельца и нет у читателя проекта", async () => {
    const { unmount } = render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const recs = screen.getByTestId("recs-button");
    expect(recs.closest(".ds-head")).not.toBeNull();
    const menuBtn = screen.getByRole("button", { name: "Действия со схемой" });
    expect(recs.compareDocumentPosition(menuBtn) & document.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

// ── Создание объекта ─────────────────────────────────────────────────────────
// «+» дерева и бросок шаблона открывают окно «Новый объект» сразу: родителя окно
// загружает само, редактор ничего не спрашивает и не пишет. Тип родителя создание не
// меняет: у листа он выбран всегда (решение владельца 2026-11-01).
describe("MapEditorPage: создание объекта", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
  });

  it("«+» у листа в дереве — окно с этим родителем, без запросов", async () => {
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

  it("создание поднимает версию вида: запись раскладки ждёт ответа load() и берёт его версию (V47б)", async () => {
    vi.mocked(nodesApi.getGraph).mockResolvedValueOnce(graph({ version: 3 }) as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const meta = (levelGraphProps.current!.persistence as { viewMeta: ViewMetaRef }).viewMeta;
    expect(meta.current.version).toBe(3);

    // Перечитывание уровня после создания висит, пока тест не ответит.
    let answer: (g: unknown) => void = () => {};
    vi.mocked(nodesApi.getGraph).mockReturnValueOnce(new Promise((r) => { answer = r; }) as never);
    const drop = levelGraphProps.current!.drop as { onDropNode: (s: string, p: { x: number; y: number }, d: string | null) => void };
    act(() => { drop.onDropNode("container", { x: 10, y: 20 }, null); });
    const onSaved = nodeModalProps.current.onSaved as (n: Node, isCreate: boolean) => void;
    act(() => { onSaved(node("new1"), true); });

    // Объект уже на холсте (оптимистично), версия вида у страницы ещё старая, и записи
    // раскладки ждут ответа: со старой версией они ловили бы самоконфликт 409.
    expect((levelGraphProps.current!.nodes as Node[]).map((n) => n.id)).toContain("new1");
    const gate = meta.current.refreshing;
    expect(gate).toBeInstanceOf(Promise);
    expect(meta.current.version).toBe(3);
    let released = false;
    void gate!.then(() => { released = true; });
    await act(async () => { await Promise.resolve(); });
    expect(released).toBe(false);

    await act(async () => { answer(graph({ version: 4 })); });
    await waitFor(() => expect(released).toBe(true));
    expect(meta.current.version).toBe(4);
    expect(meta.current.refreshing).toBeUndefined();
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
// V47б, перечень путей: удаление, перенос, восстановление и «Принять переход» тоже поднимают
// версию вида, но холст до ответа GET графа ничего не получает (оптимистичной правки нет), и
// конвейеру нечего записать со старой версией. Новые объекты приходят только из load, а он
// кладёт свежую версию раньше данных. Ожидание refreshing нужно одному созданию.
describe("MapEditorPage: своя мутация без оптимистичной правки холста (V47б)", () => {
  const снимок = { nodes: [], edges: [], layout_items: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    role.current = "owner";
    canvasLog.renders = [];
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
    vi.mocked(nodesApi.movePreview).mockResolvedValue(
      { kind: "none", before: [], after: [], docs_names: [], container_name: null } as never,
    );
    vi.mocked(nodesApi.moveSnapshot).mockResolvedValue(снимок as never);
    vi.mocked(nodesApi.update).mockResolvedValue(node("b") as never);
    vi.mocked(nodesApi.restore).mockResolvedValue(undefined as never);
  });

  async function открыть(over: Record<string, unknown> = {}) {
    vi.mocked(nodesApi.getGraph).mockResolvedValueOnce(
      graph({ version: 3, nodes: [node("a"), node("b")], ...over }) as never,
    );
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
  }

  // Мутация с перечитыванием уровня, которое висит до ответа теста. Пока ответа нет, холст
  // видит прежние объекты; объекты из ответа приходят на холст вместе с его версией.
  async function проверить(мутация: () => void | Promise<void>, ответ: { version: number; nodes: Node[] }) {
    const прежние = canvasLog.renders.at(-1)!.ids.join();
    const чтений = vi.mocked(nodesApi.getGraph).mock.calls.length;
    let answer: (g: unknown) => void = () => {};
    vi.mocked(nodesApi.getGraph).mockReturnValueOnce(new Promise((r) => { answer = r; }) as never);
    const с = canvasLog.renders.length;
    await act(async () => { await мутация(); });
    await waitFor(() => expect(nodesApi.getGraph).toHaveBeenCalledTimes(чтений + 1));
    expect(canvasLog.renders.slice(с).every((r) => r.ids.join() === прежние)).toBe(true);
    const meta = (levelGraphProps.current!.persistence as { viewMeta: ViewMetaRef }).viewMeta;
    expect(meta.current.refreshing).toBeUndefined();

    await act(async () => { answer(graph(ответ)); });
    const новые = canvasLog.renders.slice(с).filter((r) => r.ids.join() !== прежние);
    expect(новые.length).toBeGreaterThan(0);
    expect(новые.every((r) => r.version === ответ.version)).toBe(true);
  }

  it("удаление объекта", async () => {
    await открыть();
    await выбрать(node("b"));
    const onNodeDeleted = inspectorProps.current.onNodeDeleted as (id: string, s: unknown) => void;
    await проверить(() => onNodeDeleted("b", снимок), { version: 4, nodes: [node("a")] });
  });

  it("удаление нескольких объектов", async () => {
    await открыть();
    const del = levelGraphProps.current!.delete as { onRequestDeleteNodes: (ns: Node[]) => void };
    act(() => { del.onRequestDeleteNodes([node("a"), node("b")]); });
    const onDeleted = multiDeleteProps.current!.onDeleted as (ids: string[], s: unknown[]) => void;
    await проверить(() => onDeleted(["a", "b"], [снимок, снимок]), { version: 4, nodes: [] });
  });

  it("перенос в другой родитель", async () => {
    await открыть();
    const onReparent = treeProps.current.onReparent as (n: Node, p: string | null) => Promise<void> | void;
    await проверить(() => onReparent(node("b"), "x"), { version: 4, nodes: [node("a")] });
    expect(nodesApi.update).toHaveBeenCalledWith("b", { parent_id: "x" });
  });

  it("восстановление после удаления (Undo)", async () => {
    await открыть();
    await выбрать(node("b"));
    vi.mocked(nodesApi.getGraph).mockResolvedValueOnce(graph({ version: 4, nodes: [node("a")] }) as never);
    const onNodeDeleted = inspectorProps.current.onNodeDeleted as (id: string, s: unknown) => void;
    act(() => { onNodeDeleted("b", снимок); });
    await waitFor(() => expect(canvasLog.renders.at(-1)!.ids).toEqual(["a"]));
    const cmd = historyMock.push.mock.calls.at(-1)![0] as { undo: () => void };
    await проверить(() => cmd.undo(), { version: 5, nodes: [node("a"), node("b")] });
    expect(nodesApi.restore).toHaveBeenCalledWith(снимок);
  });

  it("«Принять переход»: холст размонтирован, пока уровень перечитывается", async () => {
    await открыть({ has_status_info: true });
    fireEvent.click(screen.getByRole("button", { name: "Принять переход" }));
    let answer: (g: unknown) => void = () => {};
    vi.mocked(nodesApi.getGraph).mockReturnValueOnce(new Promise((r) => { answer = r; }) as never);
    const с = canvasLog.renders.length;
    act(() => { (transitionProps.current!.onApplied as (m: string) => void)("Переход принят"); });
    expect(screen.queryByTestId("level-graph")).toBeNull();
    expect(canvasLog.renders.length).toBe(с);

    await act(async () => { answer(graph({ version: 4, nodes: [node("a")], has_status_info: true })); });
    expect(await screen.findByTestId("level-graph")).toBeInTheDocument();
    expect(canvasLog.renders.slice(с).every((r) => r.version === 4)).toBe(true);
  });
});

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
      type: "component", enabled: true, reason: "Положите «Компонент» внутрь раскрытой системы или контейнера: «orders»",
    });
    const onTemplateDrag = treeProps.current.onTemplateDrag as (type: string | null) => void;
    act(() => { onTemplateDrag("component"); });
    expect(drop().dropEligible?.levelOk).toBe(false);
    expect([...drop().dropEligible!.frameIds]).toEqual(["orders"]);

    act(() => { drop().onDropRefused("component", null); });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Компонентом объект бывает только внутри контейнера. Чтобы вложить компонент, сделайте «S1» контейнером "
      + "в его свойствах. Положите «Компонент» внутрь раскрытой системы или контейнера: «orders».",
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
    await выбрать(node("a"));
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
    // Цель переноса — система с вложенными.
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

  // Тип выбран всегда (решение владельца 2026-11-01): у листа-цели тип уже есть, окна
  // «что такое переносимый» нет — перенос идёт сразу, переносимый становится компонентом.
  it("перенос в лист-контейнер: без окна о типе, правка сразу", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue(node("new", { element: "container", element_effective: "container", sites: [] }) as never);
    await перенести();
    expect(screen.queryByText(/Что такое/)).toBeNull();
    expect(nodesApi.movePreview).toHaveBeenCalledWith("kid", "new");
    expect(nodesApi.update).toHaveBeenCalledWith("kid", { parent_id: "new" });
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

  // Первая единица в поддереве пустой системы (решение владельца 2026-11-02): цель — вложенная
  // система без площадок, держатель — система выше. Заголовок называет цель по имени из
  // дерева, текст — держателя (container_name).
  it("перенос во вложенную систему: окно называет цель из дерева и держателя площадок", async () => {
    vi.mocked(nodesApi.movePreview).mockResolvedValue({
      kind: "first_child",
      before: [{ node_id: "orders", name: "ORDERS", sites: ["prod-eu"] }],
      after: [{ node_id: "kid", name: "KID", sites: ["prod-eu"] }],
      docs_names: [], container_name: "ORDERS",
    } as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const onReparent = treeProps.current.onReparent as (n: Node, p: string | null, t?: string) => void;
    await act(async () => { onReparent(node("kid", { name: "KID", parent_id: "old" }), "new", "CORE"); });
    expect(await screen.findByText("Перенести «KID» в «CORE»?")).toBeInTheDocument();
    expect(screen.getByText("Площадки «ORDERS» перейдут первому вложенному контейнеру, базе данных или брокеру.")).toBeInTheDocument();
    expect(nodesApi.update).not.toHaveBeenCalled();
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

  // Перенос в контейнер снимает элемент (объект — компонент), а без присланного значения
  // сервер вернул бы объекту на старом месте «контейнер»: Undo шлёт прежний тип.
  it("Undo возвращает и прежний тип переносимого", async () => {
    vi.mocked(nodesApi.moveSnapshot).mockResolvedValue(снимок as never);
    vi.mocked(nodesApi.update).mockResolvedValue(node("kid") as never);
    vi.mocked(nodesApi.restore).mockResolvedValue(undefined as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("tree-panel");
    const onReparent = treeProps.current.onReparent as (n: Node, p: string | null) => void;
    const kid = node("kid", { parent_id: "old", element: "system", element_effective: "system" });
    await act(async () => { onReparent(kid, "new"); });
    const cmd = historyMock.push.mock.calls[0][0] as { undo: () => void; redo: () => void };
    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.undo(); });
    await waitFor(() => expect(nodesApi.restore).toHaveBeenCalledWith(снимок));
    expect(nodesApi.update).toHaveBeenCalledWith("kid", { parent_id: "old", element: "system" });
    // Redo — тот же перенос: элемент на новом месте выравнивает сервер.
    vi.mocked(nodesApi.update).mockClear();
    await act(async () => { cmd.redo(); });
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledWith("kid", { parent_id: "new" }));
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
    await screen.findByTestId("level-graph");
    await выбрать(before);
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
  // гостя — по id. На страницу узла ведёт лишь кнопка заголовка самой панели.
  describe("двойной клик по узлу — панель свойств", () => {
    type Drill = {
      onInspectGhost: (g: unknown) => void;
      onInspectNodeId: (id: string) => void;
    };
    type Sel = { kind: string; node?: { name: string }; ghost?: { name: string; ancestors: { name: string }[] } } | null;
    const drill = () => levelGraphProps.current?.drill as unknown as Drill;
    const selected = () => inspectorProps.current.selected as Sel;

    it("без выбора панели нет; выбор её открывает, крестик и двойной клик по пустому холсту закрывают", async () => {
      render(<MapEditorPage {...props} nodeId={null} />);
      await screen.findByTestId("level-graph");
      expect(screen.queryByTestId("object-inspector")).toBeNull();
      expect(screen.queryByText(/Объект не выбран/)).toBeNull();
      // Сворачивать панель больше незачем: её нет, пока ничего не выбрано.
      expect(screen.queryByTitle("Свойства объекта")).toBeNull();

      await выбрать(node("n1"));
      act(() => { (inspectorProps.current.onClose as () => void)(); });
      expect(screen.queryByTestId("object-inspector")).toBeNull();

      await выбрать(node("n1"));
      act(() => { (levelGraphProps.current?.drill as { onClearSelection: () => void }).onClearSelection(); });
      expect(screen.queryByTestId("object-inspector")).toBeNull();
    });

    it("крестик гасит ещё не доехавшую догрузку объекта по id: панель сама не открывается", async () => {
      render(<MapEditorPage {...props} nodeId={null} />);
      await screen.findByTestId("level-graph");
      await выбрать(node("n1"));
      let answer: (all: Node[]) => void = () => {};
      vi.mocked(nodesApi.getAll).mockReturnValueOnce(new Promise((r) => { answer = r; }) as never);
      act(() => drill().onInspectNodeId("far"));
      act(() => { (inspectorProps.current.onClose as () => void)(); });
      await act(async () => { answer([node("far", { name: "Далёкий" })]); });
      expect(screen.queryByTestId("object-inspector")).toBeNull();
    });

    it("«Показать на схеме» у гостя — уровень, где объект живёт, его панель и подсветка", async () => {
      vi.mocked(nodesApi.getAll).mockResolvedValue([
        node("sys", { name: "Система" }),
        node("ext", { name: "Партнёр", is_external: true }),
        node("ext-api", { name: "API партнёра", parent_id: "ext", is_external: true }),
      ]);
      render(<MapEditorPage {...props} nodeId="sys" />);
      await screen.findByTestId("level-graph");
      act(() => drill().onInspectGhost({ id: "ext-api", name: "API партнёра", ancestors: [{ id: "ext", name: "Партнёр" }] }));
      const api = node("ext-api", { name: "API партнёра", parent_id: "ext", is_external: true });
      vi.mocked(nodesApi.getGraph).mockResolvedValueOnce(graph({ nodes: [api] }) as never);
      await act(async () => { (inspectorProps.current.onShowGhost as (g: unknown) => void)(selected()!.ghost); });
      await waitFor(() => expect(nodesApi.getGraph).toHaveBeenLastCalledWith("ext"));
      await waitFor(() => expect(selected()).toMatchObject({ kind: "node", node: { name: "API партнёра" } }));
      expect(levelGraphProps.current?.locate).toMatchObject({ kind: "node", ids: ["ext-api"] });
      // На страницу объекта действие не уводит: страница — кнопка заголовка панели.
      expect(props.onNavigateNode).not.toHaveBeenCalled();
    });

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
// Элемент и внешность звеньев меняются и без перехода: родителю уровня или предку выше
// меняют тип или внешность. Холст (рамки) и крошки получают свежие звенья тем же сигналом,
// что дерево.
describe("MapEditorPage: крошки перечитываются после правки", () => {
  const a = node("a", { name: "Торговля", has_children: true, child_count: 1, element: "system", element_effective: "system" });
  const b = node("b", { name: "orders", parent_id: "a", element: "container", element_effective: "container" });
  const getBy = (map: Record<string, Node>) => async (id: string) => map[id] as never;
  const onNodeSaved = () => inspectorProps.current.onNodeSaved as (saved: Node, isCreate: boolean, before?: Node) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    role.current = "owner";
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph() as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([a, b]);
    vi.mocked(nodesApi.get).mockImplementation(getBy({ a, b }));
  });

  it("родителю уровня сменили тип — холст получает его без навигации", async () => {
    render(<MapEditorPage {...props} nodeId="b" />);
    await screen.findByTestId("level-graph");
    await waitFor(() => expect(levelGraphProps.current?.ancestorElements).toEqual(["system", "container"]));
    const callsBefore = vi.mocked(nodesApi.get).mock.calls.length;

    // «orders» сделали пустой системой в свойствах.
    const bSystem = node("b", { name: "orders", parent_id: "a", element: "system", element_effective: "system" });
    vi.mocked(nodesApi.get).mockImplementation(getBy({ a, b: bSystem }));
    await выбрать(b);
    act(() => { onNodeSaved()(bSystem, false, b); });

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
    await выбрать(node("x"));
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

// «+ Добавить связь» окна выбора (edge.md E97, 2026-11-02): новая связь к ПОКАЗАННОЙ паре
// концов стрелки. Пучок в свёрнутую систему «Заказы» — десять «пользуется» к её вложенным
// объектам; первая связь пучка ведёт в «Каталог», но на экране стрелка — к «Заказам».
describe("MapEditorPage: «+ Добавить связь» из окна выбора связи", () => {
  const user = node("user", { name: "Пользователь", shape: "person", element_effective: null });
  const orders = node("orders", { name: "Заказы", has_children: true, child_count: 3, element: "system", element_effective: "system" });
  const levelEdge = (id: string, s: string, t: string): LevelEdge => ({
    id, label: "пользуется", technology: null, source_id: s, target_id: t, version: 1, created_at: "",
    original_source_id: s, original_target_id: t, original_source_name: "", original_target_name: "",
  }) as LevelEdge;
  const toCatalog = levelEdge("u1", "user", "cat");
  const endpoints = [{ id: "cat", name: "Каталог" }, { id: "gw", name: "Платёжный шлюз" }];

  async function openEditor() {
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph({ nodes: [user, orders], endpoints }) as never);
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    const add = edgeChoiceArgs.current?.onAddFromChoice;
    if (!add) throw new Error("onAddFromChoice не передан");
    return add;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    role.current = "owner";
    edgeChoiceArgs.current = null;
  });

  it("пучок в свёрнутую систему — выбор потомка этой системы, а не быстрое создание к первой связи", async () => {
    const add = await openEditor();
    act(() => add(toCatalog, {
      source: "user", target: "orders",
      connect: {
        source: { kind: "direct", id: "user", name: "Пользователь" },
        target: { kind: "into", id: "orders", name: "Заказы" },
      },
    }));
    const picker = screen.getByTestId("cross-level-picker");
    expect(picker).toHaveAttribute("data-title", "Связь внутрь «Заказы»");
    expect(picker).toHaveAttribute("data-root", "orders");
    expect(picker).toHaveAttribute("data-source", "user");
    expect(picker).toHaveAttribute("data-source-label", "Пользователь");
    expect(screen.queryByTestId("edge-quick-create")).toBeNull();
  });

  it("стрелка к листу — быстрое создание с показанными концами и их именами с холста", async () => {
    const add = await openEditor();
    // «Корзина» лежит в раскрытой рамке: её имя знает только холст
    act(() => add(levelEdge("u2", "user", "cart"), {
      source: "user", target: "cart",
      connect: {
        source: { kind: "direct", id: "user", name: "Пользователь" },
        target: { kind: "direct", id: "cart", name: "Корзина" },
      },
    }));
    const quick = screen.getByTestId("edge-quick-create");
    expect(quick).toHaveAttribute("data-source", "user");
    expect(quick).toHaveAttribute("data-target", "cart");
    expect(quick).toHaveAttribute("data-target-label", "Корзина");
    expect(screen.queryByTestId("cross-level-picker")).toBeNull();
  });

  it("пучок из свёрнутой системы — источник берётся настоящим концом первой связи", async () => {
    const add = await openEditor();
    act(() => add(levelEdge("p1", "cat", "gw"), {
      source: "orders", target: "gw",
      connect: {
        source: { kind: "into", id: "orders", name: "Заказы" },
        target: { kind: "direct", id: "gw", name: "Платёжный шлюз" },
      },
    }));
    const quick = screen.getByTestId("edge-quick-create");
    expect(quick).toHaveAttribute("data-source", "cat");
    expect(quick).toHaveAttribute("data-source-label", "Каталог");
    expect(quick).toHaveAttribute("data-target", "gw");
  });

  it("концы стрелки не известны — прежнее поведение: концы первой связи пучка", async () => {
    const add = await openEditor();
    act(() => add(toCatalog));
    const quick = screen.getByTestId("edge-quick-create");
    expect(quick).toHaveAttribute("data-source", "user");
    expect(quick).toHaveAttribute("data-target", "cat");
    expect(quick).toHaveAttribute("data-target-label", "Каталог");
    expect(screen.queryByTestId("cross-level-picker")).toBeNull();
  });

  // Стрелка в рамку раскрытого контейнера — связь в сам контейнер: холст разрешает рамку
  // как зону входа, и кнопка открывает выбор потомка, а не прямую связь в контейнер (E97).
  it("стрелка в рамку раскрытого контейнера — выбор потомка этого контейнера", async () => {
    const add = await openEditor();
    act(() => add(levelEdge("u0", "user", "orders"), {
      source: "user", target: "orders",
      connect: {
        source: { kind: "direct", id: "user", name: "Пользователь" },
        target: { kind: "into", id: "orders", name: "Заказы" },
      },
    }));
    const picker = screen.getByTestId("cross-level-picker");
    expect(picker).toHaveAttribute("data-title", "Связь внутрь «Заказы»");
    expect(picker).toHaveAttribute("data-root", "orders");
    expect(screen.queryByTestId("edge-quick-create")).toBeNull();
  });

  it("цель — не конец новой связи (общий участок разных стрелок) — цель первой связи пучка", async () => {
    const add = await openEditor();
    act(() => add(toCatalog, {
      source: "user", target: null,
      connect: { source: { kind: "direct", id: "user", name: "Пользователь" }, target: null },
    }));
    const quick = screen.getByTestId("edge-quick-create");
    expect(quick).toHaveAttribute("data-source", "user");
    expect(quick).toHaveAttribute("data-target", "cat");
  });
});

// Страховка механики тостов колонки холста (редизайн, фаза 13а, меняется только вид): чужая
// правка и итог «Принять переход» — без роли, отказ — role="alert"; все три в одной колонке;
// гаснут ровно через 4, 5 и 6 с.
describe("MapEditorPage: тосты колонки холста", () => {
  type Drop = { onDropRefused: (t: string, d: string | null) => void };
  const drop = () => levelGraphProps.current!.drop as Drop;
  const ЧУЖАЯ = "Схему только что изменили в другом окне";
  const ИТОГ = "Переход принят: 2 объекта переведено в существующие";

  beforeEach(() => {
    vi.clearAllMocks();
    role.current = "owner";
    levelGraphProps.current = null;
    sessionStorage.clear();
    vi.mocked(nodesApi.getGraph).mockResolvedValue(graph({ has_status_info: true }) as never);
    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
  });
  afterEach(() => { vi.useRealTimers(); });

  async function открыть() {
    const { useRemoteSync } = await import("../useRemoteSync");
    render(<MapEditorPage {...props} nodeId={null} />);
    await screen.findByTestId("level-graph");
    return vi.mocked(useRemoteSync).mock.calls.at(-1)?.[0] as { onRemoteChange: () => void };
  }

  it("чужая правка: тост без роли, гаснет через 4 с", async () => {
    const sync = await открыть();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => { sync.onRemoteChange(); });
    const тост = screen.getByText(ЧУЖАЯ);
    expect(тост).not.toHaveAttribute("role");
    expect(тост).not.toHaveAttribute("aria-live");
    act(() => { vi.advanceTimersByTime(3999); });
    expect(screen.getByText(ЧУЖАЯ)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText(ЧУЖАЯ)).toBeNull();
  });

  it("итог «Принять переход»: тост без роли, гаснет через 5 с", async () => {
    await открыть();
    fireEvent.click(screen.getByRole("button", { name: "Принять переход" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => { (transitionProps.current!.onApplied as (m: string) => void)(ИТОГ); });
    const тост = screen.getByText(ИТОГ);
    expect(тост).not.toHaveAttribute("role");
    expect(тост).not.toHaveAttribute("aria-live");
    act(() => { vi.advanceTimersByTime(4999); });
    expect(screen.getByText(ИТОГ)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText(ИТОГ)).toBeNull();
  });

  it("отказ: тост role=alert, гаснет через 6 с", async () => {
    await открыть();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => { drop().onDropRefused("component", null); });
    expect(screen.getByRole("alert")).toHaveTextContent("Компонентом объект бывает только внутри контейнера");
    act(() => { vi.advanceTimersByTime(5999); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("три тоста разом стоят в одной колонке: чужая правка, итог, отказ", async () => {
    const sync = await открыть();
    fireEvent.click(screen.getByRole("button", { name: "Принять переход" }));
    await act(async () => { sync.onRemoteChange(); });
    await act(async () => { (transitionProps.current!.onApplied as (m: string) => void)(ИТОГ); });
    act(() => { drop().onDropRefused("component", null); });
    const колонка = screen.getByText(ЧУЖАЯ).parentElement;
    expect(колонка).not.toBeNull();
    expect(screen.getByText(ИТОГ).parentElement).toBe(колонка);
    expect(screen.getByRole("alert").parentElement).toBe(колонка);
    // Вид (фаза 13а): колонка ds-toast-rail, в ней три тоста одного вида без инлайн-стиля.
    expect(колонка).toHaveClass("ds-toast-rail");
    expect(колонка).not.toHaveAttribute("style");
    for (const тост of колонка!.children) {
      expect(тост).toHaveClass("ds-toast");
      expect(тост).not.toHaveAttribute("style");
    }
    expect([...колонка!.children].map((c) => c.textContent?.slice(0, 12))).toEqual([
      ЧУЖАЯ.slice(0, 12), ИТОГ.slice(0, 12), "Компонентом ",
    ]);
  });
});
