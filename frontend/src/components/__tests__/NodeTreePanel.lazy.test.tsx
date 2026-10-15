// NodeTreePanel — страховочная сетка распила (аудит F-7): ленивое дерево (перечитывание
// по сигналу без сворачивания, авто-раскрытие ветки до текущего узла) и палитра
// шаблонов с «корзиной» на время драга.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeTreePanel, { NODE_DRAG_MIME } from "../NodeTreePanel";
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
    const { rerender } = render(<NodeTreePanel onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect={false} reloadToken={0} />);
    fireEvent.click(await screen.findByText("BOX"));
    await screen.findByText("A1");

    vi.mocked(nodesApi.getChildren).mockResolvedValue([
      node("a1", { parent_id: "box" }), node("a2", { parent_id: "box" }),
    ]);
    rerender(<NodeTreePanel onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect={false} reloadToken={1} />);

    await screen.findByText("A2");
    expect(nodesApi.list).toHaveBeenCalledTimes(2);
    expect(nodesApi.getChildren).toHaveBeenLastCalledWith("box");
    expect(screen.getByText("A1")).toBeInTheDocument();
  });

  it("первый рендер не считается перезагрузкой — корни читаются один раз", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([node("solo")]);
    render(<NodeTreePanel onNodePage={vi.fn()} isArchitect={false} reloadToken={5} />);
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

    render(<NodeTreePanel onNodePage={vi.fn()} isArchitect={false} currentNodeId="leaf" />);

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
    const { container } = render(<NodeTreePanel onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect={false} />);
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
    render(<NodeTreePanel onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect onTemplateDrag={onTemplateDrag} />);
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

  it("палитры нет у наблюдателя и в дереве страниц", async () => {
    vi.mocked(nodesApi.list).mockResolvedValue([]);
    const { unmount } = render(<NodeTreePanel onPickLeaf={vi.fn()} onDrillTo={vi.fn()} isArchitect={false} />);
    await screen.findByText("Нет объектов");
    expect(screen.queryByText("Добавить объект")).toBeNull();
    unmount();
    render(<NodeTreePanel onNodePage={vi.fn()} isArchitect />);
    await screen.findByText("Нет объектов");
    expect(screen.queryByText("Добавить объект")).toBeNull();
  });
});
