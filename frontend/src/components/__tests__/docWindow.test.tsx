// Страховочная сетка окна документа (схема логики и спецификация, DocOverlay) перед
// переводом каркаса и стадии чтения на новый язык (редизайн, фаза 7а). Тесты держатся за
// поведение, которое переживает переделку: Escape в чтении закрывает окно, а при открытом
// меню «Изменить» только меню; читатель показывает и прячет код; стадии «Вручную» и «Через
// ИИ-агента» на месте и возвращают к чтению; переход в процесс из строки под схемой.
// Написаны на прежнем окне и зелёные на нём.
//
// Окно настоящее (DocOverlay, FlowchartDocs, FlowchartView, FlowchartDoc, OpenApiPane,
// OpenApiDoc, настоящий Modal: test-setup открывает <dialog> атрибутом open). Замоканы сеть,
// mermaid, Swagger UI и панели пакета агента.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DocOverlay from "../inspector/DocOverlay";
import { nodeDocsApi } from "../../api/nodes";
import type { NodeDoc } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodeDocsApi: {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    usage: vi.fn(() => Promise.resolve([])),
  },
  nodesApi: { get: vi.fn() },
}));
vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn(() => Promise.resolve([])) } }));
vi.mock("../../api/docsImport", () => ({ docsImportApi: { prompt: vi.fn() } }));
vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div>,
}));
vi.mock("../OpenApiViewer", () => ({
  default: ({ spec }: { spec: { info?: { title?: string } } }) => (
    <div data-testid="swagger">{spec.info?.title ?? "без заголовка"}</div>
  ),
}));
vi.mock("../docsImport/SpecAgentPanel", () => ({ default: () => <div data-testid="spec-panel" /> }));

const doc = (over: Partial<NodeDoc> = {}): NodeDoc => ({
  id: "d1", node_id: "n1", name: "Создание заказа", kind: "operation", operation: "POST /orders",
  content: "graph TD\n  A[Принять] --> B[Сохранить]", version: 1, ...over,
} as NodeDoc);

const SPEC = "openapi: 3.0.3\ninfo:\n  title: Order API\n  version: 1.0.0\npaths: {}\n";

const base = {
  nodeId: "n1",
  nodeName: "Order API",
  onDocEvent: vi.fn(),
  onCommitOpenapi: vi.fn(() => Promise.resolve(true)),
};

const dlg = () => document.querySelector("dialog") as HTMLDialogElement;
const codeField = () => document.querySelector("textarea.doc-edta") as HTMLTextAreaElement | null;
// Escape у нативного <dialog> приходит событием cancel (jsdom его по клавише не шлёт).
const cancel = () => fireEvent(dlg(), new Event("cancel", { cancelable: true }));

function openFlow(props: { isArchitect?: boolean; onClose?: () => void; onOpenProcess?: (id: string) => void } = {}) {
  render(
    <DocOverlay
      {...base}
      mode="flowchart"
      isArchitect={props.isArchitect ?? true}
      initialDocId="d1"
      onClose={props.onClose ?? vi.fn()}
      onOpenProcess={props.onOpenProcess}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodeDocsApi.list).mockResolvedValue([doc()]);
  vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
});

