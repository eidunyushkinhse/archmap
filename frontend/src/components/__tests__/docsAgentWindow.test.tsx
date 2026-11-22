// Окно «Описать схемы логики с помощью ИИ-агента»: страховочная сетка поведения окна перед
// разрезом панели и переводом окна на новый язык (редизайн, фаза 6в). Тесты держатся за
// поведение, а не за вид: режим меняет строки задания и кнопки футера; «Что описать», язык
// и подсказки уходят в запрос задания; файлы дают превью; правка имени и вида строки уходит
// в overrides; галочка «Заменять уже описанное» меняет запрос превью и применения;
// «Добавить» применяет и закрывает окно, «Добавить ещё» применяет и оставляет окно открытым
// с очищенным адресом и пустым пакетом; смена режима не теряет файлы, язык и подсказки.
//
// Где окно рисуется по-разному (вкладка режима, выбор языка, кнопка задания), вид спрятан в
// помощники ниже: сетка написана на прежнем окне, после перевода на новый язык поменялись
// только помощники. Тесты нового вида — в конце файла: Escape при открытом меню языка,
// «Отмена», пояснение режима в подсказке вкладки, галочка только вместе с файлами.
// Modal настоящий (test-setup открывает <dialog> атрибутом open).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DocsAgentModal from "../docsImport/DocsAgentModal";
import { docsImportApi } from "../../api/docsImport";
import { ApiError } from "../../api/client";
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
  render(<DocsAgentModal nodeId="n1" onClose={onClose} onApplied={onApplied} />);
  return { onClose, onApplied };
}

// ── помощники вида ───────────────────────────────────────────────────────────
const режим = (name: "Пакетом" | "По одной схеме") => screen.getByRole("button", { name });
const кнопкаЗадания = () => screen.getByRole("button", { name: "Скопировать задание" });
async function выбратьЯзык(name: "Английский") {
  await userEvent.click(screen.getByRole("button", { name: /^Язык подписей/ }));
  await userEvent.click(screen.getByRole("menuitemradio", { name }));
}
const языкВыбран = (name: "Русский" | "Английский") =>
  expect(screen.getByRole("button", { name: `Язык подписей ${name}` })).toBeInTheDocument();

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

