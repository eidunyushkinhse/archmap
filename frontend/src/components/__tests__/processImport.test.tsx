// Окно «Импорт процессов» (редизайн, фаза 3б): превью без кнопки, только проблемы,
// сопоставление, импорт пачкой, предел демо, отказ.
//
// Ключевые обещания: превью считается само и ничего не пишет; ответ на устаревший текст
// не перетирает новый; пользователь НЕ обязан сопоставить каждого участника
// (несопоставленные заводятся непривязанными, и об этом сказано до импорта); непонятые
// строки и потерянные привязки видны, а не выпадают молча; без названия импорт не идёт.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessImportModal from "../processes/ProcessImportModal";
import { processesApi } from "../../api/processes";
import { ApiError, DEMO_LIMIT_CODE } from "../../api/client";
import type { ProcessImportPreview, ProcessImportResult } from "../../types";

// Modal настоящий (test-setup открывает <dialog> атрибутом open): подтверждение по Enter
// идёт через него.
vi.mock("../../api/processes", () => ({
  processesApi: { importPreview: vi.fn(), importProcess: vi.fn() },
}));

const WAIT = { timeout: 3000 };

type Step = ProcessImportPreview["steps"][number];
const step = (order: number, status: Step["status"], over: Partial<Step> = {}): Step => ({
  order, from_name: "Покупатель", to_name: "Биллинг", caption: `шаг ${order + 1}`,
  status, doc_address: null, doc_status: null, ...over,
});

// Без проблем: все участники сопоставились, все шаги на связях.
const CLEAN: ProcessImportPreview = {
  name: "Импортированный процесс",
  participants: [
    { alias: "P1", name: "Покупатель", node_id: "n1", candidates: [{ id: "n1", name: "Покупатель", parent_name: null }] },
    { alias: "P2", name: "Веб-витрина", node_id: "n2", candidates: [{ id: "n2", name: "Веб-витрина", parent_name: null }] },
  ],
  message_count: 2, fragment_count: 0, unsupported: [], doc_refs: 0,
  steps: [step(0, "attached"), step(1, "attached")],
  attached: 2, dangling: 0, self_messages: 0,
};

// С проблемами: участник без объекта (двое тёзок), шаг без связи, непонятая строка,
// ненайденная привязка к схеме логики.
const PROBLEMS: ProcessImportPreview = {
  ...CLEAN,
  participants: [
    CLEAN.participants[0],
    {
      alias: "P2", name: "Биллинг", node_id: null,
      candidates: [
        { id: "b1", name: "Биллинг", parent_name: "Сервис оплаты" },
        { id: "b2", name: "Биллинг", parent_name: "Бухгалтерия" },
      ],
    },
  ],
  message_count: 3, fragment_count: 1,
  unsupported: ["autonumber"],
  steps: [
    step(0, "unbound", { caption: "выставить счёт" }),
    step(1, "attached", { doc_address: "Ярмарка / Нет схемы", doc_status: "unresolved" }),
    step(2, "self"),
  ],
};

const RESULT: ProcessImportResult = {
  process_id: "p9", participants: 2, unbound: 1, messages: 2,
  attached: 1, dangling: 1, self_messages: 0, fragments: 1, unsupported: [],
  doc_linked: 0, doc_unresolved: 0,
};

const SEQ = "sequenceDiagram\n    P1->>P2: шаг";

function renderModal() {
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(<ProcessImportModal onClose={onClose} onImported={onImported} />);
  return { onImported, onClose };
}

const textarea = () => screen.getByPlaceholderText(/sequenceDiagram/) as HTMLTextAreaElement;
const nameField = () => screen.getByRole("textbox", { name: "Название процесса" }) as HTMLInputElement;
const importButton = () => screen.getByRole("button", { name: /^Импортировать/ });
const fileInput = () => document.querySelector("dialog input[type=file]") as HTMLInputElement;

