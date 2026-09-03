// Карточка шага: правка подписи и удаление одним жестом.
//
// До 2026-08-11 клик по шагу открывал ТОЛЬКО «Удалить сообщение?»: задать или снять
// подпись из интерфейса было нечем, хотя бэк это умел. Заодно закреплено обещание
// новой модели — подпись принадлежит шагу, пустое поле значит «подписи нет», а не
// «взять метку связи».
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import { edgesApi } from "../../api/nodes";
import type { ProcessDetail } from "../../types";

// Диаграмма подменена пультом: кнопка отдаёт id шага ровно как настоящая полоса захвата.
vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: { onMessageClick?: (id: string) => void }) => (
    <div>
      <button onClick={() => props.onMessageClick?.("m1")}>click-m1</button>
      <button onClick={() => props.onMessageClick?.("m2")}>click-m2</button>
    </div>
  ),
}));
vi.mock("../MessageComposer", () => ({ default: () => null }));
// История: перехватываем push — им проверяем, что в откат попадает только то, что
// действительно можно восстановить.
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
    // Карточка шага лениво тянет каталог схем — без заглушки эффект падает.
    messageDocs: vi.fn(),
  },
}));
vi.mock("../../api/nodes", () => ({
  nodesApi: { get: vi.fn() },
  edgesApi: { update: vi.fn() },
}));

const MSG = {
  edge_id: "e1", leg: "forward", kind: "forward", technology: null, valid: true,
  edge_synchronous: true,
  from_participant_id: "pa", to_participant_id: "pb",
  // CAS (Д9): карточка шлёт версию шага обратно как base_version.
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
    { ...MSG, id: "m2", order: 1, caption: null },
  ],
  fragments: [],
} as unknown as ProcessDetail;

function renderCanvas() {
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  return screen.findByText("click-m1");
}

const field = () => screen.getByPlaceholderText("что происходит на этом шаге") as HTMLInputElement;

// Канал с живым плечом «ответ»: только на нём уход в асинхрон что-то ломает, и
// только там карточка спрашивает подтверждение.
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
  vi.mocked(processesApi.updateMessage).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(processesApi.removeMessage).mockResolvedValue(undefined as never);
  vi.mocked(processesApi.messageDocs).mockResolvedValue({ default_node_id: null, docs: [] } as never);
});

