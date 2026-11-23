// Окна правки процесса поверх диаграммы: шаг внутри участника, условие фрагмента, ветка
// «иначе», «Участники», привязка участника, «Добавить шаг». Страховочная сетка перевода окон
// на новый язык (редизайн, фаза 13г): держит механику, а не вид. Состав и порядок кнопок с
// текстом, фокус в поле при открытии, Enter в поле как главная кнопка, закрытие подложкой,
// Escape и «Отмена» без записи. Диаграмма подменена пультом, запросы заглушками; выбор
// объектов (ParticipantPicker) и окно шага (MessageComposer) настоящие.
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
    onConnect?: (from: string, to: string) => void;
    onEditBranch?: (id: string, index: number | null) => void;
    onSelectRange?: (from: number, to: number) => void;
    onBindParticipant?: (pid: string) => void;
  }) => (
    <div>
      <button onClick={() => props.onSelfConnect?.("pa")}>self-pa</button>
      <button onClick={() => props.onConnect?.("pa", "pb")}>connect-pa-pb</button>
      <button onClick={() => props.onEditBranch?.("f1", null)}>new-branch</button>
      <button onClick={() => props.onEditBranch?.("f1", 0)}>edit-branch-0</button>
      <button onClick={() => props.onSelectRange?.(0, 1)}>select-0-1</button>
      <button onClick={() => props.onBindParticipant?.("u")}>bind-u</button>
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

function node(id: string, name: string, over: Partial<Node> = {}): Node {
  return {
    id, name, description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "container", container_name: null,
    version: 1, created_at: "", updated_at: "", sites: [], ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processesApi.get).mockResolvedValue(DETAIL);
  vi.mocked(processesApi.directions).mockResolvedValue([] as never);
  vi.mocked(processesApi.channels).mockResolvedValue([]);
  vi.mocked(processesApi.addMessage).mockResolvedValue({ id: "m9" } as never);
  vi.mocked(processesApi.updateFragment).mockResolvedValue({} as never);
  vi.mocked(nodesApi.getAll).mockResolvedValue([node("na", "Покупатель"), node("nb", "Заказы"), node("nc", "Склад")]);
});

async function open() {
  render(<ProcessCanvas id="p1" isArchitect editing onToggleEditing={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("self-pa");
}

// Окно поверх диаграммы: ближайший предок, перед слоем которого лежит пустая подложка (у
// прежней и новой разметки порядок один: подложка, центр, окно).
function windowOf(el: HTMLElement): HTMLElement {
  let e: HTMLElement | null = el;
  while (e?.parentElement) {
    const dim = e.parentElement.previousElementSibling;
    if (dim instanceof HTMLDivElement && dim.childElementCount === 0 && !dim.textContent) return e;
    e = e.parentElement;
  }
  throw new Error("окно не найдено");
}
const dimOf = (win: HTMLElement) => win.parentElement?.previousElementSibling as HTMLElement;
// Кнопки окна с текстом в порядке разметки (значки-кнопки без текста не считаются).
const textButtons = (win: HTMLElement) =>
  within(win).getAllByRole("button").map((b) => b.textContent?.trim() ?? "").filter(Boolean);
const noWrites = () => {
  expect(processesApi.addMessage).not.toHaveBeenCalled();
  expect(processesApi.addFragment).not.toHaveBeenCalled();
  expect(processesApi.updateFragment).not.toHaveBeenCalled();
  expect(processesApi.addParticipant).not.toHaveBeenCalled();
  expect(processesApi.bindParticipant).not.toHaveBeenCalled();
};

describe("окно «Шаг внутри участника»", () => {
  it("заголовок, пояснение, фокус в поле, кнопки «Добавить» и «Отмена»", async () => {
    await open();
    await userEvent.click(screen.getByText("self-pa"));
    const win = windowOf(await screen.findByText("Шаг внутри «Покупатель»"));
    expect(within(win).getByText("Участник делает что-то сам, без связи с другими объектами.")).toBeInTheDocument();
    expect(within(win).getByPlaceholderText("напр. валидация заказа")).toHaveFocus();
    expect(textButtons(win)).toEqual(["Добавить", "Отмена"]);
  });

  it("Enter в поле добавляет шаг с подписью, как главная кнопка", async () => {
    await open();
    await userEvent.click(screen.getByText("self-pa"));
    await userEvent.type(await screen.findByPlaceholderText("напр. валидация заказа"), "проверка корзины{Enter}");
    await waitFor(() => expect(processesApi.addMessage).toHaveBeenCalledWith("p1", {
      leg: "forward", from_participant_id: "pa", to_participant_id: "pa", caption: "проверка корзины", order: 21,
    }));
    await waitFor(() => expect(screen.queryByText("Шаг внутри «Покупатель»")).toBeNull());
  });

  it("Escape, подложка и «Отмена» закрывают без записи", async () => {
    await open();
    await userEvent.click(screen.getByText("self-pa"));
    await screen.findByText("Шаг внутри «Покупатель»");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Шаг внутри «Покупатель»")).toBeNull());

    await userEvent.click(screen.getByText("self-pa"));
    await userEvent.click(dimOf(windowOf(await screen.findByText("Шаг внутри «Покупатель»"))));
    await waitFor(() => expect(screen.queryByText("Шаг внутри «Покупатель»")).toBeNull());

    await userEvent.click(screen.getByText("self-pa"));
    const win = windowOf(await screen.findByText("Шаг внутри «Покупатель»"));
    await userEvent.click(within(win).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByText("Шаг внутри «Покупатель»")).toBeNull());
    noWrites();
  });
});

describe("окно условия фрагмента", () => {
  it("кнопки «Добавить» и «Отмена», фокус в поле; подложка закрывает без записи", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Фрагмент" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Необязательно (opt)" }));
    await userEvent.click(screen.getByText("select-0-1"));
    const win = windowOf(await screen.findByText("Фрагмент «opt»"));
    expect(within(win).getByText("Шаги 1–2. Условие будет в заголовке фрагмента.")).toBeInTheDocument();
    expect(within(win).getByPlaceholderText("напр. оплата прошла")).toHaveFocus();
    expect(textButtons(win)).toEqual(["Добавить", "Отмена"]);
    await userEvent.click(dimOf(win));
    await waitFor(() => expect(screen.queryByText("Фрагмент «opt»")).toBeNull());
    noWrites();
  });
});