describe("окно схемы логики: чтение", () => {
  it("Escape в чтении закрывает окно", async () => {
    const onClose = vi.fn();
    openFlow({ onClose });
    await screen.findByTestId("mmd");
    cancel();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape при открытом меню «Изменить» закрывает только меню", async () => {
    const onClose = vi.fn();
    openFlow({ onClose });
    const edit = await screen.findByRole("button", { name: "Изменить" });
    await userEvent.click(edit);
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Вручную", "Через ИИ-агента"]);
    // Клавиша погашена: нативный <dialog> не получит cancel и не закроется.
    expect(fireEvent.keyDown(edit, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("читатель: «Показать код» даёт код только для чтения, «Скрыть код» убирает; «Изменить» нет", async () => {
    openFlow({ isArchitect: false });
    await screen.findByTestId("mmd");
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(codeField()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Показать код" }));
    expect(codeField()).toHaveAttribute("readonly");
    await userEvent.click(screen.getByRole("button", { name: "Скрыть код" }));
    expect(codeField()).toBeNull();
  });

  it("строка под схемой ведёт в процесс", async () => {
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([
      { doc_id: "d1", process_id: "p1", process_name: "Оформление заказа", steps: 2 },
    ]);
    const onOpenProcess = vi.fn();
    openFlow({ onOpenProcess });
    await userEvent.click(await screen.findByRole("button", { name: "Оформление заказа" }));
    expect(onOpenProcess).toHaveBeenCalledWith("p1");
  });
});

describe("окно схемы логики: стадии правки на месте", () => {
  it("«Вручную»: поля, код, превью, «Удалить схему»; «Отмена» — к чтению", async () => {
    openFlow();
    await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
    expect(screen.getByLabelText("Имя схемы")).toHaveValue("Создание заказа");
    expect(screen.getByLabelText("Вид")).toBeInTheDocument();
    expect(screen.getByLabelText("Эндпоинт")).toHaveValue("POST /orders");
    expect(codeField()).not.toBeNull();
    expect(codeField()).not.toHaveAttribute("readonly");
    expect(screen.getByTestId("mmd")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить схему" })).toBeInTheDocument();
    // Подпись подвала «Превью обновляется сразу» убрана (редизайн, фаза 7б).
    expect(screen.queryByText("Превью обновляется сразу")).toBeNull();
    // Главная кнопка первой, «Отмена» за ней.
    const save = screen.getByRole("button", { name: "Сохранить" });
    const back = screen.getByRole("button", { name: "Отмена" });
    expect(save.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(back);
    expect(codeField()).toBeNull();
    expect(screen.getByRole("button", { name: "Изменить" })).toBeInTheDocument();
  });

  it("«Через ИИ-агента»: задание и зона файлов, без примечания подвала; «Отмена» — к чтению", async () => {
    openFlow();
    await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
    expect(screen.getByRole("button", { name: "Скопировать задание" })).toBeInTheDocument();
    expect(screen.getByText("Перетащите сюда файл схемы от агента")).toBeInTheDocument();
    // Примечание подвала убрано (редизайн, фаза 7в).
    expect(screen.queryByText("Схема не изменится, пока вы не нажмёте «Применить»")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByText("Перетащите сюда файл схемы от агента")).toBeNull();
    expect(screen.getByTestId("mmd")).toBeInTheDocument();
  });

  it("несохранённая правка: крестик спрашивает, Escape возвращает к правке", async () => {
    const onClose = vi.fn();
    openFlow({ onClose });
    await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
    fireEvent.change(codeField()!, { target: { value: "graph TD\n  правка" } });
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    const ask = screen.getByRole("alertdialog", { name: "Закрыть без сохранения?" });
    expect(within(ask).getAllByRole("button").map((b) => b.textContent)).toEqual(["Вернуться к правке", "Закрыть"]);
    cancel();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(codeField()!.value).toContain("правка");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("окно спецификации", () => {
  function openSpec(isArchitect: boolean) {
    render(<DocOverlay {...base} mode="openapi" openapi={SPEC} isArchitect={isArchitect} onClose={vi.fn()} />);
  }

  it("читатель: Swagger и «Показать код»; правки нет", async () => {
    openSpec(false);
    expect(screen.getByTestId("swagger")).toHaveTextContent("Order API");
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Показать код" }));
    expect(codeField()).toHaveAttribute("readonly");
  });

  it("«Вручную» и «Через ИИ-агента» на месте и возвращают к чтению", async () => {
    openSpec(true);
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
    expect(codeField()).not.toHaveAttribute("readonly");
    // Примечание подвала убрано (редизайн, фаза 7б).
    expect(screen.queryByText(/Спецификацию с ошибкой можно сохранить как черновик/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(codeField()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
    expect(screen.getByTestId("spec-panel")).toBeInTheDocument();
    expect(screen.getByText("Спецификация не изменится, пока вы не нажмёте «Применить»")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "← К спецификации" }));
    expect(screen.getByTestId("swagger")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("spec-panel")).toBeNull());
  });
});
