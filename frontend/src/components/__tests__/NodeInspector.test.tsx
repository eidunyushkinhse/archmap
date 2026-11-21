// Панель объекта редактора-карты (редизайн, фаза 4а): те же строки, что «Свойства»
// страницы объекта (nodePage/PropRows), в один столбец. Строка «Тип» (Р40 раздела 13
// docs/plan-c4-elements.md) — смена формы и элемента архитектором, серые пункты, отказ
// сервера плашкой и отсутствие выпадашки у наблюдателя. Любая правка коммитится сразу
// (выбор) или по уходу с поля (тексты) и уходит в Undo редактора тем же onNodeSaved —
// своей истории у панели нет.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeInspector from "../inspector/NodeInspector";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { AncestorRef, DeletionSnapshot, Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    update: vi.fn(),
    get: vi.fn(),
    getDescendants: vi.fn(() => Promise.resolve([])),
    getEdges: vi.fn(),
    deletionSnapshot: vi.fn(),
    delete: vi.fn(),
    // Живая нормализация источника: форма поля «Источник» зовёт её при вводе.
    anchorPreview: vi.fn(),
    // Превью последствий смены элемента: строка «Тип» зовёт его до записи.
    elementPreview: vi.fn(),
  },
}));

function makeNode(over: Partial<Node> = {}): Node {
  return {
    id: "n1",
    name: "Monitored Hosts",
    description: null,
    role: null,
    technology: null,
    parent_id: null,
    shape: "person",
    is_external: false,
    status: "existing",
    openapi_spec: null,
    version: 3,
    docs: [],
    has_children: false,
    child_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as Node;
}

const cb = {
  // Предки узла (крошки уровня): по ним строка «Тип» решает, какие типы возможны.
  ancestors: [],
  onNodeSaved: vi.fn(),
  onNodeDeleted: vi.fn(),
  onNavigateNode: vi.fn(),
  onClose: vi.fn(),
};

function setup(node: Node, isArchitect = true) {
  return render(<NodeInspector node={node} isArchitect={isArchitect} {...cb} />);
}

// Строка свойств по подписи: значение (dd) её ряда.
function row(term: string): HTMLElement {
  const r = [...document.querySelectorAll(".np-prop")].find((p) => p.querySelector(".np-term")?.textContent === term);
  const dd = r?.querySelector("dd");
  if (!(dd instanceof HTMLElement)) throw new Error(`нет строки «${term}»`);
  return dd;
}
const terms = () => [...document.querySelectorAll(".np-term")].map((t) => t.textContent);

describe("NodeInspector: смена типа формой", () => {
  beforeEach(() => vi.clearAllMocks());

  const typeButton = () => screen.getByRole("button", { name: "Тип" });
  const option = (label: string) => screen.getByRole("option", { name: new RegExp(`^${label}`) });

  it("«Пользователь» → «Контейнер»: сервис с элементом одной правкой, запись в историю", async () => {
    const saved = makeNode({ shape: "service", element: "container", element_effective: "container", version: 4 });
    vi.mocked(nodesApi.update).mockResolvedValue(saved);
    const before = makeNode({ shape: "person", element_effective: null });
    setup(before);

    expect(typeButton()).toHaveTextContent("Пользователь");
    await userEvent.click(typeButton());
    await userEvent.click(option("Контейнер"));

    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    const [id, payload] = vi.mocked(nodesApi.update).mock.calls[0];
    expect(id).toBe("n1");
    expect(payload).toMatchObject({ shape: "service", element: "container", base_version: 3 });
    // Превью элемента у не-сервиса сервер не считает — правка одна, без него.
    expect(nodesApi.elementPreview).not.toHaveBeenCalled();
    await waitFor(() => expect(cb.onNodeSaved).toHaveBeenCalledWith(saved, false, before));
  });

  it("«Контейнер» → «База данных»: смена формы, элемент не шлётся", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ shape: "database", version: 4 }));
    setup(makeNode({ shape: "service", element_effective: "container" }));
    await userEvent.click(typeButton());
    await userEvent.click(option("База данных"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    const payload = vi.mocked(nodesApi.update).mock.calls[0][1];
    expect(payload.shape).toBe("database");
    expect(payload).not.toHaveProperty("element");
  });

  it("тот же тип — без запроса", async () => {
    setup(makeNode({ shape: "service", element_effective: "container" }));
    await userEvent.click(typeButton());
    await userEvent.click(option("Контейнер"));
    expect(nodesApi.update).not.toHaveBeenCalled();
    expect(nodesApi.elementPreview).not.toHaveBeenCalled();
  });

  it("отказ сервера показан плашкой, а не проглочен", async () => {
    const причина = "У объекта описана структура БД — сначала перенесите или удалите её";
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, причина));
    setup(makeNode({ shape: "database", element_effective: "container" }));

    await userEvent.click(typeButton());
    await userEvent.click(option("Брокер"));

    expect(await screen.findByText(причина)).toHaveClass("ds-warn");
    // Правка не применилась — в историю ничего не легло
    expect(cb.onNodeSaved).not.toHaveBeenCalled();
  });

  it("вложенный объект: «Пользователь» серый, запроса нет", async () => {
    // «Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31).
    const system: AncestorRef = { id: "s1", name: "Ярмарка", is_external: false, element_effective: "system" };
    render(<NodeInspector node={makeNode({ shape: "service", element_effective: "container", parent_id: "s1" })}
      isArchitect {...cb} ancestors={[system]} />);
    await userEvent.click(typeButton());
    const person = option("Пользователь");
    expect(person).toHaveAttribute("aria-disabled", "true");
    expect(person.textContent).toBe("Пользователь");
    await userEvent.click(person);
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("наблюдателю тип показан текстом, выпадашки нет", () => {
    setup(makeNode({ shape: "person", element_effective: null }), false);
    expect(row("Тип")).toHaveTextContent("Пользователь");
    expect(screen.queryByRole("button", { name: "Тип" })).toBeNull();
  });
});

