// Рендер-тесты FlowchartDocs — окна ОДНОЙ схемы логики (вьюер v2,
// docs/tasks/doc-viewer-v2.md): просмотр, «Изменить ▾» (Вручную | Через ИИ-агента),
// явное сохранение, новая схема только по «Сохранить», заглушка с «Описать ▾»,
// строка «Используется в процессах». Тяжёлый редактор FlowchartDoc (mermaid) и
// панель агента замоканы — тестируем стадии окна и CRUD-оркестрацию.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import FlowchartDocs from "../inspector/FlowchartDocs";
import { nodeDocsApi } from "../../api/nodes";
import { docsImportApi } from "../../api/docsImport";
import { ApiError } from "../../api/client";
import type { NodeDoc } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodeDocsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    usage: vi.fn(),
  },
}));
vi.mock("../../api/docsImport", () => ({ docsImportApi: { prompt: vi.fn() } }));
vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn(() => Promise.resolve([])) } }));

// Редактор схемы: показывает текст, роль (правка/просмотр) и умеет прислать черновик.
vi.mock("../inspector/FlowchartDoc", () => ({
  default: ({ initial, isArchitect, showCode, onDraft }: {
    initial: string; isArchitect: boolean; showCode: boolean; onDraft?: (v: string) => void;
  }) => (
    <div data-testid="doc-editor" data-edit={String(isArchitect)} data-code={String(showCode)}>
      {initial}
      {onDraft && <button onClick={() => onDraft("graph TD\n  новое")}>набрать</button>}
    </div>
  ),
}));
// Панель пакета агента: какую схему обновляет и кнопка «применить».
vi.mock("../docsImport/DocsAgentPanel", () => ({
  default: ({ mode, onApplied }: { mode: { kind: string; docName?: string }; onApplied: (more: boolean) => void }) => (
    <div data-testid="agent-panel" data-doc={mode.docName ?? ""}>
      <button onClick={() => onApplied(false)}>применить-пакет</button>
    </div>
  ),
}));

function doc(id: string, over: Partial<NodeDoc> = {}): NodeDoc {
  return {
    id,
    node_id: "n1",
    name: `Схема ${id}`,
    kind: "operation",
    operation: null,
    content: `content-${id}`,
    version: 1,
    ...over,
  } as NodeDoc;
}

const props = { nodeId: "n1", nodeName: "Заказы", onDocEvent: vi.fn(), onClose: vi.fn() };

async function открытьВручную() {
  await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
}

describe("FlowchartDocs · просмотр", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
  });

  it("открывается на схеме по клику: только она, без переключателя и «+ Схема»", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1"), doc("d2", { content: "целевой" })]);
    render(<FlowchartDocs {...props} isArchitect initialDocId="d2" />);
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toHaveTextContent("целевой"));
    // Просмотр: рендер без редактора кода.
    expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "false");
    expect(screen.getByText("Схема d2")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /схема/i })).toBeNull();
  });

  it("архитектору «Изменить» раскрывает «Вручную» и «Через ИИ-агента»", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1")]);
    render(<FlowchartDocs {...props} isArchitect initialDocId="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    const пункты = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(пункты).toEqual(["Вручную", "Через ИИ-агента"]);
  });

  it("наблюдателю кнопки правки нет, «Показать код» остаётся", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1")]);
    render(<FlowchartDocs {...props} isArchitect={false} initialDocId="d1" />);
    await screen.findByTestId("doc-editor");
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Показать код" }));
    expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-code", "true");
    expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "false");
  });

  it("строка «Используется в процессах» только про эту схему; клик ведёт в процесс", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1"), doc("d2")]);
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([
      { doc_id: "d1", process_id: "p1", process_name: "Оформление заказа", steps: 2 },
      { doc_id: "d2", process_id: "p2", process_name: "Возврат", steps: 1 },
    ]);
    const onOpenProcess = vi.fn();
    render(<FlowchartDocs {...props} isArchitect initialDocId="d1" onOpenProcess={onOpenProcess} />);
    await userEvent.click(await screen.findByRole("button", { name: "Оформление заказа" }));
    expect(onOpenProcess).toHaveBeenCalledWith("p1");
    expect(screen.queryByText("Возврат")).toBeNull();
  });
});

