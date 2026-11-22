// Окна фактов от агента — структура базы, каналы брокера, конфигурация: страховочная сетка
// поведения перед разрезом общей машинерии (FactAgentModal) и переводом окон на новый язык
// (редизайн, фаза 6г). Тесты держатся за поведение, а не за вид: заголовок семьи, задание
// агенту, файл даёт превью по объекту окна, галочка «Заменять уже описанное» уходит в
// превью и применение, без неё применение не заменяет, ошибки запрещают применять,
// замечания уходят агенту словами семьи, «?» объясняет адрес объекта.
//
// Где окно рисуется по-разному (кнопка задания, снятие файла), вид спрятан в помощники ниже:
// сетка написана на прежнем окне, после перевода на новый язык поменялись только помощники.
// Тесты нового вида — в конце файла: вступления нет, «?» у «Ответов агента» и Escape при
// открытой панели, галочка вместе с файлами, строка записи без «·», футер и отказ
// применения. Modal настоящий (test-setup открывает <dialog> атрибутом open).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DataAgentModal from "../docsImport/DataAgentModal";
import ChannelsAgentModal from "../docsImport/ChannelsAgentModal";
import ConfigAgentModal from "../docsImport/ConfigAgentModal";
import { channelsImportApi, configImportApi, dataImportApi } from "../../api/docsImport";
import { ApiError } from "../../api/client";
import type { ChannelsImportReport, ConfigImportReport, DataImportReport } from "../../types";

