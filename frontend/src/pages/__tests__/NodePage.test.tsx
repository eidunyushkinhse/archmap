// Рендер-тесты NodePage: загрузка узла, секции (свойства, связи, процессы),
// навигация. Тяжёлый канвас (EmbeddedSchemaBlock → LevelGraph) замокан —
// тестируем страницу-документ и её данные. Имя/роль/технология — инлайн-инпуты
// (CAS-правка по blur), поэтому ищутся по displayValue.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodePage from "../NodePage";
import { configParamsApi, nodesApi, nodeDocsApi, viewsApi } from "../../api/nodes";
import { deploymentApi } from "../../api/deployment";
import { ApiError } from "../../api/client";
import { ProjectRoleContext } from "../projectRole";
import type { ConfigParam, Node, NodeDocMeta, NodeEdgeInfo, ProcessListItem, ProjectRole } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    get: vi.fn(),
    getAll: vi.fn(),
    getEdges: vi.fn(),
    getChildren: vi.fn(),
    getDescendants: vi.fn(),
    getContextGraph: vi.fn(),
    getNodeProcesses: vi.fn(),
    update: vi.fn(),
    // Живая нормализация источника (поле «Источник» в «Свойствах»): форма зовёт её при
    // вводе. Мок модуля ЦЕЛИКОМ — забыть метод значит уронить форму на «не функция».
    anchorPreview: vi.fn(),
    // Превью «Собрать с компонентов» (Р19): страница контейнера с компонентами тянет его
    // при маунте, чтобы решить, показывать ли кнопку сбора.
    collectPreview: vi.fn(() => Promise.resolve({ components: [], param_clashes: [], specs: [] })),
    collectFacts: vi.fn(),
  },
  // usage — обратный индекс «используется в процессах» (Ф8): страница тянет его
  // эффектом при маунте, без мока эффект падает на «не функция».
  nodeDocsApi: { distribute: vi.fn(), usage: vi.fn(() => Promise.resolve([])) },
  // Секция «Структура» рендерится на странице базы данных и сама ходит за таблицами.
  dbTablesApi: { list: vi.fn(() => Promise.resolve([])), usage: vi.fn(() => Promise.resolve([])) },
  // Секция «Каналы» — то же самое на странице брокера. Мок модуля ЦЕЛИКОМ: забыть
  // здесь новый экспорт значит уронить страницу на «не функция» в первом же тесте.
  brokerChannelsApi: { list: vi.fn(() => Promise.resolve([])), usage: vi.fn(() => Promise.resolve([])) },
  // Секция «Конфигурация» монтируется на КАЖДОЙ странице (легаси-записи у неподходящей
  // формы видны только запросом), поэтому её мок нужен всем тестам, а не только сервису.
  configParamsApi: { list: vi.fn(() => Promise.resolve([])), usage: vi.fn(() => Promise.resolve([])) },
  viewsApi: { state: vi.fn() },
  edgesApi: { update: vi.fn() },
  exportApi: { subtree: vi.fn() },
}));

// Строка «Размещение» в «Свойствах» (Ф3 развёртывания): площадки грузятся по
// «Изменить», окно пишет набор площадок объекта.
vi.mock("../../api/deployment", () => ({
  deploymentApi: { sites: vi.fn(), setPlacements: vi.fn(), createSite: vi.fn() },
}));

// Канвас схемы — заглушка (LevelGraph тянет @xyflow/react и весь конвейер).
// В data-nodes выкладываем мету узлов, которую схема РИСУЕТ: по ней видно, доехала
// ли правка страницы до данных схемы без перезагрузки.
vi.mock("../../components/EmbeddedSchemaBlock", () => ({
  default: ({ nodes }: { nodes: Node[] }) => (
    <div
      data-testid="schema-block"
      data-nodes={nodes.map((n) => `${n.id}:${n.shape}:${n.status}:${n.name}`).join("|")}
    >
      схема
    </div>
  ),
}));

// Модалка на нативном <dialog>: в jsdom showModal() не выставляет open, и
// контент диалога выпадает из role-запросов. Заменяем прозрачной обёрткой
// (паттерн DocOverlay.test) — тестируем форму распределения, не фокус-менеджмент.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="modal">{children}</div>,
}));

// Окно «Список операций от агента»: маркер вместо настоящего окна — здесь проверяется вход в
// него из меню «+ Добавить», а само окно покрыто своим тестом (ReconAgentModal.test).
vi.mock("../../components/docsImport/ReconAgentModal", () => ({
  default: ({ nodeName }: { nodeName: string }) => (
    <div data-testid="recon-modal" data-node-name={nodeName} />
  ),
}));

// Окно «Доки от агента» (пакетом): маркер — здесь проверяется только вход в него из
// меню «+ Добавить»; само окно покрыто своим тестом (DocsAgentModal.test).
vi.mock("../../components/docsImport/DocsAgentModal", () => ({
  default: () => <div data-testid="docs-modal" />,
}));

// Оверлей документации: маркер с контекстом (nodeId/initialDocId/mode/стадия) —
// проверить, что split-кнопка открывает доку в контексте РЕБЁНКА, а меню «+ Добавить»
// — окно в нужной стадии, не рендеря тяжёлые FlowchartDocs/OpenApiPane.
vi.mock("../../components/inspector/DocOverlay", () => ({
  default: ({ nodeId, initialDocId, mode, createNew, initialStage }: {
    nodeId: string; initialDocId?: string; mode: string; createNew?: boolean; initialStage?: string;
  }) => (
    <div
      data-testid="doc-overlay"
      data-node-id={nodeId}
      data-doc-id={initialDocId ?? ""}
      data-mode={mode}
      data-create={String(Boolean(createNew))}
      data-stage={initialStage ?? ""}
    />
  ),
}));

// Панель «Версии документации»: маркер с пропсами — здесь проверяется вход в неё из
// ⋯-меню и права, переданные по роли; сама панель покрыта своим тестом (VersionsPanel.test).
vi.mock("../../components/nodePage/versions/VersionsPanel", () => ({
  default: ({ nodeId, title, canEdit, canDelete }: {
    nodeId: string | null; title: string; canEdit: boolean; canDelete: boolean;
  }) => (
    <div
      data-testid="versions-panel"
      data-node-id={nodeId ?? ""}
      data-title={title}
      data-can-edit={String(canEdit)}
      data-can-delete={String(canDelete)}
    />
  ),
}));

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id,
    name: "Сервис оплаты",
    description: "Приём платежей",
    role: "ядро",
    technology: "Python",
    parent_id: null,
    shape: "service",
    is_external: false,
    status: "existing",
    openapi_spec: null,
    version: 1,
    docs: [],
    has_children: false,
    child_count: 0,
    approval: "in_progress",
    approval_effective: "in_progress",
    element: null,
    element_effective: "container",
    sites: [],
    created_at: "",
    updated_at: "",
    ...over,
  } as Node;
}

function edgeInfo(over: Partial<NodeEdgeInfo> = {}): NodeEdgeInfo {
  return {
    id: "e1",
    label: "зовёт",
    technology: null,
    direction: "outgoing",
    other_node_id: "x",
    other_node_name: "Шлюз",
    ...over,
  } as NodeEdgeInfo;
}

const nav = {
  onNavigateNode: vi.fn(),
  onNavigateProject: vi.fn(),
  onNavigateMap: vi.fn(),
  onNavigateProcesses: vi.fn(),
  onNodeDeleted: vi.fn(),
};

// Граф контекста: фокус + сосед (чтобы секция «Схема» рендерила канвас, а не
// пустое состояние «Внешних связей нет»).
function contextGraph() {
  return {
    nodes: [node("n1"), node("x", { name: "Шлюз" })],
    endpoints: [],
    edges: [{ id: "e1", label: "зовёт", technology: null, source_id: "n1", target_id: "x", version: 1 }],
    layout: {},
    version: 1,
    graph_rev: 1,
    meta_rev: 1,
  } as never;
}

