// Панель шага справа от диаграммы (редизайн, фаза 3а) — вместо плавающей карточки
// «Шаг сценария». Видна при выборе шага в обоих режимах, входит в раскладку (не окно
// поверх холста), закрывается крестиком, Escape и кликом по пустому месту диаграммы.
// Чтение: свойства текстом и ссылками, кнопок правки нет. Правка: значения правятся на
// месте, запись по уходу с поля и по Enter, своих «Сохранить» и «Отмена» нет.
//
// Закреплены и обещания прежней карточки (2026-08-11 … 2026-09-03): подпись принадлежит
// шагу, пустое поле значит «подписи нет», а не «взять метку связи»; неизменённая
// подпись не пишется; удаление в историю попадает, только когда шаг есть чем вернуть;
// тип связи переключается здесь же, уход в асинхрон при живом ответе сперва спрашивает.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import { edgesApi } from "../../api/nodes";
import type { ProcessDetail } from "../../types";

// Диаграмма подменена пультом: кнопки зовут ровно те колбэки, что и настоящая.
vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: {
    onMessageClick?: (id: string) => void;
    onBackgroundClick?: () => void;
    selectedId?: string | null;
  }) => (
    <div>
      <button onClick={() => props.onMessageClick?.("m1")}>click-m1</button>
      <button onClick={() => props.onMessageClick?.("m2")}>click-m2</button>
      <button onClick={() => props.onBackgroundClick?.()}>click-empty</button>
      <span data-testid="selected">{props.selectedId ?? "none"}</span>
    </div>
  ),
}));
vi.mock("../MessageComposer", () => ({ default: () => null }));
const histPush = vi.fn();
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: histPush, undo: vi.fn(), redo: vi.fn(),
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
vi.mock("../processes/ParticipantPicker", () => ({ default: () => null }));
vi.mock("../../api/processes", () => ({
  processesApi: {
    get: vi.fn(), directions: vi.fn(), addMessage: vi.fn(), updateMessage: vi.fn(),
    removeMessage: vi.fn(), removeParticipant: vi.fn(), reattach: vi.fn(), detachMessages: vi.fn(),
    messageDocs: vi.fn(),
  },
}));
vi.mock("../../api/nodes", () => ({
  nodesApi: { get: vi.fn() },
  edgesApi: { update: vi.fn() },
}));

const MSG = {
  edge_id: "e1", leg: "forward", kind: "forward", technology: "REST", valid: true,
  edge_synchronous: true,
  from_participant_id: "pa", to_participant_id: "pb",
  // CAS (Д9): панель шлёт версию шага обратно как base_version.
  version: 3,
};
const DETAIL = {
  id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
  participants: [
    { id: "pa", node_id: "na", name: "Покупатель", role: null, shape: "service",
      is_external: false, status: "existing", order: 0 },
    { id: "pb", node_id: "nb", name: "Заказы", role: null, shape: "service",
      is_external: false, status: "existing", order: 1 },
    // Непривязанный участник (AL27): у него нет узла, значит и канала под шагом нет.
    { id: "pu", node_id: null, name: "Биллинг", role: null, shape: null,
      is_external: null, status: null, order: 2 },
  ],
  messages: [
    { ...MSG, id: "m1", order: 0, caption: "создать заказ" },
    { ...MSG, id: "m2", order: 1, caption: null, technology: null },
  ],
  fragments: [],
} as unknown as ProcessDetail;

function renderCanvas(editing = true, onOpenNode?: (id: string) => void) {
  render(
    <ProcessCanvas id="p1" isArchitect={editing} editing={editing} onToggleEditing={vi.fn()} onChanged={vi.fn()}
      onOpenNode={onOpenNode} />,
  );
  return screen.findByText("click-m1");
}
const panel = () => screen.queryByRole("complementary", { name: "Шаг" });
const field = () => screen.getByPlaceholderText("что происходит на этом шаге") as HTMLTextAreaElement;
async function openStep(id = "m1") {
  await userEvent.click(screen.getByText(`click-${id}`));
  await waitFor(() => expect(panel()).not.toBeNull());
}

