// NodeTreePanel — страховочная сетка распила (аудит F-7): ленивое дерево (перечитывание
// по сигналу без сворачивания, авто-раскрытие ветки до текущего узла) и палитра
// шаблонов с «корзиной» на время драга.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeTreePanel from "../NodeTreePanel";
import { NODE_DRAG_MIME } from "../nodeTree.mime";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { list: vi.fn(), getChildren: vi.fn(), get: vi.fn(), search: vi.fn() },
}));

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id, name: id.toUpperCase(), description: null, role: null, technology: null,
    parent_id: null, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, version: 1, docs: [], has_children: false, child_count: 0,
    created_at: "", updated_at: "",
    ...over,
  } as Node;
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom не умеет scrollIntoView — а дерево скроллит к текущей строке.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("NodeTreePanel: ленивое дерево", () => {
  it("сигнал перезагрузки перечитывает корни и раскрытые ветки, не сворачивая их", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([node("box", { has_children: true, child_count: 1 })]);
    vi.mocked(nodesApi.getChildren).mockResolvedValue([node("a1", { parent_id: "box" })]);
    const { rerender } = render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect={false} reloadToken={0} />);
    fireEvent.click(await screen.findByText("BOX"));
    await screen.findByText("A1");

    vi.mocked(nodesApi.getChildren).mockResolvedValue([
      node("a1", { parent_id: "box" }), node("a2", { parent_id: "box" }),
    ]);
    rerender(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect={false} reloadToken={1} />);

    await screen.findByText("A2");
    expect(nodesApi.list).toHaveBeenCalledTimes(2);
    expect(nodesApi.getChildren).toHaveBeenLastCalledWith("box");
    expect(screen.getByText("A1")).toBeInTheDocument();
  });

  it("первый рендер не считается перезагрузкой — корни читаются один раз", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([node("solo")]);
    render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect={false} reloadToken={5} />);
    await screen.findByText("SOLO");
    expect(nodesApi.list).toHaveBeenCalledTimes(1);
  });

  it("текущий узел: ветка раскрывается до него, строка подсвечена", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([node("root", { has_children: true, child_count: 1 })]);
    const byId: Record<string, Node> = {
      root: node("root", { has_children: true, child_count: 1 }),
      mid: node("mid", { parent_id: "root", has_children: true, child_count: 1 }),
      leaf: node("leaf", { parent_id: "mid" }),
    };
    vi.mocked(nodesApi.get).mockImplementation(async (id: string) => byId[id]);
    vi.mocked(nodesApi.getChildren).mockImplementation(async (id: string) =>
      id === "root" ? [byId.mid] : id === "mid" ? [byId.leaf] : []);

    render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect={false} currentNodeId="leaf" />);

    const leaf = await screen.findByText("LEAF");
    expect(leaf.closest(".nt-row")).toHaveClass("nt-row--current");
    expect(nodesApi.getChildren).toHaveBeenCalledWith("root");
    expect(nodesApi.getChildren).toHaveBeenCalledWith("mid");
    // У самого узла детей не грузим — раскрываются только предки.
    expect(nodesApi.getChildren).not.toHaveBeenCalledWith("leaf");
  });

  it("контейнер без детей помечается листом — шеврон не раскрывается в пустоту", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([node("box", { has_children: true, child_count: 1 })]);
    vi.mocked(nodesApi.getChildren).mockResolvedValue([]);
    const { container } = render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect={false} />);
    fireEvent.click(await screen.findByText("BOX"));
    await waitFor(() => expect(nodesApi.getChildren).toHaveBeenCalledWith("box"));
    await waitFor(() => expect(container.querySelector(".nt-chevspacer")).not.toBeNull());
  });
});