// ── Источник ───────────────────────────────────────────────────────────────────
// Та же строка «Источник», что в «Свойствах» страницы объекта (один компонент на оба
// места): в редакторе она правится не выходя с карты и уходит тем же save с CAS.
describe("NodeInspector: источник", () => {
  beforeEach(() => vi.clearAllMocks());

  it("показывает источник узла и правит его тем же PATCH с base_version", async () => {
    const n = makeNode({ shape: "service", source: { repo: null, path: null, host: "kafka" }, version: 3 });
    vi.mocked(nodesApi.anchorPreview).mockResolvedValue({
      source: { repo: "github.com/org/repo", path: null, host: null }, kind: "code", key: "git:github.com/org/repo",
    });
    vi.mocked(nodesApi.update).mockResolvedValue(
      makeNode({ source: { repo: "github.com/org/repo", path: null, host: null }, version: 4 }),
    );
    setup(n);

    await userEvent.click(within(row("Источник")).getByRole("button", { name: "Источник: kafka" }));
    await userEvent.click(screen.getByRole("radio", { name: "Код" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "github.com/org/repo");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({
      source: { repo: "github.com/org/repo", path: null },
      base_version: 3,
    });
    expect(cb.onNodeSaved).toHaveBeenCalled();
  });

  it("Escape в панели источника закрывает только её, не панель объекта", async () => {
    const onWindowKey = vi.fn();
    const listener = (e: KeyboardEvent) => { if (e.key === "Escape") onWindowKey(); };
    window.addEventListener("keydown", listener);
    setup(makeNode({ shape: "service", source: { repo: null, path: null, host: "kafka" } }));
    await userEvent.click(screen.getByRole("button", { name: "Источник: kafka" }));
    await userEvent.keyboard("{Escape}");
    window.removeEventListener("keydown", listener);
    expect(screen.queryByRole("group", { name: "Источник" })).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(cb.onClose).not.toHaveBeenCalled();
  });

  it("наблюдателю источник только читается, без источника строки нет", () => {
    const { unmount } = setup(makeNode({ shape: "service", source: { repo: "github.com/org/repo", path: null, host: null } }), false);
    expect(row("Источник")).toHaveTextContent("github.com/org/repo");
    expect(within(row("Источник")).queryByRole("button")).toBeNull();
    unmount();
    setup(makeNode({ shape: "service" }), false);
    expect(terms()).not.toContain("Источник");
  });
});

// ── Заголовок: значок формы, название, «Открыть страницу объекта», «Закрыть» ────
// Серой строки типа под названием больше нет: тип называет строка «Тип». Название у
// редактора правится на месте (поле в виде текста): Enter и уход с поля сохраняют, Escape
// возвращает прежнее.
describe("NodeInspector: заголовок", () => {
  beforeEach(() => vi.clearAllMocks());

  it("кнопки заголовка: страница объекта и закрытие; у «Пользователя» страницы нет", async () => {
    const { unmount } = setup(makeNode({ shape: "service", element_effective: "container" }));
    await userEvent.click(screen.getByRole("button", { name: "Открыть страницу объекта" }));
    expect(cb.onNavigateNode).toHaveBeenCalledWith("n1");
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(cb.onClose).toHaveBeenCalledOnce();
    unmount();
    setup(makeNode({ shape: "person", element_effective: null }));
    expect(screen.queryByRole("button", { name: "Открыть страницу объекта" })).toBeNull();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
  });

  it("серой строки типа под названием нет; блока «Документация» нет", () => {
    setup(makeNode({ shape: "service", element_effective: "container" }));
    expect(document.querySelector(".insp-typeline")).toBeNull();
    expect(screen.queryByText("Документация")).toBeNull();
    expect(screen.queryByRole("button", { name: "Открыть" })).toBeNull();
  });

  it("Enter в названии сохраняет его", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ name: "Hosts", version: 4 }));
    setup(makeNode());
    const имя = screen.getByRole("textbox", { name: "Название" });
    await userEvent.clear(имя);
    await userEvent.type(имя, "Hosts{Enter}");
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({ name: "Hosts", base_version: 3 });
  });

  it("Escape в названии с правкой возвращает прежнее и дальше не уходит; без правки — уходит", async () => {
    const onWindowKey = vi.fn();
    const listener = (e: KeyboardEvent) => { if (e.key === "Escape") onWindowKey(); };
    window.addEventListener("keydown", listener);
    setup(makeNode());
    const имя = screen.getByRole("textbox", { name: "Название" });
    await userEvent.type(имя, " 2");
    await userEvent.keyboard("{Escape}");
    expect(имя).toHaveValue("Monitored Hosts");
    expect(onWindowKey).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onWindowKey).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", listener);
    fireEvent.blur(имя);
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("читателю название — заголовком, полей нет вовсе", () => {
    setup(makeNode({ shape: "service", element_effective: "container", description: "Шлюз", role: "шлюз" }), false);
    expect(screen.getByRole("heading", { name: "Monitored Hosts" })).toBeInTheDocument();
    expect(document.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(screen.getByText("Шлюз")).toBeInTheDocument();
  });
});

