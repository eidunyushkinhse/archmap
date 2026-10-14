// Окно «Конфигурация от агента»: промпт → пакет → превью → применение.
//
// Страховка перед сведением трёх окон фактов в одно (аудит F-9, фаза 7): у окна
// конфигурации своего теста не было. Проверяется то же, что у окна структуры БД, плюс
// своё: подзаголовок без адресации (владелец — сервис окна) и строка параметра.
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ConfigAgentModal from "../docsImport/ConfigAgentModal";
import { configImportApi } from "../../api/docsImport";
import type { ConfigImportReport } from "../../types";

vi.mock("../../api/docsImport", () => ({
  configImportApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в тестах доков.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const report = (over: Partial<ConfigImportReport> = {}): ConfigImportReport =>
  ({ params: [], errors: [], warnings: [], applied: false, params_written: 0, ...over }) as ConfigImportReport;

const param = () => ({
  node_path: "Сервис заказов", source: "config.yaml", name: "ORDER_TTL",
  value_type: "int", required: true, action: "create" as const,
});

function open() {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(<ConfigAgentModal nodeId="svc1" onClose={onClose} onApplied={onApplied} />);
  return { onApplied, onClose };
}

async function вставить(текст: string) {
  await userEvent.click(screen.getByText("+ вставить из буфера"));
  const area = screen.getByPlaceholderText("вставьте содержимое файла");
  await userEvent.clear(area);
  await userEvent.type(area, текст);
}

async function превью() {
  await вставить("config:");
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
}

describe("ConfigAgentModal", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => vi.useRealTimers());

  it("заголовок и подзаголовок своего окна", () => {
    open();
    expect(screen.getByText("Описать конфигурацию с помощью ИИ-агента")).toBeInTheDocument();
    expect(screen.getByText(/в репозитории сервиса/)).toBeInTheDocument();
  });

  it("превью: строка параметра, по умолчанию НЕ перезаписывает", async () => {
    vi.mocked(configImportApi.preview).mockResolvedValue(report({ params: [param()] }));
    open();
    await превью();
    await waitFor(() => expect(configImportApi.preview).toHaveBeenCalled());
    expect(vi.mocked(configImportApi.preview).mock.calls[0][0].overwrite).toBe(false);
    expect(vi.mocked(configImportApi.preview).mock.calls[0][0].nodeId).toBe("svc1");
    expect(screen.getByText("«Сервис заказов» · ORDER_TTL · int · обяз.")).toBeInTheDocument();
    expect(screen.getByText(/Параметров: 1 \(новых 1\)/)).toBeInTheDocument();
  });

  it("пакет с ошибками применить нельзя", async () => {
    vi.mocked(configImportApi.preview).mockResolvedValue(
      report({ errors: ["config.yaml: объект «Х» не найден"] }),
    );
    open();
    await превью();
    await waitFor(() => expect(screen.getByText(/Пакет не применить/)).toBeInTheDocument());
    expect(screen.getByText("Применить")).toBeDisabled();
  });

  it("применение закрывает окно и просит родителя перечитать", async () => {
    vi.mocked(configImportApi.preview).mockResolvedValue(report({ params: [param()] }));
    vi.mocked(configImportApi.apply).mockResolvedValue(report({ applied: true, params_written: 1 }));
    const { onApplied, onClose } = open();
    await превью();
    await waitFor(() => expect(screen.getByText("Применить")).toBeEnabled());
    await userEvent.click(screen.getByText("Применить"));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("замечания уносят агенту «чини, а не удаляй» со своим словом", async () => {
    const w = "config.yaml: у параметра «DB_PASSWORD» заполнено значение по умолчанию";
    vi.mocked(configImportApi.preview).mockResolvedValue(report({ params: [param()], warnings: [w] }));
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    open();
    await превью();
    await waitFor(() => expect(screen.getByText(w)).toBeInTheDocument());
    await userEvent.click(screen.getByText("Скопировать замечания для агента"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const текст = writeText.mock.calls[0][0];
    expect(текст).toContain("Валидатор дозаливки конфигурации ArchMap");
    expect(текст).toContain("Параметры чини по замечаниям, а не удаляй из пакета");
    expect(текст).toContain(w);
  });

  it("тумблер перезаписи уезжает в запрос", async () => {
    vi.mocked(configImportApi.preview).mockResolvedValue(report({ params: [param()] }));
    open();
    await вставить("config:");
    await userEvent.click(screen.getByLabelText(/Перезаписывать заполненное/));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await waitFor(() => expect(
      vi.mocked(configImportApi.preview).mock.calls.at(-1)?.[0].overwrite,
    ).toBe(true));
  });
});
