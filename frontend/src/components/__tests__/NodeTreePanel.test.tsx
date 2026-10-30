// Рендер-тесты NodeTreePanel (плоский режим): загрузка корней, ленивое
// раскрытие, навигация, поиск, авто-раскрытие ветки по клику.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeTreePanel from "../NodeTreePanel";
import { NODE_DRAG_MIME, NODE_MOVE_MIME } from "../nodeTree.mime";
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
    render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
    expect(screen.getByText("DB")).toBeInTheDocument();
  });

  it("клик по листу вызывает onNodePage", async () => {
    const onNodePage = vi.fn();
    vi.mocked(nodesApi.list).mockResolvedValue([node("leaf")]);
    render(<NodeTreePanel mode="pages" onNodePage={onNodePage} isArchitect={false} />);
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
    render(<NodeTreePanel mode="editor" onDrillTo={onDrillTo} onPickLeaf={vi.fn()} isArchitect={false} />);
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
    render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect={false} />);
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
      <NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect onCreateChild={onCreateChild} />,
    );
    await waitFor(() => expect(screen.getByText("SVC")).toBeInTheDocument());
    const addBtn = container.querySelector(".nt-add-child");
    expect(addBtn).toBeTruthy();
    await userEvent.click(addBtn!);
    expect(onCreateChild).toHaveBeenCalledWith("svc");
  });

  it("подсказка «+»: у контейнера и компонента — «Создать компонент», иначе «Создать объект»", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([
      node("shop", { name: "Торговля", has_children: true, child_count: 1, element_effective: "system" }),
      node("orders", { name: "orders", has_children: true, child_count: 1, element: "container", element_effective: "container" }),
      node("leaf", { name: "Платежи", element_effective: "container" }),
      node("api", { name: "api", element_effective: "component", container_name: "orders" }),
    ]);
    render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect onCreateChild={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Платежи")).toBeInTheDocument());
    const plus = (name: string) =>
      screen.getByText(name).closest(".nt-row")?.querySelector(".nt-add-child")?.getAttribute("title");
    expect(plus("Торговля")).toBe("Создать объект внутри «Торговля»");
    expect(plus("orders")).toBe("Создать компонент внутри «orders»");
    expect(plus("Платежи")).toBe("Создать объект внутри «Платежи»");
    expect(plus("api")).toBe("Создать компонент внутри «api»");
  });

  it("персоны видны в плоском режиме (без отсева)", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([
      node("user", { shape: "person", name: "Покупатель" }),
    ]);
    render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect={false} />);
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
    render(<NodeTreePanel mode="editor" onDrillTo={vi.fn()} onPickLeaf={vi.fn()} onReparent={vi.fn()} isArchitect />);
    await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
    expect(screen.getAllByLabelText(/Перенести/)).toHaveLength(2);
  });

  it("без onReparent (страницы) и у наблюдателя ручки нет", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    const { unmount } = render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect />);
    await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
    expect(screen.queryByLabelText(/Перенести/)).toBeNull();
    unmount();

    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    render(<NodeTreePanel mode="editor" onDrillTo={vi.fn()} onPickLeaf={vi.fn()} onReparent={vi.fn()} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("API")).toBeInTheDocument());
    expect(screen.queryByLabelText(/Перенести/)).toBeNull();
  });

  it("dragstart кладёт id узла под СВОИМ mime, не под палитровым", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    render(<NodeTreePanel mode="editor" onDrillTo={vi.fn()} onPickLeaf={vi.fn()} onReparent={vi.fn()} isArchitect />);
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
    render(<NodeTreePanel mode="editor" onDrillTo={vi.fn()} onPickLeaf={vi.fn()} onReparent={onReparent} isArchitect />);
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

// ── Режим «Развёртывание» (Ф6, docs/specs/deployment.md D26) ─────────────────
// Дерево слева от холста площадок: система — уровень, прочие — выделить карточки (у
// компонента — его контейнера), иконка строки «Указать размещение» (архитектор, не у
// «Пользователя» и не у компонента) — режим размещения. Элемент — из ответа сервера.
// Объекты здесь не создаются и не переносятся: ни палитры, ни «+», ни ручки.
describe("NodeTreePanel: режим «Развёртывание»", () => {
  beforeEach(() => vi.clearAllMocks());

  const rows = () => [
    node("box", { name: "Витрина", has_children: true, child_count: 1, element_effective: "system" }),
    node("db", { name: "БД заказов", shape: "database", element_effective: "container" }),
    node("svc", { name: "Платежи", element_effective: "container" }),
    node("man", { name: "Покупатель", shape: "person", element_effective: null }),
  ];

  async function scene(over: { isArchitect?: boolean; onPlace?: (n: Node) => void } = {}) {
    const onOpenLevel = vi.fn();
    const onPickObject = vi.fn();
    const onPlace = "onPlace" in over ? over.onPlace : vi.fn();
    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    vi.mocked(nodesApi.getChildren).mockResolvedValue([
      node("kid", { name: "Каталог", parent_id: "box", element_effective: "container" }),
    ]);
    const utils = render(
      <NodeTreePanel
        mode="deploy"
        isArchitect={over.isArchitect ?? true}
        onOpenLevel={onOpenLevel}
        onPickObject={onPickObject}
        onPlace={onPlace}
        // «+» не рисуется даже переданным: объекты на этой вкладке не создаются
        onCreateChild={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("Витрина")).toBeInTheDocument());
    return { ...utils, onOpenLevel, onPickObject, onPlace };
  }

  it("без «+», ручки переноса и палитры; в свёрнутом рейле — только дерево", async () => {
    const { container } = await scene();
    expect(container.querySelector(".nt-add-child")).toBeNull();
    expect(screen.queryByLabelText(/Перенести/)).toBeNull();
    expect(screen.queryByText(/Добавить объект/i)).toBeNull();
    await userEvent.click(screen.getByTitle("Свернуть панель"));
    expect(screen.getByTitle("Дерево объектов")).toBeInTheDocument();
    expect(screen.queryByTitle("Добавить объект")).toBeNull();
  });

  it("иконка размещения — у сервиса, БД и системы архитектора, не у «Пользователя»", async () => {
    await scene();
    expect(screen.getByLabelText("Указать размещение: «Платежи»")).toBeInTheDocument();
    expect(screen.getByLabelText("Указать размещение: «БД заказов»")).toBeInTheDocument();
    expect(screen.getByLabelText("Указать размещение: «Витрина»")).toBeInTheDocument();
    expect(screen.queryByLabelText("Указать размещение: «Покупатель»")).toBeNull();
  });

  it("у читателя иконки размещения нет", async () => {
    await scene({ isArchitect: false });
    expect(screen.queryByLabelText(/Указать размещение/)).toBeNull();
  });

  it("клик по иконке — onPlace, навигации нет", async () => {
    const { onPlace, onOpenLevel, onPickObject } = await scene();
    await userEvent.click(screen.getByLabelText("Указать размещение: «Витрина»"));
    await userEvent.click(screen.getByLabelText("Указать размещение: «Платежи»"));
    expect(onPlace).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "box" }));
    expect(onPlace).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "svc" }));
    expect(onOpenLevel).not.toHaveBeenCalled();
    expect(onPickObject).not.toHaveBeenCalled();
  });

  it("клик по системе — onOpenLevel и раскрытие ветки, по листу — onPickObject; подсказки строк", async () => {
    const { onOpenLevel, onPickObject } = await scene();
    const row = (name: string) => screen.getByText(name).closest(".nt-row") as HTMLElement;
    expect(row("Витрина")).toHaveAttribute("title", "Открыть уровень: Витрина");
    expect(row("Платежи")).toHaveAttribute("title", "Показать на схеме: Платежи");
    await userEvent.click(screen.getByText("Витрина"));
    expect(onOpenLevel).toHaveBeenCalledWith(expect.objectContaining({ id: "box" }));
    await waitFor(() => expect(screen.getByText("Каталог")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Платежи"));
    expect(onPickObject).toHaveBeenCalledWith(expect.objectContaining({ id: "svc" }));
    expect(onOpenLevel).toHaveBeenCalledTimes(1);
  });

  it("контейнер с компонентами: строка без шеврона, щелчок — показать на схеме; компонентов в дереве нет", async () => {
    // Ф8 эпика «Элемент архитектуры» (Р24): на холсте «Развёртывание» компонентов нет —
    // дерево совпадает с ним: ветка контейнера не раскрывается, дети не грузятся.
    const onOpenLevel = vi.fn();
    const onPickObject = vi.fn();
    vi.mocked(nodesApi.list).mockResolvedValue([
      node("orders", { name: "orders", has_children: true, child_count: 1, element: "container", element_effective: "container" }),
    ]);
    vi.mocked(nodesApi.getChildren).mockResolvedValue([
      node("api", { name: "api", parent_id: "orders", element_effective: "component" }),
    ]);
    render(<NodeTreePanel mode="deploy" isArchitect onOpenLevel={onOpenLevel} onPickObject={onPickObject} onPlace={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    const row = (name: string) => screen.getByText(name).closest(".nt-row") as HTMLElement;
    expect(row("orders")).toHaveAttribute("title", "Показать на схеме: orders");
    expect(row("orders").querySelector(".nt-chevzone")).toBeNull();
    expect(screen.getByLabelText("Указать размещение: «orders»")).toBeInTheDocument();
    await userEvent.click(screen.getByText("orders"));
    expect(onPickObject).toHaveBeenCalledWith(expect.objectContaining({ id: "orders" }));
    expect(onOpenLevel).not.toHaveBeenCalled();
    expect(nodesApi.getChildren).not.toHaveBeenCalled();
    expect(screen.queryByText("api")).toBeNull();
  });

  it("система раскрывается до своих контейнеров; контейнер внутри системы — без шеврона", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([
      node("shop", { name: "Торговля", has_children: true, child_count: 1, element_effective: "system" }),
    ]);
    vi.mocked(nodesApi.getChildren).mockResolvedValue([
      node("orders", { name: "orders", parent_id: "shop", has_children: true, child_count: 2, element: "container", element_effective: "container" }),
    ]);
    render(<NodeTreePanel mode="deploy" isArchitect onOpenLevel={vi.fn()} onPickObject={vi.fn()} onPlace={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Торговля")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Развернуть ветку"));
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    expect(nodesApi.getChildren).toHaveBeenCalledTimes(1);
    expect(screen.getByText("orders").closest(".nt-row")?.querySelector(".nt-chevzone")).toBeNull();
    expect(screen.getByLabelText("Указать размещение: «orders»")).toBeInTheDocument();
  });

  it("в режиме страниц контейнер раскрывается до компонентов, как раньше", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([
      node("orders", { name: "orders", has_children: true, child_count: 1, element: "container", element_effective: "container" }),
    ]);
    vi.mocked(nodesApi.getChildren).mockResolvedValue([
      node("api", { name: "api", parent_id: "orders", element_effective: "component" }),
    ]);
    render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect={false} />);
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Развернуть ветку"));
    await waitFor(() => expect(screen.getByText("api")).toBeInTheDocument());
  });

  it("строка размещаемого объекта подсвечена", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue(rows());
    render(<NodeTreePanel mode="deploy" isArchitect onOpenLevel={vi.fn()} onPickObject={vi.fn()} onPlace={vi.fn()} placingId="svc" />);
    await waitFor(() => expect(screen.getByText("Платежи")).toBeInTheDocument());
    expect(screen.getByText("Платежи").closest(".nt-row")?.className).toContain("nt-row--placing");
    expect(screen.getByText("Витрина").closest(".nt-row")?.className).not.toContain("nt-row--placing");
  });
});