describe("FlowchartDocs · «Вручную»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
  });

  it("поля схемы сверху; эндпоинт только у операции", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1", { operation: "POST /orders" })]);
    render(<FlowchartDocs {...props} isArchitect initialDocId="d1" />);
    await открытьВручную();
    expect(screen.getByLabelText("Имя схемы")).toHaveValue("Схема d1");
    expect(screen.getByLabelText("Эндпоинт")).toHaveValue("POST /orders");
    expect(screen.getByLabelText("Эндпоинт")).toHaveAttribute("placeholder", "POST /orders");
    expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "true");
    await userEvent.selectOptions(screen.getByLabelText("Вид"), "worker");
    expect(screen.queryByLabelText("Эндпоинт")).toBeNull();
  });

  it("«Сохранить» пишет всё разом: один PATCH, одно событие edit, назад к просмотру", async () => {
    const d1 = doc("d1");
    const saved = doc("d1", { name: "Новое имя", content: "graph TD\n  новое", version: 2 });
    vi.mocked(nodeDocsApi.list).mockResolvedValue([d1]);
    vi.mocked(nodeDocsApi.update).mockResolvedValue(saved);
    const onDocEvent = vi.fn();
    render(<FlowchartDocs {...props} onDocEvent={onDocEvent} isArchitect initialDocId="d1" />);
    await открытьВручную();

    const имя = screen.getByLabelText("Имя схемы");
    await userEvent.clear(имя);
    await userEvent.type(имя, "Новое имя");
    // Уход фокуса больше ничего не пишет: сохранение только явное.
    await userEvent.click(screen.getByText("набрать"));
    expect(nodeDocsApi.update).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(nodeDocsApi.update).toHaveBeenCalledTimes(1));
    expect(nodeDocsApi.update).toHaveBeenCalledWith("n1", "d1", {
      name: "Новое имя", content: "graph TD\n  новое", base_version: 1,
    });
    expect(onDocEvent).toHaveBeenCalledTimes(1);
    expect(onDocEvent).toHaveBeenCalledWith({ type: "edit", nodeId: "n1", before: d1, after: saved });
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "false"));
  });

  it("без правок «Сохранить» просто возвращает к просмотру", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1")]);
    const onDocEvent = vi.fn();
    render(<FlowchartDocs {...props} onDocEvent={onDocEvent} isArchitect initialDocId="d1" />);
    await открытьВручную();
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(nodeDocsApi.update).not.toHaveBeenCalled();
    expect(onDocEvent).not.toHaveBeenCalled();
    expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "false");
  });

  it("«Отмена» отбрасывает черновик: ни запроса, ни события", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1")]);
    const onDocEvent = vi.fn();
    render(<FlowchartDocs {...props} onDocEvent={onDocEvent} isArchitect initialDocId="d1" />);
    await открытьВручную();
    await userEvent.click(screen.getByText("набрать"));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(nodeDocsApi.update).not.toHaveBeenCalled();
    expect(onDocEvent).not.toHaveBeenCalled();
    expect(screen.getByTestId("doc-editor")).toHaveTextContent("content-d1");
    // Повторный вход — поля снова из схемы, а не из брошенного черновика.
    await открытьВручную();
    expect(screen.getByLabelText("Имя схемы")).toHaveValue("Схема d1");
  });

  it("занятое имя ловится до запроса, черновик остаётся", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1"), doc("d2")]);
    render(<FlowchartDocs {...props} isArchitect initialDocId="d1" />);
    await открытьВручную();
    const имя = screen.getByLabelText("Имя схемы");
    await userEvent.clear(имя);
    await userEvent.type(имя, "Схема d2");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(screen.getByText("Схема с таким именем уже есть у узла")).toBeInTheDocument();
    expect(nodeDocsApi.update).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Имя схемы")).toHaveValue("Схема d2");
  });

  it("409 при сохранении: detail в баннере, свежие данные, окно в просмотре", async () => {
    vi.mocked(nodeDocsApi.list)
      .mockResolvedValueOnce([doc("d1")])
      .mockResolvedValueOnce([doc("d1", { content: "свежее", version: 4 })]);
    vi.mocked(nodeDocsApi.update).mockRejectedValue(new ApiError(409, "Схема изменена в другой сессии"));
    render(<FlowchartDocs {...props} isArchitect initialDocId="d1" />);
    await открытьВручную();
    await userEvent.click(screen.getByText("набрать"));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Схема изменена в другой сессии")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toHaveTextContent("свежее"));
    expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "false");
  });

  it("удаление в подвале: «Удалить схему» → «Точно удалить?», событие и закрытие окна", async () => {
    const d1 = doc("d1");
    vi.mocked(nodeDocsApi.list).mockResolvedValue([d1]);
    vi.mocked(nodeDocsApi.delete).mockResolvedValue(undefined);
    const onDocEvent = vi.fn();
    const onClose = vi.fn();
    render(<FlowchartDocs {...props} onDocEvent={onDocEvent} onClose={onClose} isArchitect initialDocId="d1" />);
    await открытьВручную();
    await userEvent.click(screen.getByRole("button", { name: "Удалить схему" }));
    await userEvent.click(screen.getByRole("button", { name: "Точно удалить?" }));
    await waitFor(() => expect(nodeDocsApi.delete).toHaveBeenCalledWith("n1", "d1"));
    expect(onDocEvent).toHaveBeenCalledWith({ type: "delete", nodeId: "n1", doc: d1 });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("FlowchartDocs · новая схема", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
  });

  it("открывается сразу в «Вручную»; создаётся только по «Сохранить»", async () => {
    const created = doc("new", { name: "Новая схема", content: "graph TD\n  новое" });
    vi.mocked(nodeDocsApi.list).mockResolvedValue([]);
    vi.mocked(nodeDocsApi.create).mockResolvedValue(created);
    const onDocEvent = vi.fn();
    render(<FlowchartDocs {...props} onDocEvent={onDocEvent} isArchitect createNew />);
    expect(await screen.findByLabelText("Имя схемы")).toHaveValue("Новая схема");
    expect(nodeDocsApi.create).not.toHaveBeenCalled();
    // Удалять ещё нечего.
    expect(screen.queryByRole("button", { name: "Удалить схему" })).toBeNull();

    await userEvent.click(screen.getByText("набрать"));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(nodeDocsApi.create).toHaveBeenCalledWith("n1", {
      name: "Новая схема", kind: "operation", operation: null, content: "graph TD\n  новое",
    }));
    expect(onDocEvent).toHaveBeenCalledWith({ type: "create", nodeId: "n1", doc: created });
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "false"));
  });

  it("«Отмена» новой схемы закрывает окно и ничего не оставляет", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1", { name: "Новая схема" })]);
    const onClose = vi.fn();
    render(<FlowchartDocs {...props} onClose={onClose} isArchitect createNew />);
    // Имя по умолчанию не занимает чужое.
    expect(await screen.findByLabelText("Имя схемы")).toHaveValue("Новая схема 2");
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(nodeDocsApi.create).not.toHaveBeenCalled();
  });
});

