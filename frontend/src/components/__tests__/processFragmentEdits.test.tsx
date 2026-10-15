// Правки фрагментов холста процесса — страховочная сетка выноса в fragmentEdits (аудит
// F-2): что уходит в API (строки диаграммы → order шагов), какие команды ложатся в
// историю и что возвращает их откат.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import type { ProcessDetail } from "../../types";
import type { AsyncCommand } from "../processes/useProcessHistory";

// Диаграмма подменена пультом: кнопки зовут ровно те колбэки, что и настоящая.
vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: {
    onSelectRange?: (from: number, to: number) => void;
    onFragmentClick?: (id: string) => void;
    onResizeFragment?: (id: string, from: number, to: number) => void;
    onMoveBranch?: (id: string, index: number, row: number) => void;
    onEditBranch?: (id: string, index: number | null) => void;
  }) => (
    <div>
      <button onClick={() => props.onSelectRange?.(0, 1)}>select-0-1</button>
      <button onClick={() => props.onFragmentClick?.("f1")}>click-f1</button>
      <button onClick={() => props.onResizeFragment?.("f1", 1, 2)}>resize-1-2</button>
      <button onClick={() => props.onMoveBranch?.("f1", 0, 2)}>move-branch-0-to-2</button>
      <button onClick={() => props.onEditBranch?.("f1", null)}>new-branch</button>
      <button onClick={() => props.onEditBranch?.("f1", 0)}>edit-branch-0</button>
    </div>
  ),
}));
vi.mock("../MessageComposer", () => ({ default: () => null }));
const histPush = vi.fn<(cmd: AsyncCommand) => void>();
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: histPush, undo: vi.fn(), redo: vi.fn(),
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
vi.mock("../processes/ParticipantPicker", () => ({ default: () => null }));
vi.mock("../../api/processes", () => ({
  processesApi: {
    get: vi.fn(), directions: vi.fn(),
    addFragment: vi.fn(), updateFragment: vi.fn(), removeFragment: vi.fn(),
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
// Order шагов нарочно не совпадает с номерами строк: правки обязаны переводить строку
// диаграммы в order, а не слать её как есть.
const DETAIL = {
  id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
  participants: [
    { id: "pa", node_id: "na", name: "Покупатель", role: null, shape: "service",
      is_external: false, status: "existing", order: 0 },
    { id: "pb", node_id: "nb", name: "Заказы", role: null, shape: "service",
      is_external: false, status: "existing", order: 1 },
  ],
  messages: [
    { ...MSG, id: "m3", order: 30 },
    { ...MSG, id: "m1", order: 10 },
    { ...MSG, id: "m2", order: 20 },
  ],
  fragments: [{
    id: "f1", kind: "alt", from_order: 10, to_order: 30, guard: "оплата прошла",
    branches: [{ start_order: 20, guard: "отказ" }],
  }],
} as unknown as ProcessDetail;

const lastCmd = () => histPush.mock.lastCall?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
  vi.mocked(processesApi.addFragment).mockResolvedValue({ id: "f2" } as never);
  vi.mocked(processesApi.updateFragment).mockResolvedValue({} as never);
  vi.mocked(processesApi.removeFragment).mockResolvedValue(undefined as never);
});

async function open() {
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("select-0-1");
}

describe("правки фрагментов процесса", () => {
  it("новый фрагмент: тип с тулбара, диапазон строк → order, условие; откат удаляет созданный", async () => {
    await open();
    await userEvent.click(screen.getByTitle("Фрагмент opt — выделить диапазон сообщений"));
    await userEvent.click(screen.getByText("select-0-1"));
    await userEvent.type(await screen.findByPlaceholderText("напр. оплата прошла"), "  есть скидка {Enter}");

    await waitFor(() => expect(processesApi.addFragment).toHaveBeenCalledWith("p1", {
      kind: "opt", from_order: 10, to_order: 20, guard: "есть скидка", branches: [],
    }));
    await waitFor(() => expect(screen.queryByText("Фрагмент «opt»")).toBeNull());
    expect(lastCmd()?.label).toBe("Добавление фрагмента");
    await lastCmd()?.undo();
    expect(processesApi.removeFragment).toHaveBeenCalledWith("p1", "f2");
  });

  it("охват: строки → order; откат возвращает прежние границы", async () => {
    await open();
    await userEvent.click(screen.getByText("resize-1-2"));
    await waitFor(() => expect(processesApi.updateFragment).toHaveBeenCalledWith(
      "p1", "f1", { from_order: 20, to_order: 30 }));
    expect(lastCmd()?.label).toBe("Охват фрагмента");
    await lastCmd()?.undo();
    expect(processesApi.updateFragment).toHaveBeenLastCalledWith("p1", "f1", { from_order: 10, to_order: 30 });
  });

  it("новая ветка встаёт в свободную строку охвата, ветви уходят по порядку", async () => {
    await open();
    await userEvent.click(screen.getByText("new-branch"));
    await userEvent.type(await screen.findByPlaceholderText("условие ветки, напр. «отказ»"), "ошибка");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    // Занята строка 1 (order 20), до конца охвата (строка 2) — свободная строка 2.
    await waitFor(() => expect(processesApi.updateFragment).toHaveBeenCalledWith("p1", "f1", {
      branches: [{ start_order: 20, guard: "отказ" }, { start_order: 30, guard: "ошибка" }],
    }));
    expect(lastCmd()?.label).toBe("Ветки «иначе»");
    await lastCmd()?.undo();
    expect(processesApi.updateFragment).toHaveBeenLastCalledWith(
      "p1", "f1", { branches: [{ start_order: 20, guard: "отказ" }] });
  });

  it("правка условия ветки и её снятие", async () => {
    await open();
    await userEvent.click(screen.getByText("edit-branch-0"));
    const input = await screen.findByDisplayValue("отказ");
    await userEvent.clear(input);
    await userEvent.type(input, "нет денег");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(processesApi.updateFragment).toHaveBeenCalledWith(
      "p1", "f1", { branches: [{ start_order: 20, guard: "нет денег" }] }));

    await userEvent.click(screen.getByText("edit-branch-0"));
    await userEvent.click(await screen.findByRole("button", { name: "Убрать ветку" }));
    await waitFor(() => expect(processesApi.updateFragment).toHaveBeenLastCalledWith(
      "p1", "f1", { branches: [] }));
  });

  it("перенос границы ветви: строка → order, остальное на месте", async () => {
    await open();
    await userEvent.click(screen.getByText("move-branch-0-to-2"));
    await waitFor(() => expect(processesApi.updateFragment).toHaveBeenCalledWith(
      "p1", "f1", { branches: [{ start_order: 30, guard: "отказ" }] }));
  });

  it("удаление фрагмента: откат возвращает его вместе с ветвями", async () => {
    await open();
    await userEvent.click(screen.getByText("click-f1"));
    await userEvent.click(await screen.findByRole("button", { name: "Да, удалить" }));
    await waitFor(() => expect(processesApi.removeFragment).toHaveBeenCalledWith("p1", "f1"));
    await waitFor(() => expect(screen.queryByText("Удалить фрагмент?")).toBeNull());
    expect(lastCmd()?.label).toBe("Удаление фрагмента");
    await lastCmd()?.undo();
    expect(processesApi.addFragment).toHaveBeenCalledWith("p1", {
      kind: "alt", from_order: 10, to_order: 30, guard: "оплата прошла",
      branches: [{ start_order: 20, guard: "отказ" }],
    });
  });
});
