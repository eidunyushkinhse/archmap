// Рендер-тесты NodeTreePanel (плоский режим): загрузка корней, ленивое
// раскрытие, навигация, поиск, авто-раскрытие ветки по клику.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeTreePanel, { NODE_DRAG_MIME, NODE_MOVE_MIME } from "../NodeTreePanel";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    list: vi.fn(),
    getChildren: vi.fn(),
    search: vi.fn(),
  },
}));

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id,
    name: id.toUpperCase(),
    description: null,
    role: null,
    technology: null,
    parent_id: null,
    shape: "service",
    is_external: false,
    status: "existing",
    openapi_spec: null,
    version: 1,
    docs: [],
    has_children: false,
    child_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as Node;
}

describe("NodeTreePanel (плоский режим)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("рендерит корни после загрузки", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([
      node("api", { has_children: true, child_count: 2 }),
      node("db", { shape: "database" }),
    ]);
    render(<NodeTreePanel onNodePage={vi.fn()} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
    expect(screen.getByText("DB")).toBeInTheDocument();
  });

  it("клик по листу вызывает onNodePage", async () => {
    const onNodePage = vi.fn();
    vi.mocked(nodesApi.list).mockResolvedValue([node("leaf")]);
    render(<NodeTreePanel onNodePage={onNodePage} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("LEAF")).toBeInTheDocument());
    await userEvent.click(screen.getByText("LEAF"));
    expect(onNodePage).toHaveBeenCalledWith(expect.objectContaining({ id: "leaf" }));
  });

  it("клик по контейнеру: дрилл + авто-раскрытие ветки (ленивая подгрузка детей)", async () => {
    const onDrillTo = vi.fn();
    vi.mocked(nodesApi.list).mockResolvedValue([
      node("parent", { has_children: true, child_count: 1 }),
    ]);
    vi.mocked(nodesApi.getChildren).mockResolvedValue([node("child", { parent_id: "parent" })]);
    render(<NodeTreePanel onDrillTo={onDrillTo} onPickLeaf={vi.fn()} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("PARENT")).toBeInTheDocument());
    await userEvent.click(screen.getByText("PARENT"));
    // Дрилл вызван с полным путём
    expect(onDrillTo).toHaveBeenCalledWith([expect.objectContaining({ id: "parent" })]);
    // Ветка раскрылась: дети подгружены и видны
    await waitFor(() => expect(screen.getByText("CHILD")).toBeInTheDocument());
    expect(nodesApi.getChildren).toHaveBeenCalledWith("parent");
  });

  it("поиск: debounce-запрос и рендер результатов", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([node("root")]);
    vi.mocked(nodesApi.search).mockResolvedValue([node("found", { name: "Найденный" })]);
    render(<NodeTreePanel onNodePage={vi.fn()} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("ROOT")).toBeInTheDocument());
    const input = screen.getByPlaceholderText(/поиск/i);
    await userEvent.type(input, "найд");
    // debounce 250ms
    await waitFor(() => expect(screen.getByText("Найденный")).toBeInTheDocument(), { timeout: 1000 });
    expect(nodesApi.search).toHaveBeenCalledWith("найд");
  });

  it("«+» на сервисе видна архитектору и вызывает onCreateChild", async () => {
    const onCreateChild = vi.fn();
    vi.mocked(nodesApi.list).mockResolvedValue([node("svc", { shape: "service" })]);
    const { container } = render(
      <NodeTreePanel onNodePage={vi.fn()} isArchitect onCreateChild={onCreateChild} />,
    );
    await waitFor(() => expect(screen.getByText("SVC")).toBeInTheDocument());
    const addBtn = container.querySelector(".nt-add-child");
    expect(addBtn).toBeTruthy();
    await userEvent.click(addBtn!);
    expect(onCreateChild).toHaveBeenCalledWith("svc");
  });

  it("персоны видны в плоском режиме (без отсева)", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([
      node("user", { shape: "person", name: "Покупатель" }),
    ]);
    render(<NodeTreePanel onNodePage={vi.fn()} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("Покупатель")).toBeInTheDocument());
  });
});

// ── Перенос узла на другой уровень: ручка захвата (Ф2) ───────────────────────
// Ручка — единственная точка старта жеста, и живёт только там, где перенос вообще
// возможен: редактор + архитектор. В оболочке страниц её быть не должно.
describe("NodeTreePanel: ручка переноса", () => {
  beforeEach(() => vi.clearAllMocks());

  const rows = () => [node("api", { has_children: true, child_count: 1 }), node("db", { shape: "database" })];

  it("в редакторе у архитектора ручка есть на каждой строке", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    render(<NodeTreePanel onPickLeaf={vi.fn()} onReparent={vi.fn()} isArchitect />);
    await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
    expect(screen.getAllByLabelText(/Перенести/)).toHaveLength(2);
  });

  it("без onReparent (страницы) и у наблюдателя ручки нет", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    const { unmount } = render(<NodeTreePanel onNodePage={vi.fn()} isArchitect />);
    await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
    expect(screen.queryByLabelText(/Перенести/)).toBeNull();
    unmount();

    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    render(<NodeTreePanel onPickLeaf={vi.fn()} onReparent={vi.fn()} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
    expect(screen.queryByLabelText(/Перенести/)).toBeNull();
  });

  it("dragstart кладёт id узла под СВОИМ mime, не под палитровым", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    render(<NodeTreePanel onPickLeaf={vi.fn()} onReparent={vi.fn()} isArchitect />);
    await waitFor(() => expect(screen.getByText("DB")).toBeInTheDocument());
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (t: string, v: string) => { data.set(t, v); },
      getData: (t: string) => data.get(t) ?? "",
      effectAllowed: "",
    };
    fireEvent.dragStart(screen.getByLabelText(/Перенести «DB»/), { dataTransfer });
    expect(data.get(NODE_MOVE_MIME)).toBe("db");
    expect(data.has(NODE_DRAG_MIME)).toBe(false);
  });
});

