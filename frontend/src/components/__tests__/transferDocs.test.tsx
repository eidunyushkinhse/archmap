// «Перенести документацию» и «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»):
// получатели по семьям фактов приходят превью сервера (флаги и путь от узла), окно их
// только показывает; параметры одному контейнеру. Сбор (решения владельца 2026-10-31):
// приоритет контейнера — строками-фактами, краевые случаи — вопросами в стиле разбора
// ввоза, без ответа — дефолт. Оба окна исполняются по-настоящему, подменён только транспорт.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TransferDocsModal from "../TransferDocsModal";
import CollectFactsModal from "../CollectFactsModal";
import { nodeDocsApi, nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type {
  CollectFactsOut, CollectFactsPreview, Node, TransferDocsPreview, TransferReceiver,
} from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { transferPreview: vi.fn(), collectFacts: vi.fn(), get: vi.fn() },
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
  const out = (over: Partial<CollectFactsOut> = {}): CollectFactsOut => ({
    moved_params: 3, spec_moved: false, dropped_params: 1, dropped_specs: 0,
    left_params: ["DATABASE_URL"], left_specs: 2, ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.collectFacts).mockResolvedValue(out());
  });

  const preview: CollectFactsPreview = {
    components: [
      { node_id: "api", name: "api", params: 2, has_spec: true },
      { node_id: "outbox", name: "outbox", params: 1, has_spec: true },
      { node_id: "worker", name: "worker", params: 1, has_spec: false },
    ],
    param_clashes: [
      {
        name: "DATABASE_URL", container_keeps: false,
        candidates: [
          { node_id: "api", node_name: "api", description: "адрес базы для api" },
          { node_id: "outbox", node_name: "outbox", description: null },
        ],
      },
      {
        name: "RETRY_TIMEOUT", container_keeps: true,
        candidates: [
          { node_id: "orders", node_name: "orders", description: "таймаут повтора" },
          { node_id: "worker", node_name: "worker", description: null },
        ],
      },
    ],
    specs: [{ node_id: "api", name: "api" }, { node_id: "outbox", name: "outbox" }],
    container_has_spec: false,
    single_spec_from: null,
  };

  const PARAM_Q = "Параметр «DATABASE_URL» описан у компонентов «api» и «outbox» по-разному. Чьё описание считаем верным?";
  const SPEC_Q = "Спецификация есть у компонентов «api» и «outbox». Чью считаем спецификацией контейнера «orders»?";
  // Блок вопроса по его заголовку: варианты ищутся внутри него.
  const block = (title: string): HTMLElement => {
    const el = screen.getByText(title).closest(".rq-block");
    if (!(el instanceof HTMLElement)) throw new Error(`нет блока вопроса «${title}»`);
    return el;
  };

  function open(p: CollectFactsPreview = preview) {
    const onApplied = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <CollectFactsModal nodeId="orders" nodeName="orders" preview={p} onClose={onClose} onApplied={onApplied} />,
    );
    return { onApplied, onClose, unmount };
  }

  it("факты строками, вопросы без предвыбора; «Собрать» без ответов — дефолт и итог", async () => {
    const { onApplied, onClose } = open();
    expect(screen.getByText("api · 2 параметра, спецификация")).toBeInTheDocument();
    expect(screen.getByText(
      "Параметр «RETRY_TIMEOUT» есть у контейнера — остаётся его описание, у компонента «worker» параметр будет отброшен",
    )).toBeInTheDocument();
    // По параметру с записью контейнера вопроса нет.
    expect(screen.queryByText(/Параметр «RETRY_TIMEOUT» описан/)).not.toBeInTheDocument();
    expect(screen.getByText(PARAM_Q)).toBeInTheDocument();
    expect(screen.getByText(SPEC_Q)).toBeInTheDocument();
    expect(within(block(PARAM_Q)).getByText(
      "Если не отвечать, то параметр останется у компонентов, рекомендация тоже останется.",
    )).toBeInTheDocument();
    expect(within(block(SPEC_Q)).getByText(
      "Если не отвечать, то спецификации останутся у компонентов, рекомендация тоже останется.",
    )).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { pressed: true })).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Собрать" }));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledWith("orders", { param_choices: [] }));
    expect(await screen.findByText("Собрано: 3 параметра.")).toBeInTheDocument();
    expect(screen.getByText("Отброшено: 1 параметр.")).toBeInTheDocument();
    expect(screen.getByText("Осталось у компонентов: параметр «DATABASE_URL», 2 спецификации.")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ответ по параметру уходит в param_choices, «как сейчас» по спецификации — без spec_from", async () => {
    open();
    await userEvent.click(within(block(PARAM_Q)).getByRole("button", { name: /^outbox/ }));
    expect(within(block(PARAM_Q)).getByRole("button", { name: /^outbox/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(block(SPEC_Q)).getByRole("button", { name: /Оставить у компонентов/ }));
    await userEvent.click(screen.getByRole("button", { name: "Собрать" }));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledWith("orders", {
      param_choices: [{ name: "DATABASE_URL", node_id: "outbox" }],
    }));
  });

  it("«Открыть» показывает спецификацию держателя, выбор — прямо из вьюера", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue(node("outbox", "openapi: 3.0.0\ninfo: outbox"));
    open();
    await userEvent.click(within(block(PARAM_Q)).getByRole("button", { name: /Оставить у компонентов/ }));
    await userEvent.click(within(block(SPEC_Q)).getAllByRole("button", { name: "Открыть" })[1]);
    expect(nodesApi.get).toHaveBeenCalledWith("outbox");
    expect(await screen.findByText(/info: outbox/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Выбрать этот вариант" }));
    expect(screen.queryByText(/info: outbox/)).not.toBeInTheDocument();
    expect(within(block(SPEC_Q)).getByRole("button", { name: "outbox" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Собрать" }));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledWith("orders", {
      param_choices: [], spec_from: "outbox",
    }));
  });

  it("своя спецификация контейнера и единственный держатель — фактом, без вопроса; отказ — под формой", async () => {
    vi.mocked(nodesApi.collectFacts).mockRejectedValue(
      new ApiError(422, "Для параметра «DATABASE_URL» выбран объект, у которого его нет."),
    );
    const { onApplied, unmount } = open({
      ...preview, param_clashes: [],
      specs: [{ node_id: "orders", name: "orders" }, ...preview.specs], container_has_spec: true,
    });
    expect(screen.getByText(
      "У контейнера есть своя спецификация — спецификации компонентов «api» и «outbox» будут отброшены",
    )).toBeInTheDocument();
    expect(screen.queryByText(SPEC_Q)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Собрать" }));
    expect(await screen.findByText("Для параметра «DATABASE_URL» выбран объект, у которого его нет.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Собрать" })).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    unmount();

    open({ ...preview, param_clashes: [], specs: [preview.specs[0]], single_spec_from: "api" });
    expect(screen.getByText("Спецификация компонента «api» переедет контейнеру")).toBeInTheDocument();
    expect(screen.queryByText(/Чью считаем спецификацией/)).not.toBeInTheDocument();
  });
});

function node(id: string, openapi_spec: string | null): Node {
  return {
    id, name: id, description: null, role: null, technology: null, parent_id: "orders",
    openapi_spec, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "component", container_name: "orders",
    version: 1, created_at: "2026-10-31T10:00:00Z", updated_at: "", sites: [],
  };
}