describe("NodeTreePanel: палитра шаблонов", () => {
  function dt() {
    const data = new Map<string, string>();
    return {
      setData: (t: string, v: string) => { data.set(t, v); },
      getData: (t: string) => data.get(t) ?? "",
      setDragImage: vi.fn(),
      types: [NODE_DRAG_MIME],
      effectAllowed: "",
      dropEffect: "",
      data,
    };
  }
  // «Корзина» опознаётся по своей иконке (крышка урны).
  const trash = () => document.querySelector('path[d="M3 6h18"]');

  it("драг шаблона: форма под своим MIME, превью у схемы, «корзина» — со следующего кадра", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([]);
    const onTemplateDrag = vi.fn();
    render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect onTemplateDrag={onTemplateDrag} />);
    const card = (await screen.findByTitle("Перетащить «База данных» на схему"));
    const transfer = dt();

    fireEvent.dragStart(card, { dataTransfer: transfer });
    expect(transfer.data.get(NODE_DRAG_MIME)).toBe("database");
    expect(onTemplateDrag).toHaveBeenLastCalledWith("database");
    // Синхронно в dragstart накрывать источник нельзя — браузер отменил бы драг.
    expect(trash()).toBeNull();
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(trash()).not.toBeNull();

    fireEvent.dragEnd(card);
    expect(onTemplateDrag).toHaveBeenLastCalledWith(null);
    expect(trash()).toBeNull();
  });

  // Палитра — шесть типов объекта (Р41 раздела 13 docs/plan-c4-elements.md); невозможные
  // на текущем уровне — серые, с объяснением окна «Новый объект», но тянутся: бросок в
  // раскрытую рамку контейнера бывает законным, его проверит окно.
  const tile = (type: string) => document.querySelector<HTMLElement>(`[data-tour="palette:${type}"]`)!;
  const greyed = () => [...document.querySelectorAll<HTMLElement>('[data-tour^="palette:"].template-card--off')]
    .map((t) => t.dataset.tour);

  it("шесть типов по порядку; на верхнем уровне «Компонент» серый с объяснением, но тянется", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([]);
    const onTemplateDrag = vi.fn();
    render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect currentNodeId={null} onTemplateDrag={onTemplateDrag} />);
    await screen.findByText("Нет объектов");
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-tour^="palette:"]')];
    expect(tiles.map((t) => t.textContent)).toEqual([
      "Система", "Контейнер", "Компонент", "База данных", "Брокер", "Пользователь",
    ]);
    expect(greyed()).toEqual(["palette:component"]);
    expect(tile("component")).toHaveAttribute("title", "Компонентом объект бывает только внутри контейнера.");
    expect(tile("component")).toHaveAttribute("draggable", "true");
    const offTransfer = dt();
    fireEvent.dragStart(tile("component"), { dataTransfer: offTransfer });
    expect(offTransfer.data.get(NODE_DRAG_MIME)).toBe("component");
    expect(onTemplateDrag).toHaveBeenLastCalledWith("component");
    fireEvent.dragEnd(tile("component"));

    const transfer = dt();
    fireEvent.dragStart(tile("system"), { dataTransfer: transfer });
    expect(transfer.data.get(NODE_DRAG_MIME)).toBe("system");
    expect(onTemplateDrag).toHaveBeenLastCalledWith("system");
  });

  it("уровень контейнера: доступны «Компонент» и «Пользователь»; родитель — строка загруженного дерева", async () => {
    const box = node("box", { has_children: true, child_count: 1, element: "container", element_effective: "container" });
    vi.mocked(nodesApi.list).mockResolvedValue([box]);
    vi.mocked(nodesApi.get).mockResolvedValue(box);
    vi.mocked(nodesApi.getChildren).mockResolvedValue([]);
    render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect currentNodeId="box" />);
    await waitFor(() => expect(greyed()).toEqual([
      "palette:system", "palette:container", "palette:database", "palette:broker",
    ]));
    expect(tile("database")).toHaveAttribute("title", "База данных не входит в состав контейнера, создайте её рядом с «BOX».");
    expect(nodesApi.get).toHaveBeenCalledTimes(1); // только раскрытие ветки — своего запроса у палитры нет
  });

  it("лист без элемента ждёт первого вложенного объекта — доступно всё", async () => {
    const leaf = node("api", { element: null, element_effective: "container" });
    vi.mocked(nodesApi.list).mockResolvedValue([leaf]);
    vi.mocked(nodesApi.get).mockResolvedValue(leaf);
    render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect currentNodeId="api" />);
    await screen.findByText("API");
    expect(greyed()).toEqual([]);
  });

  it("родитель уровня ещё не загружен — палитра ничего не гасит, окно проверит само", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([]);
    vi.mocked(nodesApi.get).mockReturnValue(new Promise<Node>(() => {}));
    render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect currentNodeId="deep" />);
    await screen.findByText("Нет объектов");
    expect(greyed()).toEqual([]);
  });

  it("палитры нет у наблюдателя и в дереве страниц", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([]);
    const { unmount } = render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect={false} />);
    await screen.findByText("Нет объектов");
    expect(screen.queryByText("Добавить объект")).toBeNull();
    unmount();
    render(<NodeTreePanel mode="pages" onNodePage={vi.fn()} isArchitect />);
    await screen.findByText("Нет объектов");
    expect(screen.queryByText("Добавить объект")).toBeNull();
  });
});
