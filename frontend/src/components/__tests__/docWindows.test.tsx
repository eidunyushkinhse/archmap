// Страховка механики окон документации объекта (редизайн, фаза 9е): «Собрать с
// компонентов», «Перенести документацию» и ER-диаграмма во весь экран. Окна меняют вид, а
// не механику: тела запросов (строкой JSON), что предвыбрано и что заперто, вид после
// записи, закрытие. Тесты написаны на коде до перевода окон и зелёные на нём; локаторы не
// зависят от разметки (заголовок вопроса — по тексту заголовка 4-го уровня, кнопки подвала —
// по тексту, а не по имени: у крестика окна нового языка то же имя «Закрыть»).
//
// Уже покрыто в transferDocs.test.tsx (не дублируется): получатели в порядке превью,
// подписи списков, предвыбор спецификации, итог переноса и сбора, отказы превью и записи,
// отсутствие предвыбора в вопросах, выбор спецификации из просмотра. В
// DbStructureSection.test.tsx — открытие ER-диаграммы щелчком; в ErDiagramModal.test.tsx —
// высота сцены.
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CollectFactsModal from "../CollectFactsModal";
import TransferDocsModal from "../TransferDocsModal";
import ErDiagramModal from "../ErDiagramModal";
import { nodeDocsApi, nodesApi } from "../../api/nodes";
import type {
  CollectFactsOut, CollectFactsPreview, DistributeDocsOut, TransferDocsPreview, TransferReceiver,
} from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { transferPreview: vi.fn(), collectFacts: vi.fn(), get: vi.fn() },
  nodeDocsApi: { distribute: vi.fn() },
}));
// Нативный <dialog> в jsdom не открывается: окно — обёртка, а её onClose (Escape и крестик
// прежнего окна) запоминается, чтобы проверить, что окно отдаёт его наружу.
const modal = vi.hoisted(() => ({ onClose: null as (() => void) | null }));
vi.mock("../../ui/Modal", () => ({
  default: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => {
    modal.onClose = onClose;
    return <div>{children}</div>;
  },
}));
vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <pre data-testid="chart">{chart}</pre>,
}));