describe("карточка шага: подпись", () => {
  it("клик открывает правку, а не сразу удаление", async () => {
    await renderCanvas();

    await userEvent.click(screen.getByText("click-m1"));

    expect(await screen.findByText("Шаг сценария")).toBeTruthy();
    expect(processesApi.removeMessage).not.toHaveBeenCalled();
  });

  it("поле заполнено текущей подписью", async () => {
    await renderCanvas();

    await userEvent.click(screen.getByText("click-m1"));

    expect((await screen.findByDisplayValue("создать заказ")).tagName).toBe("INPUT");
  });

  it("у шага без подписи поле пустое", async () => {
    await renderCanvas();

    await userEvent.click(screen.getByText("click-m2"));
    await screen.findByText("Шаг сценария");

    expect(field().value).toBe("");
  });

  it("сохранение пишет новую подпись", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.clear(field());
    await userEvent.type(field(), "проверка лимита");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { caption: "проверка лимита", base_version: 3 }),
    );
  });

  it("пустое поле снимает подпись, а не берёт метку связи", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.clear(field());
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { caption: null, base_version: 3 }),
    );
  });

  it("подпись без правки не пишется — иначе в истории копился бы мусор", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(screen.queryByText("Шаг сценария")).toBeNull());
    expect(processesApi.updateMessage).not.toHaveBeenCalled();
  });

  it("«Удалить» удаляет из той же карточки", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(processesApi.removeMessage).toHaveBeenCalledWith("p1", "m1"));
  });

  // Находки 2026-08-11 (жалоба «повисший шаг не удалить никак»). Шаг без канала
  // воссоздать нечем — addMessage требует edge_id у всего, кроме самосообщения.
  it("шаг непривязанного участника удаляется и экран обновляется", async () => {
    // Именно тут был ранний return: он уносил с собой reload(), шаг оставался на
    // экране, и удаление выглядело как «не работает вовсе».
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "мсч",
        edge_id: null, valid: false, to_participant_id: "pu" }],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(processesApi.removeMessage).toHaveBeenCalledWith("p1", "m1"));
    // Перечитывание списка — то, чего не хватало: без него удалённый шаг оставался
    // на экране и выглядел как неудаляемый.
    await waitFor(() => expect(processesApi.get).toHaveBeenCalledTimes(2));
  });

  it("удаление шага на канале попадает в историю (его есть чем вернуть)", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(histPush).toHaveBeenCalledOnce());
  });

  it("удаление повисшего шага в историю НЕ попадает", async () => {
    // Воссоздать его нечем — addMessage требует edge_id. Прежде запись всё равно
    // попадала в историю, а её undo молча ничего не делал: кнопка обещала откат,
    // которого нет.
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "мсч", edge_id: null, valid: false }],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(processesApi.removeMessage).toHaveBeenCalled());
    expect(histPush).not.toHaveBeenCalled();
  });

  // Тумблер синхронности живёт ЗДЕСЬ, а не в C4-модалке (решение пользователя
  // 2026-08-11): состав плеч — вопрос процесса. До этого признак правился
  // единственным местом — внутри композитора нового сообщения, куда попадаешь
  // протягиванием стрелки; починить канал по алерту AL28 было почти нечем.
  it("карточка показывает тип канала и переключает его", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Асинхронный" }));

    await waitFor(() =>
      expect(edgesApi.update).toHaveBeenCalledWith("e1", { is_synchronous: false }),
    );
  });

  // П3 челленджа дизайна (2026-08-16): тумблер закрывал карточку ДО сохранения, и
  // набранная подпись пропадала молча — человек печатал текст, переключал канал и
  // терял работу без единого слова.
  it("смена типа канала не закрывает карточку и не теряет набранную подпись", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");
    await userEvent.clear(field());
    await userEvent.type(field(), "проверка лимита");

    await userEvent.click(screen.getByRole("button", { name: "Асинхронный" }));

    await waitFor(() => expect(edgesApi.update).toHaveBeenCalled());
    expect(screen.getByText("Шаг сценария")).toBeTruthy();
    expect(field().value).toBe("проверка лимита");
  });

  it("после смены типа канала подпись всё ещё сохраняется", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");
    await userEvent.clear(field());
    await userEvent.type(field(), "проверка лимита");
    await userEvent.click(screen.getByRole("button", { name: "Асинхронный" }));
    await waitFor(() => expect(edgesApi.update).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { caption: "проверка лимита", base_version: 3 }),
    );
  });

  it("повторный выбор того же типа связь не трогает", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Синхронный" }));

    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("и обратный путь: с асинхронного канала возвращает на синхронный", async () => {
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "вызов", edge_synchronous: false }],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Синхронный" }));

    await waitFor(() =>
      expect(edgesApi.update).toHaveBeenCalledWith("e1", { is_synchronous: true }),
    );
  });

  // Редизайн карточки 2026-09-03 (вариант А по прототипу): постоянно висевшее
  // предупреждение читалось как упрёк ни за что — человек его видел, ничего ещё не
  // сделав. Теперь это ПОДТВЕРЖДЕНИЕ в момент выбора «Асинхронный».
  it("до клика предупреждения о поломке ответов на карточке нет", async () => {
    await withReturnLeg();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    expect(screen.queryByText(/шаг-ответ/)).toBeNull();
    expect(screen.queryByText(/сломается/)).toBeNull();
  });

  it("уход в асинхрон при живом ответе сперва спрашивает подтверждение", async () => {
    await withReturnLeg();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Асинхронный" }));

    // Связь НЕ тронута: сначала человек должен увидеть цену решения.
    expect(edgesApi.update).not.toHaveBeenCalled();
    expect(screen.getByText(/На канале 1 шаг-ответ/)).toBeTruthy();
    expect(screen.getByText(/он сломается/)).toBeTruthy();
  });

  it("«Оставить синхронным» убирает подтверждение и связь не трогает", async () => {
    await withReturnLeg();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");
    await userEvent.click(screen.getByRole("button", { name: "Асинхронный" }));
    await screen.findByText(/На канале 1 шаг-ответ/);

    await userEvent.click(screen.getByRole("button", { name: "Оставить синхронным" }));

    expect(screen.queryByText(/На канале 1 шаг-ответ/)).toBeNull();
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("«Сменить всё равно» доводит смену типа до связи", async () => {
    await withReturnLeg();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");
    await userEvent.click(screen.getByRole("button", { name: "Асинхронный" }));
    await screen.findByText(/На канале 1 шаг-ответ/);

    await userEvent.click(screen.getByRole("button", { name: "Сменить всё равно" }));

    await waitFor(() =>
      expect(edgesApi.update).toHaveBeenCalledWith("e1", { is_synchronous: false }),
    );
  });

  it("у шага без канала тумблера нет", async () => {
    // Самосообщение и повисший шаг канала не имеют — переключать нечего.
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [{ ...MSG, id: "m1", order: 0, caption: "проверка",
        edge_id: null, edge_synchronous: null, kind: "self", to_participant_id: "pa" }],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    expect(screen.queryByRole("button", { name: "Асинхронный" })).toBeNull();
  });

  // Редизайн 2026-09-03: имя схемы — главное и целиком, путь узла — вторая строка.
  // Прежде они делили одну строку «путь · имя», и путь съедал её без остатка.
  it("имя привязанной схемы и путь узла — разные элементы", async () => {
    await withLinkedDoc();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    const open = screen.getByRole("button", { name: DOC_NAME });
    expect(open.textContent).not.toContain("Сервис оплат");
    const path = screen.getByText(DOC_PATH);
    expect(open.contains(path)).toBe(false);
    // Полный путь остаётся доступен наведением — вторая строка режется многоточием.
    expect(path.getAttribute("title")).toBe(DOC_PATH);
  });

  it("«×» у плитки отвязывает схему и сохраняет имя действия", async () => {
    await withLinkedDoc();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Отвязать" }));

    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { doc_id: null, base_version: 3 }),
    );
  });

  it("«свернуть» закрывает каталог выбора", async () => {
    await withLinkedDoc();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByPlaceholderText("поиск по имени, операции или объекту");

    await userEvent.click(screen.getByRole("button", { name: "свернуть" }));

    expect(screen.queryByPlaceholderText("поиск по имени, операции или объекту")).toBeNull();
    expect(screen.getByRole("button", { name: "Изменить" })).toBeTruthy();
  });

  it("в открытом каталоге «Отмена» на карточке ровно одна — нижняя", async () => {
    await withLinkedDoc();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByPlaceholderText("поиск по имени, операции или объекту");

    // Прежняя «Отмена» под списком спорила с нижней карточной: два одинаковых слова
    // рядом означали разное («закрыть выбор» и «закрыть карточку»).
    const card = field().parentElement!;
    expect(within(card).getAllByRole("button", { name: "Отмена" })).toHaveLength(1);
  });

  it("вне режима правки карточка не открывается", async () => {
    render(<ProcessCanvas id="p1" isArchitect editing={false} onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText("click-m1");

    await userEvent.click(screen.getByText("click-m1"));

    expect(screen.queryByText("Шаг сценария")).toBeNull();
  });
});
