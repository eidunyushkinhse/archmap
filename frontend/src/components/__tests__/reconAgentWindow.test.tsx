// Окно «Составить список операций с помощью ИИ-агента»: страховочная сетка поведения перед
// разрезом окна и переводом на новый язык (редизайн, фаза 6г). Тесты держатся за поведение:
// задание агенту по объекту окна, файл даёт превью по объекту окна, разделы отчёта по
// действию с числами, объект списка назван, длинный раздел свёрнут, ошибки запрещают
// применять, применение уходит с объектом окна и закрывает окно, замечания уходят агенту.
//
// Где окно рисуется по-разному (кнопка задания, снятие файла, объект списка), вид спрятан в
// помощники ниже: сетка написана на прежнем окне, после перевода меняются только помощники.
// Modal настоящий (test-setup открывает <dialog> атрибутом open).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReconAgentModal from "../docsImport/ReconAgentModal";
import { reconApi } from "../../api/docsImport";
import type { ReconImportReport, ReconItem } from "../../types";

vi.mock("../../api/docsImport", () => ({
  reconApi: { prompt: vi.fn(), preview: vi.fn(), apply: vi.fn() },
}));

const WAIT = { timeout: 3000 };

const item = (over: Partial<ReconItem> = {}): ReconItem => ({
  name: "POST /orders", kind: "operation", operation: "POST /orders", action: "create", doc_name: null, ...over,
});
const report = (over: Partial<ReconImportReport> = {}): ReconImportReport => ({
  node_path: "Ярмарка / Заказы / Order API", items: [item()], errors: [], warnings: [],
  applied: false, created: 0, ...over,
});
const ЧЕТЫРЕ = [
  item({ name: "GET /orders" }),
  item({ name: "PATCH /orders/{id}" }),
  item({ name: "order_saga_worker", kind: "worker", operation: null, action: "unchanged" }),
  item({ name: "POST /orders", action: "described", doc_name: "Создание заказа" }),
  item({ name: "GET /orders/{id}", action: "vanished", doc_name: "Получение заказа" }),
];

const onClose = vi.fn();
const onApplied = vi.fn();
function open() {
  render(<ReconAgentModal nodeId="n1" nodeName="Order API" onClose={onClose} onApplied={onApplied} />);
}

// ── помощники вида ───────────────────────────────────────────────────────────
const кнопкаЗадания = () => screen.getByRole("button", { name: "Скопировать промпт" });
const fileInput = () => document.querySelector("dialog input[type=file]") as HTMLInputElement;
const применить = () => screen.getByRole("button", { name: "Применить" });
const раздел = (title: string, n: number) =>
  screen.getByRole("button", { name: new RegExp(`^${title}\\s*${n}$`) });
const объектСписка = () => screen.getByText(/Zulip \/ backend/);

async function положить(r: ReconImportReport = report()) {
  vi.mocked(reconApi.preview).mockResolvedValue(r);
  await userEvent.upload(fileInput(), new File(["# archmap-recon\noperations:\n  - GET /x\n"], "recon.yaml"));
  await waitFor(() => expect(reconApi.preview).toHaveBeenCalled(), WAIT);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reconApi.prompt).mockResolvedValue({ prompt: "задание" });
  vi.mocked(reconApi.apply).mockResolvedValue(report({ applied: true, created: 1 }));
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

describe("список операций: задание и превью", () => {
  it("заголовок; задание агенту по объекту окна, с аудитом", async () => {
    open();
    expect(screen.getByRole("heading", { name: "Составить список операций с помощью ИИ-агента" })).toBeInTheDocument();
    await userEvent.click(кнопкаЗадания());
    await waitFor(() => expect(reconApi.prompt).toHaveBeenCalledWith("n1", "orchestrated"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("задание");
  });

  it("файл даёт превью по объекту окна; разделы по действию с числами", async () => {
    open();
    await положить(report({ items: ЧЕТЫРЕ }));
    expect(vi.mocked(reconApi.preview).mock.calls[0][0]).toEqual({
      files: [{ name: "recon.yaml", content: "# archmap-recon\noperations:\n  - GET /x\n" }], nodeId: "n1",
    });
    expect(await screen.findByText(/Операций и воркеров в списке: 4 \(новых 2\)/, {}, WAIT)).toBeInTheDocument();
    expect(раздел("Создадим неописанные схемы", 2)).toBeInTheDocument();
    expect(раздел("Неописанные схемы уже есть", 1)).toBeInTheDocument();
    expect(раздел("Уже описаны, их не тронем", 1)).toBeInTheDocument();
    expect(раздел("Есть в документации, но не найдено в коде", 1)).toBeInTheDocument();
    expect(screen.getByText("Повторный сбор списка не затирает работу: описанная схема остаётся как есть.")).toBeInTheDocument();
    expect(screen.getByText("ArchMap ничего не удаляет. Если схема больше не нужна, удалите её сами.")).toBeInTheDocument();
    expect(screen.getByText("→ Создание заказа")).toBeInTheDocument();
  });

  it("объект, которому уедет список, назван", async () => {
    open();
    await положить(report({ node_path: "Zulip / backend" }));
    await screen.findByText(/Операций и воркеров в списке: 1/, {}, WAIT);
    expect(объектСписка()).toBeInTheDocument();
  });

  it("длинный раздел стартует свёрнутым и раскрывается", async () => {
    open();
    await положить(report({ items: Array.from({ length: 40 }, (_, i) => item({ name: `GET /r${i}` })) }));
    await screen.findByText(/новых 40/, {}, WAIT);
    expect(screen.queryByText("GET /r0")).toBeNull();
    await userEvent.click(раздел("Создадим неописанные схемы", 40));
    expect(screen.getByText("GET /r0")).toBeInTheDocument();
    expect(screen.getByText("GET /r39")).toBeInTheDocument();
  });

  it("битый список: «Список не применить:», применять нельзя", async () => {
    open();
    await положить(report({ items: [], errors: ["recon.yaml: объект «Нет такого объекта» не найден"] }));
    expect(await screen.findByText("Список не применить:", {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText("recon.yaml: объект «Нет такого объекта» не найден")).toBeInTheDocument();
    expect(применить()).toBeDisabled();
  });

  it("применение уходит с объектом окна и закрывает окно", async () => {
    open();
    await положить();
    await screen.findByText(/Операций и воркеров в списке: 1/, {}, WAIT);
    await userEvent.click(применить());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onApplied).toHaveBeenCalledOnce();
    expect(vi.mocked(reconApi.apply).mock.calls[0][0]).toEqual({
      files: [{ name: "recon.yaml", content: "# archmap-recon\noperations:\n  - GET /x\n" }], nodeId: "n1",
    });
  });

  it("замечания: «Проверьте:», копия для агента «чини, а не удаляй»", async () => {
    const w = "recon.yaml: повторов строк убрано: 2";
    open();
    await положить(report({ warnings: [w] }));
    expect(await screen.findByText("Проверьте:", {}, WAIT)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Скопировать замечания для агента" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const текст = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(текст).toContain("Строки чини по замечаниям, а не удаляй из списка");
    expect(текст).toContain(w);
  });
});