describe("NodePage", () => {
  beforeEach(() => vi.clearAllMocks());

  function setup(over: { node?: Partial<Node>; edges?: NodeEdgeInfo[]; processes?: ProcessListItem[] } = {}) {
    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", over.node));
    vi.mocked(nodesApi.getAll).mockResolvedValue([node("n1", over.node)]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue(over.edges ?? []);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue(over.processes ?? []);
    return render(<NodePage nodeId="n1" isArchitect {...nav} />);
  }

  // Аудит R-2: load без catch — 404/403/сеть оставляли «Загрузку…» навсегда.
  it("узел не найден: экран с причиной, «Повторить» грузит заново, «К проекту» уводит", async () => {
    vi.mocked(nodesApi.get).mockRejectedValueOnce(new ApiError(404, "Узел не найден")).mockResolvedValue(node("n1"));
    vi.mocked(nodesApi.getAll).mockResolvedValue([node("n1")]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    render(<NodePage nodeId="n1" isArchitect {...nav} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось загрузить объект");
    expect(alert).toHaveTextContent("возможно, объект удалили");

    await userEvent.click(within(alert).getByRole("button", { name: "К проекту" }));
    expect(nav.onNavigateProject).toHaveBeenCalled();

    await userEvent.click(within(alert).getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.getByDisplayValue("Сервис оплаты")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nodesApi.get).toHaveBeenCalledTimes(2);
  });

  it("загружает узел и рендерит имя в шапке (инлайн-инпут)", async () => {
    setup();
    await waitFor(() => expect(screen.getByDisplayValue("Сервис оплаты")).toBeInTheDocument());
  });

  it("рендерит свойства (роль, технология — инпуты)", async () => {
    setup();
    await waitFor(() => expect(screen.getByDisplayValue("Сервис оплаты")).toBeInTheDocument());
    expect(screen.getByDisplayValue("ядро")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Python")).toBeInTheDocument();
  });

  it("рендерит секцию связей с именем соседа", async () => {
    setup({ edges: [edgeInfo()] });
    await waitFor(() => expect(screen.getByText("Шлюз")).toBeInTheDocument());
  });

  it("рендерит блок схемы при наличии соседей", async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId("schema-block")).toBeInTheDocument());
  });

  it("секция «Участвует в процессах»: клик ведёт в процесс", async () => {
    const proc = {
      id: "p1", name: "Оплата заказа", scope_node_id: null, scope_name: null,
      message_count: 3, statuses: [],
    } as ProcessListItem;
    setup({ processes: [proc] });
    const link = await screen.findByText("Оплата заказа");
    await userEvent.click(link);
    expect(nav.onNavigateProcesses).toHaveBeenCalledWith("p1");
  });

  it("без процессов секция «Участвует в процессах» скрыта", async () => {
    setup({ processes: [] });
    await waitFor(() => expect(screen.getByDisplayValue("Сервис оплаты")).toBeInTheDocument());
    expect(screen.queryByText("Участвует в процессах")).not.toBeInTheDocument();
  });
});

// ── Правила контейнеров ─────────────────────────────────────────────────────
// Контейнер (сервис с детьми): логика/спеки — объединение потомков,
// сгруппированное по непосредственным детям (своё плоско, глубокое — в
// раскрываемой группе), свои (grandfather) схемы — с предупреждением и
// переносом по детям, технология — агрегированная read-only, создание скрыто.
describe("NodePage: правила контейнеров", () => {
  beforeEach(() => vi.clearAllMocks());

  function docMeta(over: Partial<NodeDocMeta> = {}): NodeDocMeta {
    return { id: "d1", name: "Схема оплаты", kind: "operation", operation: null, version: 1, described: true, ...over };
  }

  function setupContainer(over: { own?: Partial<Node>; children?: Node[] } = {}) {
    // Детям без parent_id ставим parent_id контейнера; узел с явным parent_id
    // (напр. внук с parent_id=ребёнок) оставляем как есть: хук выводит
    // непосредственных детей из потомков (getDescendants) по parent_id === nodeId.
    const kids = (over.children ?? []).map((k) => (k.parent_id ? k : { ...k, parent_id: "c1" }));
    const cont = node("c1", { name: "Ядро", has_children: true, child_count: kids.length, ...over.own });
    vi.mocked(nodesApi.get).mockResolvedValue(cont);
    vi.mocked(nodesApi.getAll).mockResolvedValue([cont, ...kids]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    // getDescendants — для хука агрегации контейнера и окна «Перенести документацию»
    // (оно само фетчит узел и потомков).
    vi.mocked(nodesApi.getDescendants).mockResolvedValue(kids);
    vi.mocked(nodesApi.getChildren).mockResolvedValue(kids);
    // Перенос документации — своя запись: страница сверяет курсоры (syncCursors).
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 1, meta_rev: 1, process_rev: 0 });
    return render(<NodePage nodeId="c1" isArchitect {...nav} />);
  }

  it("объединение схем детей: левая часть открывает схему ребёнка напрямую, правая ведёт на его страницу", async () => {
    setupContainer({ children: [node("k1", { name: "Шлюз", docs: [docMeta()] })] });
    await screen.findByText("Схема оплаты");
    expect(screen.getByText("от Шлюз →")).toBeInTheDocument();
    // Левая (широкая) часть — открыть схему ребёнка напрямую: оверлей в контексте
    // ребёнка (nodeId=k1, не контейнера) на конкретной схеме (d1).
    const mainBtn = screen.getByText("Схема оплаты").closest("button");
    await userEvent.click(mainBtn as HTMLButtonElement);
    const overlay = screen.getByTestId("doc-overlay");
    expect(overlay).toHaveAttribute("data-node-id", "k1");
    expect(overlay).toHaveAttribute("data-doc-id", "d1");
    expect(overlay).toHaveAttribute("data-mode", "flowchart");
    // Правая (узкая) часть — на страницу ребёнка.
    const childBtn = screen.getByText("от Шлюз →").closest("button");
    await userEvent.click(childBtn as HTMLButtonElement);
    expect(nav.onNavigateNode).toHaveBeenCalledWith("k1");
  });

  it("группировка по детям: схемы ребёнка плоско, схемы внуков — в раскрываемой группе под родителем", async () => {
    // k1 — непосредственный ребёнок со своей схемой, g1 — внук (parent_id=k1)
    // со схемой: она уходит в группу под «Шлюз», свёрнутую по умолчанию.
    const kid = node("k1", { name: "Шлюз", docs: [docMeta({ id: "dk", name: "Схема шлюза" })] });
    const grand = node("g1", { name: "Внук", parent_id: "k1", docs: [docMeta({ id: "dg", name: "Схема внука" })] });
    setupContainer({ children: [kid, grand] });
    // Собственная схема ребёнка — плоская split-кнопка, видна сразу.
    await screen.findByText("Схема шлюза");
    expect(screen.getByText("от Шлюз →")).toBeInTheDocument();
    // Схема внука — в свёрнутой группе: скрыта, но есть кнопка-группа с именем
    // ребёнка и счётчиком (aria-expanded=false).
    expect(screen.queryByText("Схема внука")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Шлюз\s*1 схема/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Клик раскрывает группу: схема внука видна, пометка «от Внук».
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Схема внука")).toBeInTheDocument();
    expect(screen.getByText("от Внук →")).toBeInTheDocument();
    // Левая часть группы открывает схему внука в его контексте.
    const deepBtn = screen.getByText("Схема внука").closest("button");
    await userEvent.click(deepBtn as HTMLButtonElement);
    expect(screen.getByTestId("doc-overlay")).toHaveAttribute("data-node-id", "g1");
    expect(screen.getByTestId("doc-overlay")).toHaveAttribute("data-doc-id", "dg");
    // Левая часть собственной схемы ребёнка — в контексте ребёнка.
    const ownBtn = screen.getByText("Схема шлюза").closest("button");
    await userEvent.click(ownBtn as HTMLButtonElement);
    expect(screen.getByTestId("doc-overlay")).toHaveAttribute("data-node-id", "k1");
    expect(screen.getByTestId("doc-overlay")).toHaveAttribute("data-doc-id", "dk");
    // Правая часть split-кнопки внука ведёт на его страницу.
    await userEvent.click(screen.getByText("от Внук →"));
    expect(nav.onNavigateNode).toHaveBeenCalledWith("g1");
  });

  it("спеки потомков: спека ребёнка плоско, спека внука — в раскрываемой группе", async () => {
    const kid = node("k1", { name: "Шлюз", openapi_spec: "openapi: 3.0.0" });
    const grand = node("g1", { name: "Внук", parent_id: "k1", openapi_spec: "openapi: 3.0.0" });
    setupContainer({ children: [kid, grand] });
    // Спека ребёнка — плоская split-кнопка, видна сразу; спека внука скрыта
    // в свёрнутой группе (видима только одна «Спецификация»).
    await screen.findByText("Спецификация");
    expect(screen.getByText("от Шлюз →")).toBeInTheDocument();
    expect(screen.getAllByText("Спецификация")).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: /Шлюз\s*1 спецификация/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Спецификация")).toHaveLength(2);
    // Левая часть спеки внука открывает оверлей в его контексте (режим openapi).
    await userEvent.click(screen.getByTitle("Открыть спецификацию «Внук»"));
    const overlay = screen.getByTestId("doc-overlay");
    expect(overlay).toHaveAttribute("data-node-id", "g1");
    expect(overlay).toHaveAttribute("data-mode", "openapi");
    // Правая часть ведёт на страницу внука.
    await userEvent.click(screen.getByText("от Внук →"));
    expect(nav.onNavigateNode).toHaveBeenCalledWith("g1");
  });

  it("свои схемы: предупреждение и «Перенести документацию», создание скрыто", async () => {
    setupContainer({ own: { docs: [docMeta()] } });
    await screen.findByText(/остались собственные логические диаграммы/);
    expect(screen.getByRole("button", { name: "Перенести документацию" })).toBeInTheDocument();
    expect(screen.queryByText("+ Добавить")).not.toBeInTheDocument();
  });

  it("система: технология — агрегированная из детей, только чтение", async () => {
    // Сводная технология — только у системы (Р15 эпика «Элемент архитектуры»): у
    // контейнера с компонентами технология своя и правится.
    setupContainer({
      own: { element_effective: "system" },
      children: [
        node("k1", { name: "А-сервис", technology: "Python" }),
        node("k2", { name: "Б-шлюз", technology: "Kafka" }),
        node("k3", { name: "В-воркер", technology: "Python" }),
      ],
    });
    expect(await screen.findByText("Python, Kafka")).toBeInTheDocument();
    // Своего поля technology у системы нет — инпута с ним быть не должно
    expect(screen.queryByDisplayValue("Python")).not.toBeInTheDocument();
  });

  it("контейнер с компонентами: своя технология полем, сводной нет", async () => {
    setupContainer({
      own: { element: "container", element_effective: "container", technology: "Go" },
      children: [node("k1", { name: "api", technology: "Python", element_effective: "component" })],
    });
    expect(await screen.findByDisplayValue("Go")).toBeInTheDocument();
    expect(screen.queryByText("Python")).not.toBeInTheDocument();
  });

  it("база с детьми — не контейнер: своя технология полем, потомков не запрашивает", async () => {
    // Характеризация Ф0 эпика «Элемент архитектуры»: контейнером страница считает только
    // сервис с детьми (canHaveChildren); база с детьми — данные до проверки формы
    // родителя на сервере — остаётся листом.
    setupContainer({
      own: { shape: "database", technology: "PostgreSQL" },
      children: [node("k1", { name: "Реплика", technology: "Python" })],
    });
    expect(await screen.findByDisplayValue("PostgreSQL")).toBeInTheDocument();
    expect(nodesApi.getDescendants).not.toHaveBeenCalled();
    expect(screen.queryByText("Python")).not.toBeInTheDocument();
  });

  it("окно «Перенести документацию»: переносит схему выбранному получателю", async () => {
    vi.mocked(nodeDocsApi.distribute).mockResolvedValue({ moved_docs: 1, spec_moved: false, moved_params: 0 });
    setupContainer({
      own: { docs: [docMeta()] },
      children: [node("k1", { name: "Шлюз" })],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Перенести документацию" }));
    await screen.findByText("Схемы логики"); // форма окна загрузилась
    await userEvent.click(screen.getByRole("button", { name: "Перенести" }));
    await waitFor(() =>
      expect(nodeDocsApi.distribute).toHaveBeenCalledWith("c1", {
        doc_assignments: [{ doc_id: "d1", child_id: "k1" }],
      }),
    );
    // Модалка закрылась после успеха
    await waitFor(() => expect(screen.queryByTestId("modal")).toBeNull());
  });

  it("система с параметрами: «Перенести документацию» в конфигурации — параметры одному контейнеру", async () => {
    const params = [{ id: "p1" }, { id: "p2" }] as ConfigParam[];
    vi.mocked(configParamsApi.list).mockImplementation((id) => Promise.resolve(id === "c1" ? params : []));
    vi.mocked(nodeDocsApi.distribute).mockResolvedValue({ moved_docs: 0, spec_moved: false, moved_params: 2 });
    setupContainer({
      own: { element_effective: "system" },
      children: [node("k1", { name: "Шлюз" })],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Перенести документацию" }));
    expect(await screen.findByText("2 параметра")).toBeInTheDocument();
    expect(screen.getByLabelText("Куда перенести конфигурацию")).toHaveValue("k1");
    const listed = vi.mocked(configParamsApi.list).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Перенести" }));
    await waitFor(() => expect(nodeDocsApi.distribute).toHaveBeenCalledWith("c1", {
      doc_assignments: [], params_target_id: "k1",
    }));
    // После записи секции перемонтируются: конфигурация перечитана.
    await waitFor(() => expect(vi.mocked(configParamsApi.list).mock.calls.length).toBeGreaterThan(listed));
    // У системы сбора нет — и превью не запрашивается.
    expect(nodesApi.collectPreview).not.toHaveBeenCalled();
    vi.mocked(configParamsApi.list).mockImplementation(() => Promise.resolve([]));
  });

  it("контейнер с компонентами: «Собрать с компонентов» по превью, своя спецификация без переноса", async () => {
    vi.mocked(nodesApi.collectPreview).mockResolvedValue({
      components: [{ node_id: "k1", name: "api", params: 2, has_spec: true }],
      param_clashes: [],
      specs: [{ node_id: "k1", name: "api" }],
    });
    vi.mocked(nodesApi.collectFacts).mockResolvedValue({ moved_params: 2, spec_moved: true });
    setupContainer({
      own: { element: "container", element_effective: "container", openapi_spec: "openapi: 3.0.0" },
      children: [node("k1", { name: "api", element_effective: "component", container_name: "Ядро" })],
    });
    // Кнопка — в конфигурации и в «OpenAPI».
    const buttons = await screen.findAllByRole("button", { name: "Собрать с компонентов" });
    expect(buttons).toHaveLength(2);
    expect(nodesApi.collectPreview).toHaveBeenCalledWith("c1");
    // Своя спецификация контейнера на месте — переносить её некуда и незачем.
    expect(screen.queryByRole("button", { name: "Перенести документацию" })).not.toBeInTheDocument();

    await userEvent.click(buttons[0]);
    expect(screen.getByText("api · 2 параметра, спецификация")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Собрать" }));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledWith("c1", {
      param_choices: [], spec_from: "k1",
    }));
    // Превью перечитано по новой эпохе страницы.
    await waitFor(() => expect(nodesApi.collectPreview).toHaveBeenCalledTimes(2));
    vi.mocked(nodesApi.collectPreview).mockResolvedValue({ components: [], param_clashes: [], specs: [] });
  });
});

// ── Смена типа узла ─────────────────────────────────────────────────────────
// Тип (форма C4) правится с самой страницы: импорт мог ошибиться («Monitored
// Hosts» приехал «Пользователем»), и раньше починить это можно было только
// пересозданием объекта. Запреты держит сервер — страница обязана показать его
// причину, а не проглотить отказ.
describe("NodePage: смена типа", () => {
  beforeEach(() => vi.clearAllMocks());

  function setupType(over: Partial<Node> = {}, isArchitect = true) {
    const n = node("n1", { name: "Monitored Hosts", ...over });
    vi.mocked(nodesApi.get).mockResolvedValue(n);
    vi.mocked(nodesApi.getAll).mockResolvedValue([n]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    return render(<NodePage nodeId="n1" isArchitect={isArchitect} {...nav} />);
  }

  it("архитектор меняет тип из выпадашки — PATCH с новой формой", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(node("n1", { shape: "service", version: 2 }));
    setupType({ shape: "person" });
    const кнопка = await screen.findByRole("button", { name: "Пользователь" });
    await userEvent.click(кнопка);
    await userEvent.click(screen.getByText("Сервис"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1].shape).toBe("service");
  });

  it("наблюдателю тип показан текстом, редактора нет", async () => {
    setupType({ shape: "person" }, false);
    await waitFor(() => expect(screen.getByText("Пользователь")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Пользователь" })).toBeNull();
  });

  it("отказ сервера виден на странице, а не проглатывается", async () => {
    // У узла с детьми строки «Тип» нет (Р24 эпика «Элемент архитектуры»): отказ — на базе
    // с описанной структурой.
    const причина = "У узла описана структура БД — сначала перенесите или удалите её";
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, причина));
    setupType({ shape: "database" });
    await userEvent.click(await screen.findByRole("button", { name: "База данных" }));
    await userEvent.click(screen.getByText("Брокер сообщений"));
    expect(await screen.findByText(причина)).toBeInTheDocument();
  });

  it("у узла с детьми строки «Тип» нет — тип говорит элемент архитектуры", async () => {
    setupType({ shape: "service", has_children: true, child_count: 1, element_effective: "system" });
    await screen.findByText("Элемент архитектуры");
    expect(screen.queryByText("Тип")).not.toBeInTheDocument();
  });
});

// ── Правки меты доезжают до схемы страницы ──────────────────────────────────
// Схема страницы держит СВОЙ снимок контекст-графа (фетч при монтировании), и до
// 2026-08-14 правка меты в него не попадала: пользователь менял тип, а объект на
// схеме оставался прежним до перезагрузки. Свежий узел из ответа PATCH вливается
// в данные схемы точечно — рефетча и ремаунта холста тут нет.
describe("NodePage: правки меты и схема страницы", () => {
  beforeEach(() => vi.clearAllMocks());

  function setupSchema(over: Partial<Node> = {}) {
    const n = node("n1", over);
    vi.mocked(nodesApi.get).mockResolvedValue(n);
    vi.mocked(nodesApi.getAll).mockResolvedValue([n]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    return render(<NodePage nodeId="n1" isArchitect {...nav} />);
  }

  const схема = () => screen.getByTestId("schema-block").getAttribute("data-nodes") ?? "";

  it("смена типа сразу видна на схеме, без перезагрузки", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(node("n1", { shape: "database", version: 2 }));
    setupSchema({ shape: "service" });
    await waitFor(() => expect(схема()).toContain("n1:service"));

    await userEvent.click(screen.getByRole("button", { name: "Сервис" }));
    await userEvent.click(screen.getByText("База данных"));

    await waitFor(() => expect(схема()).toContain("n1:database"));
    // Сосед не пострадал, и контекст не перезапрашивался — данные уже были на руках
    expect(схема()).toContain("x:service");
    expect(nodesApi.getContextGraph).toHaveBeenCalledOnce();
  });

  it("смена статуса сразу видна на схеме (механизм один для всей меты)", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(node("n1", { status: "planned", version: 2 }));
    setupSchema({ status: "existing" });
    await waitFor(() => expect(схема()).toContain(":existing:"));

    await userEvent.click(screen.getByRole("button", { name: "Существует" }));
    await userEvent.click(screen.getByText("Проектируется"));

    await waitFor(() => expect(схема()).toContain("n1:service:planned"));
  });
});

// ── Чужая правка узла догоняет «Свойства» страницы ──────────────────────────
// Структурные поля (имя, форма) двигают graph_rev, а мета (роль/статус/…) — meta_rev
// (V48/V53). Страница слушала только meta_rev: чужая смена имени/типа перерисовывала
// встроенную схему (она поллит graph_rev), а «Свойства» оставались старыми до
// перезахода. Канал освежения один — сверка свежего узла по version и сигнатуре.
// Ожидания блока — до 5 с (ждать ниже), а таймаут теста по умолчанию — те же 5 с: под
// нагрузкой полного гейта ожидание и тест упирались в одну границу и тест падал по
// таймауту (флак и на чистом main). Тесту — запас над его ожиданиями.
describe("NodePage: чужая правка узла и «Свойства»", { timeout: 15_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  function setupPoll(own: Partial<Node> = {}) {
    const n = node("n1", own);
    vi.mocked(nodesApi.get).mockResolvedValue(n);
    vi.mocked(nodesApi.getAll).mockResolvedValue([n]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    // Курсоры при загрузке — как в контекст-графе (graph_rev 1 / meta_rev 1).
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 1, meta_rev: 1, process_rev: 0 });
    return render(<NodePage nodeId="n1" isArchitect {...nav} />);
  }

  // Тик поллинга: фокус окна сверяет курсоры немедленно (useRemoteSync), без таймеров.
  // Подписка на фокус — пассивный эффект схемы страницы, а waitFor видит «Свойства»
  // сразу после коммита DOM, раньше этого эффекта: фокус, посланный в этот зазор,
  // уходил в пустоту, и тест ждал до таймаута (флак ~1 из 5). Запрос контекст-графа —
  // эффект схемы из того же сброса, поэтому он и служит признаком «подписка на месте».
  async function тик() {
    await waitFor(() => expect(nodesApi.getContextGraph).toHaveBeenCalled());
    await act(async () => { window.dispatchEvent(new Event("focus")); });
  }

  // Дефолтный таймаут waitFor — 1000 мс, и ожидания этого блока в него упирались:
  // падения ловились на 1.03–1.06 с, то есть тик поллинга и перерисовка «Свойств»
  // не успевали под нагрузкой (CI, параллельные файлы). Логика тут ни при чём —
  // даём запас, чтобы медленная машина не выглядела красным тестом.
  const ждать = { timeout: 5000 };

  it("чужая смена ТИПА (graph_rev) освежает «Свойства», а не только схему", async () => {
    setupPoll({ shape: "service" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Сервис" })).toBeInTheDocument(), ждать);

    // Другая сессия сменила тип: структурная правка двигает graph_rev, meta_rev
    // стоит на месте. Форма — единственное отличие, поэтому тест ловит и «слушаем
    // только meta_rev», и «сигнатура не различает форму».
    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", { shape: "database", version: 5 }));
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 2, meta_rev: 1, process_rev: 0 });
    await тик();

    await waitFor(() => expect(screen.getByRole("button", { name: "База данных" })).toBeInTheDocument(), ждать);
    expect(screen.getByText("Данные обновлены в другой сессии")).toBeInTheDocument();
  });

  it("чужая смена элемента у предка (graph_rev) освежает страницу без правки самого узла", async () => {
    // Предок стал контейнером: строка узла не менялась (version прежняя), а действующий
    // элемент стал «компонент». Сигнатура без элемента промолчала бы.
    setupPoll();
    await waitFor(() => expect(screen.getByDisplayValue("Сервис оплаты")).toBeInTheDocument(), ждать);

    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", { element_effective: "component" }));
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 2, meta_rev: 1, process_rev: 0 });
    await тик();

    await waitFor(() => expect(screen.getByText("Данные обновлены в другой сессии")).toBeInTheDocument(), ждать);
  });

  it("чужое переименование (graph_rev) доезжает до поля имени", async () => {
    setupPoll({ name: "Сервис оплаты" });
    await waitFor(() => expect(screen.getByDisplayValue("Сервис оплаты")).toBeInTheDocument(), ждать);

    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", { name: "Платёжный шлюз", version: 5 }));
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 2, meta_rev: 1, process_rev: 0 });
    await тик();

    await waitFor(() => expect(screen.getByDisplayValue("Платёжный шлюз")).toBeInTheDocument(), ждать);
  });

  it("чужая смена статуса (meta_rev) освежает «Свойства» — прежний канал цел", async () => {
    setupPoll({ status: "existing" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Существует/ })).toBeInTheDocument(), ждать);

    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", { status: "deprecated", version: 5 }));
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 1, meta_rev: 2, process_rev: 0 });
    await тик();

    await waitFor(() => expect(screen.getByRole("button", { name: /Выводится/ })).toBeInTheDocument(), ждать);
  });

  it("своя правка тем же тиком страницу не дёргает (эхо-подавление)", async () => {
    // Тик застал СВОЮ правку: сервер отдаёт ровно то, что уже показано, —
    // ни подмены полей, ни тоста «Данные обновлены» быть не должно.
    setupPoll({ name: "Сервис оплаты", shape: "service" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Сервис" })).toBeInTheDocument(), ждать);

    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", { name: "Сервис оплаты", shape: "service", version: 5 }));
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 2, meta_rev: 1, process_rev: 0 });
    await тик();

    expect(screen.getByDisplayValue("Сервис оплаты")).toBeInTheDocument();
    expect(screen.queryByText("Данные обновлены в другой сессии")).not.toBeInTheDocument();
  });

  it("устаревший ответ страницу не откатывает: свежесть решает version", async () => {
    // Своя правка типа доехала (version 5), а следом возвращается ответ запроса,
    // выпущенного ДО неё (version 2 со старым типом). Порядок прихода не решает —
    // решает version строки (тот же критерий, что у withOwnEdits, X20).
    vi.mocked(nodesApi.update).mockResolvedValue(node("n1", { shape: "database", version: 5 }));
    setupPoll({ shape: "service" });
    // findBy* ждёт тем же дефолтом в 1000 мс — болезнь та же, лечим заодно.
    await userEvent.click(await screen.findByRole("button", { name: "Сервис" }, ждать));
    await userEvent.click(screen.getByText("База данных"));
    await waitFor(() => expect(screen.getByRole("button", { name: "База данных" })).toBeInTheDocument(), ждать);

    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", { shape: "service", version: 2 }));
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 2, meta_rev: 1, process_rev: 0 });
    await тик();

    expect(screen.getByRole("button", { name: "База данных" })).toBeInTheDocument();
    expect(screen.queryByText("Данные обновлены в другой сессии")).not.toBeInTheDocument();
  });

  // Размещение — не колонка узла: чужая смена площадок двигает курсоры, а version узла
  // стоит. Освежит строку только сигнатура, в которой размещение есть.
  it("чужое размещение доезжает до строки «Размещение»", async () => {
    setupPoll();
    await waitFor(() => expect(screen.getByText("не указано")).toBeInTheDocument(), ждать);

    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", {
      sites: [{ id: "k8s", name: "Кластер prod", kind: "kubernetes", partial: false }],
    }));
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 2, meta_rev: 2, process_rev: 0 });
    await тик();

    await waitFor(() => expect(screen.getByText("Кластер prod")).toBeInTheDocument(), ждать);
    expect(screen.queryByText("не указано")).not.toBeInTheDocument();
  });

  it("своё размещение со страницы: строка перечитана, курсоры сверены — тик тостов не даёт", async () => {
    vi.mocked(deploymentApi.sites).mockResolvedValue([
      { id: "k8s", name: "Кластер prod", kind: "kubernetes", technology: null, description: null, parent_id: null, version: 1, instance_count: 0 },
    ]);
    vi.mocked(deploymentApi.setPlacements).mockResolvedValue(undefined);
    setupPoll();
    await userEvent.click(await screen.findByRole("button", { name: "Изменить размещение" }, ждать));
    await userEvent.click(await screen.findByRole("checkbox", { name: /^Кластер prod/ }, ждать));

    // Сервер после записи: у узла площадка, курсоры схемы и меты сдвинуты своей записью.
    vi.mocked(nodesApi.get).mockResolvedValue(node("n1", {
      sites: [{ id: "k8s", name: "Кластер prod", kind: "kubernetes", partial: false }],
    }));
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 2, meta_rev: 2, process_rev: 0 });
    const stateCalls = vi.mocked(viewsApi.state).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));

    expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["n1"], ["k8s"]);
    await waitFor(() => expect(screen.getByText("Кластер prod")).toBeInTheDocument(), ждать);
    await waitFor(() => expect(vi.mocked(viewsApi.state).mock.calls.length).toBeGreaterThan(stateCalls), ждать);
    await act(async () => { await Promise.resolve(); });

    await тик();
    expect(screen.queryByText("Схема обновлена в другой сессии")).not.toBeInTheDocument();
    expect(screen.queryByText("Данные обновлены в другой сессии")).not.toBeInTheDocument();
  });
});

