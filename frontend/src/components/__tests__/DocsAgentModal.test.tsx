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
// Валидатор mermaid — ленивый чанк; в тестах вместо него мок, вердикт задаёт тест
// (по умолчанию — «схема парсится»).
const { validateMermaidMock } = vi.hoisted(() => ({ validateMermaidMock: vi.fn() }));
vi.mock("../mermaidLoader", () => ({ validateMermaid: validateMermaidMock }));

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
  beforeEach(() => {
    vi.clearAllMocks();
    validateMermaidMock.mockResolvedValue(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
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

  it("замечания уносят агенту одну цель починки и запрет удалять пометки", async () => {
    // Текст кнопки — вторая половина лечения: без запрета «исправь пакет» читается
    // слабой моделью как разрешение вырезать то, на что жалуется валидатор.
    // И цель должна быть ОДНА: «имя ИЛИ квалификатор» слабая модель отрабатывает
    // дешёвой механикой — добавляет квалификатор, следующим кругом снимает, а имя
    // так и не сверяет (находка №1 docs/qa-zulip-brokers.md).
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open();
    await вставить("graph TD");
    await попытка(
      report({ warnings: ["a.mmd: пометка «accounts» — таблица не найдена — похоже на «accounts_v2»"] }),
      " A",
    );

    await userEvent.click(screen.getByText("Скопировать замечания для агента"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const текст = writeText.mock.calls[0][0];
    expect(текст).toContain("чини ДОСЛОВНЫМ именем");
    expect(текст).toContain("бери его из подсказки «похоже на …» в замечании");
    // Квалификатор не запрещён — у него теперь названо условие применения.
    expect(текст).toContain("ТОЛЬКО когда одинаковое имя есть у разных узлов");
    expect(текст).toContain("НЕ удаляй пометки");
    expect(текст).toContain("удаление прячет факт, а не исправляет его");
    expect(текст).toContain("a.mmd: пометка «accounts» — таблица не найдена — похоже на «accounts_v2»");
  });

  it("непарсящаяся схема видна над сводкой и уезжает агенту файлом", async () => {
    // Полевая находка (Zulip v2): 9 из 30 применённых схем не парсились, а окно
    // показывало только значок ✗ в строке файла — в списке на три десятка схем он
    // теряется, и пакет применяют целиком. Значит: строка НАД сводкой + замечание
    // с именем ФАЙЛА (чинит агент файлы, а не «схемы такого-то узла»).
    validateMermaidMock.mockResolvedValue(
      'Parse error on line 7:\n...F{"Есть вложения?"]\n--------^\nExpecting SQE',
    );
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open();
    await вставить("graph TD");
    await попытка(report({ warnings: ["замечание бэка"] }), " A");

    expect(await screen.findByText(/Не парсятся mermaid: 1 из 1 схем/)).toBeInTheDocument();

    await userEvent.click(screen.getByText("Скопировать замечания для агента"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const текст = writeText.mock.calls[0][0];
    expect(текст).toContain("вставка-1: mermaid не парсится — Parse error on line 7:");
    // Замечание бэка при этом не потерялось — списки складываются.
    expect(текст).toContain("замечание бэка");
  });
});

// ── Окно, открытое с адресом точки входа ────────────────────────────────────
// Кнопка «Описать» у неописанной строки списка схем открывает это же окно, но уже
// заполненным: режим «по одной» и адрес в поле «Что описать» (docs/plan-recon.md,
// Ф2). Механику переизобретать было не нужно — нужен был только адрес.
describe("DocsAgentModal · адрес точки входа из списка схем", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateMermaidMock.mockResolvedValue(null);
  });

  it("режим «по одной» и «Что описать» заполнены с порога, адрес уезжает в промпт", async () => {
    vi.mocked(docsImportApi.prompt).mockResolvedValue({ prompt: "промпт" });
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <DocsAgentModal
        nodeId="n1"
        nodeName="orders"
        initialMode="single"
        initialTarget="POST /orders"
        onClose={vi.fn()}
        onApplied={vi.fn()}
      />,
    );

    // Поле «Что описать» есть только в режиме «по одной» — значит и режим доехал.
    expect(screen.getByDisplayValue("POST /orders")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Скопировать промпт"));
    await waitFor(() => expect(docsImportApi.prompt).toHaveBeenCalled());
    expect(vi.mocked(docsImportApi.prompt).mock.calls[0][0].target).toBe("POST /orders");
  });

  it("без адреса окно прежнее: пакетом и с пустым полем", async () => {
    render(<DocsAgentModal nodeId="n1" nodeName="orders" onClose={vi.fn()} onApplied={vi.fn()} />);
    expect(screen.queryByText("Что описать")).toBeNull();
  });
});
