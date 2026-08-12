// Окно «Данные от агента»: промпт → пакет → превью → применение.
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
    tables: [], access: [], errors: [], warnings: [], applied: false,
    tables_written: 0, columns_written: 0, access_written: 0, ...over,
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
