// Стадия «Через ИИ-агента» окна документа (схема логики и спецификация): страховочная сетка
// перед переводом стадии на новый язык (редизайн, фаза 7в). Тесты держатся за поведение,
// которое переживает переделку: задание копируется с теми же параметрами; файл даёт превью
// с тем же запросом (у схемы имя этой схемы и перезапись, у спецификации overwrite и only
// "api"); «Применить» шлёт тот же запрос, и окно возвращается к чтению свежего содержимого;
// выход из стадии возвращает к чтению, Escape закрывает окно.
//
// Где стадия рисуется по-разному (подпись кнопки задания, кнопка выхода), вид спрятан в
// помощники ниже: сетка написана на прежней стадии и зелёная на ней. Окно настоящее
// (DocOverlay, FlowchartDocs, OpenApiPane, панели пакета, настоящий Modal: test-setup
// открывает <dialog> атрибутом open). Замоканы сеть, mermaid и Swagger UI.
//
// Тесты нового вида (фаза 7в) — в конце файла: малое окно семьи без шагов и примечаний,
// порядок кнопок подвала, отказ применения над кнопками, отчёт одной схемы, вставка
// текстом, замечания и неизменившийся вход, вход из карточки неописанной схемы.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DocOverlay from "../inspector/DocOverlay";
import { nodeDocsApi, nodesApi } from "../../api/nodes";
import { docsImportApi } from "../../api/docsImport";
import { ApiError } from "../../api/client";
import type { DocsImportReport, Node, NodeDoc } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodeDocsApi: {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    usage: vi.fn(() => Promise.resolve([])),
  },
  nodesApi: { get: vi.fn() },
}));
vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn(() => Promise.resolve([])) } }));
vi.mock("../../api/docsImport", () => ({
  docsImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
// Проверка Mermaid — ленивый чанк; в тестах схема всегда читается.
vi.mock("../mermaidLoader", () => ({ validateMermaid: vi.fn().mockResolvedValue(null) }));
vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div>,
}));
vi.mock("../OpenApiViewer", () => ({
  default: ({ spec }: { spec: { info?: { title?: string } } }) => (
    <div data-testid="swagger">{spec.info?.title ?? "без заголовка"}</div>
  ),
}));

const WAIT = { timeout: 3000 };

const doc = (over: Partial<NodeDoc> = {}): NodeDoc => ({
  id: "d1", node_id: "n1", name: "Создание заказа", kind: "operation", operation: "POST /orders",
  content: "graph TD\n  A[Принять] --> B[Сохранить]", version: 1, ...over,
} as NodeDoc);

const SPEC = (title: string) => `openapi: 3.0.3\ninfo:\n  title: ${title}\n  version: 1.0.0\npaths: {}\n`;
const MMD = "%% archmap-name: Приём\ngraph TD\n  A[От агента] --> B[Готово]\n";

const logicReport = (over: Partial<DocsImportReport> = {}): DocsImportReport => ({
  logic: [{
    node_path: "Ярмарка / Заказы / Order API", source: "a.mmd", name: "Создание заказа",
    kind: "operation", operation: "POST /orders", action: "overwrite", mermaid: MMD,
  }],
  specs: [], errors: [], warnings: [], conflicts: [], applied: false,
  created_docs: 0, filled_docs: 0, updated_docs: 0, specs_written: 0,
  data_refs_total: 0, channel_refs_total: 0, ...over,
});

const specReport = (over: Partial<DocsImportReport> = {}): DocsImportReport => ({
  logic: [],
  specs: [{
    node_path: "Ярмарка / Заказы / Order API", source: "openapi.yaml", origin: "found",
    action: "overwrite", valid_yaml: true, looks_openapi: true, oas_version: "3.0.3",
  }],
  errors: [], warnings: [], conflicts: [], applied: false,
  created_docs: 0, filled_docs: 0, updated_docs: 0, specs_written: 0,
  data_refs_total: 0, channel_refs_total: 0, ...over,
});

