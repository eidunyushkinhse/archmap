// Рендер-тесты NodePage: загрузка узла, секции (свойства, связи, процессы),
// навигация. Тяжёлый канвас (EmbeddedSchemaBlock → LevelGraph) замокан —
// тестируем страницу-документ и её данные. Имя/роль/технология — инлайн-инпуты
// (CAS-правка по blur), поэтому ищутся по displayValue.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodePage from "../NodePage";
import { nodesApi, nodeDocsApi } from "../../api/nodes";
import type { Node, NodeDocMeta, NodeEdgeInfo, ProcessListItem } from "../../types";

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
  },
  nodeDocsApi: { distribute: vi.fn() },
  viewsApi: { state: vi.fn() },
  edgesApi: { update: vi.fn() },
  exportApi: { subtree: vi.fn() },
}));

// Канвас схемы — заглушка (LevelGraph тянет @xyflow/react и весь конвейер).
vi.mock("../../components/EmbeddedSchemaBlock", () => ({
  default: () => <div data-testid="schema-block">схема</div>,
}));

// Модалка на нативном <dialog>: в jsdom showModal() не выставляет open, и
// контент диалога выпадает из role-запросов. Заменяем прозрачной обёрткой
// (паттерн DocOverlay.test) — тестируем форму распределения, не фокус-менеджмент.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="modal">{children}</div>,
}));

// Оверлей документации: маркер с контекстом (nodeId/initialDocId/mode) — проверить,
// что split-кнопка открывает доку в контексте РЕБЁНКА, не рендеря тяжёлый FlowchartDocs.
vi.mock("../../components/inspector/DocOverlay", () => ({
  default: ({ nodeId, initialDocId, mode }: { nodeId: string; initialDocId?: string; mode: string }) => (
    <div data-testid="doc-overlay" data-node-id={nodeId} data-doc-id={initialDocId ?? ""} data-mode={mode} />
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
// Контейнер (сервис с детьми): логика/спеки — объединение детей с пометкой
// ребёнка, свои (grandfather) схемы — с предупреждением и переносом по детям,
// технология — агрегированная read-only, создание схем/спек скрыто.
describe("NodePage: правила контейнеров", () => {
  beforeEach(() => vi.clearAllMocks());

  function docMeta(over: Partial<NodeDocMeta> = {}): NodeDocMeta {
    return { id: "d1", name: "Схема оплаты", kind: "overview", operation: null, version: 1, ...over };
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
    // getDescendants — для хука агрегации контейнера; getChildren — для модалки
    // «Распределить по детям» (она сама фетчит непосредственных детей).
    vi.mocked(nodesApi.getDescendants).mockResolvedValue(kids);
    vi.mocked(nodesApi.getChildren).mockResolvedValue(kids);
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

  it("объединение включает схемы опосредованных потомков (внуков)", async () => {
    // k1 — непосредственный ребёнок (без своих схем), g1 — внук (parent_id=k1)
    // со схемой: она должна попасть в объединение с пометкой «от Внук».
    const kid = node("k1", { name: "Шлюз" });
    const grand = node("g1", { name: "Внук", parent_id: "k1", docs: [docMeta({ id: "dg", name: "Схема внука" })] });
    setupContainer({ children: [kid, grand] });
    await screen.findByText("Схема внука");
    expect(screen.getByText("от Внук →")).toBeInTheDocument();
    // Левая часть открывает схему внука в его контексте.
    const mainBtn = screen.getByText("Схема внука").closest("button");
    await userEvent.click(mainBtn as HTMLButtonElement);
    expect(screen.getByTestId("doc-overlay")).toHaveAttribute("data-node-id", "g1");
  });

  it("свои схемы: предупреждение и «Распределить по детям», создание скрыто", async () => {
    setupContainer({ own: { docs: [docMeta()] } });
    await screen.findByText(/остались собственные схемы логики/);
    expect(screen.getByRole("button", { name: "Распределить по детям" })).toBeInTheDocument();
    expect(screen.queryByText("+ Добавить")).not.toBeInTheDocument();
  });

  it("технология — агрегированная из детей, только чтение", async () => {
    setupContainer({
      children: [
        node("k1", { name: "А-сервис", technology: "Python" }),
        node("k2", { name: "Б-шлюз", technology: "Kafka" }),
        node("k3", { name: "В-воркер", technology: "Python" }),
      ],
    });
    expect(await screen.findByText("Python, Kafka")).toBeInTheDocument();
    // Своего поля technology у контейнера нет — инпута с ним быть не должно
    expect(screen.queryByDisplayValue("Python")).not.toBeInTheDocument();
  });

  it("модалка распределения: переносит схему выбранному ребёнку", async () => {
    vi.mocked(nodeDocsApi.distribute).mockResolvedValue({ moved_docs: 1, spec_moved: false });
    setupContainer({
      own: { docs: [docMeta()] },
      children: [node("k1", { name: "Шлюз" })],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Распределить по детям" }));
    await screen.findByText("Схемы логики"); // форма модалки загрузилась
    await userEvent.click(screen.getByRole("button", { name: "Распределить" }));
    await waitFor(() =>
      expect(nodeDocsApi.distribute).toHaveBeenCalledWith("c1", {
        doc_assignments: [{ doc_id: "d1", child_id: "k1" }],
      }),
    );
    // Модалка закрылась после успеха
    await waitFor(() => expect(screen.queryByTestId("modal")).toBeNull());
  });
});