// Шаг с привязанной схемой: имя и путь длинные нарочно — именно на них прежняя
// однострочная «путь · имя» обрывалась ровно на имени.
const DOC_NAME = "Вебхук статуса платежа";
const DOC_PATH = "Маркетплейс «Ярмарка» / Сервис оплат";
function withLinkedDoc() {
  vi.mocked(processesApi.get).mockResolvedValue({
    ...DETAIL,
    messages: [{ ...MSG, id: "m1", order: 0, caption: "вызов",
      doc_id: "d1", doc_name: DOC_NAME, doc_node_id: "nb", doc_node_path: DOC_PATH }],
  } as unknown as ProcessDetail);
  vi.mocked(processesApi.messageDocs).mockResolvedValue({
    default_node_id: "nb",
    docs: [{ id: "d1", node_id: "nb", node_path: DOC_PATH, name: DOC_NAME,
      kind: "operation", operation: "POST /pay", described: true }],
  } as never);
  return renderCanvas();
}

// Канал с живым плечом «ответ»: только на нём уход в асинхрон что-то ломает.
function withReturnLeg() {
  vi.mocked(processesApi.get).mockResolvedValue({
    ...DETAIL,
    messages: [
      { ...MSG, id: "m1", order: 0, caption: "вызов" },
      { ...MSG, id: "m9", order: 1, caption: "ответ", leg: "return", kind: "return",
        from_participant_id: "pb", to_participant_id: "pa" },
    ],
  } as unknown as ProcessDetail);
  return renderCanvas();
}
async function pickType(name: "Синхронный" | "Асинхронный") {
  await userEvent.click(screen.getByRole("button", { name: /^(Синхронный|Асинхронный)/ }));
  await userEvent.click(screen.getByRole("menuitem", { name }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
  vi.mocked(processesApi.updateMessage).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(processesApi.removeMessage).mockResolvedValue(undefined as never);
  vi.mocked(processesApi.messageDocs).mockResolvedValue({ default_node_id: null, docs: [] } as never);
});

describe("панель шага: видимость", () => {
  it("в чтении: шаг выбран — панель со свойствами, без полей и кнопок правки", async () => {
    const onOpenNode = vi.fn();
    await renderCanvas(false, onOpenNode);
    expect(panel()).toBeNull();

    await openStep();

    expect(screen.getByTestId("selected").textContent).toBe("m1");
    expect(screen.getByRole("heading", { name: "создать заказ" })).toBeInTheDocument();
    expect(screen.getByText("REST")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("что происходит на этом шаге")).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить шаг" })).toBeNull();
    // «Откуда» и «Куда» — ссылками на страницы объектов.
    await userEvent.click(screen.getByRole("button", { name: "Заказы" }));
    expect(onOpenNode).toHaveBeenCalledWith("nb");
    // Каталог схем нужен только правке.
    expect(processesApi.messageDocs).not.toHaveBeenCalled();
  });

  it("читателю пустые свойства не показываются", async () => {
    await renderCanvas(false);
    await openStep("m2");
    expect(screen.queryByText("Технология")).toBeNull();
    expect(screen.queryByText("Схема логики")).toBeNull();
  });

  it("в правке: та же панель с полем подписи и «Удалить шаг»; клик по шагу ничего не удаляет", async () => {
    await renderCanvas(true);
    await openStep();
    expect(field().value).toBe("создать заказ");
    expect(processesApi.removeMessage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Удалить шаг" })).toBeInTheDocument();
    // Своих «Сохранить» и «Отмена» у панели нет.
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отмена" })).toBeNull();
  });

  it("закрывается крестиком, Escape и кликом по пустому месту диаграммы", async () => {
    await renderCanvas(false);
    await openStep();
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(panel()).toBeNull();

    await openStep();
    await userEvent.keyboard("{Escape}");
    expect(panel()).toBeNull();

    await openStep();
    await userEvent.click(screen.getByText("click-empty"));
    expect(panel()).toBeNull();
    expect(screen.getByTestId("selected").textContent).toBe("none");
  });

  it("выбор другого шага переключает панель на него", async () => {
    await renderCanvas(true);
    await openStep("m1");
    await openStep("m2");
    expect(field().value).toBe("");
  });
});

describe("панель шага: подпись", () => {
  it("уход с поля пишет новую подпись", async () => {
    await renderCanvas();
    await openStep();
    await userEvent.clear(field());
    await userEvent.type(field(), "проверка лимита");
    await userEvent.tab();
    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { caption: "проверка лимита", base_version: 3 }),
    );
    expect(histPush).toHaveBeenCalledWith(expect.objectContaining({ label: "Подпись шага" }));
  });

  it("Enter пишет подпись", async () => {
    await renderCanvas();
    await openStep();
    await userEvent.clear(field());
    await userEvent.type(field(), "оплатить{Enter}");
    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { caption: "оплатить", base_version: 3 }),
    );
  });

  it("пустое поле снимает подпись, а не берёт метку связи", async () => {
    await renderCanvas();
    await openStep();
    await userEvent.clear(field());
    await userEvent.tab();
    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { caption: null, base_version: 3 }),
    );
  });

  it("подпись без правки не пишется — иначе в истории копился бы мусор", async () => {
    await renderCanvas();
    await openStep();
    fireEvent.focus(field());
    await userEvent.tab();
    expect(processesApi.updateMessage).not.toHaveBeenCalled();
  });

  it("уход из поля к выбору типа записывает набранную подпись", async () => {
    // П3 челленджа 2026-08-16: смена типа связи не должна терять набранное.
    await renderCanvas();
    await openStep();
    await userEvent.clear(field());
    await userEvent.type(field(), "проверка лимита");
    await pickType("Асинхронный");
    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { caption: "проверка лимита", base_version: 3 }),
    );
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledWith("e1", { is_synchronous: false }));
  });

  it("Escape в поле закрывает панель и набранное не пишет", async () => {
    await renderCanvas();
    await openStep();
    await userEvent.clear(field());
    await userEvent.type(field(), "черновик");
    await userEvent.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(processesApi.updateMessage).not.toHaveBeenCalled();
  });
});