// ── Строки: порядок, читатель ────────────────────────────────────────────────
describe("NodeInspector: строки свойств", () => {
  beforeEach(() => vi.clearAllMocks());

  it("один столбец в порядке «Тип», «Принадлежность», «Статус», «Роль», «Технология», «Источник»", () => {
    setup(makeNode({ shape: "service", element_effective: "container" }));
    expect(terms()).toEqual(["Тип", "Принадлежность", "Статус", "Роль", "Технология", "Источник"]);
    // Размещение ведётся в режиме «Развёртывание» и на странице объекта.
    expect(terms()).not.toContain("Размещение");
  });

  it("у «Пользователя» технологии нет", () => {
    setup(makeNode({ shape: "person", element_effective: null }));
    expect(terms()).toEqual(["Тип", "Принадлежность", "Статус", "Роль", "Источник"]);
  });

  it("читатель видит только строки со значением, пустое описание не показано", () => {
    setup(makeNode({ shape: "service", element_effective: "container" }), false);
    expect(terms()).toEqual(["Тип", "Принадлежность", "Статус"]);
    expect(screen.queryByText("Добавьте описание")).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить объект" })).toBeNull();
  });

  it("статус — выпадашкой; Escape закрывает только меню", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ status: "planned", version: 4 }));
    setup(makeNode({ shape: "service", element_effective: "container" }));
    const value = within(row("Статус")).getByRole("button");
    await userEvent.click(value);
    await userEvent.keyboard("{Escape}");
    expect(value).toHaveAttribute("aria-expanded", "false");
    expect(cb.onClose).not.toHaveBeenCalled();
    await userEvent.click(value);
    await userEvent.click(screen.getByRole("button", { name: "Проектируется" }));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({ status: "planned" });
  });
});