describe("Схемы логики с агентом: вид нового языка", () => {
  it("пояснение режима — в подсказке вкладки, вступления и серой строки нет", () => {
    renderWindow();
    expect(режим("Пакетом")).toHaveAttribute(
      "title",
      "Агент отдаст пакет со всеми схемами объекта за один заход. Используйте этот режим в репозиториях микросервисов",
    );
    expect(режим("По одной схеме")).toHaveAttribute(
      "title",
      "Агент отдаст схему одного воркера или эндпоинта за один заход. Используйте этот режим в репозиториях крупных монолитов",
    );
    expect(режим("Пакетом")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/Используйте этот режим/)).toBeNull();
    expect(screen.queryByText(/ИИ-агент опишет по коду/)).toBeNull();
    expect(screen.queryByText(/опционально/)).toBeNull();
  });

  it("зона файлов одной строкой по режиму; галочка появляется вместе с файлами", async () => {
    renderWindow();
    expect(screen.getByText("Перетащите сюда файлы схем от агента")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Заменять уже описанное/)).toBeNull();
    await userEvent.click(режим("По одной схеме"));
    expect(screen.getByText("Перетащите сюда файл схемы от агента")).toBeInTheDocument();
    await положитьФайл();
    const box = screen.getByLabelText(/Заменять уже описанное/);
    expect(box).not.toBeChecked();
    expect(box.closest("label")).toHaveAttribute("title", expect.stringContaining("новая по умолчанию пропускается"));
    // Галочка в теле под отчётом, а не в футере.
    expect(box.closest(".ds-win-foot")).toBeNull();
  });

  it("вставка текстом открывает поле; файл с диска открывается по клику на имя", async () => {
    renderWindow();
    await положитьФайл();
    expect(screen.queryByLabelText("Текст a.mmd")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "a.mmd" }));
    expect(screen.getByLabelText("Текст a.mmd")).toHaveValue("%% archmap-name: Приём заказа\ngraph TD\n  A-->B\n");
    await userEvent.click(screen.getByRole("button", { name: "a.mmd" }));
    expect(screen.queryByLabelText("Текст a.mmd")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Вставить текст" }));
    expect(screen.getByLabelText("Текст вставка-1")).toHaveValue("");
  });

  it("строка плана: адрес объекта над строками, операция под именем, без «·»", async () => {
    renderWindow();
    await положитьФайл();
    const plan = screen.getByText("Схемы логики:").closest(".apl-plan") as HTMLElement;
    expect(within(plan).getByText("Ярмарка / Заказы")).toBeInTheDocument();
    expect(within(plan).getByText("POST /orders")).toBeInTheDocument();
    expect(within(plan).getByText("новая")).toBeInTheDocument();
    expect(plan.textContent).not.toContain("·");
  });

  it("«Отмена» закрывает окно, футер: главная кнопка первой", async () => {
    const { onClose } = renderWindow();
    const foot = document.querySelector(".ds-win-foot") as HTMLElement;
    expect(within(foot).getAllByRole("button").map((b) => b.textContent)).toEqual(["Применить", "Отмена"]);
    await userEvent.click(режим("По одной схеме"));
    expect(within(foot).getAllByRole("button").map((b) => b.textContent)).toEqual(["Добавить", "Добавить ещё", "Отмена"]);
    await userEvent.click(within(foot).getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape при открытом меню языка закрывает только меню, следующий — окно", async () => {
    const { onClose } = renderWindow();
    const value = screen.getByRole("button", { name: "Язык подписей Русский" });
    await userEvent.click(value);
    const item = screen.getByRole("menuitemradio", { name: "Русский" });
    expect(item).toHaveFocus();

    // Браузер закрывает <dialog> по Escape событием cancel, если keydown не погашен.
    const dialog = document.querySelector("dialog")!;
    const notPrevented = fireEvent.keyDown(item, { key: "Escape" });
    if (notPrevented) fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(notPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(value).toHaveFocus();

    expect(fireEvent.keyDown(value, { key: "Escape" })).toBe(true);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("сводка перечисляет только ненулевые счётчики", async () => {
    renderWindow();
    await положитьФайл();
    expect(screen.getByText("Схем: 1 (новых 1)")).toBeInTheDocument();

    vi.mocked(docsImportApi.preview).mockResolvedValue(report({
      logic: [row(), row({ source: "b.mmd", name: "Отмена", action: "skip" }), row({ source: "c.mmd", name: "Оплата", action: "fill" })],
    }));
    await userEvent.upload(fileInput(), new File(["graph TD\n"], "b.mmd"));
    expect(await screen.findByText("Схем: 3 (новых 1, заполнение неописанных 1, пропуск 1)", {}, WAIT)).toBeInTheDocument();
  });

  it("сводка без ненулевых счётчиков — без скобок", async () => {
    vi.mocked(docsImportApi.preview).mockResolvedValue(report({ logic: [] }));
    renderWindow();
    await userEvent.upload(fileInput(), new File(["graph TD\n"], "a.mmd"));
    expect(await screen.findByText("Схем: 0", {}, WAIT)).toBeInTheDocument();
  });

  it("отказ применения: строка над кнопками, окно открыто, пакет на месте", async () => {
    const { onApplied, onClose } = renderWindow();
    await положитьФайл();
    vi.mocked(docsImportApi.apply).mockRejectedValueOnce(new ApiError(422, "Имя схемы длиннее 200 символов"));
    await userEvent.click(button("Применить")!);
    const foot = document.querySelector(".ds-win-foot") as HTMLElement;
    expect(await within(foot).findByRole("alert")).toHaveTextContent("Не сохранилось. Имя схемы длиннее 200 символов");
    expect(onClose).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByText("a.mmd")).toBeInTheDocument();

    // Повторное применение снимает прежний отказ.
    await userEvent.click(button("Применить")!);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(within(foot).queryByRole("alert")).toBeNull();
  });

  it("кнопка задания: «Скопировать задание», не главная, «Скопировано» без галочки", async () => {
    renderWindow();
    expect(кнопкаЗадания()).not.toHaveClass("ds-btn--primary");
    await userEvent.click(кнопкаЗадания());
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeInTheDocument();
  });
});
