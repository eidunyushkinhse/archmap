// «Перенести документацию» и «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»):
// получатели по семьям фактов, подписи путём от узла, параметры одному контейнеру,
// сбор с одноимёнными параметрами и несколькими спецификациями. Чистые функции отбора
// и оба окна исполняются по-настоящему, подменён только транспорт.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TransferDocsModal from "../TransferDocsModal";
import CollectFactsModal from "../CollectFactsModal";
import { collectLine, subtreeRows, takesLogic, takesProcessFacts } from "../element/transferDocs";
import { configParamsApi, nodeDocsApi, nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { CollectFactsPreview, ConfigParam, Node, NodeDocMeta } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { get: vi.fn(), getDescendants: vi.fn(), collectFacts: vi.fn() },
  nodeDocsApi: { distribute: vi.fn() },
  configParamsApi: { list: vi.fn() },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в тестах других окон.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function n(id: string, over: Partial<Node> = {}): Node {
  return {
    id, name: id, description: null, role: null, technology: null, parent_id: null,
    shape: "service", is_external: false, status: "existing", openapi_spec: null, version: 1,
    docs: [], has_children: false, child_count: 0, approval: "in_progress",
    approval_effective: "in_progress", element: null, element_effective: "container",
    container_name: null, sites: [], created_at: "", updated_at: "", ...over,
  } as Node;
}

const doc = (id: string, name: string): NodeDocMeta =>
  ({ id, name, kind: "operation", operation: null, version: 1, described: true });

// Ярмарка (система) → orders (контейнер с компонентами: api, worker), billing (лист),
// orders-db (лист-база), Покупатель.
const ROOT = "shop";
const tree = [
  n("orders", { parent_id: ROOT, has_children: true, element: "container" }),
  n("api", { parent_id: "orders", element_effective: "component", container_name: "orders" }),
  n("worker", { parent_id: "orders", element_effective: "component", container_name: "orders" }),
  n("billing", { parent_id: ROOT, openapi_spec: "openapi: 3.0.0" }),
  n("orders-db", { parent_id: ROOT, shape: "database" }),
  n("Покупатель", { parent_id: ROOT, shape: "person", element_effective: null }),
];

describe("отбор получателей", () => {
  it("путь от узла и порядок дерева", () => {
    const rows = subtreeRows(ROOT, tree);
    expect(rows.map((r) => r.label)).toEqual([
      "orders", "orders / api", "orders / worker", "billing", "orders-db", "Покупатель",
    ]);
  });

  it("схемы логики — компонентам и сервисам без вложенных; спецификация и конфигурация — контейнерам", () => {
    const rows = subtreeRows(ROOT, tree);
    expect(rows.filter((r) => takesLogic(r.node)).map((r) => r.label))
      .toEqual(["orders / api", "orders / worker", "billing"]);
    expect(rows.filter((r) => takesProcessFacts(r.node)).map((r) => r.label))
      .toEqual(["orders", "billing"]);
  });

  it("строка компонента в окне сбора", () => {
    expect(collectLine({ node_id: "a", name: "api", params: 2, has_spec: true })).toBe("api · 2 параметра, спецификация");
    expect(collectLine({ node_id: "s", name: "scheduler", params: 1, has_spec: false })).toBe("scheduler · 1 параметр");
    expect(collectLine({ node_id: "c", name: "checkout", params: 0, has_spec: true })).toBe("checkout · спецификация");
  });
});

describe("окно «Перенести документацию»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getDescendants).mockResolvedValue(tree);
    vi.mocked(configParamsApi.list).mockResolvedValue([{ id: "p1" }, { id: "p2" }, { id: "p3" }] as ConfigParam[]);
    vi.mocked(nodeDocsApi.distribute).mockResolvedValue({ moved_docs: 1, spec_moved: true, moved_params: 3 });
  });

  function open(root: Node) {
    vi.mocked(nodesApi.get).mockResolvedValue(root);
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(<TransferDocsModal nodeId={ROOT} onClose={onClose} onApplied={onApplied} />);
    return { onApplied, onClose };
  }

  it("у системы — три части, получатели по семьям, параметры одному контейнеру", async () => {
    const { onApplied, onClose } = open(n(ROOT, {
      name: "Ярмарка", has_children: true, element_effective: "system",
      docs: [doc("d1", "Старт заказа")], openapi_spec: "openapi: 3.0.0",
    }));
    expect(await screen.findByText("У системы своей документации нет. Выберите, куда перенести каждую часть.")).toBeInTheDocument();

    const logic = screen.getByLabelText("Куда перенести схему «Старт заказа»");
    expect(within(logic).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["orders / api", "orders / worker", "billing"]);
    const spec = screen.getByLabelText("Куда перенести спецификацию");
    expect(within(spec).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["Не переносить", "orders", "billing (уже есть спецификация)"]);
    // По умолчанию — первый контейнер без своей спецификации.
    expect(spec).toHaveValue("orders");
    expect(screen.getByText("3 параметра")).toBeInTheDocument();
    const params = screen.getByLabelText("Куда перенести конфигурацию");
    expect(within(params).getAllByRole("option").map((o) => o.textContent))
      .toEqual(["Не переносить", "orders", "billing"]);

    await userEvent.selectOptions(logic, "billing");
    await userEvent.selectOptions(params, "billing");
    await userEvent.click(screen.getByRole("button", { name: "Перенести" }));
    await waitFor(() => expect(nodeDocsApi.distribute).toHaveBeenCalledWith(ROOT, {
      doc_assignments: [{ doc_id: "d1", child_id: "billing" }],
      spec_child_id: "orders",
      params_target_id: "billing",
    }));
    expect(onApplied).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("у контейнера с компонентами — только схемы логики", async () => {
    open(n(ROOT, {
      name: "orders", has_children: true, element: "container", element_effective: "container",
      docs: [doc("d1", "Старт заказа")], openapi_spec: "openapi: 3.0.0",
    }));
    expect(await screen.findByText("Схемы логики описывают код, и их место у компонентов.")).toBeInTheDocument();
    expect(screen.getByText("Схемы логики")).toBeInTheDocument();
    expect(screen.queryByText("Спецификация")).not.toBeInTheDocument();
    expect(screen.queryByText("Конфигурация")).not.toBeInTheDocument();
  });

  it("отказ сервера — текстом под формой, окно открыто", async () => {
    vi.mocked(nodeDocsApi.distribute).mockRejectedValue(new ApiError(409, "У «orders / api» уже есть схема «Старт заказа»"));
    const { onApplied } = open(n(ROOT, {
      name: "Ярмарка", has_children: true, element_effective: "system", docs: [doc("d1", "Старт заказа")],
    }));
    await userEvent.click(await screen.findByRole("button", { name: "Перенести" }));
    expect(await screen.findByText("У «orders / api» уже есть схема «Старт заказа»")).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe("окно «Собрать с компонентов»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.collectFacts).mockResolvedValue({ moved_params: 3, spec_moved: true });
  });

  const preview: CollectFactsPreview = {
    components: [
      { node_id: "api", name: "api", params: 2, has_spec: true },
      { node_id: "checkout", name: "checkout", params: 1, has_spec: true },
    ],
    param_clashes: [{
      name: "FEATURE_NEW_CHECKOUT",
      candidates: [
        { node_id: "api", node_name: "api", description: "включает новый расчёт корзины" },
        { node_id: "checkout", node_name: "checkout", description: null },
      ],
    }],
    specs: [{ node_id: "api", name: "api" }, { node_id: "checkout", name: "checkout" }],
  };

  it("коллизия имён и несколько спецификаций — выбор уходит в запрос", async () => {
    const onApplied = vi.fn();
    render(<CollectFactsModal nodeId="orders" nodeName="orders" preview={preview} onClose={vi.fn()} onApplied={onApplied} />);
    expect(screen.getByText(/Параметры и спецификации компонентов переедут в «orders»\./)).toBeInTheDocument();
    expect(screen.getByText("api · 2 параметра, спецификация")).toBeInTheDocument();
    expect(screen.getByText("checkout · 1 параметр, спецификация")).toBeInTheDocument();
    expect(screen.getByText("Одинаковые имена: FEATURE_NEW_CHECKOUT у api и checkout. Какое описание оставить?")).toBeInTheDocument();
    expect(screen.getByLabelText("api: «включает новый расчёт корзины»")).toBeChecked();
    await userEvent.click(screen.getByLabelText("checkout: без описания"));
    expect(screen.getByText("Спецификаций несколько. Какую отдать «orders»?")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("checkout"));

    await userEvent.click(screen.getByRole("button", { name: "Собрать" }));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledWith("orders", {
      param_choices: [{ name: "FEATURE_NEW_CHECKOUT", node_id: "checkout" }],
      spec_from: "checkout",
    }));
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it("«Не переносить» спецификацию — без spec_from; одна спецификация компонента — без вопроса", async () => {
    const { unmount } = render(
      <CollectFactsModal nodeId="orders" nodeName="orders" preview={preview} onClose={vi.fn()} onApplied={vi.fn()} />,
    );
    await userEvent.click(screen.getByLabelText("Не переносить"));
    await userEvent.click(screen.getByRole("button", { name: "Собрать" }));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledWith("orders", {
      param_choices: [{ name: "FEATURE_NEW_CHECKOUT", node_id: "api" }],
    }));
    unmount();

    vi.mocked(nodesApi.collectFacts).mockClear();
    render(<CollectFactsModal
      nodeId="orders" nodeName="orders" onClose={vi.fn()} onApplied={vi.fn()}
      preview={{ components: [preview.components[0]], param_clashes: [], specs: [preview.specs[0]] }}
    />);
    expect(screen.queryByText(/Спецификаций несколько/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Собрать" }));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledWith("orders", {
      param_choices: [], spec_from: "api",
    }));
  });
});