// Принадлежность — выпадашкой из двух пунктов, как на странице объекта (прежний тогл
// панели ушёл вместе с ней). Данные прежние: выбор переключает is_external.
describe("NodeInspector: принадлежность", () => {
  beforeEach(() => vi.clearAllMocks());
  // Открытое меню выпадашки: пункт с тем же словом, что значение, есть и в нём.
  const menu = () => {
    const m = document.querySelector(".np-menu");
    if (!(m instanceof HTMLElement)) throw new Error("меню не открыто");
    return m;
  };

  it("значение называет принадлежность словом", () => {
    const { unmount } = setup(makeNode({ is_external: false }));
    expect(within(row("Принадлежность")).getByRole("button")).toHaveTextContent("Внутренний");
    unmount();
    setup(makeNode({ is_external: true }));
    expect(within(row("Принадлежность")).getByRole("button")).toHaveTextContent("Внешний");
  });

  it("отказ записи — значение возвращается, причина плашкой (аудит R-13)", async () => {
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, "Сервер отказал"));
    setup(makeNode({ is_external: false }));
    await userEvent.click(within(row("Принадлежность")).getByRole("button"));
    await userEvent.click(screen.getByRole("button", { name: "Внешний" }));
    expect(await screen.findByText("Сервер отказал")).toBeInTheDocument();
    expect(within(row("Принадлежность")).getByRole("button")).toHaveTextContent("Внутренний");
  });

  it("выбор «Внешний» переключает is_external; тот же пункт — без запроса", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ is_external: true, version: 4 }));
    setup(makeNode({ is_external: false }));
    await userEvent.click(within(row("Принадлежность")).getByRole("button"));
    await userEvent.click(within(menu()).getByRole("button", { name: "Внутренний" }));
    expect(nodesApi.update).not.toHaveBeenCalled();
    await userEvent.click(within(row("Принадлежность")).getByRole("button"));
    await userEvent.click(screen.getByRole("button", { name: "Внешний" }));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1].is_external).toBe(true);
  });
});

describe("NodeInspector: правка текстовых полей", () => {
  beforeEach(() => vi.clearAllMocks());

  it("имя по blur — PATCH всего узла, в историю узел ДО правки, следующая правка от новой версии", async () => {
    const first = makeNode({ name: "Hosts", version: 4 });
    const second = makeNode({ name: "Hosts", role: "агент", version: 5 });
    vi.mocked(nodesApi.update).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const before = makeNode();
    setup(before);

    const имя = screen.getByDisplayValue("Monitored Hosts");
    await userEvent.clear(имя);
    await userEvent.type(имя, "Hosts");
    await userEvent.tab();
    await waitFor(() => expect(cb.onNodeSaved).toHaveBeenCalledWith(first, false, before));
    const [, payload] = vi.mocked(nodesApi.update).mock.calls[0];
    expect(payload).toMatchObject({ name: "Hosts", base_version: 3, shape: "person", status: "existing" });

    await userEvent.type(screen.getByRole("textbox", { name: "Роль" }), "агент");
    await userEvent.tab();
    await waitFor(() => expect(cb.onNodeSaved).toHaveBeenCalledWith(second, false, first));
    expect(vi.mocked(nodesApi.update).mock.calls[1][1]).toMatchObject({ role: "агент", base_version: 4 });
  });

  it("пустое имя по blur откатывается без запроса", async () => {
    setup(makeNode());
    const имя = screen.getByDisplayValue("Monitored Hosts");
    await userEvent.clear(имя);
    await userEvent.tab();
    expect(screen.getByDisplayValue("Monitored Hosts")).toBeInTheDocument();
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("описание — тем же полем, что на странице объекта; Escape с правкой возвращает прежнее", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ description: "Новое", version: 4 }));
    setup(makeNode({ description: "Старое" }));
    const описание = screen.getByRole("textbox", { name: "Описание" });
    expect(описание).toHaveClass("np-desc-input");
    await userEvent.type(описание, " и ещё");
    await userEvent.keyboard("{Escape}");
    expect(описание).toHaveValue("Старое");
    await userEvent.clear(описание);
    await userEvent.type(описание, "Новое");
    await userEvent.tab();
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({ description: "Новое" });
  });

  it("409 — поля подтянуты с сервера, плашка, в историю ничего", async () => {
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(409, "conflict"));
    vi.mocked(nodesApi.get).mockResolvedValue(makeNode({ role: "чужая роль", version: 7 }));
    setup(makeNode());

    await userEvent.type(screen.getByRole("textbox", { name: "Роль" }), "моя роль");
    await userEvent.tab();

    expect(await screen.findByText(/только что изменили в другом окне/)).toHaveClass("ds-warn");
    expect(screen.getByDisplayValue("чужая роль")).toBeInTheDocument();
    expect(cb.onNodeSaved).not.toHaveBeenCalled();
  });
});

