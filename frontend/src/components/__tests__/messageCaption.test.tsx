// Карточка шага: правка подписи и удаление одним жестом.
//
// До 2026-08-11 клик по шагу открывал ТОЛЬКО «Удалить сообщение?»: задать или снять
// подпись из интерфейса было нечем, хотя бэк это умел. Заодно закреплено обещание
// новой модели — подпись принадлежит шагу, пустое поле значит «подписи нет», а не
// «взять метку связи».
import { render, screen, waitFor } from "@testing-library/react";
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

  it("предупреждает, что уход в асинхронный сломает ответы", async () => {
    vi.mocked(processesApi.get).mockResolvedValue({
      ...DETAIL,
      messages: [
        { ...MSG, id: "m1", order: 0, caption: "вызов" },
        { ...MSG, id: "m9", order: 1, caption: "ответ", leg: "return", kind: "return",
          from_participant_id: "pb", to_participant_id: "pa" },
      ],
    } as unknown as ProcessDetail);
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    expect(screen.getByText(/один шаг-ответ/)).toBeTruthy();
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

  it("вне режима правки карточка не открывается", async () => {
    render(<ProcessCanvas id="p1" isArchitect editing={false} onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByText("click-m1");

    await userEvent.click(screen.getByText("click-m1"));

    expect(screen.queryByText("Шаг сценария")).toBeNull();
  });
});
