// Карточка шага: привязка к схеме логики (эпик «процессы → доки шага», Ф3).
//
// Что закрепляют тесты, кроме самой привязки:
//   • каталог берётся С БЭКА целиком — правило владельца и скоуп поддеревьев живут
//     там, и вторая их реализация здесь неизбежно разошлась бы с первой;
//   • поиск обязателен: у монолита в каталоге до двухсот схем (барьер У5), и список
//     без фильтра — стена, а не витрина;
//   • шапка называет участников (барьер У6): без них автоподстановку исполнителя
//     нечем проверить глазами;
//   • провал в схему открывается НА ЧТЕНИЕ с явной кнопкой правки (барьер У7), его
//     колбэки настоящие: правка в оверлее перечитывает процесс и каталог (барьер У8),
//     а Escape закрывает оверлей, не роняя карточку (оверлей выше в стеке).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import type { ProcessDetail } from "../../types";

vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: { onMessageClick?: (id: string) => void }) => (
    <button onClick={() => props.onMessageClick?.("m1")}>click-m1</button>
  ),
}));
vi.mock("../MessageComposer", () => ({ default: () => null }));
vi.mock("../processes/ParticipantPicker", () => ({ default: () => null }));
const histPush = vi.fn();
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: histPush, undo: vi.fn(), redo: vi.fn(),
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
vi.mock("../../api/processes", () => ({
  processesApi: {
    get: vi.fn(), directions: vi.fn(), updateMessage: vi.fn(), removeMessage: vi.fn(),
    addMessage: vi.fn(), removeParticipant: vi.fn(), reattach: vi.fn(),
    detachMessages: vi.fn(), messageDocs: vi.fn(),
  },
}));
vi.mock("../../api/nodes", () => ({ nodesApi: { get: vi.fn() }, edgesApi: { update: vi.fn() } }));
// Оверлей документации: тяжёлый (FlowchartDocs + mermaid) — отражаем пропы провала.
vi.mock("../inspector/DocOverlay", () => ({
  default: (props: {
    nodeName: string;
    isArchitect: boolean;
    initialDocId?: string;
    onRequestEdit?: () => void;
    onDocEvent: (evt: unknown) => void;
    onClose: () => void;
  }) => (
    <div data-testid="doc-overlay">
      <span data-testid="ov-node">{props.nodeName}</span>
      <span data-testid="ov-doc">{props.initialDocId ?? "none"}</span>
      <span data-testid="ov-edit">{String(props.isArchitect)}</span>
      {props.onRequestEdit && <button onClick={props.onRequestEdit}>ov-править</button>}
      <button onClick={() => props.onDocEvent({ type: "edit" })}>ov-мутация</button>
    </div>
  ),
}));

const MSG = {
  edge_id: "e1", leg: "forward", kind: "forward", technology: null, valid: true,
  edge_synchronous: true, from_participant_id: "pa", to_participant_id: "pb",
  doc_id: null, doc_node_id: null, doc_name: null,
};
const DETAIL = {
  id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
  participants: [
    { id: "pa", node_id: "na", name: "Веб-витрина", role: null, shape: "service",
      is_external: false, status: "existing", order: 0 },
    { id: "pb", node_id: "nb", name: "Заказы", role: null, shape: "service",
      is_external: false, status: "existing", order: 1 },
  ],
  messages: [{ ...MSG, id: "m1", order: 0, caption: "создать заказ" }],
  fragments: [],
} as unknown as ProcessDetail;

// Шаг с готовой привязкой — для строки привязки и провала в схему.
const ПРИВЯЗАН = {
  ...DETAIL,
  messages: [{ ...MSG, id: "m1", order: 0, caption: "создать заказ",
               doc_id: "d1", doc_node_id: "nb", doc_name: "POST /orders" }],
} as unknown as ProcessDetail;

const КАТАЛОГ = {
  default_node_id: "nb",
  docs: [
    { id: "d1", node_id: "nb", node_path: "Ярмарка / Заказы", name: "POST /orders",
      kind: "operation", operation: "POST /orders", described: true },
    { id: "d2", node_id: "nb", node_path: "Ярмарка / Заказы", name: "email_senders",
      kind: "worker", operation: null, described: false },
    { id: "d3", node_id: "na", node_path: "Ярмарка / Веб-витрина", name: "Оформление заказа",
      kind: "operation", operation: null, described: true },
  ],
};

async function открыть(detail: ProcessDetail = DETAIL) {
  vi.mocked(processesApi.get).mockResolvedValue(detail);
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByText("click-m1"));
  await screen.findByText("Шаг сценария");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
  vi.mocked(processesApi.updateMessage).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(processesApi.messageDocs).mockResolvedValue(КАТАЛОГ as never);
});