vi.mock("../../api/docsImport", () => ({
  dataImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
  channelsImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
  configImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));

const WAIT = { timeout: 3000 };

type Api = typeof dataImportApi;
interface Family {
  name: string;
  title: string;
  api: Api;
  render: (p: { onClose: () => void; onApplied: () => void }) => void;
  /** Отчёт превью с одной записью действия action. */
  report: (action: "create" | "skip" | "overwrite", over?: { errors?: string[]; warnings?: string[]; applied?: boolean }) => unknown;
  record: string;
  summary: RegExp;
  remarks: [string, string];
  /** Механика адреса за «?»: текст про объект окна; null — «?» у окна нет. */
  help: RegExp | null;
  /** Путь объекта записи и число тихим цветом в строке плана. */
  path: string;
  detail: string;
  /** Вступление прежнего окна: на новом языке его нет. */
  intro: RegExp;
}

const base = { scanner: [], errors: [] as string[], warnings: [] as string[], applied: false };

const FAMILIES: Family[] = [
  {
    name: "структура базы",
    title: "Описать структуру с помощью ИИ-агента",
    api: dataImportApi,
    render: (p) => render(<DataAgentModal nodeId="db1" nodeName="БД заказов" {...p} />),
    report: (action, over = {}): DataImportReport => ({
      ...base, tables_written: 0, columns_written: 0, ...over,
      tables: [{ node_path: "Ярмарка / БД заказов", source: "data.yaml", schema_name: "", name: "orders", columns: 3, action }],
    }),
    record: "orders",
    summary: /Таблиц: 1 \(новых/,
    remarks: ["ArchMap проверил файлы структуры", "Записи чини по замечаниям, а не удаляй из пакета"],
    help: /Таблицы из файла без такой строки попадут к объекту «БД заказов»/,
    path: "Ярмарка / БД заказов",
    detail: "колонок 3",
    intro: /Агент прочитает миграции/,
  },
  {
    name: "каналы брокера",
    title: "Описать каналы с помощью ИИ-агента",
    api: channelsImportApi as unknown as Api,
    render: (p) => render(<ChannelsAgentModal nodeId="db1" nodeName="Kafka" {...p} />),
    report: (action, over = {}): ChannelsImportReport => ({
      ...base, channels_written: 0, fields_written: 0, ...over,
      channels: [{ node_path: "Ярмарка / Kafka", source: "channels.yaml", group_name: "", name: "orders.events", fields: 2, action }],
    }),
    record: "orders.events",
    summary: /Каналов: 1 \(новых/,
    remarks: ["ArchMap проверил файлы каналов", "Каналы и поля чини по замечаниям, а не удаляй из пакета"],
    help: /Каналы из файла без такой строки попадут к объекту «Kafka»/,
    path: "Ярмарка / Kafka",
    detail: "полей 2",
    intro: /Каналы брокера описаны в коде/,
  },
  {
    name: "конфигурация",
    title: "Описать конфигурацию с помощью ИИ-агента",
    api: configImportApi as unknown as Api,
    render: (p) => render(<ConfigAgentModal nodeId="db1" {...p} />),
    report: (action, over = {}): ConfigImportReport => ({
      ...base, params_written: 0, ...over,
      params: [{ node_path: "Ярмарка / Order API", source: "config.yaml", name: "ORDER_TTL", value_type: "int", required: true, action }],
    }),
    record: "ORDER_TTL",
    summary: /Параметров: 1 \(новых/,
    remarks: ["ArchMap проверил файлы конфигурации", "Параметры чини по замечаниям, а не удаляй из пакета"],
    help: null,
    path: "Ярмарка / Order API",
    detail: "int, обяз.",
    intro: /Агент найдёт в коде/,
  },
];

// ── помощники вида ───────────────────────────────────────────────────────────
const кнопкаЗадания = () => screen.getByRole("button", { name: "Скопировать задание" });
const fileInput = () => document.querySelector("dialog input[type=file]") as HTMLInputElement;
const применить = () => screen.getByRole("button", { name: "Применить" });
const галочка = () => screen.getByLabelText(/Заменять уже описанное/);
const убрать = (name: string) => screen.getByRole("button", { name: `Убрать ${name}` });

async function положить(f: Family, name = "facts.yaml", text = "tables:\n") {
  await userEvent.upload(fileInput(), new File([text], name));
  await waitFor(() => expect(f.api.preview).toHaveBeenCalled(), WAIT);
}

describe.each(FAMILIES)("окно фактов · $name", (f) => {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  const open = () => f.render({ onClose, onApplied });
  const lastPreview = () => vi.mocked(f.api.preview).mock.calls.at(-1)?.[0];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(f.api.prompt).mockResolvedValue({ prompt: "задание" });
    vi.mocked(f.api.preview).mockResolvedValue(f.report("create") as DataImportReport);
    vi.mocked(f.api.apply).mockResolvedValue(f.report("create", { applied: true }) as DataImportReport);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
  });

  it("заголовок семьи; задание агенту копируется с аудитом", async () => {
    open();
    expect(screen.getByRole("heading", { name: f.title })).toBeInTheDocument();
    await userEvent.click(кнопкаЗадания());
    await waitFor(() => expect(f.api.prompt).toHaveBeenCalledWith("orchestrated"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("задание");
  });

  it("файл даёт превью по объекту окна, по умолчанию без замены", async () => {
    open();
    await положить(f);
    expect(lastPreview()).toEqual({
      files: [{ name: "facts.yaml", content: "tables:\n" }], overwrite: false, nodeId: "db1",
    });
    expect(await screen.findByText(f.summary, {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(f.record.replace(".", "\\.")))).toBeInTheDocument();
    expect(применить()).toBeEnabled();
  });

  it("без галочки применение не заменяет описанное и закрывает окно", async () => {
    open();
    await положить(f);
    await screen.findByText(f.summary, {}, WAIT);
    await userEvent.click(применить());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onApplied).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.apply).mock.calls[0][0]).toMatchObject({ overwrite: false, nodeId: "db1" });
  });

  it("галочка «Заменять уже описанное» уходит в превью и применение", async () => {
    vi.mocked(f.api.preview).mockResolvedValue(f.report("skip") as DataImportReport);
    open();
    await положить(f);
    await screen.findByText(f.summary, {}, WAIT);
    expect(галочка()).not.toBeChecked();

    vi.mocked(f.api.preview).mockResolvedValue(f.report("overwrite") as DataImportReport);
    await userEvent.click(галочка());
    await waitFor(() => expect(lastPreview()?.overwrite).toBe(true), WAIT);
    await userEvent.click(применить());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(vi.mocked(f.api.apply).mock.calls[0][0]).toMatchObject({ overwrite: true, nodeId: "db1" });
  });

  it("ошибки в файлах: «Файлы не применить:», применять нельзя", async () => {
    vi.mocked(f.api.preview).mockResolvedValue(
      f.report("create", { errors: ["facts.yaml: объект «Нет такого» не найден"] }) as DataImportReport,
    );
    open();
    await положить(f);
    expect(await screen.findByText("Файлы не применить:", {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText("facts.yaml: объект «Нет такого» не найден")).toBeInTheDocument();
    expect(применить()).toBeDisabled();
  });

  it("замечания: «Проверьте:», копия для агента словами семьи", async () => {
    const w = "facts.yaml: ключ archmap-node адресом не является";
    vi.mocked(f.api.preview).mockResolvedValue(f.report("create", { warnings: [w] }) as DataImportReport);
    open();
    await положить(f);
    expect(await screen.findByText("Проверьте:", {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText(w)).toBeInTheDocument();
    expect(применить()).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Скопировать замечания для агента" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const текст = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(текст).toContain(f.remarks[0]);
    expect(текст).toContain(f.remarks[1]);
    expect(текст).toContain(w);
  });

  it("убрали файл — отчёта нет, применять нечего", async () => {
    open();
    await положить(f);
    await screen.findByText(f.summary, {}, WAIT);
    await userEvent.click(убрать("facts.yaml"));
    expect(screen.queryByText(f.summary)).toBeNull();
    expect(применить()).toBeDisabled();
  });

  it("«?» объясняет адрес объекта в файле", async () => {
    open();
    const btn = screen.queryByRole("button", { name: "Как ArchMap разбирает файлы" });
    if (f.help === null) {
      expect(btn).toBeNull();
      return;
    }
    expect(btn).not.toBeNull();
    expect(screen.queryByText(f.help)).toBeNull();
    await userEvent.click(btn!);
    expect(screen.getByText(f.help)).toBeInTheDocument();
  });

  // ── вид нового языка ──────────────────────────────────────────────────────
  it("вступления нет; «?» — у заголовка «Ответы агента»", () => {
    open();
    expect(screen.queryByText(f.intro)).toBeNull();
    expect(screen.getByText("Перетащите сюда файлы от агента")).toBeInTheDocument();
    const btn = screen.queryByRole("button", { name: "Как ArchMap разбирает файлы" });
    if (f.help === null) return;
    expect(btn!.closest(".ds-win-block-head")).toHaveTextContent("Ответы агента");
  });

  it("Escape при открытом «?» закрывает только его, следующий — окно", async () => {
    if (f.help === null) return;
    open();
    await userEvent.click(screen.getByRole("button", { name: "Как ArchMap разбирает файлы" }));
    expect(screen.getByText(f.help)).toBeInTheDocument();
    // Браузер закрывает <dialog> по Escape событием cancel, если keydown не погашен.
    const dialog = document.querySelector("dialog")!;
    const notPrevented = fireEvent.keyDown(window, { key: "Escape" });
    if (notPrevented) fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(notPrevented).toBe(false);
    expect(screen.queryByText(f.help)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(window, { key: "Escape" })).toBe(true);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("галочка появляется вместе с файлами; пояснение — в подсказке", async () => {
    open();
    expect(screen.queryByLabelText(/Заменять уже описанное/)).toBeNull();
    await положить(f);
    expect(галочка().closest("label")).toHaveAttribute("title", expect.stringContaining("новые"));
    expect(галочка().closest(".ds-win-foot")).toBeNull();
  });

  it("строка записи: путь над строками, имя, число тихим цветом, без «·»", async () => {
    open();
    await положить(f);
    await screen.findByText(f.summary, {}, WAIT);
    const plan = document.querySelector(".apl-plan") as HTMLElement;
    expect(within(plan).getByText(f.path)).toHaveClass("apl-path");
    expect(within(plan).getByText(f.record)).toBeInTheDocument();
    expect(within(plan).getByText(f.detail)).toHaveClass("apl-detail");
    expect(within(plan).getByText("новая")).toHaveClass("apl-act");
    expect(plan.textContent).not.toContain("·");
  });

  it("футер: «Применить», «Отмена»; «Отмена» закрывает окно", async () => {
    open();
    const foot = document.querySelector(".ds-win-foot") as HTMLElement;
    expect(within(foot).getAllByRole("button").map((b) => b.textContent)).toEqual(["Применить", "Отмена"]);
    await userEvent.click(within(foot).getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("отказ применения: строка над кнопками, окно открыто", async () => {
    vi.mocked(f.api.apply).mockRejectedValueOnce(new ApiError(409, "Проект не помещается в демо"));
    open();
    await положить(f);
    await screen.findByText(f.summary, {}, WAIT);
    await userEvent.click(применить());
    const foot = document.querySelector(".ds-win-foot") as HTMLElement;
    expect(await within(foot).findByRole("alert")).toHaveTextContent("Не сохранилось. Проект не помещается в демо");
    expect(onClose).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(применить()).toBeEnabled();
  });

  it("кнопка задания не главная, «Скопировано» без галочки", async () => {
    open();
    expect(кнопкаЗадания()).not.toHaveClass("ds-btn--primary");
    await userEvent.click(кнопкаЗадания());
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeInTheDocument();
  });
});