function paste(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
}
// Текст с названием в шапке: без названия кнопка заперта, и ждать её было бы нечего.
async function pasteAndWait(body: string, calls = 1) {
  paste(`---\ntitle: Оплата\n---\n${body}`);
  await waitFor(() => expect(processesApi.importPreview).toHaveBeenCalledTimes(calls), WAIT);
  await waitFor(() => expect(importButton()).not.toBeDisabled(), WAIT);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.importPreview).mockResolvedValue(CLEAN);
  vi.mocked(processesApi.importProcess).mockResolvedValue(RESULT);
});

describe("импорт процессов: превью без кнопки", () => {
  it("кнопки «Разобрать» нет; пустой текст импортировать нечего", () => {
    renderModal();
    expect(screen.queryByRole("button", { name: "Разобрать" })).toBeNull();
    expect(importButton()).toBeDisabled();
  });

  it("превью уходит само после паузы в правке, текст без шапки и без title", async () => {
    renderModal();
    paste(`---\ntitle: Оплата заказа\n---\nsequenceDiagram\n    title Оплата\n    P1->>P2: шаг`);
    expect(processesApi.importPreview).not.toHaveBeenCalled(); // пауза ещё не прошла

    await waitFor(() => expect(processesApi.importPreview).toHaveBeenCalledOnce(), WAIT);
    expect(processesApi.importPreview).toHaveBeenCalledWith({
      text: "sequenceDiagram\n    P1->>P2: шаг", overrides: null,
    });
    expect(nameField().value).toBe("Оплата заказа"); // название из шапки
    expect(processesApi.importProcess).not.toHaveBeenCalled(); // превью ничего не пишет
  });

  it("ответ на устаревший текст отбрасывается", async () => {
    const pending: Array<(p: ProcessImportPreview) => void> = [];
    vi.mocked(processesApi.importPreview).mockImplementation(
      () => new Promise<ProcessImportPreview>((res) => { pending.push(res); }),
    );
    renderModal();
    paste("---\ntitle: Оплата\n---\nsequenceDiagram\n    P1->>P2: старый");
    await waitFor(() => expect(pending).toHaveLength(1), WAIT);
    paste("---\ntitle: Оплата\n---\nsequenceDiagram\n    P1->>P2: новый");
    await waitFor(() => expect(pending).toHaveLength(2), WAIT);

    pending[1](CLEAN); // свежий ответ пришёл первым…
    await waitFor(() => expect(importButton()).not.toBeDisabled(), WAIT);
    pending[0](PROBLEMS); // …а медленный ответ на прежний текст — позже

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Биллинг")).toBeNull();
    expect(screen.queryByText(/без связи на схеме/)).toBeNull();
  });

  it("отказ разбора виден у черновика, импорт не идёт", async () => {
    vi.mocked(processesApi.importPreview).mockRejectedValue(new Error("Текст больше предела"));
    renderModal();
    paste(SEQ);

    expect(await screen.findByText("Текст больше предела", undefined, WAIT)).toBeTruthy();
    expect(importButton()).toBeDisabled();
  });
});

describe("импорт процессов: только проблемы", () => {
  it("без проблем под черновиком только тихое «Сопоставлено N»", async () => {
    renderModal();
    await pasteAndWait(SEQ);

    expect(screen.getByRole("button", { name: /Сопоставлено 2/ })).toBeTruthy();
    // Счётчиков «шагов · фрагментов» и подписи участников больше нет.
    expect(screen.queryByText(/Шагов:/)).toBeNull();
    expect(screen.queryByText(/Участники/)).toBeNull();
    expect(screen.queryByText("Покупатель")).toBeNull(); // сопоставившийся сам — свёрнут
  });

  it("проблемы называют участника без объекта, шаги без связи, непонятые строки и привязки", async () => {
    vi.mocked(processesApi.importPreview).mockResolvedValue(PROBLEMS);
    renderModal();
    await pasteAndWait(SEQ);

    expect(screen.getByText("Биллинг")).toBeTruthy();
    // Тёзки различаются родителем в скобках.
    expect(screen.getByRole("option", { name: "Биллинг (Сервис оплаты)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /1 шаг без связи на схеме/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Не разобрана 1 строка/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /1 привязка к схеме логики не найдена/ })).toBeTruthy();

    // Списки — по клику.
    expect(screen.queryByText("Покупатель → Биллинг, выставить счёт")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /без связи на схеме/ }));
    expect(screen.getByText("Покупатель → Биллинг, выставить счёт")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Не разобрана/ }));
    expect(screen.getByText("autonumber")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /привязка к схеме логики/ }));
    expect(screen.getByText("Ярмарка / Нет схемы")).toBeTruthy();
  });
});