// Тело последнего вызова строкой JSON: порядок ключей и отсутствие лишних — часть контракта.
const bodyOf = (fn: (...args: never[]) => unknown): string => {
  const calls = vi.mocked(fn).mock.calls;
  return JSON.stringify(calls[calls.length - 1]);
};
// Кнопка с видимым текстом (кнопка-значок с тем же именем не в счёт).
const textButton = (text: string): HTMLElement => screen.getByText(text, { selector: "button" });
const noTextButton = (text: string): void => {
  expect(screen.queryByText(text, { selector: "button" })).toBeNull();
};
// Отложенный ответ сервера: окно видно в состоянии записи.
function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("«Собрать с компонентов»: механика", () => {
  const out: CollectFactsOut = {
    moved_params: 2, spec_moved: true, dropped_params: 0, dropped_specs: 1, left_params: [], left_specs: 0,
  };
  const preview: CollectFactsPreview = {
    components: [
      { node_id: "api", name: "api", params: 2, has_spec: true },
      { node_id: "outbox", name: "outbox", params: 1, has_spec: true },
    ],
    param_clashes: [{
      name: "DATABASE_URL", container_keeps: false,
      candidates: [
        { node_id: "api", node_name: "api", description: "адрес базы для api" },
        { node_id: "outbox", node_name: "outbox", description: null },
      ],
    }],
    specs: [{ node_id: "api", name: "api" }, { node_id: "outbox", name: "outbox" }],
    container_has_spec: false,
    single_spec_from: null,
  };
  const PARAM_Q = "Параметр «DATABASE_URL» описан у компонентов «api» и «outbox» по-разному. Чьё описание считаем верным?";
  const SPEC_Q = "Спецификация есть у компонентов «api» и «outbox». Чью считаем спецификацией контейнера «orders»?";

  // Вопрос по тексту заголовка: варианты ищутся в его контейнере.
  const question = (title: string): HTMLElement => {
    const h = screen.getAllByRole("heading", { level: 4 }).find((x) => x.textContent === title);
    if (!h?.parentElement) throw new Error(`нет вопроса «${title}»`);
    return h.parentElement;
  };
  const keep = (title: string) => within(question(title)).getByRole("button", { name: /^Оставить у компонентов/ });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.collectFacts).mockResolvedValue(out);
  });

  function open() {
    const onApplied = vi.fn();
    const onClose = vi.fn();
    const r = render(
      <CollectFactsModal nodeId="orders" nodeName="orders" preview={preview} onClose={onClose} onApplied={onApplied} />,
    );
    return { onApplied, onClose, unmount: r.unmount };
  }

  it("ответ «Оставить у компонентов» и отсутствие ответа дают одно и то же тело", async () => {
    const first = open();
    await userEvent.click(textButton("Собрать"));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledTimes(1));
    const silent = bodyOf(nodesApi.collectFacts);
    expect(silent).toBe(JSON.stringify(["orders", { param_choices: [] }]));
    first.unmount();

    open();
    // Сначала кандидат, потом «Оставить у компонентов»: ответ заменяется, кандидат не уходит.
    await userEvent.click(within(question(PARAM_Q)).getByRole("button", { name: /^api/ }));
    await userEvent.click(keep(PARAM_Q));
    await userEvent.click(within(question(SPEC_Q)).getByRole("button", { name: "outbox" }));
    await userEvent.click(keep(SPEC_Q));
    expect(keep(PARAM_Q)).toHaveAttribute("aria-pressed", "true");
    expect(keep(SPEC_Q)).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(textButton("Собрать"));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledTimes(2));
    expect(bodyOf(nodesApi.collectFacts)).toBe(silent);
  });

  it("ответы на оба вопроса вариантами: тело строкой JSON", async () => {
    open();
    await userEvent.click(within(question(PARAM_Q)).getByRole("button", { name: /^api/ }));
    await userEvent.click(within(question(SPEC_Q)).getByRole("button", { name: "outbox" }));
    expect(within(question(PARAM_Q)).getByRole("button", { name: /^api/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(question(SPEC_Q)).getByRole("button", { name: "outbox" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(textButton("Собрать"));
    await waitFor(() => expect(nodesApi.collectFacts).toHaveBeenCalledOnce());
    expect(bodyOf(nodesApi.collectFacts)).toBe(JSON.stringify(
      ["orders", { param_choices: [{ name: "DATABASE_URL", node_id: "api" }], spec_from: "outbox" }],
    ));
  });

  it("во время записи «Собираем» заперта, после записи — итог и одна «Закрыть»", async () => {
    const d = deferred<CollectFactsOut>();
    vi.mocked(nodesApi.collectFacts).mockReturnValue(d.promise);
    const { onApplied, onClose } = open();
    await userEvent.click(textButton("Собрать"));
    expect(textButton("Собираем")).toBeDisabled();
    expect(textButton("Отмена")).toBeEnabled();
    expect(onApplied).not.toHaveBeenCalled();

    d.resolve(out);
    expect(await screen.findByText("Собрано: 2 параметра, спецификация.")).toBeInTheDocument();
    expect(screen.getByText("Отброшено: 1 спецификация.")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledOnce();
    // Вопросов, строк компонентов и кнопок формы в итоге нет.
    expect(screen.queryAllByRole("heading", { level: 4 })).toEqual([]);
    expect(screen.queryByText(/outbox/)).toBeNull();
    noTextButton("Собрать");
    noTextButton("Собираем");
    noTextButton("Отмена");
    await userEvent.click(textButton("Закрыть"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("«Отмена» и закрытие окна зовут onClose, записи нет", async () => {
    const { onClose } = open();
    await userEvent.click(textButton("Отмена"));
    expect(onClose).toHaveBeenCalledTimes(1);
    modal.onClose?.();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(nodesApi.collectFacts).not.toHaveBeenCalled();
  });

  it("сбой чтения спецификации для просмотра — текстом, выбор не меняется", async () => {
    vi.mocked(nodesApi.get).mockRejectedValue(new Error("сеть"));
    open();
    await userEvent.click(within(question(SPEC_Q)).getAllByRole("button", { name: "Открыть" })[0]);
    expect(nodesApi.get).toHaveBeenCalledWith("api");
    expect(await screen.findByText("Не удалось открыть спецификацию")).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { pressed: true })).toEqual([]);
  });
});

describe("«Перенести документацию»: механика", () => {
  function receiver(path: string, over: Partial<TransferReceiver> = {}): TransferReceiver {
    return {
      node_id: path.split(" / ").pop() ?? path, path, element_effective: "container",
      takes_docs: false, takes_process_facts: false, has_spec: false, ...over,
    };
  }
  const receivers = [
    receiver("orders", { takes_process_facts: true }),
    receiver("orders / api", { element_effective: "component", takes_docs: true }),
    receiver("billing", { takes_docs: true, takes_process_facts: true, has_spec: true }),
  ];
  const preview: TransferDocsPreview = {
    node_id: "shop", name: "Ярмарка", element_effective: "system",
    docs: [
      { doc_id: "d1", name: "Старт заказа", kind: "operation", operation: null },
      { doc_id: "d2", name: "Выгрузка остатков", kind: "worker", operation: null },
    ],
    has_spec: true, params: 2, receivers,
  };
  const done: DistributeDocsOut = { moved_docs: 2, spec_moved: true, moved_params: 2 };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.transferPreview).mockResolvedValue(preview);
    vi.mocked(nodeDocsApi.distribute).mockResolvedValue(done);
  });

  function open() {
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(<TransferDocsModal nodeId="shop" onClose={onClose} onApplied={onApplied} />);
    return { onApplied, onClose };
  }

  it("пока превью не пришло — «Загружаем данные объекта»", async () => {
    const d = deferred<TransferDocsPreview>();
    vi.mocked(nodesApi.transferPreview).mockReturnValue(d.promise);
    open();
    expect(screen.getByText("Загружаем данные объекта")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    d.resolve(preview);
    expect(await screen.findByLabelText("Куда перенести спецификацию")).toBeInTheDocument();
    expect(screen.queryByText("Загружаем данные объекта")).toBeNull();
  });

  it("без правок — тело по предвыбору строкой JSON, вид схемы назван словом", async () => {
    open();
    await screen.findByLabelText("Куда перенести спецификацию");
    expect(screen.getByLabelText("Куда перенести схему «Старт заказа»")).toHaveValue("api");
    expect(screen.getByLabelText("Куда перенести схему «Выгрузка остатков»")).toHaveValue("api");
    expect(screen.getByLabelText("Куда перенести конфигурацию")).toHaveValue("orders");
    expect(screen.getByText("операция")).toBeInTheDocument();
    expect(screen.getByText("воркер")).toBeInTheDocument();
    expect(screen.getByTitle("Старт заказа")).toBeInTheDocument();
    await userEvent.click(textButton("Перенести"));
    await waitFor(() => expect(nodeDocsApi.distribute).toHaveBeenCalledOnce());
    expect(bodyOf(nodeDocsApi.distribute)).toBe(JSON.stringify(["shop", {
      doc_assignments: [{ doc_id: "d1", child_id: "api" }, { doc_id: "d2", child_id: "api" }],
      spec_child_id: "orders",
      params_target_id: "orders",
    }]));
  });

  it("«Не переносить» убирает часть из тела; запертый получатель спецификации не выбирается", async () => {
    open();
    const spec = await screen.findByLabelText("Куда перенести спецификацию");
    const locked = within(spec).getByRole("option", { name: "billing (уже есть спецификация)" });
    expect(locked).toBeDisabled();
    expect(within(spec).getByRole("option", { name: "orders" })).toBeEnabled();
    expect(within(spec).getByRole("option", { name: "Не переносить" })).toBeEnabled();
    // В конфигурации и схемах логики запертых пунктов нет.
    const params = screen.getByLabelText("Куда перенести конфигурацию");
    expect(within(params).getAllByRole("option").filter((o) => (o as HTMLOptionElement).disabled)).toEqual([]);
    expect(within(params).getByRole("option", { name: "billing" })).toBeEnabled();

    await userEvent.selectOptions(spec, "");
    await userEvent.selectOptions(params, "");
    await userEvent.selectOptions(screen.getByLabelText("Куда перенести схему «Выгрузка остатков»"), "billing");
    await userEvent.click(textButton("Перенести"));
    await waitFor(() => expect(nodeDocsApi.distribute).toHaveBeenCalledOnce());
    expect(bodyOf(nodeDocsApi.distribute)).toBe(JSON.stringify(["shop", {
      doc_assignments: [{ doc_id: "d1", child_id: "api" }, { doc_id: "d2", child_id: "billing" }],
    }]));
  });

  it("во время записи «Переносим» заперта, после записи — итог и одна «Закрыть»", async () => {
    const d = deferred<DistributeDocsOut>();
    vi.mocked(nodeDocsApi.distribute).mockReturnValue(d.promise);
    const { onApplied, onClose } = open();
    await screen.findByLabelText("Куда перенести спецификацию");
    await userEvent.click(textButton("Перенести"));
    expect(textButton("Переносим")).toBeDisabled();
    expect(textButton("Отмена")).toBeEnabled();
    d.resolve(done);
    expect(await screen.findByText("Перенесено: 2 схемы логики, спецификация, 2 параметра.")).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledOnce();
    expect(screen.queryByRole("combobox")).toBeNull();
    noTextButton("Перенести");
    noTextButton("Отмена");
    await userEvent.click(textButton("Закрыть"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("«Отмена» и закрытие окна зовут onClose, записи нет", async () => {
    const { onClose } = open();
    await screen.findByLabelText("Куда перенести спецификацию");
    await userEvent.click(textButton("Отмена"));
    expect(onClose).toHaveBeenCalledTimes(1);
    modal.onClose?.();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(nodeDocsApi.distribute).not.toHaveBeenCalled();
  });
});

describe("ER-диаграмма во весь экран: открытие и закрытие", () => {
  it("заголовок и диаграмма видны, крестик и закрытие окна зовут onClose", async () => {
    const onClose = vi.fn();
    render(<ErDiagramModal chart={'erDiagram\n  "orders" {\n  }'} title="Структура: БД заказов" onClose={onClose} />);
    expect(screen.getByRole("heading", { level: 2, name: "Структура: БД заказов" })).toBeInTheDocument();
    expect(screen.getByTestId("chart").textContent).toContain('"orders"');
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    modal.onClose?.();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