// ── Перенос узла: цели дропа и запреты (Ф3) ──────────────────────────────────
// Запреты продублированы на фронте не «на всякий случай», а чтобы отказ был виден
// ДО дропа: недопустимая цель не принимает жест (preventDefault не зовём — курсор
// остаётся «запретным»), и onReparent не срабатывает.
describe("NodeTreePanel: цели переноса", () => {
  beforeEach(() => vi.clearAllMocks());

  function dt() {
    const data = new Map<string, string>();
    return {
      setData: (t: string, v: string) => { data.set(t, v); },
      getData: (t: string) => data.get(t) ?? "",
      types: [NODE_MOVE_MIME],
      effectAllowed: "",
      dropEffect: "",
    };
  }

  async function scene(nodes: Node[], onReparent = vi.fn()) {
    vi.mocked(nodesApi.list).mockResolvedValue(nodes);
    render(<NodeTreePanel onPickLeaf={vi.fn()} onReparent={onReparent} isArchitect />);
    await waitFor(() => expect(screen.getByText(nodes[0].name)).toBeInTheDocument());
    return onReparent;
  }

  const row = (name: string) => screen.getByText(name).closest(".nt-row") as HTMLElement;

  it("дроп на чужой контейнер переносит", async () => {
    const onReparent = await scene([
      node("box", { name: "Контейнер", has_children: true, child_count: 1 }),
      node("leaf", { name: "Лист" }),
    ]);
    const transfer = dt();
    fireEvent.dragStart(screen.getByLabelText(/Перенести «Лист»/), { dataTransfer: transfer });
    fireEvent.dragOver(row("Контейнер"), { dataTransfer: transfer });
    fireEvent.drop(row("Контейнер"), { dataTransfer: transfer });
    expect(onReparent).toHaveBeenCalledWith(expect.objectContaining({ id: "leaf" }), "box");
  });

  it("в узел без права иметь детей и в самого себя — нельзя", async () => {
    const onReparent = await scene([
      node("db", { name: "БД", shape: "database" }),
      node("leaf", { name: "Лист" }),
    ]);
    const transfer = dt();
    fireEvent.dragStart(screen.getByLabelText(/Перенести «Лист»/), { dataTransfer: transfer });
    fireEvent.drop(row("БД"), { dataTransfer: transfer });
    fireEvent.drop(row("Лист"), { dataTransfer: transfer });
    expect(onReparent).not.toHaveBeenCalled();
  });

  it("в собственного потомка — нельзя", async () => {
    vi.mocked(nodesApi.getChildren).mockResolvedValue([
      node("kid", { name: "Ребёнок", parent_id: "box" }),
    ]);
    const onReparent = await scene([node("box", { name: "Контейнер", has_children: true, child_count: 1 })]);
    await userEvent.click(screen.getByLabelText("Развернуть ветку"));
    await waitFor(() => expect(screen.getByText("Ребёнок")).toBeInTheDocument());
    const transfer = dt();
    fireEvent.dragStart(screen.getByLabelText(/Перенести «Контейнер»/), { dataTransfer: transfer });
    fireEvent.drop(row("Ребёнок"), { dataTransfer: transfer });
    expect(onReparent).not.toHaveBeenCalled();
  });

  it("человека можно только вынести в корень, но не вложить", async () => {
    vi.mocked(nodesApi.getChildren).mockResolvedValue([
      node("man", { name: "Оператор", shape: "person", parent_id: "box" }),
    ]);
    const onReparent = await scene([
      node("box", { name: "Контейнер", has_children: true, child_count: 1 }),
      node("box2", { name: "Второй", has_children: true, child_count: 1 }),
    ]);
    await userEvent.click(screen.getAllByLabelText("Развернуть ветку")[0]);
    await waitFor(() => expect(screen.getByText("Оператор")).toBeInTheDocument());
    const transfer = dt();
    fireEvent.dragStart(screen.getByLabelText(/Перенести «Оператор»/), { dataTransfer: transfer });
    fireEvent.drop(row("Второй"), { dataTransfer: transfer });
    expect(onReparent).not.toHaveBeenCalled();
    // Полоса «в корень» для него есть — вынести наружу можно всегда.
    await waitFor(() => expect(screen.getByText("В корень проекта")).toBeInTheDocument());
    fireEvent.drop(screen.getByText("В корень проекта"), { dataTransfer: transfer });
    expect(onReparent).toHaveBeenCalledWith(expect.objectContaining({ id: "man" }), null);
  });

  it("у корневого узла полосы «в корень» нет — он и так там", async () => {
    await scene([node("leaf", { name: "Лист" })]);
    fireEvent.dragStart(screen.getByLabelText(/Перенести «Лист»/), { dataTransfer: dt() });
    // Ждём кадра, которым зажигается подсветка жеста: к этому моменту полоса «в
    // корень» уже была бы отрисована, если бы вообще полагалась.
    await waitFor(() => expect(row("Лист").className).toContain("nt-row--moving"));
    expect(screen.queryByText("В корень проекта")).toBeNull();
  });
});
