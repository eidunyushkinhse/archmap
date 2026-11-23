// Фокус окон правки процесса (редизайн, фаза 13в): при открытии фокус внутри окна, Tab и
// Shift+Tab ходят по кругу внутри верхнего окна стека, закрытие возвращает фокус туда, где
// он был до открытия. Диаграмма подменена пультом (как в processEditWindows.test), выбор
// объектов и окна настоящие.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import ProcessCanvas from "../processes/ProcessCanvas";
import { processesApi } from "../../api/processes";
import { nodesApi } from "../../api/nodes";
import type { Node, ProcessDetail } from "../../types";

vi.mock("../processes/SequenceDiagram", () => ({
  default: (props: {
    onSelfConnect?: (pid: string) => void;
    onBindParticipant?: (pid: string) => void;
    onFragmentClick?: (fid: string) => void;
  }) => (
    <div>
      <button onClick={() => props.onSelfConnect?.("pa")}>self-pa</button>
      <button onClick={() => props.onBindParticipant?.("u")}>bind-u</button>
      <button onClick={() => props.onFragmentClick?.("f1")}>frag-f1</button>
    </div>
  ),
}));
vi.mock("../processes/useProcessHistory", () => ({
  useProcessHistory: () => ({
    push: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    canUndo: false, canRedo: false, undoLabel: null, redoLabel: null,
  }),
}));
vi.mock("../../api/processes", () => ({
  processesApi: {
    get: vi.fn(), directions: vi.fn(), channels: vi.fn(), addMessage: vi.fn(),
    addFragment: vi.fn(), updateFragment: vi.fn(), addParticipant: vi.fn(), bindParticipant: vi.fn(),
  },
}));
vi.mock("../../api/nodes", () => ({
  nodesApi: { get: vi.fn(), getAll: vi.fn() },
  edgesApi: { update: vi.fn(), create: vi.fn() },
}));

const MSG = {
  edge_id: "e1", leg: "forward", kind: "forward", technology: null, valid: true,
  edge_synchronous: true, from_participant_id: "pa", to_participant_id: "pb", caption: null,
};
const DETAIL = {
  id: "p1", name: "Оплата", scope_node_id: null, scope_name: null,
  participants: [
    { id: "pa", node_id: "na", name: "Покупатель", role: null, shape: "person",
      is_external: false, status: "existing", order: 0 },
    { id: "pb", node_id: "nb", name: "Заказы", role: null, shape: "service",
      is_external: false, status: "existing", order: 1 },
    { id: "u", node_id: null, name: "Биллинг", role: null, shape: null,
      is_external: null, status: null, order: 2 },
  ],
  messages: [{ ...MSG, id: "m1", order: 10 }, { ...MSG, id: "m2", order: 20 }],
  fragments: [{
    id: "f1", kind: "alt", from_order: 10, to_order: 20, guard: "оплата прошла",
    branches: [{ start_order: 20, guard: "отказ" }],
  }],
} as unknown as ProcessDetail;

function node(id: string, name: string): Node {
  return {
    id, name, description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "container", container_name: null,
    version: 1, created_at: "", updated_at: "", sites: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
  vi.mocked(processesApi.channels).mockResolvedValue([]);
  vi.mocked(nodesApi.getAll).mockResolvedValue([node("na", "Покупатель"), node("nb", "Заказы"), node("nc", "Склад")]);
});

async function open() {
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("self-pa");
}

// Верхнее окно стека: последний центр окна или подтверждения в разметке.
function topWindow(): HTMLElement {
  const all = document.querySelectorAll<HTMLElement>(".proc-center, .proc-confirm-center");
  const top = all[all.length - 1];
  if (!top) throw new Error("окно не открыто");
  return top;
}

// n нажатий Tab (или Shift+Tab): фокус ни разу не выходит из верхнего окна.
async function staysInside(n: number, shift = false) {
  const win = topWindow();
  for (let i = 0; i < n; i++) {
    await userEvent.tab({ shift });
    expect(win.contains(document.activeElement)).toBe(true);
  }
}

describe("фокус окон правки процесса", () => {
  it("«Участники»: фокус в поиске, Tab по кругу внутри, закрытие возвращает фокус на кнопку тулбара", async () => {
    await open();
    const add = screen.getByRole("button", { name: "Добавить участника" });
    add.focus();
    await userEvent.keyboard("{Enter}");
    const search = await screen.findByPlaceholderText("Поиск по имени");
    await waitFor(() => expect(search).toHaveFocus());
    await staysInside(12);
    await staysInside(12, true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Участники")).toBeNull());
    expect(add).toHaveFocus();
  });

  it("с последнего элемента Tab ведёт на первый, с первого Shift+Tab — на последний", async () => {
    await open();
    await userEvent.click(screen.getByText("self-pa"));
    const input = await screen.findByPlaceholderText("напр. валидация заказа");
    expect(input).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Добавить" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Отмена" })).toHaveFocus();
    await userEvent.tab();
    expect(input).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Отмена" })).toHaveFocus();
  });

  it("«Привязать «…»»: фокус в поиске, Escape возвращает фокус туда, откуда открыли", async () => {
    await open();
    const opener = screen.getByText("bind-u");
    await userEvent.click(opener);
    const search = await screen.findByPlaceholderText("Поиск по имени");
    await waitFor(() => expect(search).toHaveFocus());
    await staysInside(8);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Привязать «Биллинг»")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("«Привязать «…»» сменилось «Именами расходятся»: фокус на «Привязать», закрытие — туда, откуда открыли привязку", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue(node("nc", "Склад"));
    await open();
    const opener = screen.getByText("bind-u");
    await userEvent.click(opener);
    await userEvent.click(await screen.findByText("Склад"));
    await userEvent.click(screen.getByRole("button", { name: "Добавить (1)" }));
    await screen.findByText("Имена расходятся");
    expect(within(topWindow()).getByRole("button", { name: "Привязать" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Имена расходятся")).toBeNull());
    expect(opener).toHaveFocus();
    expect(processesApi.bindParticipant).not.toHaveBeenCalled();
  });

  it("подтверждение: фокус на главной кнопке, Tab между двумя кнопками, закрытие — фокус обратно", async () => {
    await open();
    const opener = screen.getByText("frag-f1");
    await userEvent.click(opener);
    const del = await screen.findByRole("button", { name: "Удалить" });
    expect(del).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Отмена" })).toHaveFocus();
    await userEvent.tab();
    expect(del).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Удалить фрагмент?")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("подтверждение поверх «Участников»: Tab держится в верхнем окне, закрытие — фокус в окно под ним", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Добавить участника" }));
    await screen.findByPlaceholderText("Поиск по имени");
    const remove = screen.getAllByTitle("Убрать")[0];
    await userEvent.click(remove);
    await waitFor(() => expect(document.querySelector(".proc-confirm-center")).not.toBeNull());
    const confirm = within(topWindow()).getByRole("button", { name: "Убрать" });
    expect(confirm).toHaveFocus();
    await staysInside(4);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".proc-confirm-center")).toBeNull());
    expect(remove).toHaveFocus();
    expect(screen.getByText("Участники")).toBeInTheDocument();
  });
});
