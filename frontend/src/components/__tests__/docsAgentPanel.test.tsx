// Панель дозаливки схем логики в окне ОДНОЙ схемы (DocOverlay → «Изменить → Через
// ИИ-агента»). Отличие от модалки «Доки от агента» одно и принципиальное: пакет
// обновляет открытую схему. Имя уходит её (overrides), перезапись разрешена без
// галки — иначе агент, назвавший схему по-своему, создал бы вторую рядом, а
// описанная схема получила бы «пропуск (занято)».
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DocsAgentPanel from "../docsImport/DocsAgentPanel";
import { docsImportApi } from "../../api/docsImport";
import type { DocsImportReport } from "../../types";

vi.mock("../../api/docsImport", () => ({
  docsImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
vi.mock("../mermaidLoader", () => ({ validateMermaid: vi.fn().mockResolvedValue(null) }));
vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div>,
}));

const report = (action: "overwrite" | "fill" | "unchanged", over: Partial<DocsImportReport> = {}): DocsImportReport =>
  ({
    logic: [{
      node_path: "Ярмарка / Заказы", source: "вставка-1", name: "GET /orders",
      kind: "operation", operation: "GET /orders", action, mermaid: "graph TD\n  A-->B",
    }],
    specs: [], errors: [], warnings: [], conflicts: [], applied: false,
    created_docs: 0, filled_docs: 0, updated_docs: 0, specs_written: 0,
    data_refs_total: 0, channel_refs_total: 0, ...over,
  }) as DocsImportReport;

async function вставить(текст: string) {
  await userEvent.click(screen.getByText("+ вставить из буфера"));
  await userEvent.type(screen.getByPlaceholderText("вставьте содержимое файла"), текст);
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
}

describe("DocsAgentPanel · окно одной схемы", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it("пакет ложится в открытую схему: имя её, перезапись без галки", async () => {
    vi.mocked(docsImportApi.preview).mockResolvedValue(report("overwrite"));
    render(<DocsAgentPanel nodeId="n1" mode={{ kind: "doc", docName: "GET /orders" }} onApplied={vi.fn()} />);

    await вставить("graph TD");

    await waitFor(() => expect(docsImportApi.preview).toHaveBeenCalled());
    const params = vi.mocked(docsImportApi.preview).mock.calls.at(-1)![0];
    expect(params.overwrite).toBe(true);
    expect(params.overrides).toEqual([{ file: "вставка-1", name: "GET /orders" }]);
    // Галки модалки и правки имени в строках здесь нет: схема уже выбрана.
    expect(screen.queryByText("Обновлять готовые диаграммы")).toBeNull();
    expect(screen.queryByLabelText(/Имя схемы из файла/)).toBeNull();
  });

  it("сводка словами про эту схему и рисунок того, что придёт", async () => {
    vi.mocked(docsImportApi.preview).mockResolvedValue(report("overwrite"));
    render(<DocsAgentPanel nodeId="n1" mode={{ kind: "doc", docName: "GET /orders" }} onApplied={vi.fn()} />);

    await вставить("graph TD");

    expect(await screen.findByText("Схема «GET /orders» будет обновлена")).toBeInTheDocument();
    expect(screen.getByTestId("mmd")).toHaveTextContent("A-->B");
  });

  it("заглушка описывается, «Применить» пишет и отдаёт управление окну", async () => {
    vi.mocked(docsImportApi.preview).mockResolvedValue(report("fill"));
    vi.mocked(docsImportApi.apply).mockResolvedValue(report("fill", { applied: true, filled_docs: 1 }));
    const onApplied = vi.fn();
    render(<DocsAgentPanel nodeId="n1" mode={{ kind: "doc", docName: "GET /orders" }} onApplied={onApplied} />);

    await вставить("graph TD");
    expect(await screen.findByText("Схема «GET /orders» будет описана")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(false));
    const params = vi.mocked(docsImportApi.apply).mock.calls[0][0];
    expect(params.overrides).toEqual([{ file: "вставка-1", name: "GET /orders" }]);
    expect(params.overwrite).toBe(true);
  });

  it("файл совпадает со схемой: применять нечего", async () => {
    vi.mocked(docsImportApi.preview).mockResolvedValue(report("unchanged"));
    render(<DocsAgentPanel nodeId="n1" mode={{ kind: "doc", docName: "GET /orders" }} onApplied={vi.fn()} />);

    await вставить("graph TD");

    expect(await screen.findByText("Файл совпадает со схемой, менять нечего")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
  });
});
