// Правая панель редактора: смена ТИПА узла (форма C4) архитектором, отказ сервера
// плашкой и полное отсутствие редактора у наблюдателя. Смена типа коммитится сразу
// (как статус) и уходит в Undo редактора тем же onNodeSaved, что и остальная мета —
// своей истории у панели нет.
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
    // Превью последствий смены элемента: строка «Элемент архитектуры» зовёт его до записи.
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
  // Предки узла (крошки уровня): по ним строка «Элемент архитектуры» ищет контейнер.
  ancestors: [],
  onNodeSaved: vi.fn(),
  onNodeDeleted: vi.fn(),
  onNavigateNode: vi.fn(),
};

function setup(node: Node, isArchitect = true) {
  return render(<NodeInspector node={node} isArchitect={isArchitect} {...cb} />);
}

describe("NodeInspector: смена типа", () => {
  beforeEach(() => vi.clearAllMocks());

  it("архитектор меняет тип из выпадашки — PATCH с новой формой и запись в историю", async () => {
    const saved = makeNode({ shape: "service", version: 4 });
    vi.mocked(nodesApi.update).mockResolvedValue(saved);
    const before = makeNode({ shape: "person" });
    setup(before);

    await userEvent.click(screen.getByRole("button", { name: /Пользователь/ }));
    await userEvent.click(screen.getByRole("option", { name: "Сервис" }));

    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    const [id, payload] = vi.mocked(nodesApi.update).mock.calls[0];
    expect(id).toBe("n1");
    expect(payload.shape).toBe("service");
    // CAS от версии последнего сохранённого — как у любой правки панели
    expect(payload.base_version).toBe(3);
    // Undo редактора достаётся бесплатно: полный payload + узел ДО правки
    await waitFor(() => expect(cb.onNodeSaved).toHaveBeenCalledWith(saved, false, before));
  });

  it("тот же тип — без запроса", async () => {
    setup(makeNode({ shape: "service" }));
    await userEvent.click(screen.getByRole("button", { name: /Сервис/ }));
    await userEvent.click(screen.getByRole("option", { name: "Сервис" }));
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("отказ сервера показан плашкой, а не проглочен", async () => {
    const причина = "У узла описана структура БД — сначала перенесите или удалите её";
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, причина));
    setup(makeNode({ shape: "database" }));

    await userEvent.click(screen.getByRole("button", { name: /База данных/ }));
    await userEvent.click(screen.getByRole("option", { name: "Сервис" }));

    expect(await screen.findByText(причина)).toBeInTheDocument();
    // Правка не применилась — в историю ничего не легло
    expect(cb.onNodeSaved).not.toHaveBeenCalled();
  });

  it("наблюдателю тип показан текстом, редактора нет", async () => {
    setup(makeNode({ shape: "person" }), false);
    await waitFor(() => expect(screen.getAllByText("Пользователь").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /Пользователь/ })).toBeNull();
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

// ── Элемент архитектуры (Ф5 эпика docs/plan-c4-elements.md) ─────────────────
// Строка под «Типом»: выбор у узла с детьми (редактор), текст у листа и компонента, у
// «Пользователя» строки нет. Смена — превью последствий: без них PATCH сразу и в историю,
// с ними — окно, PATCH после подтверждения и без истории.
describe("NodeInspector: элемент архитектуры", () => {
  beforeEach(() => vi.clearAllMocks());

  const system = (over: Partial<Node> = {}) => makeNode({
    name: "orders", shape: "service", has_children: true, child_count: 2,
    element: null, element_effective: "system", container_name: null, ...over,
  });
  const quiet = { kind: "system_to_container" as const, before: [], after: [], docs_names: [], container_name: null };

  async function pickContainer() {
    await userEvent.click(screen.getByRole("button", { name: /^Система/ }));
    await userEvent.click(screen.getByRole("option", { name: /^Контейнер/ }));
  }

  it("у узла с детьми — выпадашка; без последствий PATCH сразу и в историю", async () => {
    vi.mocked(nodesApi.elementPreview).mockResolvedValue(quiet);
    const saved = system({ element: "container", element_effective: "container", version: 4 });
    vi.mocked(nodesApi.update).mockResolvedValue(saved);
    const before = system();
    setup(before);
    expect(screen.getByText("Элемент архитектуры")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Система/ }));
    // Пункты в две строки: подпись и пояснение.
    expect(screen.getByText("группа контейнеров, сама не запускается")).toBeInTheDocument();
    expect(screen.getByText("запускается отдельно, внутри его компоненты")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /^Контейнер/ }));

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

  it("лист — «Контейнер», компонент — «Компонент контейнера «orders»», без выпадашки", () => {
    const { unmount } = setup(makeNode({ shape: "service", element_effective: "container", container_name: null }));
    expect(screen.getByText("Контейнер")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Контейнер/ })).not.toBeInTheDocument();
    unmount();
    setup(makeNode({ shape: "service", element_effective: "component", container_name: "orders" }));
    expect(screen.getByText("Компонент контейнера «orders»")).toBeInTheDocument();
  });

  it("у «Пользователя» строки нет; читателю узел с детьми — текстом", () => {
    const { unmount } = setup(makeNode({ shape: "person", element_effective: null, container_name: null }));
    expect(screen.queryByText("Элемент архитектуры")).not.toBeInTheDocument();
    unmount();
    setup(system({ element: "container", element_effective: "container" }), false);
    expect(screen.getByText("Элемент архитектуры")).toBeInTheDocument();
    expect(screen.getByText("Контейнер")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Контейнер/ })).not.toBeInTheDocument();
  });
});

