// «Перенести документацию» и «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»):
// получатели по семьям фактов приходят превью сервера (флаги и путь от узла), окно их
// только показывает; параметры одному контейнеру, сбор с одноимёнными параметрами и
// несколькими спецификациями. Оба окна исполняются по-настоящему, подменён только транспорт.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TransferDocsModal from "../TransferDocsModal";
import CollectFactsModal from "../CollectFactsModal";
import { collectLine } from "../element/transferDocs";
import { nodeDocsApi, nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { CollectFactsPreview, TransferDocsPreview, TransferReceiver } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { transferPreview: vi.fn(), collectFacts: vi.fn() },
  nodeDocsApi: { distribute: vi.fn() },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в тестах других окон.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function receiver(path: string, over: Partial<TransferReceiver> = {}): TransferReceiver {
  return {
    node_id: path.split(" / ").pop() ?? path, path, element_effective: "container",
    takes_docs: false, takes_process_facts: false, has_spec: false, ...over,
  };
}

// Ярмарка (система) → orders (контейнер с компонентами: api, worker), billing (лист со
// своей спецификацией), orders-db (лист-база), Покупатель. Флаги — как их считает сервер.
const ROOT = "shop";
const receivers = [
  receiver("orders", { takes_process_facts: true }),
  receiver("orders / api", { element_effective: "component", takes_docs: true }),
  receiver("orders / worker", { element_effective: "component", takes_docs: true }),
  receiver("billing", { takes_docs: true, takes_process_facts: true, has_spec: true }),
  receiver("orders-db"),
  receiver("Покупатель", { element_effective: null }),
];

function preview(over: Partial<TransferDocsPreview> = {}): TransferDocsPreview {
  return {
    node_id: ROOT, name: "Ярмарка", element_effective: "system",
    docs: [{ doc_id: "d1", name: "Старт заказа", kind: "operation", operation: null }],
    has_spec: true, params: 3, receivers, ...over,
  };
}

describe("строки окна сбора", () => {
  it("строка компонента в окне сбора", () => {
    expect(collectLine({ node_id: "a", name: "api", params: 2, has_spec: true })).toBe("api · 2 параметра, спецификация");
    expect(collectLine({ node_id: "s", name: "scheduler", params: 1, has_spec: false })).toBe("scheduler · 1 параметр");
    expect(collectLine({ node_id: "c", name: "checkout", params: 0, has_spec: true })).toBe("checkout · спецификация");
  });
});

describe("окно «Перенести документацию»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.distribute).mockResolvedValue({ moved_docs: 1, spec_moved: true, moved_params: 3 });
  });

  function open(data: TransferDocsPreview | Error) {
    if (data instanceof Error) vi.mocked(nodesApi.transferPreview).mockRejectedValue(data);
    else vi.mocked(nodesApi.transferPreview).mockResolvedValue(data);
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(<TransferDocsModal nodeId={ROOT} onClose={onClose} onApplied={onApplied} />);
    return { onApplied, onClose };
  }

  it("у системы — три части, получатели по флагам превью в его порядке, параметры одному контейнеру", async () => {
    const { onApplied, onClose } = open(preview());
    expect(await screen.findByText("У системы своей документации нет. Выберите, куда перенести каждую часть.")).toBeInTheDocument();
    expect(nodesApi.transferPreview).toHaveBeenCalledWith(ROOT);

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
    open(preview({
      name: "orders", element_effective: "container",
      receivers: [receivers[1], receivers[2]],
    }));
    expect(await screen.findByText("Схемы логики описывают код, и их место у компонентов.")).toBeInTheDocument();
    expect(screen.getByText("Схемы логики")).toBeInTheDocument();
    expect(screen.queryByText("Спецификация")).not.toBeInTheDocument();
    expect(screen.queryByText("Конфигурация")).not.toBeInTheDocument();
  });

  it("никто не берёт схемы логики — «Внутри нет подходящего объекта»", async () => {
    open(preview({ has_spec: false, params: 0, receivers: [receivers[0], receivers[4]] }));
    expect(await screen.findByText("Внутри нет подходящего объекта.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Куда перенести схему «Старт заказа»")).not.toBeInTheDocument();
  });

  it("отказ превью 422 — текстом сервера, формы нет", async () => {
    open(new ApiError(422, "Внутри «billing» нет объектов, поэтому переносить документацию некуда."));
    expect(await screen.findByText("Внутри «billing» нет объектов, поэтому переносить документацию некуда.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Перенести" })).not.toBeInTheDocument();
  });

  it("сбой загрузки превью — общий текст", async () => {
    open(new ApiError(500, "Internal Server Error"));
    expect(await screen.findByText("Не удалось загрузить данные объекта.")).toBeInTheDocument();
  });

  it("отказ сервера при переносе — текстом под формой, окно открыто", async () => {
    vi.mocked(nodeDocsApi.distribute).mockRejectedValue(new ApiError(409, "У «orders / api» уже есть схема «Старт заказа»"));
    const { onApplied } = open(preview({ has_spec: false, params: 0 }));
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
