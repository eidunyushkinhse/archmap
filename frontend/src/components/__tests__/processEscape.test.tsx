// Escape закрывает оверлеи процесса — как все окна проекта.
//
// П5 челленджа дизайна (2026-08-16): единственный клавиатурный обработчик канваса
// ловил только Ctrl+Z/Ctrl+Y (первая строка отсекала всё без Ctrl), и карточка шага,
// карточки фрагмента, панель участников закрывались лишь мышью. Все модалки проекта
// (ui/Modal.tsx на нативном <dialog>) закрываются по Escape — разное поведение окон
// в одном приложении. Перевести оверлеи на ui/Modal нельзя: вложенные <dialog> в
// проекте запрещены (их cancel всплывает), потому это обычные div с position:fixed.
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

describe("Escape закрывает оверлеи процесса", () => {
  it("карточку шага — при этом фокус стоит в поле подписи (autoFocus)", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");
    // Именно этот случай и был бы потерян, отсекай мы события из полей ввода:
    // поле карточки забирает фокус само.
    expect(document.activeElement).toBe(screen.getByPlaceholderText("что происходит на этом шаге"));

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Шаг сценария")).toBeNull());
  });

  it("подтверждение удаления фрагмента", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-f1"));
    await screen.findByText("Удалить фрагмент?");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Удалить фрагмент?")).toBeNull());
    expect(processesApi.removeFragment).not.toHaveBeenCalled();
  });

  it("карточку ветки «иначе»", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-branch"));
    await screen.findByText("Добавить ветку «иначе»");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Добавить ветку «иначе»")).toBeNull());
  });

  it("карточку рефлексивного сообщения", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-self"));
    await screen.findByText(/Рефлексивное сообщение/);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText(/Рефлексивное сообщение/)).toBeNull());
  });

  it("панель участников", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByRole("button", { name: "Участник" }));
    await screen.findByText("Добавить из дерева схемы");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Добавить из дерева схемы")).toBeNull());
  });

  it("закрывает по одному оверлею за нажатие и ничего не пишет", async () => {
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Шаг сценария")).toBeNull());
    // Escape по пустому холсту ничего не ломает и ничего не отменяет.
    await userEvent.keyboard("{Escape}");

    expect(processesApi.updateMessage).not.toHaveBeenCalled();
    expect(processesApi.removeMessage).not.toHaveBeenCalled();
  });

  it("Escape не задевает Undo — история остаётся на месте", async () => {
    // Обработчик отмены требует Ctrl/Cmd, наш — их отсутствия: пути не пересекаются.
    await renderCanvas();
    await userEvent.click(screen.getByText("click-m1"));
    await screen.findByText("Шаг сценария");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Шаг сценария")).toBeNull());
    expect(histUndo).not.toHaveBeenCalled();
  });
});