// ── Ф8: справка «?», скрытый «Тип», ссылка компонента, технология по элементу ─────
// Р24: у узла с детьми строки «Тип» нет (форма всегда «Сервис»), «Элемент архитектуры» —
// первая строка; у компонента имя контейнера — ссылка на его страницу (контейнер берётся
// из цепочки предков). Р15: сводная технология только у системы.
describe("NodeInspector: элемент архитектуры по Ф8", () => {
  beforeEach(() => vi.clearAllMocks());

  const ancestor = (id: string, name: string, element_effective: AncestorRef["element_effective"]): AncestorRef =>
    ({ id, name, is_external: false, element_effective });
  const terms = () => [...document.querySelectorAll(".insp-term")].map((t) => t.textContent);

  it("у узла с детьми строки «Тип» нет, «Элемент архитектуры» первая; у листа «Тип» на месте", () => {
    const { unmount } = setup(makeNode({
      shape: "service", has_children: true, child_count: 2, element: "container", element_effective: "container",
    }));
    expect(terms()[0]).toBe("Элемент архитектуры");
    expect(terms()).not.toContain("Тип");
    unmount();
    setup(makeNode({ shape: "service", element_effective: "container" }));
    expect(terms().slice(0, 2)).toEqual(["Тип", "Элемент архитектуры"]);
  });

  it("«?» у термина открывает справку о системе, контейнере и компоненте", async () => {
    setup(makeNode({ shape: "service", element_effective: "container" }));
    await userEvent.click(screen.getByRole("button", { name: "Что такое система, контейнер и компонент" }));
    const help = screen.getByRole("dialog", { name: "Что такое система, контейнер и компонент" });
    for (const head of ["Контейнер.", "Компонент.", "Система.", "Как выбрать."]) {
      expect(help).toHaveTextContent(head);
    }
    expect(help.textContent).not.toMatch(/[Сс]пек/);
  });

  it("компонент: имя контейнера — ссылка на его страницу, контейнер — из предков", async () => {
    render(<NodeInspector
      {...cb}
      ancestors={[ancestor("s", "Торговля", "system"), ancestor("c", "orders", "container")]}
      node={makeNode({ shape: "service", element_effective: "component", container_name: "orders" })}
      isArchitect
    />);
    const link = screen.getByRole("button", { name: "«orders»" });
    expect(link.parentElement).toHaveTextContent("Компонент контейнера «orders»");
    await userEvent.click(link);
    expect(cb.onNavigateNode).toHaveBeenCalledWith("c");
  });

  it("компонент без контейнера в цепочке — имя текстом, без ссылки", () => {
    setup(makeNode({ shape: "service", element_effective: "component", container_name: "orders" }));
    expect(screen.getByText("Компонент контейнера «orders»")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "«orders»" })).not.toBeInTheDocument();
  });

  it("внешний лист — «Внешняя система»", () => {
    setup(makeNode({ shape: "service", is_external: true, element_effective: "container" }));
    expect(screen.getByText("Внешняя система")).toBeInTheDocument();
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