describe("окно ветки «иначе»", () => {
  it("новая ветка: «Добавить» и «Отмена»; Escape закрывает без записи", async () => {
    await open();
    await userEvent.click(screen.getByText("new-branch"));
    const win = windowOf(await screen.findByText("Добавить ветку «иначе»"));
    expect(within(win).getByPlaceholderText("условие ветки, напр. «отказ»")).toHaveFocus();
    expect(textButtons(win)).toEqual(["Добавить", "Отмена"]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Добавить ветку «иначе»")).toBeNull());
    noWrites();
  });

  it("правка ветки: «Убрать ветку», «Сохранить», «Отмена»; Enter сохраняет условие", async () => {
    await open();
    await userEvent.click(screen.getByText("edit-branch-0"));
    const win = windowOf(await screen.findByText("Ветка «иначе»"));
    expect(within(win).getByText("Ветка 2 у этого alt")).toBeInTheDocument();
    expect(textButtons(win)).toEqual(["Убрать ветку", "Сохранить", "Отмена"]);
    const input = within(win).getByDisplayValue("отказ");
    expect(input).toHaveFocus();
    await userEvent.type(input, " банка{Enter}");
    await waitFor(() => expect(processesApi.updateFragment).toHaveBeenCalledWith(
      "p1", "f1", { branches: [{ start_order: 20, guard: "отказ банка" }] }));
  });
});

describe("окно «Участники»", () => {
  it("строки участников с «Убрать», выбор объектов и «Добавить» без выбора заперта", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Добавить участника" }));
    const win = windowOf(await screen.findByText("Участники"));
    expect(within(win).getAllByTitle("Убрать")).toHaveLength(3);
    expect(within(win).getByText("Добавить из дерева схемы")).toBeInTheDocument();
    await within(win).findByText("Склад");
    expect(within(win).getByPlaceholderText("Поиск по имени")).toBeInTheDocument();
    expect(textButtons(win)).toEqual(["Добавить"]);
    expect(within(win).getByRole("button", { name: "Добавить" })).toBeDisabled();
  });

  it("Escape и подложка закрывают без записи", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Добавить участника" }));
    await screen.findByText("Участники");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Участники")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Добавить участника" }));
    await userEvent.click(dimOf(windowOf(await screen.findByText("Участники"))));
    await waitFor(() => expect(screen.queryByText("Участники")).toBeNull());
    noWrites();
  });
});

describe("окно «Привязать «…»»", () => {
  it("заголовок с именем участника, пояснение, «Добавить» без выбора заперта", async () => {
    await open();
    await userEvent.click(screen.getByText("bind-u"));
    const win = windowOf(await screen.findByText("Привязать «Биллинг»"));
    expect(within(win).getByText(/Участник пришёл из импорта, или его объект удалили со схемы/)).toBeInTheDocument();
    await within(win).findByText("Склад");
    expect(textButtons(win)).toEqual(["Добавить"]);
    expect(within(win).getByRole("button", { name: "Добавить" })).toBeDisabled();
  });

  it("Escape и подложка закрывают без записи", async () => {
    await open();
    await userEvent.click(screen.getByText("bind-u"));
    await screen.findByText("Привязать «Биллинг»");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Привязать «Биллинг»")).toBeNull());

    await userEvent.click(screen.getByText("bind-u"));
    await userEvent.click(dimOf(windowOf(await screen.findByText("Привязать «Биллинг»"))));
    await waitFor(() => expect(screen.queryByText("Привязать «Биллинг»")).toBeNull());
    noWrites();
  });
});

describe("окно «Добавить шаг» на холсте", () => {
  it("подложка и Escape закрывают окно, направления перечитываются", async () => {
    await open();
    // Направления читаются при входе в правку и при каждой смене процесса: считаем от
    // числа вызовов к моменту открытия окна.
    await userEvent.click(screen.getByText("connect-pa-pb"));
    const win = windowOf(await screen.findByText("Добавить шаг"));
    expect(processesApi.channels).toHaveBeenCalledWith("p1", "na", "nb");
    const before = vi.mocked(processesApi.directions).mock.calls.length;
    await userEvent.click(dimOf(win));
    await waitFor(() => expect(screen.queryByText("Добавить шаг")).toBeNull());
    expect(processesApi.directions).toHaveBeenCalledTimes(before + 1);

    await userEvent.click(screen.getByText("connect-pa-pb"));
    await screen.findByText("Добавить шаг");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Добавить шаг")).toBeNull());
    expect(processesApi.directions).toHaveBeenCalledTimes(before + 2);
    noWrites();
  });
});
