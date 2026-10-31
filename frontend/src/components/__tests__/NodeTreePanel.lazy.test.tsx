// NodeTreePanel — страховочная сетка распила (аудит F-7): ленивое дерево (перечитывание
// по сигналу без сворачивания, авто-раскрытие ветки до текущего узла) и палитра
// шаблонов с «корзиной» на время драга.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeTreePanel from "../NodeTreePanel";
import { NODE_DRAG_MIME } from "../nodeTree.mime";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";
import type { DropFrameTarget } from "../graph/types";
import { paletteTiles } from "../element/paletteTiles";
import { typeOptions } from "../element/typeOptions";

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

  // Палитра — шесть типов объекта (Р41 раздела 13 docs/plan-c4-elements.md). Плитки считает
  // страница (element/paletteTiles, приёмка Ф12 2026-10-31): тип, которого некуда положить
  // ни на уровне, ни в раскрытые рамки, — серый с объяснением и не тянется.
  const tile = (type: string) => document.querySelector<HTMLElement>(`[data-tour="palette:${type}"]`)!;
  const greyed = () => [...document.querySelectorAll<HTMLElement>('[data-tour^="palette:"][aria-disabled="true"]')]
    .map((t) => t.dataset.tour);
  const systemLevel = typeOptions({
    mode: "create",
    parent: { name: "shop", shape: "service", element: null, element_effective: "system", has_children: true, container_name: null },
  });
  const ordersFrame: DropFrameTarget = {
    id: "orders", name: "orders",
    subject: { name: "orders", shape: "service", element: "container", element_effective: "container", has_children: true, container_name: null },
  };

  it("шесть типов по порядку; серая плитка — с объяснением и не тянется", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([]);
    const onTemplateDrag = vi.fn();
    const tiles = paletteTiles(typeOptions({ mode: "create", parent: null }), []);
    render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect currentNodeId={null} onTemplateDrag={onTemplateDrag} paletteTiles={tiles} />);
    await screen.findByText("Нет объектов");
    const all = [...document.querySelectorAll<HTMLElement>('[data-tour^="palette:"]')];
    expect(all.map((t) => t.textContent)).toEqual([
      "Система", "Контейнер", "Компонент", "База данных", "Брокер", "Пользователь",
    ]);
    expect(greyed()).toEqual(["palette:component"]);
    expect(tile("component")).toHaveAttribute("title", "Компонентом объект бывает только внутри контейнера.");
    expect(tile("component")).not.toHaveAttribute("draggable");
    fireEvent.dragStart(tile("component"), { dataTransfer: dt() });
    expect(onTemplateDrag).not.toHaveBeenCalled();

    const transfer = dt();
    fireEvent.dragStart(tile("system"), { dataTransfer: transfer });
    expect(transfer.data.get(NODE_DRAG_MIME)).toBe("system");
    expect(onTemplateDrag).toHaveBeenLastCalledWith("system");
  });

  it("уровень системы с раскрытой рамкой контейнера: «Компонент» активен, подсказка — куда положить", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([]);
    const onTemplateDrag = vi.fn();
    render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect onTemplateDrag={onTemplateDrag}
      paletteTiles={paletteTiles(systemLevel, [ordersFrame])} />);
    await screen.findByText("Нет объектов");
    // «Пользователь» живёт только на верхнем уровне: в системе и в рамке контейнера его
    // некуда положить, плитка серая с причиной.
    expect(greyed()).toEqual(["palette:person"]);
    expect(tile("person")).toHaveAttribute(
      "title", "Пользователь живёт вне границ системы, создайте его на верхнем уровне.",
    );
    expect(tile("component")).toHaveAttribute("title", "Положите «Компонент» в раскрытую рамку: «orders»");
    expect(tile("component")).toHaveAttribute("draggable", "true");
    const transfer = dt();
    fireEvent.dragStart(tile("component"), { dataTransfer: transfer });
    expect(transfer.data.get(NODE_DRAG_MIME)).toBe("component");
    expect(onTemplateDrag).toHaveBeenLastCalledWith("component");
  });

  it("плиток нет (родитель уровня не загружен) — палитра ничего не гасит, своего запроса нет", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([]);
    render(<NodeTreePanel mode="editor" onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect currentNodeId={null} />);
    await screen.findByText("Нет объектов");
    expect(greyed()).toEqual([]);
    expect(tile("component")).toHaveAttribute("title", "Перетащить «Компонент» на схему");
    expect(nodesApi.get).not.toHaveBeenCalled();
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