describe("импорт процессов: сопоставление", () => {
  it("выбор объекта уходит в превью уточнением и в импорт сопоставлением", async () => {
    vi.mocked(processesApi.importPreview).mockResolvedValue(PROBLEMS);
    renderModal();
    await pasteAndWait(SEQ);

    await userEvent.selectOptions(screen.getByRole("combobox"), "b2");
    await waitFor(() => expect(processesApi.importPreview).toHaveBeenCalledTimes(2), WAIT);
    expect(processesApi.importPreview).toHaveBeenLastCalledWith({ text: SEQ, overrides: { P2: "b2" } });
    await waitFor(() => expect(importButton()).not.toBeDisabled(), WAIT);

    await userEvent.click(importButton());
    await waitFor(() =>
      expect(processesApi.importProcess).toHaveBeenCalledWith({
        text: SEQ, name: "Оплата", mapping: { P1: "n1", P2: "b2" },
      }),
    );
  });

  it("снятое сопоставление уходит как null", async () => {
    renderModal();
    await pasteAndWait(SEQ);
    await userEvent.click(screen.getByRole("button", { name: /Сопоставлено/ }));

    await userEvent.selectOptions(screen.getAllByRole("combobox")[0], "");
    await waitFor(() => expect(processesApi.importPreview).toHaveBeenCalledTimes(2), WAIT);
    await waitFor(() => expect(importButton()).not.toBeDisabled(), WAIT);
    await userEvent.click(importButton());

    await waitFor(() =>
      expect(processesApi.importProcess).toHaveBeenCalledWith(
        expect.objectContaining({ mapping: { P1: null, P2: "n2" } }),
      ),
    );
  });
});

describe("импорт процессов: название", () => {
  it("у вставленного текста без title названия нет, без него импорт не идёт", async () => {
    renderModal();
    await waitFor(() => expect(importButton()).toBeDisabled());
    paste(SEQ);
    await waitFor(() => expect(processesApi.importPreview).toHaveBeenCalledOnce(), WAIT);
    await new Promise((r) => setTimeout(r, 50));

    expect(nameField().value).toBe("");
    expect(importButton()).toBeDisabled();
    await userEvent.type(nameField(), "Возврат");
    expect(importButton()).not.toBeDisabled();
  });

  it("Enter в поле названия импортирует, итогового экрана нет: окно отдаёт id и закрывается", async () => {
    const { onImported } = renderModal();
    await pasteAndWait(SEQ);

    await userEvent.type(nameField(), "{Enter}");

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(["p9"], true));
    expect(processesApi.importProcess).toHaveBeenCalledWith({ text: SEQ, name: "Оплата", mapping: { P1: "n1", P2: "n2" } });
    expect(screen.queryByText("Процесс создан")).toBeNull();
  });
});

