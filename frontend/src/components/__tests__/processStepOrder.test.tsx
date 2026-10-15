// Перестановки и добавления на холсте процесса — страховочная сетка выноса правок шагов и
// участников из ProcessCanvas (аудит F-2): оптимистичный порядок, что уходит в API, какие
// команды ложатся в историю и что делает их откат.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import type { MessageCreate, ProcessDetail, ProcessMessage } from "../../types";
import type { AsyncCommand } from "../processes/useProcessHistory";

// Диаграмма подменена пультом и показывает порядок, который получила.
vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: {
    messages: { id: string }[];
    participants: { id: string }[];
    onReorderMessages?: (ids: string[]) => void;
    onReorderParticipants?: (ids: string[]) => void;
    onConnect?: (fromPid: string, toPid: string) => void;
  }) => (
    <div>
      <span data-testid="msg-order">{props.messages.map((m) => m.id).join(",")}</span>
      <span data-testid="part-order">{props.participants.map((p) => p.id).join(",")}</span>
      <button onClick={() => props.onReorderMessages?.(["m2", "m1"])}>swap-steps</button>
      <button onClick={() => props.onReorderParticipants?.(["pb", "pa"])}>swap-parts</button>
      <button onClick={() => props.onConnect?.("pa", "pb")}>connect-pa-pb</button>
    </div>
  ),
}));
// Композитор подменён: одна кнопка «добавлено» с ответом бэка и телом запроса.
const ADDED = { id: "m9" } as ProcessMessage;
const PAYLOAD: MessageCreate = {
  edge_id: "e1", leg: "forward", from_participant_id: "pa", to_participant_id: "pb", caption: null, order: 2,
};
vi.mock("../MessageComposer", () => ({
  default: (props: { onAdded: (m: ProcessMessage, p: MessageCreate) => void; onClose: () => void }) => (
    <button onClick={() => { props.onAdded(ADDED, PAYLOAD); props.onClose(); }}>composer-added</button>
  ),
}));
const histPush = vi.fn<(cmd: AsyncCommand) => void>();
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: histPush, undo: vi.fn(), redo: vi.fn(),
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
// Пикер участников подменён: «добавить два узла разом».
vi.mock("../processes/ParticipantPicker", () => ({
  default: (props: { onAdd: (ids: string[]) => void }) => (
    <button onClick={() => props.onAdd(["nc", "nd"])}>pick-nc-nd</button>
  ),
}));
vi.mock("../../api/processes", () => ({
  processesApi: {
    get: vi.fn(), directions: vi.fn(), reorderMessages: vi.fn(), reorderParticipants: vi.fn(),
    addMessage: vi.fn(), removeMessage: vi.fn(), addParticipant: vi.fn(), removeParticipant: vi.fn(),
  },
}));
vi.mock("../../api/nodes", () => ({
  nodesApi: { get: vi.fn() },
  edgesApi: { update: vi.fn() },
}));

const MSG = {
  edge_id: "e1", leg: "forward", kind: "forward", technology: null, valid: true,
  edge_synchronous: true, from_participant_id: "pa", to_participant_id: "pb", caption: null,
};
const DETAIL = {
  id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
  participants: [
    { id: "pa", node_id: "na", name: "Покупатель", role: null, shape: "service",
      is_external: false, status: "existing", order: 0 },
    { id: "pb", node_id: "nb", name: "Заказы", role: null, shape: "service",
      is_external: false, status: "existing", order: 1 },
  ],
  messages: [
    { ...MSG, id: "m1", order: 0 },
    { ...MSG, id: "m2", order: 1 },
  ],
  fragments: [],
} as unknown as ProcessDetail;

const lastCmd = () => histPush.mock.lastCall?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
  vi.mocked(processesApi.reorderMessages).mockReturnValue(new Promise(() => {}));
  vi.mocked(processesApi.reorderParticipants).mockReturnValue(new Promise(() => {}));
  vi.mocked(processesApi.addMessage).mockResolvedValue({ id: "m10" } as never);
  vi.mocked(processesApi.removeMessage).mockResolvedValue(undefined as never);
  let n = 0;
  vi.mocked(processesApi.addParticipant).mockImplementation(async () => ({ id: `new${++n}` }) as never);
});

async function open() {
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("swap-steps");
}

describe("перестановки и добавления на холсте процесса", () => {
  it("перестановка шагов: новый порядок виден до ответа API; откат шлёт прежний", async () => {
    await open();
    expect(screen.getByTestId("msg-order").textContent).toBe("m1,m2");
    await userEvent.click(screen.getByText("swap-steps"));
    // Ответ API ещё не пришёл (промис висит), а диаграмма уже в новом порядке.
    expect(screen.getByTestId("msg-order").textContent).toBe("m2,m1");
    expect(processesApi.reorderMessages).toHaveBeenCalledWith("p1", ["m2", "m1"]);
  });

  it("перестановка шагов кладёт в историю команду с прежним порядком", async () => {
    vi.mocked(processesApi.reorderMessages).mockResolvedValue(undefined as never);
    await open();
    await userEvent.click(screen.getByText("swap-steps"));
    await waitFor(() => expect(lastCmd()?.label).toBe("Перестановка шагов"));
    await lastCmd()?.undo();
    expect(processesApi.reorderMessages).toHaveBeenLastCalledWith("p1", ["m1", "m2"]);
  });

  it("перестановка участников: оптимистично, в API — id участников; откат — прежний порядок", async () => {
    await open();
    await userEvent.click(screen.getByText("swap-parts"));
    expect(screen.getByTestId("part-order").textContent).toBe("pb,pa");
    expect(processesApi.reorderParticipants).toHaveBeenCalledWith("p1", ["pb", "pa"]);

    vi.mocked(processesApi.reorderParticipants).mockResolvedValue(undefined as never);
    await userEvent.click(screen.getByText("swap-parts"));
    await waitFor(() => expect(lastCmd()?.label).toBe("Перестановка участников"));
  });

  it("шаг из композитора ложится в историю: откат удаляет созданный, повтор пересоздаёт", async () => {
    await open();
    await userEvent.click(screen.getByText("connect-pa-pb"));
    await userEvent.click(await screen.findByText("composer-added"));
    expect(lastCmd()?.label).toBe("Добавление сообщения");
    await lastCmd()?.undo();
    expect(processesApi.removeMessage).toHaveBeenCalledWith("p1", "m9");
    await lastCmd()?.redo();
    expect(processesApi.addMessage).toHaveBeenCalledWith("p1", PAYLOAD);
    // После повтора откат бьёт по НОВОМУ id.
    await lastCmd()?.undo();
    expect(processesApi.removeMessage).toHaveBeenLastCalledWith("p1", "m10");
  });

  it("участники из пикера добавляются подряд с растущим порядком, каждый — командой истории", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Участник" }));
    await userEvent.click(await screen.findByText("pick-nc-nd"));
    await waitFor(() => expect(processesApi.addParticipant).toHaveBeenCalledTimes(2));
    expect(processesApi.addParticipant).toHaveBeenNthCalledWith(1, "p1", { node_id: "nc", order: 2 });
    expect(processesApi.addParticipant).toHaveBeenNthCalledWith(2, "p1", { node_id: "nd", order: 3 });
    expect(histPush).toHaveBeenCalledTimes(2);
    await lastCmd()?.undo();
    expect(processesApi.removeParticipant).toHaveBeenCalledWith("p1", "new2");
  });
});