describe("панель шага: удаление", () => {
  it("«Удалить шаг» удаляет и кладёт в историю", async () => {
    await renderCanvas();
    await openStep();
    await userEvent.click(screen.getByRole("button", { name: "Удалить шаг" }));
    await waitFor(() => expect(processesApi.removeMessage).toHaveBeenCalledWith("p1", "m1"));
    await waitFor(() => expect(histPush).toHaveBeenCalledWith(expect.objectContaining({ label: "Удаление шага" })));
  });

  it("удаление повисшего шага в историю НЕ попадает: вернуть его нечем", async () => {
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "мсч", edge_id: null, valid: false }],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await openStep();
    await userEvent.click(screen.getByRole("button", { name: "Удалить шаг" }));
    await waitFor(() => expect(processesApi.removeMessage).toHaveBeenCalled());
    expect(histPush).not.toHaveBeenCalled();
  });

  // Находки 2026-08-11 (жалоба «повисший шаг не удалить никак»). Шаг без канала
  // воссоздать нечем — addMessage требует edge_id у всего, кроме самосообщения.
  it("шаг непривязанного участника удаляется и экран обновляется; в историю не идёт", async () => {
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "мсч",
        edge_id: null, valid: false, to_participant_id: "pu" }],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await openStep();
    await userEvent.click(screen.getByRole("button", { name: "Удалить шаг" }));
    await waitFor(() => expect(processesApi.removeMessage).toHaveBeenCalledWith("p1", "m1"));
    await waitFor(() => expect(processesApi.get).toHaveBeenCalledTimes(2));
    expect(histPush).not.toHaveBeenCalled();
  });
});

