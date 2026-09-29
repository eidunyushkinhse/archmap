// Окно «Список операций от агента»: промпт → перечень → превью → применение.
//
// Проверяется то, что отличает это окно от четырёх соседних: превью группируется ПО
// ДЕЙСТВИЮ (перечень монолита — двести строк, плоский столбец в нём нечитаем),
// политики «перезаписывать» здесь нет вовсе, а «исчезло из кода» обязано говорить,
// что ничего не удаляется.
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ReconAgentModal from "../docsImport/ReconAgentModal";
import { reconApi } from "../../api/docsImport";
import type { ReconImportReport, ReconItem } from "../../types";

vi.mock("../../api/docsImport", () => ({
  reconApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в тестах соседей.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const report = (over: Partial<ReconImportReport> = {}): ReconImportReport => ({
  node_path: "Zulip / backend", items: [], errors: [], warnings: [],
  applied: false, created: 0, ...over,
});

const item = (over: Partial<ReconItem> = {}): ReconItem => ({
  name: "POST /messages", kind: "operation", operation: "POST /messages",
  action: "create", doc_name: null, ...over,
});

function open() {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(<ReconAgentModal nodeId="n1" nodeName="backend" onClose={onClose} onApplied={onApplied} />);
  return { onApplied, onClose };
}

// Перечень вставляется текстом: файловый ввод в jsdom тестировать нечем, путь тот же.
async function вставить(текст: string) {
  await userEvent.click(screen.getByText("+ вставить из буфера"));
  const area = screen.getByPlaceholderText("вставьте содержимое файла");
  await userEvent.clear(area);
  await userEvent.type(area, текст);
}

async function превью(r: ReconImportReport) {
  vi.mocked(reconApi.preview).mockResolvedValue(r);
  const ctx = open();
  await вставить("operations:");
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
  await waitFor(() => expect(reconApi.preview).toHaveBeenCalled());
  return ctx;
}

describe("ReconAgentModal", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => vi.useRealTimers());

  it("окно названо по семье — «Составить список операций с помощью ИИ-агента»", () => {
    // Форма заголовка — общая с четырьмя соседними окнами («Описать логику с помощью
    // агента» и прочие), а первые три слова дословно совпадают с пунктом меню:
    // разъедутся — человек не поймёт, куда попал.
    open();
    expect(screen.getByRole("heading", { name: "Составить список операций с помощью ИИ-агента" }))
      .toBeInTheDocument();
  });

  it("слова «разведка» нет в названии окна и в отчёте превью", async () => {
    // Название выбрано пользователем «без слова „разведка“ и без „точек входа“».
    // В подзаголовке «проведет разведку» — дословный текст пользователя (2026-09-29),
    // поэтому сторож проверяет всё, кроме подзаголовка.
    await превью(report({
      items: [
        item({ name: "POST /messages", action: "described", doc_name: "Отправка" }),
        item({ name: "DELETE /legacy", action: "vanished" }),
      ],
    }));
    await waitFor(() => expect(screen.getByText(/Повторный сбор списка не затирает работу/)).toBeInTheDocument());
    const sub = screen.getByText(/проведет разведку/);
    const rest = (document.body.textContent ?? "").replace(sub.textContent ?? "", "");
    expect(rest).not.toMatch(/разведк/i);
  });

  it("превью группируется по действию, числа — в заголовках групп", async () => {
    await превью(report({
      items: [
        item({ name: "POST /messages" }),
        item({ name: "GET /messages", action: "create" }),
        item({ name: "email_senders", kind: "worker", operation: null, action: "unchanged" }),
        item({ name: "POST /users", action: "described", doc_name: "Регистрация" }),
        item({ name: "DELETE /legacy", action: "vanished" }),
      ],
    }));

    await waitFor(() => expect(screen.getByText(/Точек входа в перечне: 4 \(новых 2\)/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Создадим заглушки\s*2$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Заглушки уже есть\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Уже описаны — не тронем\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Есть в документации, но не найдено в коде\s*1$/ })).toBeInTheDocument();
    // Объект, которому уедет перечень, назван: адрес мог прийти из самого файла.
    expect(screen.getByText(/объект «Zulip \/ backend»/)).toBeInTheDocument();
  });

  it("группы с нулём строк не показываются вовсе", async () => {
    await превью(report({ items: [item({ name: "POST /messages" })] }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Создадим заглушки\s*1$/ })).toBeInTheDocument());
    expect(screen.queryByText("Заглушки уже есть")).toBeNull();
    expect(screen.queryByText("Уже описаны — не тронем")).toBeNull();
    expect(screen.queryByText("Есть в документации, но не найдено в коде")).toBeNull();
  });

  it("«уже описана» называет схему, которая закрыла операцию", async () => {
    // Ключ сопоставления берёт и поле operation: «POST /messages» бывает описан
    // схемой «Отправка сообщения», и человек должен видеть, ЧТО именно её закрыло.
    await превью(report({
      items: [item({ name: "POST /messages", action: "described", doc_name: "Отправка сообщения" })],
    }));
    await waitFor(() => expect(screen.getByText("POST /messages")).toBeInTheDocument());
    expect(screen.getByText("→ Отправка сообщения")).toBeInTheDocument();
    expect(screen.getByText(/Повторный сбор списка не затирает работу/)).toBeInTheDocument();
  });

  it("«исчезло из кода» говорит, что ничего не удаляется", async () => {
    await превью(report({ items: [item({ name: "DELETE /legacy", action: "vanished" })] }));
    await waitFor(() => expect(screen.getByText(/Ничего не удаляем/)).toBeInTheDocument());
    // Строк перечня нет — применять нечего.
    expect(screen.getByText("Применить")).toBeDisabled();
  });

  it("длинная группа стартует свёрнутой: двести строк не выталкивают «Применить»", async () => {
    const много = Array.from({ length: 40 }, (_, i) => item({ name: `GET /r${i}` }));
    await превью(report({ items: много }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Создадим заглушки\s*40$/ })).toBeInTheDocument());
    expect(screen.queryByText("GET /r0")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /^Создадим заглушки\s*40$/ }));
    expect(screen.getByText("GET /r0")).toBeInTheDocument();
  });

  it("перечень с ошибками применить нельзя", async () => {
    await превью(report({ errors: ["recon.yaml: объект «Х» не найден"] }));
    await waitFor(() => expect(screen.getByText(/Перечень не применить/)).toBeInTheDocument());
    expect(screen.getByText("Применить")).toBeDisabled();
  });

  it("применение зовёт ручку, закрывает окно и просит родителя перечитать", async () => {
    const { onApplied, onClose } = await превью(report({ items: [item()] }));
    vi.mocked(reconApi.apply).mockResolvedValue(report({ applied: true, created: 1 }));
    await waitFor(() => expect(screen.getByText("Применить")).toBeEnabled());

    await userEvent.click(screen.getByText("Применить"));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    // Адрес объекта уезжает с перечнем: файл без строки «node:» приедет к нему.
    expect(vi.mocked(reconApi.apply).mock.calls[0][0].nodeId).toBe("n1");
  });

  it("политики перезаписи у окна нет — ни тумблера, ни поля в запросе", async () => {
    await превью(report({ items: [item()] }));
    expect(screen.queryByLabelText(/Перезаписывать/)).toBeNull();
    const запрос = vi.mocked(reconApi.preview).mock.calls[0][0];
    expect(запрос).not.toHaveProperty("overwrite");
  });

  it("замечания уносят агенту «чини, а не удаляй»", async () => {
    const w = "recon.yaml: перечень пуст";
    await превью(report({ warnings: [w] }));
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await waitFor(() => expect(screen.getByText(w)).toBeInTheDocument());

    await userEvent.click(screen.getByText("Скопировать замечания для агента"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const текст = writeText.mock.calls[0][0];
    expect(текст).toContain("Строки чини по замечаниям, а не удаляй из перечня");
    expect(текст).toContain(w);
    // Замечания уезжают агенту текстом, который пользователь видит и правит, —
    // слова «разведка» нет и здесь.
    expect(текст).not.toMatch(/разведк/i);
  });
});
