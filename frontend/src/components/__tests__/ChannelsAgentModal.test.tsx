// Окно «Описать каналы»: промпт → пакет → превью → применение.
//
// Проверяется то, что отличает это окно от трёх соседних (схемы логики, спека,
// структура БД): свой контракт дозаливки, честный подзаголовок про «прогоняй в каждом
// репозитории» (у брокера нет репозитория-владельца — узнать это после первого пустого
// пакета поздно), расхождение меты в замечаниях и запрет применять пакет с ошибками.
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChannelsAgentModal from "../docsImport/ChannelsAgentModal";
import { channelsImportApi } from "../../api/docsImport";
import type { ChannelsImportReport } from "../../types";

vi.mock("../../api/docsImport", () => ({
  channelsImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в тестах доков.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const report = (over: Partial<ChannelsImportReport> = {}): ChannelsImportReport =>
  ({
    channels: [], errors: [], warnings: [], applied: false,
    channels_written: 0, fields_written: 0, ...over,
  }) as ChannelsImportReport;

const channel = () => ({
  node_path: "Шина", source: "channels.yaml", group_name: "", name: "orders.created",
  fields: 3, action: "create" as const,
});

function open() {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(
    <ChannelsAgentModal nodeId="b1" nodeName="Шина" onClose={onClose} onApplied={onApplied} />,
  );
  return { onApplied, onClose };
}

// Пакет вставляется текстом: файловый ввод в jsdom тестировать нечем, а путь тот же.
async function вставить(текст: string) {
  await userEvent.click(screen.getByText("+ вставить из буфера"));
  const area = screen.getByPlaceholderText("вставьте содержимое файла");
  await userEvent.clear(area);
  await userEvent.type(area, текст);
}

describe("ChannelsAgentModal", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => vi.useRealTimers());

  it("превью показывает, что приедет, и по умолчанию НЕ перезаписывает", async () => {
    vi.mocked(channelsImportApi.preview).mockResolvedValue(report({ channels: [channel()] }));
    open();
    await вставить("channels:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(channelsImportApi.preview).toHaveBeenCalled());
    expect(vi.mocked(channelsImportApi.preview).mock.calls[0][0].overwrite).toBe(false);
    expect(screen.getByText(/Шина.*orders\.created.*полей 3/)).toBeInTheDocument();
  });

  it("окно честно говорит, где запускать агента", async () => {
    // Главное отличие от «Структуры»: репозитория-владельца у брокера нет. Пользователь,
    // прогнавший агента один раз «где-то», получит четверть каналов и решит, что фича
    // не работает, — поэтому правило стоит в подзаголовке, до кнопки промпта.
    open();
    expect(screen.getByText("Описать каналы с помощью ИИ-агента")).toBeInTheDocument();
    expect(screen.getByText(/КАЖДОМ репозитории, который ходит в брокер/)).toBeInTheDocument();
    // Адресация названа точно: к объекту окна уедет файл БЕЗ «# archmap-node:».
    expect(screen.getByText(/без\s+адреса .* приедут к объекту «Шина»/)).toBeInTheDocument();
  });

  it("пакет с ошибками применить нельзя", async () => {
    vi.mocked(channelsImportApi.preview).mockResolvedValue(
      report({ errors: ["channels.yaml: объект «Х» — не брокер"] }),
    );
    open();
    await вставить("channels:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(screen.getByText(/Пакет не применить/)).toBeInTheDocument());
    expect(screen.getByText("Применить")).toBeDisabled();
  });

  it("расхождение меты показано и уезжает агенту одной кнопкой", async () => {
    // Два репозитория честно видят разный retention: применению это не мешает
    // (побеждает описанное раньше), но человек обязан увидеть расхождение — и уметь
    // отдать его агенту, не переписывая руками.
    const w = "channels.yaml: канал «orders.created» — retention в пакете «30d», "
      + "в ArchMap «7d»; оставлено значение из ArchMap (перезапись выключена)";
    vi.mocked(channelsImportApi.preview).mockResolvedValue(
      report({ channels: [channel()], warnings: [w] }),
    );
    // jsdom не даёт navigator.clipboard — подменяем целиком (как в ImportPane.test).
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open();
    await вставить("channels:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(screen.getByText(w)).toBeInTheDocument());
    expect(screen.getByText("Применить")).toBeEnabled();

    await userEvent.click(screen.getByText("Скопировать замечания для агента"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const текст = writeText.mock.calls[0][0];
    expect(текст).toContain("Валидатор дозаливки каналов ArchMap нашёл замечания");
    expect(текст).toContain(w);
  });

  it("применение закрывает окно и просит родителя перечитать", async () => {
    vi.mocked(channelsImportApi.preview).mockResolvedValue(report({ channels: [channel()] }));
    vi.mocked(channelsImportApi.apply).mockResolvedValue(
      report({ applied: true, channels_written: 1, fields_written: 3 }),
    );
    const { onApplied, onClose } = open();
    await вставить("channels:");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(screen.getByText("Применить")).toBeEnabled());
    await userEvent.click(screen.getByText("Применить"));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("тумблер перезаписи уезжает в запрос", async () => {
    vi.mocked(channelsImportApi.preview).mockResolvedValue(report({ channels: [channel()] }));
    open();
    await вставить("channels:");
    await userEvent.click(screen.getByLabelText(/Перезаписывать заполненное/));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(
      vi.mocked(channelsImportApi.preview).mock.calls.at(-1)?.[0].overwrite,
    ).toBe(true));
  });
});
