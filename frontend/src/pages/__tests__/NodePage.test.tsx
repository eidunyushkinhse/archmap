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
import { ApiError } from "../../api/client";
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
  // Секция «Структура» рендерится на странице базы данных и сама ходит за таблицами.
  dbTablesApi: { list: vi.fn(() => Promise.resolve([])), usage: vi.fn(() => Promise.resolve([])) },
  // Секция «Каналы» — то же самое на странице брокера. Мок модуля ЦЕЛИКОМ: забыть
  // здесь новый экспорт значит уронить страницу на «не функция» в первом же тесте.
  brokerChannelsApi: { list: vi.fn(() => Promise.resolve([])), usage: vi.fn(() => Promise.resolve([])) },
  viewsApi: { state: vi.fn() },
  edgesApi: { update: vi.fn() },
  exportApi: { subtree: vi.fn() },
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
// Контейнер (сервис с детьми): логика/спеки — объединение потомков,
// сгруппированное по непосредственным детям (своё плоско, глубокое — в
// раскрываемой группе), свои (grandfather) схемы — с предупреждением и
// переносом по детям, технология — агрегированная read-only, создание скрыто.
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
    const toggle = screen.getByRole("button", { name: /Шлюз\s*1 спека/ });
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

  it("свои схемы: предупреждение и «Распределить по детям», создание скрыто", async () => {
    setupContainer({ own: { docs: [docMeta()] } });
    await screen.findByText(/остались собственные логические диаграммы/);
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
    const причина = "У узла есть вложенные объекты — тип «Сервис» единственный, который может их иметь";
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, причина));
    setupType({ shape: "service", has_children: true, child_count: 1 });
    await userEvent.click(await screen.findByRole("button", { name: "Сервис" }));
    await userEvent.click(screen.getByText("База данных"));
    expect(await screen.findByText(причина)).toBeInTheDocument();
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
    const док: NodeDocMeta = { id: "d1", name: "Схема оплаты", kind: "overview", operation: null, version: 1 };
    setupShape({ shape: "database", name: "Хранилище", docs: [док], openapi_spec: "openapi: 3.0.0" });
    await waitFor(() => expect(screen.getByText("Логика")).toBeInTheDocument());
    expect(screen.getByText(/у этого объекта его нет — перенесите/)).toBeInTheDocument();
    expect(screen.getByText(/OpenAPI описывает HTTP-API/)).toBeInTheDocument();
    // Заводить новое всё равно нельзя — только унести существующее.
    expect(screen.queryByText("+ Добавить")).not.toBeInTheDocument();
  });
});