describe("FlowchartDocs · неописанная схема", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
  });

  it("операция: пустое состояние и «Описать» с тем же меню", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1", { content: "", operation: "GET /orders" })]);
    render(<FlowchartDocs {...props} isArchitect initialDocId="d1" />);
    expect(await screen.findByText("Эта операция ещё не описана")).toBeInTheDocument();
    expect(screen.getByText("Она попала в список операций сервиса, но схемы логики у неё пока нет.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Описать" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Вручную" }));
    expect(screen.getByLabelText("Эндпоинт")).toHaveValue("GET /orders");
  });

  it("воркер — свои слова; читателю кнопки нет", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1", { content: "", kind: "worker" })]);
    render(<FlowchartDocs {...props} isArchitect={false} initialDocId="d1" />);
    expect(await screen.findByText("Этот воркер ещё не описан")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Описать" })).toBeNull();
  });
});

describe("FlowchartDocs · «Через ИИ-агента»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.usage).mockResolvedValue([]);
  });

  it("шаги слева, промпт нацелен на эндпоинт, «← К схеме» возвращает", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1", { name: "Оформление", operation: "POST /orders" })]);
    vi.mocked(docsImportApi.prompt).mockResolvedValue({ prompt: "промпт" });
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<FlowchartDocs {...props} isArchitect initialDocId="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));

    expect(screen.getByText(/Запустите агента с этим промптом в репозитории сервиса «Заказы»/)).toBeInTheDocument();
    expect(screen.getByText("Перетащите файл, который вернёт агент, в поле справа.")).toBeInTheDocument();
    expect(screen.getByTestId("agent-panel")).toHaveAttribute("data-doc", "Оформление");

    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));
    await waitFor(() => expect(docsImportApi.prompt).toHaveBeenCalled());
    expect(vi.mocked(docsImportApi.prompt).mock.calls[0][0]).toMatchObject({
      nodeId: "n1", include: "logic", target: "POST /orders", variant: "orchestrated",
    });

    await userEvent.click(screen.getByRole("button", { name: "← К схеме" }));
    expect(screen.getByTestId("doc-editor")).toHaveAttribute("data-edit", "false");
  });

  it("у воркера адрес промпта — имя схемы", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc("d1", { name: "email_senders", kind: "worker", content: "" })]);
    vi.mocked(docsImportApi.prompt).mockResolvedValue({ prompt: "промпт" });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
    render(<FlowchartDocs {...props} isArchitect initialDocId="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Описать" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));
    await waitFor(() => expect(docsImportApi.prompt).toHaveBeenCalled());
    expect(vi.mocked(docsImportApi.prompt).mock.calls[0][0].target).toBe("email_senders");
  });

  it("после «Применить» окно перечитывает схему и показывает просмотр", async () => {
    vi.mocked(nodeDocsApi.list)
      .mockResolvedValueOnce([doc("d1", { content: "" })])
      .mockResolvedValueOnce([doc("d1", { content: "от агента", version: 2 })]);
    const onApplied = vi.fn();
    render(<FlowchartDocs {...props} onApplied={onApplied} isArchitect initialDocId="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Описать" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
    await userEvent.click(screen.getByText("применить-пакет"));
    await waitFor(() => expect(screen.getByTestId("doc-editor")).toHaveTextContent("от агента"));
    expect(onApplied).toHaveBeenCalledOnce();
    expect(nodeDocsApi.list).toHaveBeenCalledTimes(2);
  });
});
