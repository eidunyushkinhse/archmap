// Каркас мутаций процесса (аудит F-18, F-36): отказ любой правки показывает причину
// и перечитывает процесс — оптимистичный стейт возвращается к истине; следующая
// удачная правка снимает прежнюю ошибку, а не оставляет её висеть до ухода со страницы.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import type { ProcessDetail } from "../../types";

// Диаграмма подменена пультом: кнопки открывают ровно те оверлеи, что и настоящая.
vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: {
    onMessageClick?: (id: string) => void;
    onFragmentClick?: (id: string) => void;
    onEditBranch?: (id: string, index: number | null) => void;
    onSelfConnect?: (id: string) => void;
  }) => (
    <div>
      <button onClick={() => props.onMessageClick?.("m1")}>click-m1</button>
      <button onClick={() => props.onFragmentClick?.("f1")}>click-f1</button>
      <button onClick={() => props.onEditBranch?.("f1", null)}>click-branch</button>
      <button onClick={() => props.onSelfConnect?.("pa")}>click-self</button>
    </div>
  ),
}));
vi.mock("../MessageComposer", () => ({ default: () => null }));
const histUndo = vi.fn();
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: vi.fn(), undo: histUndo, redo: vi.fn(),
    canUndo: true, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
vi.mock("../processes/ParticipantPicker", () => ({ default: () => null }));
vi.mock("../../api/processes", () => ({
  processesApi: {
    get: vi.fn(), directions: vi.fn(), addMessage: vi.fn(), updateMessage: vi.fn(),
    removeMessage: vi.fn(), removeParticipant: vi.fn(), reattach: vi.fn(), detachMessages: vi.fn(),
    removeFragment: vi.fn(), updateFragment: vi.fn(),
    // Карточка шага лениво тянет каталог схем для привязки — без заглушки её эффект
    // падает, и Escape тестировать не на чем.
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
    { ...MSG, id: "m1", order: 0, caption: "создать заказ" },
    { ...MSG, id: "m2", order: 1, caption: null },
  ],
  fragments: [{ id: "f1", kind: "alt", from_order: 0, to_order: 1, guard: "оплата прошла", branches: [] }],
} as unknown as ProcessDetail;

function renderCanvas() {
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  return screen.findByText("click-m1");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
});

async function правитьПодпись(текст: string) {
  await userEvent.click(screen.getByText("click-m1"));
  const поле = await screen.findByPlaceholderText("что происходит на этом шаге");
  await userEvent.clear(поле);
  await userEvent.type(поле, текст);
  await userEvent.click(screen.getByText("Сохранить"));
}

describe("мутации процесса: отказ и следующий успех", () => {
  it("отказ показывает причину и перечитывает процесс", async () => {
    vi.mocked(processesApi.updateMessage).mockRejectedValue(new Error("Шаг изменён в другой сессии"));
    await renderCanvas();
    const загрузок = vi.mocked(processesApi.get).mock.calls.length;

    await правитьПодпись("оплатить заказ");

    expect(await screen.findByText("Шаг изменён в другой сессии")).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(processesApi.get).mock.calls.length).toBeGreaterThan(загрузок));
  });

  it("следующая удачная правка снимает прежнюю ошибку", async () => {
    vi.mocked(processesApi.updateMessage)
      .mockRejectedValueOnce(new Error("Шаг изменён в другой сессии"))
      .mockResolvedValue({} as never);
    await renderCanvas();

    await правитьПодпись("оплатить заказ");
    expect(await screen.findByText("Шаг изменён в другой сессии")).toBeInTheDocument();

    await правитьПодпись("оплатить заказ картой");
    await waitFor(() => expect(screen.queryByText("Шаг изменён в другой сессии")).toBeNull());
  });
});