describe("импорт процессов: файлы и пачка", () => {
  const file = (name: string, text: string) => new File([text], name, { type: "text/plain" });

  it("три файла — три черновика с названиями из имён, кнопка называет число", async () => {
    renderModal();
    await userEvent.upload(fileInput(), [
      file("Оформление заказа.mmd", SEQ), file("Оплата заказа.mmd", SEQ), file("Возврат.txt", SEQ),
    ]);

    await waitFor(() => expect(processesApi.importPreview).toHaveBeenCalledTimes(3), WAIT);
    const names = screen.getAllByRole("textbox", { name: "Название процесса" }).map((i) => (i as HTMLInputElement).value);
    expect(names).toEqual(["Оформление заказа", "Оплата заказа", "Возврат"]);
    expect(await screen.findByRole("button", { name: "Импортировать 3 процесса" }, WAIT)).not.toBeDisabled();
    expect(screen.getAllByText("2 шага")).toHaveLength(3); // справа тихо число шагов
  });

  it(".md с двумя блоками — два черновика, название из заголовка над блоком", async () => {
    renderModal();
    const md = ["## Оформление заказа", "```mermaid", SEQ, "```", "## Возврат", "```mermaid", SEQ, "```"].join("\n");
    await userEvent.upload(fileInput(), [file("процессы.md", md)]);

    await waitFor(() => expect(screen.getAllByRole("textbox", { name: "Название процесса" })).toHaveLength(2), WAIT);
    const names = screen.getAllByRole("textbox", { name: "Название процесса" }).map((i) => (i as HTMLInputElement).value);
    expect(names).toEqual(["Оформление заказа", "Возврат"]);
  });

  it("строка без проблем свёрнута, с проблемами раскрыта", async () => {
    vi.mocked(processesApi.importPreview).mockImplementation(({ text }) =>
      Promise.resolve(text.includes("плохой") ? PROBLEMS : CLEAN));
    renderModal();
    await userEvent.upload(fileInput(), [
      file("Хороший.mmd", SEQ), file("Плохой.mmd", `${SEQ}\n%% плохой`),
    ]);

    await screen.findByRole("button", { name: /без связи на схеме/ }, WAIT);
    // Свёрнута строка «Хороший»: её «Сопоставлено» не видно; у «Плохого» проблемы видны.
    const chevrons = screen.getAllByRole("button", { name: /Раскрыть|Свернуть/ });
    expect(chevrons.map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(screen.getByText("Биллинг")).toBeTruthy();
  });

  it("пачка с одной ошибкой: прошедшие уходят, упавший остаётся со своим текстом", async () => {
    vi.mocked(processesApi.importProcess).mockImplementation(({ name }) =>
      name === "Оплата заказа"
        ? Promise.reject(new Error("Процесс с таким именем уже есть"))
        : Promise.resolve({ ...RESULT, process_id: `id-${name}` }));
    const { onImported } = renderModal();
    await userEvent.upload(fileInput(), [
      file("Оформление заказа.mmd", SEQ), file("Оплата заказа.mmd", SEQ), file("Возврат.mmd", SEQ),
    ]);
    const btn = await screen.findByRole("button", { name: "Импортировать 3 процесса" }, WAIT);
    await waitFor(() => expect(btn).not.toBeDisabled(), WAIT);

    await userEvent.click(btn);

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(["id-Оформление заказа", "id-Возврат"], false));
    expect(processesApi.importProcess).toHaveBeenCalledTimes(3); // по очереди, все три
    expect(await screen.findByText("Процесс с таким именем уже есть")).toBeTruthy();
    // Остался один черновик — упавший.
    expect(nameField().value).toBe("Оплата заказа");
  });

  it("предел демо-стенда: отказ строкой с жирным началом у черновика", async () => {
    vi.mocked(processesApi.importProcess).mockRejectedValue(
      new ApiError(409, "В демо-проекте можно до 5 процессов.", DEMO_LIMIT_CODE),
    );
    const { onImported } = renderModal();
    await pasteAndWait(SEQ);

    await userEvent.click(importButton());

    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("b")?.textContent).toBe("Не получилось добавить процесс.");
    expect(alert.textContent).toContain("В демо-проекте можно до 5 процессов.");
    expect(onImported).not.toHaveBeenCalled();
  });

  it("файл больше 1 МБ не читается: об этом сказано у черновика", async () => {
    renderModal();
    const big = file("Большой.mmd", "x");
    Object.defineProperty(big, "size", { value: 2 * 1024 * 1024 });

    await userEvent.upload(fileInput(), [big]);

    expect(await screen.findByText("Файл больше 1 МБ и не прочитан")).toBeTruthy();
    expect(processesApi.importPreview).not.toHaveBeenCalled();
    expect(importButton()).toBeDisabled();
  });
});