describe("карточка шага: привязка к схеме логики", () => {
  it("шапка называет участников шага", async () => {
    // Барьер У6: «Шаг сценария» не отличает один шаг от другого, и подставленного
    // исполнителя нечем проверить глазами.
    await открыть();

    expect(screen.getByText(/Веб-витрина → Заказы/)).toBeTruthy();
  });

  it("непривязанный шаг говорит об этом прямо", async () => {
    await открыть();

    expect(screen.getByText("не привязана")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Выбрать" })).toBeTruthy();
  });

  it("каталог приходит с бэка и помечает исполнителя", async () => {
    await открыть();

    await userEvent.click(screen.getByRole("button", { name: "Выбрать" }));

    expect(processesApi.messageDocs).toHaveBeenCalledWith("p1", "m1");
    // Схемы владельца идут первыми, схема вызывающего — тоже в списке: клиентский
    // сценарий живёт именно у него, и запирать каталог владельцем нельзя.
    const строки = screen.getAllByRole("button").filter((b) => b.textContent?.includes("Ярмарка /"));
    expect(строки.map((b) => b.querySelector("span")?.textContent)).toEqual([
      "POST /orders", "email_senders", "Оформление заказа",
    ]);
    // Пометка исполнителя стоит у схем владельца и не стоит у схемы вызывающего.
    expect(строки.map((b) => b.textContent?.includes("исполнитель"))).toEqual([true, true, false]);
    // Заглушка разведки видна: привязать к неописанной операции законно, но человек
    // должен понимать, что документации там пока нет.
    expect(строки[1].textContent).toContain("не описана");
  });

  it("поиск фильтрует по имени, операции и объекту", async () => {
    // Барьер У5: каталог монолита — до двухсот строк, листать их человек не станет.
    await открыть();
    await userEvent.click(screen.getByRole("button", { name: "Выбрать" }));

    await userEvent.type(screen.getByPlaceholderText("поиск по имени, операции или объекту"), "витрин");

    expect(screen.getByText("Оформление заказа")).toBeTruthy();
    expect(screen.queryByText("POST /orders")).toBeNull();
  });

  it("выбор схемы пишет привязку и кладёт её в историю", async () => {
    await открыть();
    await userEvent.click(screen.getByRole("button", { name: "Выбрать" }));

    await userEvent.click(screen.getByText("POST /orders"));

    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { doc_id: "d1" }));
    expect(histPush).toHaveBeenCalledWith(expect.objectContaining({ label: "Привязка схемы к шагу" }));
  });

  it("привязанный шаг показывает схему с путём объекта и умеет отвязать", async () => {
    await открыть(ПРИВЯЗАН);

    // Путь берётся из каталога: в самом шаге его нет, а одного имени схемы для
    // понимания «чья это схема» мало.
    expect(await screen.findByText("Ярмарка / Заказы · POST /orders")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Отвязать" }));

    await waitFor(() =>
      expect(processesApi.updateMessage).toHaveBeenCalledWith("p1", "m1", { doc_id: null }));
  });

  it("имя привязанной схемы проваливается в оверлей НА ЧТЕНИЕ", async () => {
    // Барьер У7: провал не должен приводить архитектора в редактор чужой схемы.
    await открыть(ПРИВЯЗАН);

    await userEvent.click(await screen.findByRole("button", { name: "Ярмарка / Заказы · POST /orders" }));

    expect(screen.getByTestId("ov-doc").textContent).toBe("d1");
    expect(screen.getByTestId("ov-edit").textContent).toBe("false");
    // Имя узла в шапке оверлея — последний сегмент пути из каталога.
    expect(screen.getByTestId("ov-node").textContent).toBe("Заказы");
  });

  it("явная кнопка правки включает редактор", async () => {
    await открыть(ПРИВЯЗАН);
    await userEvent.click(await screen.findByRole("button", { name: "Ярмарка / Заказы · POST /orders" }));

    await userEvent.click(screen.getByText("ov-править"));

    expect(screen.getByTestId("ov-edit").textContent).toBe("true");
  });

  it("правка схемы в оверлее перечитывает процесс и каталог", async () => {
    // Барьер У8: колбэки оверлея настоящие. Заглушка здесь показала бы в строке
    // привязки старое имя схемы, а после удаления — привязку к уже мёртвой схеме.
    await открыть(ПРИВЯЗАН);
    await userEvent.click(await screen.findByRole("button", { name: "Ярмарка / Заказы · POST /orders" }));
    expect(processesApi.get).toHaveBeenCalledTimes(1);
    expect(processesApi.messageDocs).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByText("ov-мутация"));

    await waitFor(() => expect(processesApi.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(processesApi.messageDocs).toHaveBeenCalledTimes(2));
  });

  it("Escape закрывает оверлей, а карточка шага остаётся", async () => {
    // Оверлей стоит в стеке Escape ВЫШЕ карточки — иначе клавиша роняла бы обоих.
    await открыть(ПРИВЯЗАН);
    await userEvent.click(await screen.findByRole("button", { name: "Ярмарка / Заказы · POST /orders" }));

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByTestId("doc-overlay")).toBeNull();
    expect(screen.getByText("Шаг сценария")).toBeTruthy();
  });

  it("пустой каталог объясняет себя, а не молчит", async () => {
    // Барьер У12: пустой список без объяснения читается как поломка.
    vi.mocked(processesApi.messageDocs).mockResolvedValue(
      { default_node_id: null, docs: [] } as never);
    await открыть();

    await userEvent.click(screen.getByRole("button", { name: "Выбрать" }));

    expect(screen.getByText(/нет схем логики/)).toBeTruthy();
  });
});
