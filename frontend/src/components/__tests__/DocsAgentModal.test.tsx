// Окно «Описать логику с помощью агента»: дифф числа пометок между попытками и
// запрет удалять пометки в тексте замечаний.
//
// Оба — лечение находки №2 полевого QA (docs/qa-sentry-brokers.md): по списку из
// семи битых пометок слабая модель «починила» их удалением ВСЕХ восьмидесяти трёх,
// превью стало «идеальным», а обратный индекс базы опустел молча. Текстовый запрет
// нужен, но тексты дисперсны — число пометок не врёт, поэтому проверяем и его.
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import DocsAgentModal from "../docsImport/DocsAgentModal";
import { docsImportApi } from "../../api/docsImport";
import type { DocsImportReport } from "../../types";

vi.mock("../../api/docsImport", () => ({
  docsImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в соседних тестах.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// Валидатор mermaid — ленивый чанк; к диффу пометок он отношения не имеет.
vi.mock("../mermaidLoader", () => ({ validateMermaid: () => Promise.resolve(null) }));

const doc = () => ({
  node_path: "Ярмарка / orders", source: "вставка-1", name: "Списание",
  kind: "overview" as const, operation: null, action: "create" as const,
  mermaid: 'graph TD\n  A["Списать<br>пишет: orders"]',
});

const report = (over: Partial<DocsImportReport> = {}): DocsImportReport =>
  ({
    logic: [doc()], specs: [], errors: [], warnings: [], conflicts: [], applied: false,
    created_docs: 0, updated_docs: 0, specs_written: 0,
    data_refs_total: 0, channel_refs_total: 0, ...over,
  }) as DocsImportReport;

function open() {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(
    <DocsAgentModal nodeId="n1" nodeName="orders" onClose={onClose} onApplied={onApplied} />,
  );
  return { onApplied, onClose };
}

// Пакет вставляется текстом: файловый ввод в jsdom тестировать нечем, а путь тот же.
async function вставить(текст: string) {
  await userEvent.click(screen.getByText("+ вставить из буфера"));
  await печатать(текст);
}

async function печатать(текст: string) {
  await userEvent.type(screen.getByPlaceholderText("вставьте содержимое файла"), текст);
}

// Ответ превью — НОВЫЙ объект на попытку: окно сравнивает отчёты по ссылке, и
// лишний дебаунс-прогон с тем же ответом историю не сдвигает (это и нужно).
async function попытка(r: DocsImportReport, правка: string) {
  vi.mocked(docsImportApi.preview).mockResolvedValue(r);
  await печатать(правка);
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
  await waitFor(() => expect(screen.getByText(r.warnings[0])).toBeInTheDocument());
}

describe("DocsAgentModal · дифф пометок между попытками агента", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => vi.useRealTimers());

  it("падение числа пометок показано обеим семьям", async () => {
    open();
    await вставить("graph TD");
    await попытка(
      report({ warnings: ["попытка 1"], data_refs_total: 83, channel_refs_total: 29 }),
      " A",
    );
    // Агент «починил» замечания ампутацией — этого и не видно было в поле.
    await попытка(
      report({ warnings: ["попытка 2"], data_refs_total: 0, channel_refs_total: 26 }),
      " B",
    );

    expect(screen.getByText(/Пометок данных было 83 → стало 0/)).toBeInTheDocument();
    expect(screen.getByText(/Пометок каналов было 29 → стало 26/)).toBeInTheDocument();
    // Подсказка называет причину, а не только числа: иначе она читается как норма.
    expect(
      screen.getAllByText(/агент мог удалить их вместо починки/).length,
    ).toBe(2);
  });

  it("рост и равенство молчат", async () => {
    open();
    await вставить("graph TD");
    await попытка(
      report({ warnings: ["попытка 1"], data_refs_total: 4, channel_refs_total: 2 }),
      " A",
    );
    // Данных стало больше, каналов столько же — обычный второй заход агента.
    await попытка(
      report({ warnings: ["попытка 2"], data_refs_total: 9, channel_refs_total: 2 }),
      " B",
    );

    expect(screen.queryByText(/Пометок данных было/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Пометок каналов было/)).not.toBeInTheDocument();
  });

  it("первая попытка сравнивать не с чем", async () => {
    open();
    await вставить("graph TD");
    await попытка(
      report({ warnings: ["попытка 1"], data_refs_total: 7, channel_refs_total: 5 }),
      " A",
    );

    // Первый пакет не с чем сравнивать: его собственные числа не должны сыграть
    // роль «было» (перепутанные местами было/стало кричали бы на каждом первом
    // превью — и подсказку перестали бы читать).
    expect(screen.queryByText(/Пометок данных было/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Пометок каналов было/)).not.toBeInTheDocument();
  });

  it("сброс пакета забывает историю попыток", async () => {
    open();
    await вставить("graph TD");
    await попытка(
      report({ warnings: ["попытка 1"], data_refs_total: 12, channel_refs_total: 3 }),
      " A",
    );
    await попытка(
      report({ warnings: ["попытка 2"], data_refs_total: 2, channel_refs_total: 1 }),
      " B",
    );
    expect(screen.getByText(/Пометок данных было 12 → стало 2/)).toBeInTheDocument();

    // Убрали последний файл — дальше грузят ДРУГОЙ пакет, и старые числа дали бы
    // ложную ампутацию.
    await userEvent.click(screen.getByTitle("Убрать файл"));
    await вставить("graph LR");
    await попытка(
      report({ warnings: ["новый пакет"], data_refs_total: 1, channel_refs_total: 0 }),
      " C",
    );

    expect(screen.queryByText(/Пометок данных было/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Пометок каналов было/)).not.toBeInTheDocument();
  });

  it("замечания уносят агенту запрет удалять пометки", async () => {
    // Текст кнопки — вторая половина лечения: без запрета «исправь пакет» читается
    // слабой моделью как разрешение вырезать то, на что жалуется валидатор.
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open();
    await вставить("graph TD");
    await попытка(
      report({ warnings: ["a.mmd: пометка «accounts» — таблица не найдена"] }),
      " A",
    );

    await userEvent.click(screen.getByText("Скопировать замечания для агента"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const текст = writeText.mock.calls[0][0];
    expect(текст).toContain("НЕ удаляй пометки");
    expect(текст).toContain("удаление прячет факт, а не исправляет его");
    expect(текст).toContain("a.mmd: пометка «accounts» — таблица не найдена");
  });
});