// ── Документация по форме узла ──────────────────────────────────────────────
// Логика (mermaid) и OpenAPI — артефакты СЕРВИСА. У базы данных их не бывает: её
// «контракт» — структура. Промпт агента это правило проговаривал давно, а страница
// до 2026-08-12 предлагала слоты под них любой атомарной форме.
describe("NodePage: документация по форме узла", () => {
  beforeEach(() => vi.clearAllMocks());

  function setupShape(over: Partial<Node>) {
    const n = node("n1", { ...over, has_children: false, child_count: 0 });
    vi.mocked(nodesApi.get).mockResolvedValue(n);
    vi.mocked(nodesApi.getAll).mockResolvedValue([n]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    return render(<NodePage nodeId="n1" isArchitect {...nav} />);
  }

  it("у сервиса секции «Логика» и «OpenAPI» на месте", async () => {
    setupShape({ shape: "service" });
    await waitFor(() => expect(screen.getByText("Логика")).toBeInTheDocument());
    expect(screen.getByText("OpenAPI")).toBeInTheDocument();
  });

  it("у базы данных ни логики, ни OpenAPI не предлагается", async () => {
    setupShape({ shape: "database", name: "Хранилище" });
    await waitFor(() => expect(screen.getByDisplayValue("Хранилище")).toBeInTheDocument());
    expect(screen.queryByText("Логика")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenAPI")).not.toBeInTheDocument();
  });

  it("у брокера тоже нет — вместо них его собственные «Каналы»", async () => {
    setupShape({ shape: "broker", name: "Очередь" });
    await waitFor(() => expect(screen.getByDisplayValue("Очередь")).toBeInTheDocument());
    expect(screen.queryByText("Логика")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenAPI")).not.toBeInTheDocument();
    expect(screen.getByText("Каналы")).toBeInTheDocument();
  });

  it("«Каналы» — только у брокера: у сервиса их нет", async () => {
    // Симметрично «Структуре» базы: канал без брокера бессмысленен, и бэкенд их даже
    // не примет (гвард формы Ф0) — предлагать слот было бы обманом.
    setupShape({ shape: "service" });
    await waitFor(() => expect(screen.getByText("Логика")).toBeInTheDocument());
    expect(screen.queryByText("Каналы")).not.toBeInTheDocument();
  });

  it("легаси-содержимое у базы не прячется, а объясняется", async () => {
    const док: NodeDocMeta = { id: "d1", name: "Схема оплаты", kind: "operation", operation: null, version: 1, described: true };
    setupShape({ shape: "database", name: "Хранилище", docs: [док], openapi_spec: "openapi: 3.0.0" });
    await waitFor(() => expect(screen.getByText("Логика")).toBeInTheDocument());
    expect(screen.getByText(/у этого объекта его нет — перенесите/)).toBeInTheDocument();
    expect(screen.getByText(/OpenAPI описывает HTTP-API/)).toBeInTheDocument();
    // Заводить новое всё равно нельзя — только унести существующее.
    expect(screen.queryByText("+ Добавить")).not.toBeInTheDocument();
  });

  // ── OpenAPI: окно спеки вместо отдельной модалки (вьюер v2) ───────────────
  async function меню_OpenAPI(пункт: string) {
    const карточка = screen.getByText("OpenAPI").closest(".np-card") as HTMLElement;
    await userEvent.click(within(карточка).getByText("+ Добавить"));
    await userEvent.click(screen.getByRole("menuitem", { name: пункт }));
  }

  it("спеки нет: «+ Добавить → Вручную» открывает окно спеки сразу в редакторе", async () => {
    setupShape({ shape: "service" });
    await waitFor(() => expect(screen.getByText("Спецификация не задана")).toBeInTheDocument());
    await меню_OpenAPI("Вручную");
    const окно = screen.getByTestId("doc-overlay");
    expect(окно).toHaveAttribute("data-mode", "openapi");
    expect(окно).toHaveAttribute("data-stage", "manual");
  });

  it("спеки нет: «+ Добавить → Через ИИ-агента» открывает то же окно панелью агента", async () => {
    setupShape({ shape: "service" });
    await waitFor(() => expect(screen.getByText("Спецификация не задана")).toBeInTheDocument());
    await меню_OpenAPI("Через ИИ-агента");
    const окно = screen.getByTestId("doc-overlay");
    expect(окно).toHaveAttribute("data-mode", "openapi");
    expect(окно).toHaveAttribute("data-stage", "agent");
  });

  it("спека есть: строка открывает просмотр, кнопки «Обновить с помощью ИИ-агента» нет", async () => {
    // Обновление через агента теперь — «Изменить» в самом окне спеки.
    setupShape({ shape: "service", openapi_spec: "openapi: 3.0.0" });
    await waitFor(() => expect(screen.getByText("Спецификация")).toBeInTheDocument());
    expect(screen.queryByText("Обновить с помощью ИИ-агента")).toBeNull();
    await userEvent.click(screen.getByText("Спецификация"));
    const окно = screen.getByTestId("doc-overlay");
    expect(окно).toHaveAttribute("data-mode", "openapi");
    expect(окно).toHaveAttribute("data-stage", "");
  });
});

// ── Витрина разведки: остаток работы виден числом ───────────────────────────
// Разведка кладёт в «Логику» ЗАГЛУШКИ — схемы с пустым телом. Витрина обязана их
// отличать (иначе заглушку не спутать с документацией нельзя), показывать остаток
// работы числом (без знаменателя «опиши монолит» снова становится безразмерным) и
// пережить две сотни строк: до разведки полевым максимумом были тринадцать.
describe("NodePage: «Логика» — описанные схемы, заглушки в блоке «Не описано», группы по видам", () => {
  beforeEach(() => vi.clearAllMocks());

  function док(over: Partial<NodeDocMeta> = {}): NodeDocMeta {
    return { id: "d1", name: "Схема", kind: "operation", operation: null, version: 1, described: true, ...over };
  }

  function setupDocs(docs: NodeDocMeta[]) {
    const n = node("n1", { docs, shape: "service", has_children: false, child_count: 0 });
    vi.mocked(nodesApi.get).mockResolvedValue(n);
    vi.mocked(nodesApi.getAll).mockResolvedValue([n]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    return render(<NodePage nodeId="n1" isArchitect {...nav} />);
  }

  const СМЕСЬ = () => [
    док({ id: "d1", name: "POST /orders", kind: "operation", described: true }),
    док({ id: "d2", name: "GET /orders", kind: "operation", described: false }),
    док({ id: "d3", name: "email_senders", kind: "worker", described: false }),
  ];

  async function раскрытьНеОписано() {
    await userEvent.click(screen.getByRole("button", { name: /^Не описано/ }));
  }

  // ── Заглушки — не в «Логике», а в блоке «Не описано» под чертой ──────────
  it("заглушки в «Логике» не показываются, счётчиков «описано» нет", async () => {
    // Решение пользователя 2026-09-03: витрина объекта — описанные схемы; заглушка
    // разведки — не схема, а бэклог, и смешивать их нельзя. Счётчики отделяли одно
    // от другого внутри одного списка — при разделённых списках они лишние.
    setupDocs(СМЕСЬ());
    await waitFor(() => expect(screen.getByText("POST /orders")).toBeInTheDocument());
    expect(screen.queryByText("GET /orders")).toBeNull();
    expect(screen.queryByText("email_senders")).toBeNull();
    expect(screen.queryByText(/описано \d+/)).toBeNull();
    expect(screen.queryByText("не описана")).toBeNull();
    // Заголовок группы — только размер, без «остатка работы»; пустая группа не рисуется.
    expect(screen.getByRole("button", { name: /^Операции/ })).toHaveTextContent("(1)");
    expect(screen.queryByRole("button", { name: /^Воркеры/ })).toBeNull();
  });

  it("блок «Не описано» свёрнут, в шапке счётчик в скобках как у групп; раскрывается кликом", async () => {
    setupDocs(СМЕСЬ());
    await waitFor(() => expect(screen.getByText("POST /orders")).toBeInTheDocument());
    const шапка = screen.getByRole("button", { name: /^Не описано/ });
    // Пробел между словом и скобками даёт flex-gap, в textContent его нет (как у групп).
    expect(шапка).toHaveTextContent(/Не описано\s*\(2\)/);
    expect(шапка).not.toHaveTextContent("точк");
    expect(шапка).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("GET /orders")).toBeNull();

    await раскрытьНеОписано();

    expect(шапка).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("GET /orders")).toBeInTheDocument();
    expect(screen.getByText("email_senders")).toBeInTheDocument();
    // Блок — часть карточки «Логика» под чертой, а не карточка наравне с ней.
    expect(шапка.closest(".np-card")).toBe(screen.getByText("Логика").closest(".np-card"));
  });

  it("заглушек нет — блока «Не описано» нет вовсе", async () => {
    setupDocs([док({ id: "d1", name: "POST /orders" })]);
    await waitFor(() => expect(screen.getByText("POST /orders")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Не описано/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Описать все" })).toBeNull();
  });

  it("одни заглушки: «Логика» говорит, что описанных пока нет, блок лежит ниже", async () => {
    // Так выглядит объект сразу после разведки; «не заданы» тут соврало бы.
    setupDocs([док({ id: "d2", name: "GET /orders", described: false })]);
    await waitFor(() => expect(screen.getByText("Описанных схем логики пока нет")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Не описано/ })).toHaveTextContent("(1)");
  });

  it("кнопки «Описать все» у блока «Не описано» нет", async () => {
    setupDocs([док({ id: "d2", name: "GET /orders", described: false })]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Не описано/ })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Описать все" })).toBeNull();
  });

  // ── Масштаб списка: группы по видам ───────────────────────────────────────
  it("маленький объект: группы развёрнуты, схемы видны без единого клика", async () => {
    // Порог сворачивания не должен менять привычный вид там, где схем немного.
    setupDocs([
      док({ id: "d1", name: "POST /orders" }),
      док({ id: "d2", name: "email_senders", kind: "worker" }),
    ]);
    await waitFor(() => expect(screen.getByText("POST /orders")).toBeInTheDocument());
    expect(screen.getByText("email_senders")).toBeInTheDocument();
  });

  it("двести схем: свёрнута только группа-стена, воркеры видны сразу", async () => {
    const много = Array.from({ length: 200 }, (_, i) => док({ id: `o${i}`, name: `GET /r${i}` }));
    setupDocs([
      ...много,
      док({ id: "w1", name: "email_senders", kind: "worker" }),
    ]);
    // Стены из двухсот кнопок нет, а соседняя группа — не стена, и прятать её незачем.
    await waitFor(() => expect(screen.getByText("email_senders")).toBeInTheDocument());
    expect(screen.queryByText("GET /r0")).toBeNull();
    expect(screen.getByRole("button", { name: /^Операции/ })).toHaveTextContent("(200)");

    await userEvent.click(screen.getByRole("button", { name: /^Операции/ }));
    expect(screen.getByText("GET /r0")).toBeInTheDocument();
    expect(screen.getByText("GET /r199")).toBeInTheDocument();
  });

  it("двести заглушек: внутри «Не описано» группа-стена тоже свёрнута", async () => {
    // Тот же порог, что и в «Логике»: раскрытый блок не должен разворачивать стену.
    const много = Array.from({ length: 200 }, (_, i) =>
      док({ id: `o${i}`, name: `GET /r${i}`, described: false }));
    setupDocs([...много, док({ id: "w1", name: "email_senders", kind: "worker", described: false })]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Не описано/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Не описано/ })).toHaveTextContent("(201)");

    await раскрытьНеОписано();

    expect(screen.queryByText("GET /r0")).toBeNull();
    expect(screen.getByText("email_senders")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Операции/ }));
    expect(screen.getByText("GET /r199")).toBeInTheDocument();
  });

  it("тринадцать схем: порог считается по группе, а не по объекту", async () => {
    // Полевой Zulip до разведки — тринадцать схем: схем больше порога, но стены нет
    // ни в одной группе. Свернуть их значило бы забрать читаемый список без выигрыша.
    const операции = Array.from({ length: 10 }, (_, i) => док({ id: `o${i}`, name: `GET /r${i}` }));
    setupDocs([
      ...операции,
      док({ id: "w1", name: "email_senders", kind: "worker" }),
      док({ id: "w2", name: "embed_links", kind: "worker" }),
      док({ id: "w3", name: "digest_senders", kind: "worker" }),
    ]);
    await waitFor(() => expect(screen.getByText("GET /r0")).toBeInTheDocument());
    expect(screen.getByText("GET /r9")).toBeInTheDocument();
    expect(screen.getByText("email_senders")).toBeInTheDocument();
  });

  it("в заголовке группы — число строк, и только оно", async () => {
    setupDocs([
      док({ id: "d1", name: "POST /orders" }),
      док({ id: "d2", name: "GET /orders" }),
      док({ id: "d3", name: "email_senders", kind: "worker" }),
    ]);
    await waitFor(() => expect(screen.getByText("POST /orders")).toBeInTheDocument());
    const операции = screen.getByRole("button", { name: /^Операции/ });
    expect(операции).toHaveTextContent("(2)");
    expect(операции).not.toHaveTextContent("описано");
    expect(screen.getByRole("button", { name: /^Воркеры/ })).toHaveTextContent("(1)");
  });

  it("пустая группа не рисуется вовсе", async () => {
    setupDocs([док({ id: "d1", name: "POST /orders" })]);
    await waitFor(() => expect(screen.getByText("POST /orders")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Воркеры/ })).toBeNull();
  });

  // ── Неописанная строка открывает своё окно (внутри блока «Не описано») ─────
  // Вьюер v2 (решение пользователя 2026-09-29): кнопки «Описать» у строк больше нет —
  // строка открывает окно схемы, а «Описать» (вручную или через ИИ-агента) стоит там.
  // Адрес промпта (эндпоинт, у воркера — имя схемы) проверяет FlowchartDocs.test.
  it("у строк «Не описано» нет своей кнопки «Описать»: строка открывает окно схемы", async () => {
    setupDocs([
      док({ id: "d1", name: "Оформление заказа", operation: "POST /orders", described: false }),
      док({ id: "d2", name: "email_senders", kind: "worker", described: false }),
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Не описано/ })).toBeInTheDocument());
    await раскрытьНеОписано();
    expect(screen.queryByRole("button", { name: "Описать" })).toBeNull();

    await userEvent.click(screen.getByText("Оформление заказа"));
    const окно = screen.getByTestId("doc-overlay");
    expect(окно).toHaveAttribute("data-mode", "flowchart");
    expect(окно).toHaveAttribute("data-doc-id", "d1");
    expect(screen.queryByTestId("docs-modal")).toBeNull();
  });

  it("воркер-заглушка открывается тем же окном, что и операция", async () => {
    setupDocs([док({ id: "d2", name: "email_senders", kind: "worker", described: false })]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Не описано/ })).toBeInTheDocument());
    await раскрытьНеОписано();
    await userEvent.click(screen.getByText("email_senders"));
    expect(screen.getByTestId("doc-overlay")).toHaveAttribute("data-doc-id", "d2");
  });

  it("клик по строке заглушки открывает схему (писать руками), а не окно агента", async () => {
    setupDocs([док({ id: "d1", name: "POST /orders", described: false })]);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Не описано/ })).toBeInTheDocument());
    await раскрытьНеОписано();
    await userEvent.click(screen.getByText("POST /orders"));
    expect(screen.getByTestId("doc-overlay")).toHaveAttribute("data-doc-id", "d1");
    expect(screen.queryByTestId("docs-modal")).toBeNull();
  });

  it("у описанной строки кнопки «Описать» нет", async () => {
    // Описанную открывают («открыть →»), описывать заново нечего.
    setupDocs([
      док({ id: "d1", name: "POST /orders", described: true }),
    ]);
    await waitFor(() => expect(screen.getByText("POST /orders")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Описать" })).toBeNull();
  });

  it("«+ Добавить → Вручную»: окно новой схемы, а не созданная заранее схема", async () => {
    setupDocs([]);
    await waitFor(() => expect(screen.getByText("Логика")).toBeInTheDocument());
    const карточка = screen.getByText("Логика").closest(".np-card") as HTMLElement;
    await userEvent.click(within(карточка).getByText("+ Добавить"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
    const окно = screen.getByTestId("doc-overlay");
    expect(окно).toHaveAttribute("data-mode", "flowchart");
    expect(окно).toHaveAttribute("data-create", "true");
  });

  it("«+ Добавить → Через ИИ-агента» в «Логике» — пакетная модалка", async () => {
    setupDocs([]);
    await waitFor(() => expect(screen.getByText("Логика")).toBeInTheDocument());
    const карточка = screen.getByText("Логика").closest(".np-card") as HTMLElement;
    await userEvent.click(within(карточка).getByText("+ Добавить"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
    expect(screen.getByTestId("docs-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-overlay")).toBeNull();
  });

  it("меню «+ Добавить» ведёт в составление списка операций", async () => {
    setupDocs([]);
    await waitFor(() => expect(screen.getByText("Логика")).toBeInTheDocument());
    expect(screen.queryByTestId("recon-modal")).toBeNull();

    // «+ Добавить» на странице два (Логика и OpenAPI) — берём меню секции «Логика».
    const карточка = screen.getByText("Логика").closest(".np-card") as HTMLElement;
    await userEvent.click(within(карточка).getByText("+ Добавить"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Составить список операций" }));
    expect(screen.getByTestId("recon-modal")).toHaveAttribute("data-node-name", "Сервис оплаты");
  });

  it("читателю видно состояние схем, но разведка ему не предлагается", async () => {
    // Окно только архитектору (меню целиком под isArchitect) — а вот бэклог
    // читатель видеть вправе: это состояние документации, а не действие над ней.
    const n = node("n1", {
      docs: [док({ id: "d1", name: "POST /orders", described: false })],
      shape: "service",
    });
    vi.mocked(nodesApi.get).mockResolvedValue(n);
    vi.mocked(nodesApi.getAll).mockResolvedValue([n]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    render(<NodePage nodeId="n1" isArchitect={false} {...nav} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Не описано/ })).toBeInTheDocument());
    expect(screen.getByText("Описанных схем логики пока нет")).toBeInTheDocument();
    expect(screen.queryByText("+ Добавить")).toBeNull();
    // «Описать» и «Описать все» — действия над документацией, читателю их не предлагаем.
    expect(screen.queryByRole("button", { name: "Описать все" })).toBeNull();
    await раскрытьНеОписано();
    expect(screen.getByText("POST /orders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Описать" })).toBeNull();
  });
});


// ── Источник ───────────────────────────────────────────────────────────────────
// Строка «Источник» в «Свойствах»: до Ф1 (docs/plan-anchor-ux.md) источник был скрытой
// метаданной прогона агента — ручной узел вёл себя при обновлениях иначе, чем
// агентский с виду такой же, и увидеть этого было негде.
describe("NodePage: источник", () => {
  beforeEach(() => vi.clearAllMocks());

  function setupAnchor(over: Partial<Node> = {}, isArchitect = true) {
    const n = node("n1", over);
    vi.mocked(nodesApi.get).mockResolvedValue(n);
    vi.mocked(nodesApi.getAll).mockResolvedValue([n]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    return render(<NodePage nodeId="n1" isArchitect={isArchitect} {...nav} />);
  }

  it("источник агентского узла показан видом и значением", async () => {
    setupAnchor({ source: { repo: "github.com/org/mono", path: "services/orders", host: null } });
    expect(await screen.findByText("код:")).toBeInTheDocument();
    expect(screen.getByText("github.com/org/mono, путь services/orders")).toBeInTheDocument();
  });

  it("узел без источника говорит, по чему его тогда узнают", async () => {
    setupAnchor();
    expect(await screen.findByText("нет — опознаётся по имени")).toBeInTheDocument();
  });

  it("правка источника уходит PATCH-ом со своим CAS, не трогая прочих свойств", async () => {
    vi.mocked(nodesApi.anchorPreview).mockResolvedValue({
      source: { repo: "github.com/org/repo", path: null, host: null }, kind: "code", key: "git:github.com/org/repo",
    });
    vi.mocked(nodesApi.update).mockResolvedValue(
      node("n1", { source: { repo: "github.com/org/repo", path: null, host: null }, version: 2 }),
    );
    setupAnchor({ version: 1 });

    await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "https://github.com/org/repo.git");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({
      source: { repo: "https://github.com/org/repo.git", path: null },
      base_version: 1,
      name: "Сервис оплаты",
      role: "ядро",
    });
    // Форма ушла — на её месте свежий источник из ответа сервера.
    expect(await screen.findByText("github.com/org/repo")).toBeInTheDocument();
  });

  it("наблюдатель источник видит, но не правит", async () => {
    setupAnchor({ source: { repo: "github.com/org/repo", path: null, host: null } }, false);
    expect(await screen.findByText("код:")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.getByRole("button", { name: "Что такое источник" })).toBeInTheDocument();
  });
});

// ── Статус страницы (docs/tasks/page-status.md) ─────────────────────────────
// Пилюля у имени: у листа редактор меняет статус PATCH-ом, читатель только видит; у
// контейнера статус и точки детей — с сервера, клик по строке открывает ребёнка, а
// чужое согласование ребёнка (meta_rev) перечитывает детей — счётчик не застывает.
describe("NodePage: статус страницы", { timeout: 15_000 }, () => {
  beforeEach(() => vi.clearAllMocks());
  const ждать = { timeout: 5000 };

  function setupPage(n: Node, kids: Node[] = [], isArchitect = true) {
    vi.mocked(nodesApi.get).mockResolvedValue(n);
    vi.mocked(nodesApi.getAll).mockResolvedValue([n, ...kids]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    vi.mocked(nodesApi.getDescendants).mockResolvedValue(kids);
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 1, meta_rev: 1, process_rev: 0 });
    return render(<NodePage nodeId={n.id} isArchitect={isArchitect} {...nav} />);
  }

  it("лист: пилюля рядом с именем, выбор «Согласовано» уходит PATCH-ом и красит пилюлю", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(
      node("n1", { approval: "approved", approval_effective: "approved", version: 2 }),
    );
    setupPage(node("n1", { version: 1 }));
    const pill = await screen.findByRole("button", { name: /В работе/ });
    expect(pill.closest(".np-title-row")).not.toBeNull();

    await userEvent.click(pill);
    await userEvent.click(screen.getByRole("button", { name: /^Согласовано проверено редактором/ }));

    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({ approval: "approved", base_version: 1 });
    expect(await screen.findByRole("button", { name: /Согласовано/ })).toHaveClass("np-approval--ok");
  });

  it("лист, читатель: пилюля без выпадашки", async () => {
    const { container } = setupPage(node("n1"), [], false);
    await screen.findByText("Сервис оплаты");
    const pill = container.querySelector(".np-approval") as HTMLElement;
    expect(pill.tagName).toBe("SPAN");
    expect(pill).toHaveTextContent("В работе");
  });

  it("система: счётчик по вложенным объектам, клик по строке открывает его страницу", async () => {
    const kids = [
      node("k1", { name: "Шлюз", parent_id: "c1", approval: "approved", approval_effective: "approved" }),
      node("k2", { name: "База платежей", parent_id: "c1", shape: "database" }),
    ];
    setupPage(
      node("c1", { name: "Ядро", has_children: true, child_count: 2, element_effective: "system" }),
      kids, false,
    );
    const pill = await screen.findByRole("button", { name: /В работе · 1 из 2/ }, ждать);
    await userEvent.click(pill);
    await userEvent.click(screen.getByRole("button", { name: "База платежей" }));
    expect(nav.onNavigateNode).toHaveBeenCalledWith("k2");
  });

  it("система: чужое согласование ребёнка перечитывает детей — счётчик не застывает", async () => {
    const kids = [
      node("k1", { name: "Шлюз", parent_id: "c1" }),
      node("k2", { name: "База платежей", parent_id: "c1", shape: "database" }),
    ];
    const cont = node("c1", { name: "Ядро", has_children: true, child_count: 2, element_effective: "system" });
    setupPage(cont, kids);
    await screen.findByRole("button", { name: /В работе · 0 из 2/ }, ждать);

    // Другая сессия согласовала одного ребёнка: статус системы тот же («в работе»),
    // его сигнатура не меняется — освежить счётчик обязано перечитывание детей.
    vi.mocked(nodesApi.getDescendants).mockResolvedValue([
      { ...kids[0], approval: "approved", approval_effective: "approved" }, kids[1],
    ]);
    vi.mocked(viewsApi.state).mockResolvedValue({ version: 1, graph_rev: 1, meta_rev: 2, process_rev: 0 });
    await waitFor(() => expect(nodesApi.getContextGraph).toHaveBeenCalled());
    await act(async () => { window.dispatchEvent(new Event("focus")); });

    await screen.findByRole("button", { name: /В работе · 1 из 2/ }, ждать);
  });

  it("система: единицы — все вложенные объекты, кроме систем, в том числе компоненты контейнера", async () => {
    // Торговля → Заказы (контейнер) → Заказы-API (компонент); Торговля → Склад (система) →
    // Остатки. Вложенная система не позиция счётчика, её объекты — позиции.
    const kids = [
      node("o", { name: "Заказы", parent_id: "s", has_children: true, child_count: 1, element: "container",
        approval: "approved", approval_effective: "approved" }),
      node("a", { name: "Заказы-API", parent_id: "o", element_effective: "component" }),
      node("w", { name: "Склад", parent_id: "s", has_children: true, child_count: 1, element_effective: "system",
        approval: "approved", approval_effective: "in_progress" }),
      node("r", { name: "Остатки", parent_id: "w" }),
    ];
    setupPage(
      node("s", { name: "Торговля", has_children: true, child_count: 2, element_effective: "system" }),
      kids, false,
    );
    const pill = await screen.findByRole("button", { name: /В работе · 1 из 3/ }, ждать);
    await userEvent.click(pill);
    expect(screen.getByText("Согласовано 1 из 3")).toBeInTheDocument();
    for (const name of ["Заказы", "Заказы-API", "Остатки"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Склад" })).toBeNull();
  });

  it("контейнер с компонентами: редактор ставит свой статус PATCH-ом", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(
      node("o", { name: "Заказы", has_children: true, child_count: 1, element: "container",
        approval: "approved", approval_effective: "approved", version: 2 }),
    );
    const kids = [node("a", { name: "Заказы-API", parent_id: "o", element_effective: "component" })];
    setupPage(node("o", { name: "Заказы", has_children: true, child_count: 1, element: "container" }), kids);
    const pill = await screen.findByRole("button", { name: "В работе" }, ждать);
    await userEvent.click(pill);
    await userEvent.click(screen.getByRole("button", { name: /^Согласовано проверено редактором/ }));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({ approval: "approved", base_version: 1 });
  });
});


// ── ⋯-меню: история версий ────────────────────────────────────────────────────
// Меню видно обеим ролям (docs/tasks/doc-versions.md §7): у читателя — пункты
// просмотра («Открыть в карте», «Версии документации»), пункты правки — у редактора.
// Удалять версии может только владелец проекта — панель получает это по роли.
describe("NodePage: ⋯-меню и версии документации", () => {
  beforeEach(() => vi.clearAllMocks());

  async function openMenu(isArchitect: boolean, role: ProjectRole) {
    vi.mocked(nodesApi.get).mockResolvedValue(node("n1"));
    vi.mocked(nodesApi.getAll).mockResolvedValue([node("n1")]);
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.getContextGraph).mockResolvedValue(contextGraph());
    vi.mocked(nodesApi.getNodeProcesses).mockResolvedValue([]);
    render(
      <ProjectRoleContext.Provider value={role}>
        <NodePage nodeId="n1" isArchitect={isArchitect} {...nav} />
      </ProjectRoleContext.Provider>,
    );
    await userEvent.click(await screen.findByTitle("Действия"));
  }

  it("читатель: меню есть, в нём только просмотр; пункт открывает панель без права правки", async () => {
    await openMenu(false, "reader");
    expect(screen.getByRole("button", { name: "Открыть в карте" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Экспорт поддерева" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить объект" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Версии документации" }));
    const panel = screen.getByTestId("versions-panel");
    expect(panel).toHaveAttribute("data-node-id", "n1");
    expect(panel).toHaveAttribute("data-title", "Сервис оплаты");
    expect(panel).toHaveAttribute("data-can-edit", "false");
    expect(panel).toHaveAttribute("data-can-delete", "false");
    // Меню закрылось вместе с выбором пункта.
    expect(screen.queryByRole("button", { name: "Версии документации" })).toBeNull();
  });

  it("редактор: пункты правки на месте, панель с фиксацией, но без удаления версий", async () => {
    await openMenu(true, "editor");
    expect(screen.getByRole("button", { name: "Экспорт поддерева" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить объект" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Версии документации" }));
    const panel = screen.getByTestId("versions-panel");
    expect(panel).toHaveAttribute("data-can-edit", "true");
    expect(panel).toHaveAttribute("data-can-delete", "false");
  });

  it("владелец: панель с удалением версий", async () => {
    await openMenu(true, "owner");
    await userEvent.click(screen.getByRole("button", { name: "Версии документации" }));
    expect(screen.getByTestId("versions-panel")).toHaveAttribute("data-can-delete", "true");
  });
});
