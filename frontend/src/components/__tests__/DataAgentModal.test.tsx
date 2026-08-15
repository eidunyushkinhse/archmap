// Окно «Структура от агента»: промпт → пакет → превью → применение.
//
// Проверяется то, что отличает это окно от двух соседних (схемы логики, спека):
// свой контракт дозаливки, дефолт «не перезаписывать» и запрет применять пакет с
// ошибками — превью здесь единственная страховка, в undo применение не кладётся.
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import DataAgentModal from "../docsImport/DataAgentModal";
import { dataImportApi } from "../../api/docsImport";
import type { DataImportReport } from "../../types";

vi.mock("../../api/docsImport", () => ({
  dataImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в тестах доков.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const report = (over: Partial<DataImportReport> = {}): DataImportReport =>
  ({
    tables: [], errors: [], warnings: [], applied: false,
    tables_written: 0, columns_written: 0, ...over,
  }) as DataImportReport;

const table = () => ({
  node_path: "Хранилище", source: "data.yaml", schema_name: "", name: "orders",
  columns: 3, action: "create" as const,
});

function open() {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(<DataAgentModal nodeId="db1" nodeName="Хранилище" onClose={onClose} onApplied={onApplied} />);
  return { onApplied, onClose };
}

// Пакет вставляется текстом: файловый ввод в jsdom тестировать нечем, а путь тот же.
async function вставить(текст: string) {
  await userEvent.click(screen.getByText("+ вставить из буфера"));
  const area = screen.getByPlaceholderText("вставьте содержимое файла");
  await userEvent.clear(area);
  await userEvent.type(area, текст);
}

describe("DataAgentModal", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => vi.useRealTimers());

  it("превью показывает, что приедет, и по умолчанию НЕ перезаписывает", async () => {
    vi.mocked(dataImportApi.preview).mockResolvedValue(report({ tables: [table()] }));
    open();
    await вставить("tables:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(dataImportApi.preview).toHaveBeenCalled());
    expect(vi.mocked(dataImportApi.preview).mock.calls[0][0].overwrite).toBe(false);
    expect(screen.getByText(/Хранилище.*orders.*колонок 3/)).toBeInTheDocument();
  });

  it("пакет с ошибками применить нельзя", async () => {
    vi.mocked(dataImportApi.preview).mockResolvedValue(
      report({ errors: ["data.yaml: объект «Х» не найден"] }),
    );
    open();
    await вставить("tables:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(screen.getByText(/Пакет не применить/)).toBeInTheDocument());
    expect(screen.getByText("Применить")).toBeDisabled();
  });

  it("применение закрывает окно и просит родителя перечитать", async () => {
    vi.mocked(dataImportApi.preview).mockResolvedValue(report({ tables: [table()] }));
    vi.mocked(dataImportApi.apply).mockResolvedValue(
      report({ applied: true, tables_written: 1, columns_written: 3 }),
    );
    const { onApplied, onClose } = open();
    await вставить("tables:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(screen.getByText("Применить")).toBeEnabled());
    await userEvent.click(screen.getByText("Применить"));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("окно про структуру: обращений в нём нет", async () => {
    // Пивот §9: обращения к данным приезжают пометками внутри схем логики, а не сюда.
    // Пакет по старому промпту не отвергается — на раздел `access` отвечает
    // предупреждением бэкенд, и оно попадает в общий список «Проверьте».
    vi.mocked(dataImportApi.preview).mockResolvedValue(
      report({
        tables: [table()],
        warnings: ["data.yaml: раздел access больше не поддерживается — обращения "
          + "описываются пометками «читает:/пишет:» в схемах логики"],
      }),
    );
    open();
    expect(screen.getByText("Описать структуру с помощью ИИ-агента")).toBeInTheDocument();
    // Адресация названа точно: к объекту окна уедет файл БЕЗ «# archmap-node:».
    expect(screen.getByText(/без адреса .* приедут к объекту «Хранилище»/)).toBeInTheDocument();
    await вставить("tables:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(screen.getByText(/Таблиц: 1/)).toBeInTheDocument());
    expect(screen.queryByText("Обращения:")).not.toBeInTheDocument();
    expect(screen.getByText(/раздел access больше не поддерживается/)).toBeInTheDocument();
    // Предупреждение применению не мешает: таблицы в пакете есть.
    expect(screen.getByText("Применить")).toBeEnabled();
  });

  it("замечания уносят агенту «чини, а не удаляй»", async () => {
    // На голое «исправь» слабая модель отвечает ампутацией — вырезает записи, на
    // которые жалуется валидатор (docs/qa-sentry-brokers.md, находка №2: так из
    // доков исчезли все 83 пометки по списку из семи битых).
    const w = "data.yaml: таблица «orders» без колонок";
    vi.mocked(dataImportApi.preview).mockResolvedValue(
      report({ tables: [table()], warnings: [w] }),
    );
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open();
    await вставить("tables:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(screen.getByText(w)).toBeInTheDocument());

    await userEvent.click(screen.getByText("Скопировать замечания для агента"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const текст = writeText.mock.calls[0][0];
    expect(текст).toContain("Записи чини по замечаниям, а не удаляй из пакета");
    expect(текст).toContain(w);
  });

  it("тумблер перезаписи уезжает в запрос", async () => {
    vi.mocked(dataImportApi.preview).mockResolvedValue(report({ tables: [table()] }));
    open();
    await вставить("tables:");
    await userEvent.click(screen.getByLabelText(/Перезаписывать заполненное/));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(
      vi.mocked(dataImportApi.preview).mock.calls.at(-1)?.[0].overwrite,
    ).toBe(true));
  });
});
