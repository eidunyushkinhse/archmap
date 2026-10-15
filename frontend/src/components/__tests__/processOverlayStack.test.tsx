// Стек оверлеев холста процесса (аудит F-3). Окна ложатся в порядке открытия: открытое
// позже рисуется поверх и первым закрывается по Escape. Раньше порядок наложения был
// зашит в разметку — подтверждение удаления участника, открытое из панели «Участники»,
// оказывалось ПОД панелью. Схема логики — сама модалка: Escape принадлежит ей
// (несохранённая правка спрашивает), холст его не перехватывает.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import type { ProcessDetail } from "../../types";

// Диаграмма подменена пультом: кнопка открывает схему логики шага, как в просмотре.
vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: { onOpenDoc?: (id: string) => void }) => (
    <button onClick={() => props.onOpenDoc?.("m1")}>open-doc-m1</button>
  ),
}));
vi.mock("../inspector/DocOverlay", () => ({
  default: (props: { onClose: () => void }) => (
    <div>
      схема-логики
      <button onClick={props.onClose}>закрыть-схему</button>
    </div>
  ),
}));
vi.mock("../MessageComposer", () => ({ default: () => null }));
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
vi.mock("../processes/ParticipantPicker", () => ({ default: () => null }));
vi.mock("../../api/processes", () => ({
  processesApi: {
    get: vi.fn(), directions: vi.fn(), removeParticipant: vi.fn(),
    messageDocs: vi.fn().mockResolvedValue({ default_node_id: null, docs: [] }),
  },
}));
vi.mock("../../api/nodes", () => ({
  nodesApi: { get: vi.fn() },
  edgesApi: { update: vi.fn() },
}));

const MSG = {
  edge_id: "e1", leg: "forward", kind: "forward", technology: null, valid: true,
  edge_synchronous: true, from_participant_id: "pa", to_participant_id: "pb",
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
    { ...MSG, id: "m1", order: 0, caption: "создать заказ", doc_id: "d1", doc_node_id: "nb",
      doc_node_path: "Заказы" },
  ],
  fragments: [],
} as unknown as ProcessDetail;

const CONFIRM = /Вы уверены, что хотите удалить «Покупатель»/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
});

// Панель «Участники» → крестик у участника с шагами → подтверждение удаления.
async function openDeleteFromPanel() {
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: "Участник" }));
  await screen.findByText("Добавить из дерева схемы");
  await userEvent.click(screen.getAllByTitle("Убрать")[0]);
  return screen.findByText(CONFIRM);
}

describe("стек оверлеев холста процесса", () => {
  it("подтверждение из панели участников ложится поверх панели", async () => {
    const confirm = await openDeleteFromPanel();
    const panel = screen.getByText("Добавить из дерева схемы");
    // Одинаковый z-index — сверху то, что позже в DOM.
    expect(panel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Escape закрывает сперва подтверждение, затем панель — и ничего не удаляет", async () => {
    await openDeleteFromPanel();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(CONFIRM)).toBeNull());
    expect(screen.getByText("Добавить из дерева схемы")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Добавить из дерева схемы")).toBeNull());
    expect(processesApi.removeParticipant).not.toHaveBeenCalled();
  });

  it("во время удаления Escape не бросает подтверждение и не закрывает панель под ним", async () => {
    vi.mocked(processesApi.removeParticipant).mockReturnValue(new Promise<void>(() => {}));
    await openDeleteFromPanel();
    await userEvent.click(screen.getByRole("button", { name: "Да, удалить" }));
    await screen.findByRole("button", { name: "Удаление..." });

    await userEvent.keyboard("{Escape}");

    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    expect(screen.getByText("Добавить из дерева схемы")).toBeInTheDocument();
  });

  it("схему логики Escape холста не закрывает — она модалка и решает сама", async () => {
    render(<ProcessCanvas id="p1" isArchitect={false} editing={false} onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByText("open-doc-m1"));
    await screen.findByText("схема-логики");

    await userEvent.keyboard("{Escape}");
    expect(screen.getByText("схема-логики")).toBeInTheDocument();

    // Её собственное закрытие (крестик, Escape нативного <dialog>) снимает окно.
    await userEvent.click(screen.getByRole("button", { name: "закрыть-схему" }));
    await waitFor(() => expect(screen.queryByText("схема-логики")).toBeNull());
  });
});