// ── Строка «Тип»: система и контейнер (Р40) ──────────────────────────────────
// Строки «Тип» и «Элемент архитектуры» слиты: система ↔ контейнер у сервиса — смена
// элемента с превью последствий (без них PATCH сразу и в историю, с ними — окно, PATCH
// после подтверждения и без истории). Невозможные пункты — серые.
describe("NodeInspector: тип система и контейнер", () => {
  beforeEach(() => vi.clearAllMocks());

  const system = (over: Partial<Node> = {}) => makeNode({
    name: "orders", shape: "service", has_children: true, child_count: 2,
    element: null, element_effective: "system", container_name: null, ...over,
  });
  const quiet = { kind: "system_to_container" as const, before: [], after: [], docs_names: [], container_name: null };
  const typeButton = () => screen.getByRole("button", { name: "Тип" });
  const option = (label: string) => screen.getByRole("option", { name: new RegExp(`^${label}`) });

  async function pickContainer() {
    await userEvent.click(typeButton());
    await userEvent.click(option("Контейнер"));
  }

  it("система → контейнер без последствий: PATCH сразу и в историю", async () => {
    vi.mocked(nodesApi.elementPreview).mockResolvedValue(quiet);
    const saved = system({ element: "container", element_effective: "container", version: 4 });
    vi.mocked(nodesApi.update).mockResolvedValue(saved);
    const before = system();
    setup(before);
    expect(typeButton()).toHaveTextContent("Система");

    await userEvent.click(typeButton());
    // Пункт — только название типа, без подсказки под ним.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Система", "Контейнер", "Компонент", "База данных", "Брокер", "Пользователь",
    ]);
    await userEvent.click(option("Контейнер"));

    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(nodesApi.elementPreview).toHaveBeenCalledWith("n1", "container");
    expect(vi.mocked(nodesApi.update).mock.calls[0][1].element).toBe("container");
    await waitFor(() => expect(cb.onNodeSaved).toHaveBeenCalledWith(saved, false, before));
    expect(screen.queryByText("Сделать «orders» контейнером?")).not.toBeInTheDocument();
  });

  it("с последствиями — окно с таблицей, PATCH после подтверждения и без истории", async () => {
    vi.mocked(nodesApi.elementPreview).mockResolvedValue({
      ...quiet,
      before: [{ node_id: "a", name: "api", sites: ["prod-eu"] }],
      after: [{ node_id: "n1", name: "orders", sites: ["prod-eu"] }],
    });
    const saved = system({ element: "container", element_effective: "container", version: 4 });
    vi.mocked(nodesApi.update).mockResolvedValue(saved);
    setup(system());

    await pickContainer();
    expect(await screen.findByText("Сделать «orders» контейнером?")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(nodesApi.update).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("Сделать контейнером"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    await waitFor(() => expect(cb.onNodeSaved).toHaveBeenCalledWith(saved, false, undefined));
  });

  it("«Отмена» в окне последствий — без записи", async () => {
    vi.mocked(nodesApi.elementPreview).mockResolvedValue({ ...quiet, docs_names: ["api"] });
    setup(system());
    await pickContainer();
    await userEvent.click(await screen.findByText("Отмена"));
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("отказ превью — плашка с причиной, записи нет", async () => {
    vi.mocked(nodesApi.elementPreview).mockRejectedValue(new ApiError(
      422, "Внутри лежит база данных «orders-db», она не может входить в состав контейнера. Вынесите её на уровень выше и повторите.",
    ));
    setup(system());
    await pickContainer();
    expect(await screen.findByText(/Внутри лежит база данных «orders-db»/)).toBeInTheDocument();
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("невозможные пункты серые и не выбираются", async () => {
    setup(system());
    await userEvent.click(typeButton());
    const db = option("База данных");
    expect(db).toHaveAttribute("aria-disabled", "true");
    expect(db.textContent).toBe("База данных");
    expect(option("Компонент")).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(db);
    expect(nodesApi.update).not.toHaveBeenCalled();
    expect(nodesApi.elementPreview).not.toHaveBeenCalled();
  });

  it("лист → «Система»: превью и запись элемента (пустая система, Р39)", async () => {
    vi.mocked(nodesApi.elementPreview).mockResolvedValue({ ...quiet, kind: "empty_system" });
    vi.mocked(nodesApi.update).mockResolvedValue(
      makeNode({ shape: "service", element: "system", element_effective: "system", version: 4 }),
    );
    setup(makeNode({ shape: "service", element_effective: "container" }));
    await userEvent.click(typeButton());
    await userEvent.click(option("Система"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(nodesApi.elementPreview).toHaveBeenCalledWith("n1", "system");
    expect(vi.mocked(nodesApi.update).mock.calls[0][1].element).toBe("system");
  });

  it("внешний лист без элемента — «Внешняя система», «Контейнер» в списке — смена элемента (Р42)", async () => {
    vi.mocked(nodesApi.elementPreview).mockResolvedValue({ ...quiet, kind: "none" });
    vi.mocked(nodesApi.update).mockResolvedValue(
      makeNode({ shape: "service", is_external: true, element: "container", element_effective: "container", version: 4 }),
    );
    setup(makeNode({ shape: "service", is_external: true, element: null, element_effective: "system" }));
    expect(typeButton()).toHaveTextContent("Внешняя система");
    await userEvent.click(typeButton());
    // Пункты меню — названия типов, без слова «внешний».
    expect(option("Система")).toHaveAttribute("aria-selected", "true");
    await userEvent.click(option("Контейнер"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1].element).toBe("container");
  });

  it("читателю — текстом; у «Пользователя» тип тоже есть", () => {
    const { unmount } = setup(system({ element: "container", element_effective: "container" }), false);
    expect(within(row("Тип")).getByText("Контейнер")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Тип" })).not.toBeInTheDocument();
    unmount();
    setup(makeNode({ shape: "person", element_effective: null }));
    expect(typeButton()).toHaveTextContent("Пользователь");
  });
});

// ── Р40: одна строка «Тип» подписью typeView, технология системы ───────────────
// Р40: строка «Тип» одна у любого объекта (у узла с детьми тоже) и стоит первой. Слова
// «Сервис» в интерфейсе нет, внешность звучит только у системы и контейнера. Справки «?»
// у подписи и строки «Входит в контейнер» нет: контейнер компонента виден по уровню
// схемы. Р15: сводная технология только у системы.
describe("NodeInspector: строка «Тип» по Р40", () => {
  beforeEach(() => vi.clearAllMocks());

  const ancestor = (id: string, name: string, element_effective: AncestorRef["element_effective"]): AncestorRef =>
    ({ id, name, is_external: false, element_effective });

  const cases: [string, Partial<Node>, string][] = [
    ["контейнер", { shape: "service", element_effective: "container" }, "Контейнер"],
    ["система с вложенными", { shape: "service", has_children: true, child_count: 2, element_effective: "system" }, "Система"],
    ["внешняя система", { shape: "service", is_external: true, element_effective: "system" }, "Внешняя система"],
    ["внешний контейнер", { shape: "service", is_external: true, element: "container", element_effective: "container" }, "Внешний контейнер"],
    ["компонент", { shape: "service", element_effective: "component", container_name: "orders" }, "Компонент"],
    ["внешняя база данных", { shape: "database", is_external: true, element_effective: "container" }, "База данных"],
    ["пользователь", { shape: "person", element_effective: null }, "Пользователь"],
    ["пустая система (Р39)", { shape: "service", element: "system", element_effective: "system" }, "Система"],
  ];

  it.each(cases)("%s — подпись строки «Тип»", (_name, over, label) => {
    setup(makeNode(over), false);
    expect(row("Тип").textContent).toBe(label);
    expect(row("Тип").textContent).not.toMatch(/[Сс]ервис|внутренн/);
  });

  it("одна строка «Тип» первой — у листа и у узла с детьми; «Элемент архитектуры» и «?» нет", () => {
    const { unmount } = setup(makeNode({
      shape: "service", has_children: true, child_count: 2, element: "container", element_effective: "container",
    }));
    expect(terms()[0]).toBe("Тип");
    expect(terms()).not.toContain("Элемент архитектуры");
    expect(screen.queryByRole("button", { name: "Что такое система, контейнер и компонент" })).toBeNull();
    unmount();
    setup(makeNode({ shape: "service", element_effective: "container" }));
    expect(terms().filter((t) => t === "Тип")).toHaveLength(1);
  });

  it("компонент: выпадашка «Компонент» без строки «Входит в контейнер»", () => {
    render(<NodeInspector
      {...cb}
      ancestors={[ancestor("s", "Торговля", "system"), ancestor("c", "orders", "container")]}
      node={makeNode({ shape: "service", element_effective: "component", container_name: "orders" })}
      isArchitect
    />);
    expect(screen.getByRole("button", { name: "Тип" })).toHaveTextContent("Компонент");
    expect(screen.queryByText(/Входит в контейнер/)).toBeNull();
    expect(screen.queryByRole("button", { name: "«orders»" })).toBeNull();
  });

  it("технология системы: потомки не загрузились — «не загрузилась» и «Повторить», а не «не указана»", async () => {
    vi.mocked(nodesApi.getDescendants)
      .mockRejectedValueOnce(new ApiError(500, "Сервер недоступен"))
      .mockResolvedValue([makeNode({ id: "k1", shape: "service", technology: "Go" })]);
    setup(makeNode({ shape: "service", has_children: true, child_count: 1, element_effective: "system" }));
    expect(await screen.findByText("не загрузилась")).toBeInTheDocument();
    expect(screen.queryByText("не указана")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Go")).toBeInTheDocument();
    expect(screen.queryByText("не загрузилась")).not.toBeInTheDocument();
  });

  it("технология: у контейнера с компонентами — своя полем, у системы — сводная", async () => {
    vi.mocked(nodesApi.getDescendants).mockResolvedValue([
      makeNode({ id: "k1", shape: "service", technology: "Go" }),
      makeNode({ id: "k2", shape: "service", technology: "Python" }),
    ]);
    const group = { shape: "service" as const, has_children: true, child_count: 2, technology: "Java" };
    const { unmount } = setup(makeNode({ ...group, element: "container", element_effective: "container" }));
    expect(screen.getByDisplayValue("Java")).toBeInTheDocument();
    expect(nodesApi.getDescendants).not.toHaveBeenCalled();
    unmount();
    setup(makeNode({ ...group, element_effective: "system" }));
    expect(await screen.findByText("Go, Python")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Java")).not.toBeInTheDocument();
  });

  it("пустая система — сводная технология без запроса потомков: «не указана»", () => {
    setup(makeNode({ shape: "service", element: "system", element_effective: "system", technology: "Java" }));
    expect(row("Технология")).toHaveTextContent("не указана");
    expect(nodesApi.getDescendants).not.toHaveBeenCalled();
  });
});

// ── Удаление ─────────────────────────────────────────────────────────────────
describe("NodeInspector: удаление", () => {
  beforeEach(() => vi.clearAllMocks());

  it("«Удалить объект» внизу — тем же подтверждением; терять нечего — удаление сразу, в историю снимок", async () => {
    const snapshot = { nodes: [], edges: [], layout_items: [], node_docs: [], db_tables: [], db_columns: [], broker_channels: [], channel_fields: [] } as unknown as DeletionSnapshot;
    vi.mocked(nodesApi.getEdges).mockResolvedValue([]);
    vi.mocked(nodesApi.deletionSnapshot).mockResolvedValue(snapshot);
    vi.mocked(nodesApi.delete).mockResolvedValue(undefined as never);
    setup(makeNode({ shape: "service", element_effective: "container" }));
    const del = screen.getByRole("button", { name: "Удалить объект" });
    expect(del).toHaveClass("ip-delete");
    await userEvent.click(del);
    await waitFor(() => expect(nodesApi.delete).toHaveBeenCalledWith("n1"));
    await waitFor(() => expect(cb.onNodeDeleted).toHaveBeenCalledWith("n1", snapshot));
  });
});