// Тип связи живёт ЗДЕСЬ, а не в C4-модалке (решение пользователя 2026-08-11): состав
// плеч — вопрос процесса. Правится связь целиком — пояснение в подсказке строки.
describe("панель шага: тип связи", () => {
  it("переключает тип связи и не закрывает панель, набранная подпись цела", async () => {
    await renderCanvas();
    await openStep();
    expect(screen.getByText("Тип").closest("[title]")?.getAttribute("title")).toMatch(/общий для всех шагов/);
    await userEvent.clear(field());
    await userEvent.type(field(), "проверка лимита");
    await pickType("Асинхронный");
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledWith("e1", { is_synchronous: false }));
    expect(panel()).not.toBeNull();
  });

  it("и обратный путь: с асинхронной связи возвращает на синхронную", async () => {
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "вызов", edge_synchronous: false, kind: "async" }],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await openStep();
    await pickType("Синхронный");
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledWith("e1", { is_synchronous: true }));
  });

  it("Escape при открытом меню типа сворачивает меню, панель остаётся", async () => {
    await renderCanvas();
    await openStep();
    await userEvent.click(screen.getByRole("button", { name: /^Синхронный/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("повторный выбор того же типа связь не трогает", async () => {
    await renderCanvas();
    await openStep();
    await pickType("Синхронный");
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("уход в асинхрон при живом ответе сперва спрашивает; «Сменить всё равно» доводит", async () => {
    await withReturnLeg();
    await openStep();
    expect(screen.queryByText(/шаг-ответ/)).toBeNull();
    await pickType("Асинхронный");
    expect(edgesApi.update).not.toHaveBeenCalled();
    expect(screen.getByText(/По этой связи идёт шаг-ответ/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Сменить всё равно" }));
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledWith("e1", { is_synchronous: false }));
  });

  it("«Оставить синхронным» убирает вопрос и связь не трогает", async () => {
    await withReturnLeg();
    await openStep();
    await pickType("Асинхронный");
    await userEvent.click(screen.getByRole("button", { name: "Оставить синхронным" }));
    expect(screen.queryByText(/По этой связи идёт шаг-ответ/)).toBeNull();
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("у шага без связи выбора типа нет", async () => {
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "проверка",
        edge_id: null, edge_synchronous: null, kind: "self", to_participant_id: "pa" }],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await openStep();
    expect(screen.getByText("Внутри участника")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Синхронный/ })).toBeNull();
  });
});

// Редизайн карточки 2026-09-03: имя схемы — главное и целиком, путь узла — второй строкой.
describe("панель шага: схема логики", () => {
  it("имя привязанной схемы и путь объекта — разные элементы", async () => {
    await withLinkedDoc();
    await openStep();
    const open = screen.getByRole("button", { name: DOC_NAME });
    expect(open.textContent).not.toContain("Сервис оплат");
    const path = screen.getByText(DOC_PATH);
    expect(open.contains(path)).toBe(false);
    expect(path.getAttribute("title")).toBe(DOC_PATH);
  });

  it("«Отвязать» снимает схему с версией шага", async () => {
    await withLinkedDoc();
    await openStep();
    await userEvent.click(screen.getByRole("button", { name: "Отвязать" }));
    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { doc_id: null, base_version: 3 }),
    );
  });

  it("«свернуть» закрывает выбор схемы, Escape — тоже, и панель остаётся", async () => {
    await withLinkedDoc();
    await openStep();
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByPlaceholderText("поиск по имени, операции или объекту");
    await userEvent.click(screen.getByRole("button", { name: "свернуть" }));
    expect(screen.queryByPlaceholderText("поиск по имени, операции или объекту")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("поиск по имени, операции или объекту")).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("читателю схема — ссылкой, без выбора и отвязки", async () => {
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "вызов",
        doc_id: "d1", doc_name: DOC_NAME, doc_node_id: "nb", doc_node_path: DOC_PATH }],
    } as unknown as ProcessDetail);
    await renderCanvas(false);
    await openStep();
    const p = within(panel()!);
    expect(p.getByRole("button", { name: DOC_NAME })).toBeInTheDocument();
    expect(p.queryByRole("button", { name: "Отвязать" })).toBeNull();
    expect(p.queryByRole("button", { name: "Изменить" })).toBeNull();
  });
});

describe("вход «чинить»: сломанный шаг открыт сразу", () => {
  it("fixOnOpen выбирает первый сломанный шаг", async () => {
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [
        { ...MSG, id: "m1", order: 0, caption: "целый" },
        { ...MSG, id: "m2", order: 1, caption: "повис", edge_id: null, valid: false, invalid_reason: "edge_deleted" },
      ],
    } as unknown as ProcessDetail);
    render(<ProcessCanvas id="p1" isArchitect editing fixOnOpen onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("m2"));
    expect(screen.getByText("связь удалена")).toBeInTheDocument();
  });
});
