// Окно «Описать схемы логики с помощью ИИ-агента»: страховочная сетка поведения окна перед
// разрезом панели и переводом окна на новый язык (редизайн, фаза 6в). Тесты держатся за
// поведение, а не за вид: режим меняет строки задания и кнопки футера; «Что описать», язык
// и подсказки уходят в запрос задания; файлы дают превью; правка имени и вида строки уходит
// в overrides; галочка «Заменять уже описанное» меняет запрос превью и применения;
// «Добавить» применяет и закрывает окно, «Добавить ещё» применяет и оставляет окно открытым
// с очищенным адресом и пустым пакетом; смена режима не теряет файлы, язык и подсказки.
//
// Где окно рисуется по-разному (вкладка режима, выбор языка, кнопка задания), вид спрятан в
// помощники ниже. Modal настоящий (test-setup открывает <dialog> атрибутом open).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DocsAgentModal from "../docsImport/DocsAgentModal";
import { docsImportApi } from "../../api/docsImport";
import type { DocsImportReport } from "../../types";

vi.mock("../../api/docsImport", () => ({
  docsImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
// Проверка Mermaid — ленивый чанк; в тестах схема всегда читается.
vi.mock("../mermaidLoader", () => ({ validateMermaid: vi.fn().mockResolvedValue(null) }));

const WAIT = { timeout: 3000 };

const row = (over: Partial<DocsImportReport["logic"][number]> = {}): DocsImportReport["logic"][number] => ({
  node_path: "Ярмарка / Заказы", source: "a.mmd", name: "Приём заказа",
  kind: "operation", operation: "POST /orders", action: "create",
  mermaid: "graph TD\n  A-->B", ...over,
});

const report = (over: Partial<DocsImportReport> = {}): DocsImportReport => ({
  logic: [row()], specs: [], errors: [], warnings: [], conflicts: [], applied: false,
  created_docs: 0, filled_docs: 0, updated_docs: 0, specs_written: 0,
  data_refs_total: 0, channel_refs_total: 0, ...over,
});

function renderWindow() {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(<DocsAgentModal nodeId="n1" nodeName="Заказы" onClose={onClose} onApplied={onApplied} />);
  return { onClose, onApplied };
}

// ── помощники вида ───────────────────────────────────────────────────────────
const режим = (name: "Пакетом" | "По одной схеме") => screen.getByRole("tab", { name });
const кнопкаЗадания = () => screen.getByRole("button", { name: "Скопировать промпт" });
async function выбратьЯзык(name: "Английский") {
  await userEvent.click(screen.getByLabelText(name));
}
const языкВыбран = (name: "Русский" | "Английский") =>
  expect(screen.getByLabelText(name)).toBeChecked();

const полеАдреса = () => screen.queryByPlaceholderText(/воркер или эндпоинт/) as HTMLTextAreaElement | null;
const полеПодсказок = () => screen.getByPlaceholderText(/billing/) as HTMLTextAreaElement;
const fileInput = () => document.querySelector("dialog input[type=file]") as HTMLInputElement;
const lastPreview = () => vi.mocked(docsImportApi.preview).mock.calls.at(-1)?.[0];
const lastPrompt = () => vi.mocked(docsImportApi.prompt).mock.calls.at(-1)?.[0];
const button = (name: string) => screen.queryByRole("button", { name });

async function положитьФайл(name = "a.mmd", text = "%% archmap-name: Приём заказа\ngraph TD\n  A-->B\n") {
  await userEvent.upload(fileInput(), new File([text], name));
  await waitFor(() => expect(docsImportApi.preview).toHaveBeenCalled(), WAIT);
  await screen.findByText(/Схем: 1 \(новых 1/, {}, WAIT);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(docsImportApi.prompt).mockResolvedValue({ prompt: "задание" });
  vi.mocked(docsImportApi.preview).mockResolvedValue(report());
  vi.mocked(docsImportApi.apply).mockResolvedValue(report({ applied: true, created_docs: 1 }));
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

describe("Схемы логики с агентом: режимы и задание", () => {
  it("режим меняет строки задания и кнопки футера", async () => {
    renderWindow();
    expect(полеАдреса()).toBeNull();
    expect(screen.queryByText("Что описать")).toBeNull();
    expect(button("Применить")).not.toBeNull();
    expect(button("Добавить")).toBeNull();
    expect(button("Добавить ещё")).toBeNull();

    await userEvent.click(режим("По одной схеме"));
    expect(полеАдреса()).not.toBeNull();
    expect(screen.getByText("Что описать")).toBeInTheDocument();
    expect(button("Применить")).toBeNull();
    // Главная кнопка первой, «Добавить ещё» правее.
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names.indexOf("Добавить ещё")).toBe(names.indexOf("Добавить") + 1);

    await userEvent.click(режим("Пакетом"));
    expect(полеАдреса()).toBeNull();
    expect(button("Применить")).not.toBeNull();
  });

  it("«Что описать», язык и подсказки уходят в запрос задания", async () => {
    renderWindow();
    await userEvent.click(режим("По одной схеме"));
    await userEvent.type(полеАдреса()!, "POST /orders");
    await выбратьЯзык("Английский");
    await userEvent.type(полеПодсказок(), "только billing");
    await userEvent.click(кнопкаЗадания());
    await waitFor(() => expect(lastPrompt()).toEqual({
      nodeId: "n1", include: "logic", lang: "en", hints: "только billing",
      target: "POST /orders", variant: "orchestrated",
    }));
  });

  it("смена режима не теряет файлы, язык, подсказки и адрес", async () => {
    renderWindow();
    await userEvent.click(режим("По одной схеме"));
    await userEvent.type(полеАдреса()!, "GET /orders");
    await выбратьЯзык("Английский");
    await userEvent.type(полеПодсказок(), "подсказка");
    await положитьФайл();

    await userEvent.click(режим("Пакетом"));
    языкВыбран("Английский");
    expect(полеПодсказок().value).toBe("подсказка");
    expect(screen.getByText("a.mmd")).toBeInTheDocument();
    expect(screen.getByText(/Схем: 1 \(новых 1/)).toBeInTheDocument();

    await userEvent.click(режим("По одной схеме"));
    expect(полеАдреса()!.value).toBe("GET /orders");
    expect(screen.getByText("a.mmd")).toBeInTheDocument();
  });
});

describe("Схемы логики с агентом: файлы и превью", () => {
  it("файл даёт превью схем логики по объекту окна", async () => {
    renderWindow();
    await положитьФайл();
    expect(lastPreview()).toEqual({
      files: [{ name: "a.mmd", content: "%% archmap-name: Приём заказа\ngraph TD\n  A-->B\n" }],
      overwrite: false, only: "logic", nodeId: "n1", overrides: [],
    });
    expect(button("Применить")).toBeEnabled();
  });

  it("правка имени и вида в строке отчёта уходит в overrides", async () => {
    renderWindow();
    await положитьФайл();
    // Пустое имя правкой не считается (поле возвращает имя из файла), поэтому значение
    // ставится целиком, а не стиранием и набором.
    fireEvent.change(screen.getByLabelText("Имя схемы из файла a.mmd"), { target: { value: "Новое имя" } });
    await waitFor(() => expect(lastPreview()?.overrides).toEqual([{ file: "a.mmd", name: "Новое имя" }]), WAIT);
    await userEvent.selectOptions(screen.getByLabelText("Вид схемы из файла a.mmd"), "worker");
    await waitFor(() => expect(lastPreview()?.overrides).toEqual([{ file: "a.mmd", name: "Новое имя", kind: "worker" }]), WAIT);
  });

  it("галочка «Заменять уже описанное» меняет запрос превью и применения", async () => {
    vi.mocked(docsImportApi.preview).mockResolvedValue(report({ logic: [row({ action: "skip" })] }));
    const { onApplied, onClose } = renderWindow();
    await userEvent.upload(fileInput(), new File(["graph TD\n"], "a.mmd"));
    await screen.findByText(/пропуск 1/, {}, WAIT);
    // Пропуск ничего не пишет: применять нечего.
    expect(button("Применить")).toBeDisabled();

    vi.mocked(docsImportApi.preview).mockResolvedValue(report({ logic: [row({ action: "overwrite" })] }));
    await userEvent.click(screen.getByLabelText(/Заменять уже описанное/));
    await waitFor(() => expect(lastPreview()?.overwrite).toBe(true), WAIT);
    await screen.findByText(/перезапись 1/, {}, WAIT);
    await userEvent.click(button("Применить")!);
    await waitFor(() => expect(docsImportApi.apply).toHaveBeenCalledOnce());
    expect(vi.mocked(docsImportApi.apply).mock.calls[0][0]).toMatchObject({ overwrite: true, only: "logic", nodeId: "n1" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onApplied).toHaveBeenCalledOnce();
  });
});

describe("Схемы логики с агентом: по одной схеме", () => {
  it("«Добавить» применяет и закрывает окно", async () => {
    const { onApplied, onClose } = renderWindow();
    await userEvent.click(режим("По одной схеме"));
    await положитьФайл();
    await userEvent.click(button("Добавить")!);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onApplied).toHaveBeenCalledOnce();
    expect(vi.mocked(docsImportApi.apply).mock.calls[0][0]).toMatchObject({ overwrite: false, only: "logic", nodeId: "n1" });
  });

  it("«Добавить ещё» применяет и оставляет окно открытым с очищенным адресом и пустым пакетом", async () => {
    const { onApplied, onClose } = renderWindow();
    await userEvent.click(режим("По одной схеме"));
    await userEvent.type(полеАдреса()!, "POST /orders");
    await положитьФайл();
    await userEvent.click(button("Добавить ещё")!);
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(docsImportApi.apply).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(полеАдреса()!.value).toBe(""));
    expect(screen.queryByText("a.mmd")).toBeNull();
    expect(screen.queryByText(/Схем: 1/)).toBeNull();
    // Режим остался «по одной»: готовим следующую схему.
    expect(button("Добавить ещё")).not.toBeNull();
  });
});