const base = {
  nodeId: "n1",
  nodeName: "Order API",
  onDocEvent: vi.fn(),
  onCommitOpenapi: vi.fn(() => Promise.resolve(true)),
};

// ── помощники вида ───────────────────────────────────────────────────────────
const кнопкаЗадания = () => screen.getByRole("button", { name: /^Скопировать (промпт|задание)$/ });
const выход = () => screen.getByRole("button", { name: /^(← К схеме|← К спецификации|Отмена)$/ });
const fileInput = () => document.querySelector("dialog input[type=file]") as HTMLInputElement;
const dlg = () => document.querySelector("dialog") as HTMLDialogElement;
// Escape у нативного <dialog> приходит событием cancel (jsdom его по клавише не шлёт).
const cancel = () => fireEvent(dlg(), new Event("cancel", { cancelable: true }));

function clipboard() {
  const writeText = vi.fn((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

async function стадияСхемы(over: { onClose?: () => void; onApplied?: () => void } = {}) {
  render(
    <DocOverlay
      {...base}
      mode="flowchart"
      isArchitect
      initialDocId="d1"
      onClose={over.onClose ?? vi.fn()}
      onApplied={over.onApplied}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Изменить" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
}

async function стадияСпецификации(openapi: string, over: { onClose?: () => void; onApplied?: () => void } = {}) {
  render(
    <DocOverlay
      {...base}
      mode="openapi"
      openapi={openapi}
      isArchitect
      initialStage={openapi ? undefined : "agent"}
      onClose={over.onClose ?? vi.fn()}
      onApplied={over.onApplied}
    />,
  );
  if (openapi) {
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
  }
}

describe("стадия агента у схемы логики", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc()]);
  });

  it("задание нацелено на эндпоинт схемы, текст уходит в буфер", async () => {
    vi.mocked(docsImportApi.prompt).mockResolvedValue({ prompt: "задание схемы" });
    const writeText = clipboard();
    await стадияСхемы();
    await userEvent.click(кнопкаЗадания());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("задание схемы"));
    expect(vi.mocked(docsImportApi.prompt).mock.calls).toEqual([[{
      nodeId: "n1", include: "logic", lang: "ru", hints: "", target: "POST /orders", variant: "orchestrated",
    }]]);
  });

  it("файл даёт превью этой схемы; «Применить» шлёт тот же запрос; окно читает свежую схему", async () => {
    vi.mocked(nodeDocsApi.list)
      .mockResolvedValueOnce([doc()])
      .mockResolvedValueOnce([doc({ content: "graph TD\n  X[Свежая]", version: 2 })]);
    vi.mocked(docsImportApi.preview).mockResolvedValue(logicReport());
    vi.mocked(docsImportApi.apply).mockResolvedValue(logicReport({ applied: true, updated_docs: 1 }));
    const onApplied = vi.fn();
    await стадияСхемы({ onApplied });

    await userEvent.upload(fileInput(), new File([MMD], "a.mmd"));
    await waitFor(() => expect(docsImportApi.preview).toHaveBeenCalled(), WAIT);
    const sent = {
      files: [{ name: "a.mmd", content: MMD }], overwrite: true, only: "logic", nodeId: "n1",
      overrides: [{ file: "a.mmd", name: "Создание заказа" }],
    };
    expect(vi.mocked(docsImportApi.preview).mock.calls.at(-1)![0]).toEqual(sent);
    expect(await screen.findByText("Схема «Создание заказа» будет обновлена", {}, WAIT)).toBeInTheDocument();

    const apply = screen.getByRole("button", { name: "Применить" });
    await waitFor(() => expect(apply).toBeEnabled());
    await userEvent.click(apply);
    await waitFor(() => expect(docsImportApi.apply).toHaveBeenCalledOnce());
    expect(vi.mocked(docsImportApi.apply).mock.calls[0][0]).toEqual(sent);

    // Окно в чтении со свежей схемой.
    await waitFor(() => expect(screen.getByTestId("mmd")).toHaveTextContent("X[Свежая]"), WAIT);
    expect(screen.getByRole("button", { name: "Изменить" })).toBeInTheDocument();
    expect(fileInput()).toBeNull();
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it("выход из стадии возвращает к чтению той же схемы", async () => {
    await стадияСхемы();
    expect(fileInput()).not.toBeNull();
    await userEvent.click(выход());
    expect(fileInput()).toBeNull();
    expect(screen.getByTestId("mmd")).toHaveTextContent("A[Принять]");
    expect(screen.getByRole("button", { name: "Изменить" })).toBeInTheDocument();
  });

  it("Escape в стадии закрывает окно", async () => {
    const onClose = vi.fn();
    await стадияСхемы({ onClose });
    cancel();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("стадия агента у спецификации", () => {
  beforeEach(() => vi.clearAllMocks());

  it("задание без цели, текст уходит в буфер", async () => {
    vi.mocked(docsImportApi.prompt).mockResolvedValue({ prompt: "задание спецификации" });
    const writeText = clipboard();
    await стадияСпецификации(SPEC("Order API"));
    await userEvent.click(кнопкаЗадания());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("задание спецификации"));
    expect(vi.mocked(docsImportApi.prompt).mock.calls).toEqual([[{
      nodeId: "n1", include: "api", lang: "ru", hints: "", variant: "orchestrated",
    }]]);
  });

  it("файл даёт превью; «Применить» шлёт тот же запрос; окно читает свежую спецификацию", async () => {
    vi.mocked(docsImportApi.preview).mockResolvedValue(specReport());
    vi.mocked(docsImportApi.apply).mockResolvedValue(specReport({ applied: true, specs_written: 1 }));
    vi.mocked(nodesApi.get).mockResolvedValue({ id: "n1", openapi_spec: SPEC("От агента") } as Node);
    const onApplied = vi.fn();
    await стадияСпецификации(SPEC("Order API"), { onApplied });

    const text = SPEC("От агента");
    await userEvent.upload(fileInput(), new File([text], "openapi.yaml"));
    await waitFor(() => expect(docsImportApi.preview).toHaveBeenCalled(), WAIT);
    const sent = { files: [{ name: "openapi.yaml", content: text }], overwrite: true, only: "api", nodeId: "n1" };
    expect(vi.mocked(docsImportApi.preview).mock.calls.at(-1)![0]).toEqual(sent);

    const apply = screen.getByRole("button", { name: "Применить" });
    await waitFor(() => expect(apply).toBeEnabled(), WAIT);
    await userEvent.click(apply);
    await waitFor(() => expect(docsImportApi.apply).toHaveBeenCalledOnce());
    expect(vi.mocked(docsImportApi.apply).mock.calls[0][0]).toEqual(sent);

    await waitFor(() => expect(screen.getByTestId("swagger")).toHaveTextContent("От агента"), WAIT);
    expect(screen.getByRole("button", { name: "Изменить" })).toBeInTheDocument();
    expect(fileInput()).toBeNull();
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it("со спецификацией выход из стадии возвращает к чтению", async () => {
    await стадияСпецификации(SPEC("Order API"));
    await userEvent.click(выход());
    expect(screen.getByTestId("swagger")).toHaveTextContent("Order API");
    expect(fileInput()).toBeNull();
  });

  it("без спецификации Escape в стадии закрывает окно", async () => {
    const onClose = vi.fn();
    await стадияСпецификации("", { onClose });
    expect(fileInput()).not.toBeNull();
    cancel();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ── вид нового языка (редизайн, фаза 7в) ─────────────────────────────────────

const окно = () => document.querySelector("dialog .doc-agentwin") as HTMLElement;
const подвал = () => окно().querySelector(".ds-win-foot") as HTMLElement;

async function положитьФайл(report: DocsImportReport, name = "a.mmd", text = MMD) {
  vi.mocked(docsImportApi.preview).mockResolvedValue(report);
  await userEvent.upload(fileInput(), new File([text], name));
  await waitFor(() => expect(docsImportApi.preview).toHaveBeenCalled(), WAIT);
}

describe("стадия агента у схемы: вид нового языка", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc()]);
  });

  it("малое окно семьи: шапка, задание, зона файлов; шагов, примечаний и кнопок прежнего вида нет", async () => {
    await стадияСхемы();
    expect(окно()).toHaveClass("ds-win");
    // Шапка: имя объекта и название схемы, крестик; кнопки «← К схеме» нет.
    expect(окно().querySelector(".ds-win-head")).toHaveTextContent(/^Order APIСоздание заказа$/);
    expect(screen.queryByRole("button", { name: "← К схеме" })).toBeNull();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Задание агенту", "Ответы агента"]);
    // Кнопка задания — вторичная кнопка нового языка, как в окне «Описать схемы логики…».
    expect(кнопкаЗадания()).toHaveClass("ds-btn");
    expect(кнопкаЗадания()).not.toHaveClass("ds-btn--primary");
    expect(screen.getByText("Перетащите сюда файл схемы от агента")).toBeInTheDocument();
    for (const text of [
      "Скопируйте промпт.", /Он уже нацелен на схему/, /Запустите агента с этим промптом/,
      "Перетащите файл, который вернёт агент, в поле справа.",
      "Схема не изменится, пока вы не нажмёте «Применить»",
    ]) expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryByRole("button", { name: "Загрузить файлы" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ вставить из буфера" })).toBeNull();
    expect(document.querySelector("dialog .legacy-root")).toBeNull();
    // Отчёта до файла нет, галочки «Заменять уже описанное» нет вовсе.
    expect(окно().querySelector(".apl")).toBeNull();
    expect(screen.queryByText("Заменять уже описанное")).toBeNull();
  });

  it("подвал: «Применить» первой и погашена до файла, «Отмена» за ней", async () => {
    await стадияСхемы();
    const кнопки = within(подвал()).getAllByRole("button");
    expect(кнопки.map((b) => b.textContent)).toEqual(["Применить", "Отмена"]);
    expect(кнопки[0]).toHaveClass("ds-btn", "ds-btn--primary");
    expect(кнопки[0]).toBeDisabled();
    expect(кнопки[1]).toHaveClass("ds-btn");
    expect(кнопки[1]).not.toHaveClass("ds-btn--primary");
  });

  it("сводка словами про эту схему; имя и вид в строке не правятся; рисунок того, что придёт", async () => {
    await стадияСхемы();
    await положитьФайл(logicReport());
    expect(await screen.findByText("Схема «Создание заказа» будет обновлена", {}, WAIT)).toHaveClass("apl-summary", "is-ok");
    // Строка: путь объекта над ней, имя, эндпоинт, вид и что будет; без полей правки и
    // без заголовка «Схемы логики:» над единственной строкой.
    expect(screen.getByText("Ярмарка / Заказы / Order API")).toHaveClass("apl-path");
    const строка = окно().querySelector(".apl-row") as HTMLElement;
    expect(строка).toHaveTextContent(/^Создание заказаPOST \/ordersОперацияперезапись$/);
    expect(screen.queryByLabelText(/Имя схемы из файла/)).toBeNull();
    expect(screen.queryByLabelText(/Вид схемы из файла/)).toBeNull();
    expect(screen.queryByText("Схемы логики:")).toBeNull();
    // Рисунок схемы, которую получит окно.
    expect(окно().querySelector(".doc-incoming")).toHaveTextContent("A[От агента]");
    expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled();
  });

  it("файл совпадает со схемой: применять нечего", async () => {
    await стадияСхемы();
    await положитьФайл(logicReport({ logic: [{ ...logicReport().logic[0], action: "unchanged" }] }));
    expect(await screen.findByText("Файл совпадает со схемой, менять нечего", {}, WAIT)).not.toHaveClass("is-ok");
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
  });

  it("отказ применения строкой над кнопками; окно и файл на месте", async () => {
    vi.mocked(docsImportApi.apply).mockRejectedValue(new ApiError(422, "Слишком длинное имя схемы"));
    const onApplied = vi.fn();
    await стадияСхемы({ onApplied });
    await положитьФайл(logicReport());
    await screen.findByText("Схема «Создание заказа» будет обновлена", {}, WAIT);
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));

    const отказ = await screen.findByRole("alert");
    expect(отказ).toHaveTextContent("Не сохранилось. Слишком длинное имя схемы");
    expect(отказ).toHaveClass("ds-danger", "ds-win-err");
    expect(отказ.parentElement).toBe(подвал());
    expect(отказ.compareDocumentPosition(screen.getByRole("button", { name: "Применить" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "a.mmd" })).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("вставка текстом: поле, правка текста, отчёт обновляется", async () => {
    vi.mocked(docsImportApi.preview)
      .mockResolvedValueOnce(logicReport({ logic: [{ ...logicReport().logic[0], source: "вставка-1", action: "unchanged" }] }))
      .mockResolvedValue(logicReport({ logic: [{ ...logicReport().logic[0], source: "вставка-1" }] }));
    await стадияСхемы();
    await userEvent.click(screen.getByRole("button", { name: "Вставить текст" }));
    const поле = screen.getByRole("textbox", { name: "Текст вставка-1" });
    fireEvent.change(поле, { target: { value: "graph TD\n  A-->B" } });
    expect(await screen.findByText("Файл совпадает со схемой, менять нечего", {}, WAIT)).toBeInTheDocument();
    expect(vi.mocked(docsImportApi.preview).mock.calls.at(-1)![0].files).toEqual([{ name: "вставка-1", content: "graph TD\n  A-->B" }]);
    fireEvent.change(поле, { target: { value: "graph TD\n  A-->C" } });
    expect(await screen.findByText("Схема «Создание заказа» будет обновлена", {}, WAIT)).toBeInTheDocument();
    expect(vi.mocked(docsImportApi.preview).mock.calls.at(-1)![0].files).toEqual([{ name: "вставка-1", content: "graph TD\n  A-->C" }]);
  });

  it("замечания: копирование и вопрос о файлах; тот же файл ещё раз — заметка о неизменившемся входе", async () => {
    const writeText = clipboard();
    await стадияСхемы();
    await положитьФайл(logicReport({ warnings: ["a.mmd: в пометке «ordrs» нет такой таблицы"] }));
    await userEvent.click(await screen.findByRole("button", { name: "Скопировать замечания для агента" }, WAIT));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toMatch(/^ArchMap проверил файлы archmap-docs и нашёл замечания\. Исправь пакет/);
    expect(writeText.mock.calls[0][0]).toMatch(/\n- a\.mmd: в пометке «ordrs» нет такой таблицы$/);
    expect(screen.getByRole("button", { name: "Скопировано" })).toBeInTheDocument();
    expect(screen.getByText(/Агент пришлёт исправленные файлы/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Оставить" }));
    expect(screen.queryByText(/Агент пришлёт исправленные файлы/)).toBeNull();

    await userEvent.upload(fileInput(), new File([MMD], "a.mmd"));
    expect(await screen.findByText(/^Содержимое не изменилось с прошлой проверки/, {}, WAIT)).toHaveClass("ds-warn");
  });

  it("неописанная схема: «Описать» → «Через ИИ-агента» открывает ту же стадию", async () => {
    vi.mocked(nodeDocsApi.list).mockResolvedValue([doc({ content: "" })]);
    render(<DocOverlay {...base} mode="flowchart" isArchitect initialDocId="d1" onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Описать" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Через ИИ-агента" }));
    expect(окно().querySelector(".ds-win-head")).toHaveTextContent(/^Order APIСоздание заказа$/);
    expect(кнопкаЗадания()).toHaveTextContent("Скопировать задание");
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.getByRole("button", { name: "Описать" })).toBeInTheDocument();
  });
});
