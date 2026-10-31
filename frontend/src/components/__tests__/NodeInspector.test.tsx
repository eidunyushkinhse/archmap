// Правая панель редактора: строка «Тип» (Р40 раздела 13 docs/plan-c4-elements.md) —
// смена формы и элемента архитектором, серые пункты, отказ сервера плашкой и полное
// отсутствие выпадашки у наблюдателя. Смена коммитится сразу (как статус) и уходит в Undo
// редактора тем же onNodeSaved, что и остальная мета — своей истории у панели нет.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeInspector from "../inspector/NodeInspector";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { AncestorRef, Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    update: vi.fn(),
    get: vi.fn(),
    getDescendants: vi.fn(() => Promise.resolve([])),
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
  // Предки узла (крошки уровня): по ним строка «Тип» ищет контейнер.
  ancestors: [],
  onNodeSaved: vi.fn(),
  onNodeDeleted: vi.fn(),
  onNavigateNode: vi.fn(),
};

function setup(node: Node, isArchitect = true) {
  return render(<NodeInspector node={node} isArchitect={isArchitect} {...cb} />);
}

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
    const причина = "У узла описана структура БД — сначала перенесите или удалите её";
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, причина));
    setup(makeNode({ shape: "database", element_effective: "container" }));

    await userEvent.click(typeButton());
    await userEvent.click(option("Брокер"));

    expect(await screen.findByText(причина)).toBeInTheDocument();
    // Правка не применилась — в историю ничего не легло
    expect(cb.onNodeSaved).not.toHaveBeenCalled();
  });

  it("вложенный объект: «Пользователь» серый с причиной, запроса нет", async () => {
    // «Пользователь» живёт только на верхнем уровне (решение владельца 2026-10-31).
    const system: AncestorRef = { id: "s1", name: "Ярмарка", is_external: false, element_effective: "system" };
    render(<NodeInspector node={makeNode({ shape: "service", element_effective: "container", parent_id: "s1" })}
      isArchitect {...cb} ancestors={[system]} />);
    await userEvent.click(typeButton());
    const person = option("Пользователь");
    expect(person).toHaveAttribute("aria-disabled", "true");
    expect(person).toHaveTextContent(
      "Пользователь живёт вне границ системы, сначала перенесите объект на верхний уровень.",
    );
    await userEvent.click(person);
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("наблюдателю тип показан текстом, выпадашки нет", async () => {
    setup(makeNode({ shape: "person", element_effective: null }), false);
    await waitFor(() => expect(screen.getAllByText("Пользователь").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Тип" })).toBeNull();
  });
});


// ── Источник ───────────────────────────────────────────────────────────────────
// Та же строка «Источник», что и в карточке объекта (один компонент на оба места):
// в редакторе она правится не выходя с карты и уходит тем же save с CAS.
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
    render(<NodeInspector node={n} isArchitect {...cb} />);

    expect(screen.getByText("имя зависимости:")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
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

  it("наблюдателю источник только читается", () => {
    const n = makeNode({ shape: "service", source: { repo: "github.com/org/repo", path: null, host: null } });
    render(<NodeInspector node={n} isArchitect={false} {...cb} />);
    expect(screen.getByText("код:")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
  });
});

// Тогл «Принадлежность» инвертирован по решению пользователя 2026-09-04: «включён»
// (синий) — ВНУТРЕННИЙ сервис, «выключен» (серый) — внешний. Данные при этом
// прежние: клик по-прежнему переключает is_external.
describe("NodeInspector: тогл принадлежности", () => {
  beforeEach(() => vi.clearAllMocks());

  it("внутренний — тогл включён и подписан «Внутренний», внешний — выключен", () => {
    const { unmount } = setup(makeNode({ is_external: false }));
    const inner = screen.getByRole("button", { name: "Внутренний" });
    expect(inner.getAttribute("aria-pressed")).toBe("true");
    expect(inner.querySelector(".insp-switch")?.classList.contains("is-on")).toBe(true);
    unmount();

    setup(makeNode({ is_external: true }));
    const outer = screen.getByRole("button", { name: "Внешний" });
    expect(outer.getAttribute("aria-pressed")).toBe("false");
    expect(outer.querySelector(".insp-switch")?.classList.contains("is-on")).toBe(false);
  });

  it("отказ записи тогла — тогл возвращается, причина плашкой (аудит R-13)", async () => {
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, "Сервер отказал"));
    setup(makeNode({ is_external: false }));
    const toggle = screen.getByRole("button", { name: "Внутренний" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(toggle);
    expect(await screen.findByText("Сервер отказал")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Внутренний" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("клик по тоглу переключает is_external, а не вид", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ is_external: true, version: 4 }));
    setup(makeNode({ is_external: false }));
    await userEvent.click(screen.getByRole("button", { name: "Внутренний" }));
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

    await userEvent.type(screen.getByPlaceholderText("API, воркер, шлюз…"), "агент");
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

  it("409 — поля подтянуты с сервера, плашка, в историю ничего", async () => {
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(409, "conflict"));
    vi.mocked(nodesApi.get).mockResolvedValue(makeNode({ role: "чужая роль", version: 7 }));
    setup(makeNode());

    await userEvent.type(screen.getByPlaceholderText("API, воркер, шлюз…"), "моя роль");
    await userEvent.tab();

    expect(await screen.findByText(/изменён в другой сессии/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("чужая роль")).toBeInTheDocument();
    expect(cb.onNodeSaved).not.toHaveBeenCalled();
  });
});

// ── Строка «Тип»: система и контейнер (Р40) ──────────────────────────────────
// Строки «Тип» и «Элемент архитектуры» слиты: система ↔ контейнер у сервиса — смена
// элемента с превью последствий (без них PATCH сразу и в историю, с ними — окно, PATCH
// после подтверждения и без истории). Невозможные пункты — серые с объяснением.
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
    // Пункты в две строки: подпись и подсказка.
    expect(screen.getByText("Группа контейнеров: сама не запускается")).toBeInTheDocument();
    expect(screen.getByText("Одно приложение, которое запускается целиком")).toBeInTheDocument();
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

  it("невозможные пункты серые с причиной и не выбираются", async () => {
    setup(system());
    await userEvent.click(typeButton());
    const db = option("База данных");
    expect(db).toHaveAttribute("aria-disabled", "true");
    expect(db).toHaveTextContent("Объект с вложенными объектами не может стать базой данных.");
    expect(option("Компонент")).toHaveTextContent("перенесите его в контейнер");
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
    expect(screen.getByText("Контейнер")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Тип" })).not.toBeInTheDocument();
    unmount();
    setup(makeNode({ shape: "person", element_effective: null }));
    expect(typeButton()).toHaveTextContent("Пользователь");
  });
});

// ── Ф8 и Р40: одна строка «Тип», справка «?», ссылка компонента, технология ─────
// Р40: строка «Тип» одна у любого объекта (у узла с детьми тоже) и стоит первой; у
// компонента имя контейнера — ссылка на его страницу (контейнер берётся из цепочки
// предков). Р15: сводная технология только у системы.
describe("NodeInspector: строка «Тип» по Ф8 и Р40", () => {
  beforeEach(() => vi.clearAllMocks());

  const ancestor = (id: string, name: string, element_effective: AncestorRef["element_effective"]): AncestorRef =>
    ({ id, name, is_external: false, element_effective });
  const terms = () => [...document.querySelectorAll(".insp-term")].map((t) => t.textContent);

  it("одна строка «Тип» первой — у листа и у узла с детьми; «Элемент архитектуры» нет", () => {
    const { unmount } = setup(makeNode({
      shape: "service", has_children: true, child_count: 2, element: "container", element_effective: "container",
    }));
    expect(terms()[0]).toBe("Тип");
    expect(terms()).not.toContain("Элемент архитектуры");
    unmount();
    setup(makeNode({ shape: "service", element_effective: "container" }));
    expect(terms()[0]).toBe("Тип");
    expect(terms().filter((t) => t === "Тип")).toHaveLength(1);
  });

  it("«?» у термина открывает справку о системе, контейнере и компоненте", async () => {
    setup(makeNode({ shape: "service", element_effective: "container" }));
    await userEvent.click(screen.getByRole("button", { name: "Что такое система, контейнер и компонент" }));
    const help = screen.getByRole("dialog", { name: "Что такое система, контейнер и компонент" });
    for (const head of ["Контейнер.", "Компонент.", "Система.", "Как выбрать."]) {
      expect(help).toHaveTextContent(head);
    }
    expect(help).toHaveTextContent("Тип выбирается при создании и меняется в свойствах.");
    expect(help.textContent).not.toMatch(/[Сс]пек/);
  });

  it("компонент: выпадашка «Компонент» и ссылка на контейнер из предков", async () => {
    render(<NodeInspector
      {...cb}
      ancestors={[ancestor("s", "Торговля", "system"), ancestor("c", "orders", "container")]}
      node={makeNode({ shape: "service", element_effective: "component", container_name: "orders" })}
      isArchitect
    />);
    expect(screen.getByRole("button", { name: "Тип" })).toHaveTextContent("Компонент");
    const link = screen.getByRole("button", { name: "«orders»" });
    expect(link.parentElement).toHaveTextContent("Входит в контейнер «orders»");
    await userEvent.click(link);
    expect(cb.onNavigateNode).toHaveBeenCalledWith("c");
  });

  it("компонент у читателя: «Компонент контейнера «orders»»; без контейнера в цепочке — без ссылки", () => {
    setup(makeNode({ shape: "service", element_effective: "component", container_name: "orders" }), false);
    expect(screen.getByText("Компонент контейнера «orders»")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "«orders»" })).not.toBeInTheDocument();
  });

  it("пустая система (Р39) — «Система»", () => {
    setup(makeNode({ shape: "service", element: "system", element_effective: "system" }), false);
    expect(screen.getByText("Система")).toBeInTheDocument();
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
});
