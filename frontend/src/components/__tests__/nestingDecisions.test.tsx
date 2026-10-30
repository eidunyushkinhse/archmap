// Характеризация точек решения «узел с детьми или лист» вне холста (эпик «Элемент
// архитектуры», Ф0, docs/plan-c4-elements.md). Узлом с детьми фронт считает только
// СЕРВИС с has_children: база или брокер с детьми (данные до проверки формы родителя на
// сервере) остаются листом — рисуются своей формой, не дрилятся, не сворачивают
// технологию. Тест снят ДО перевода точек на общую функцию и обязан остаться зелёным
// после: поведение не меняется.
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import NodeTreePanel from "../NodeTreePanel";
import NodeSearchPicker from "../NodeSearchPicker";
import GhostInspector from "../inspector/GhostInspector";
import NodeInspector from "../inspector/NodeInspector";
import EdgeInspector from "../inspector/EdgeInspector";
import { treeRowTitle } from "../nodeTree.mode";
import { brokerChannelsApi, nodesApi } from "../../api/nodes";
import { compareByRank, nodeNesting } from "../../types";
import type { GhostNode, LevelEdge, Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    list: vi.fn(),
    getChildren: vi.fn(),
    search: vi.fn(),
    get: vi.fn(),
    getDescendants: vi.fn(() => Promise.resolve([])),
    update: vi.fn(),
    deletionSnapshot: vi.fn(),
    delete: vi.fn(),
    anchorPreview: vi.fn(),
  },
  edgesApi: { update: vi.fn(), get: vi.fn(), delete: vi.fn(), deletionSnapshot: vi.fn() },
  brokerChannelsApi: { list: vi.fn(() => Promise.resolve([])) },
}));

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: null, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, version: 1, docs: [], has_children: false, child_count: 0,
    approval: "in_progress", approval_effective: "in_progress", sites: [],
    created_at: "", updated_at: "", ...over,
  } as Node;
}

// Три случая на каждую точку: сервис с детьми, сервис-лист, база с детьми. Элемент —
// как его ответил бы сервер (app/element.py): у узла с детьми без хранимого элемента —
// система при любой форме, у листа — контейнер.
const group = () => node("Ядро", { has_children: true, child_count: 2, element_effective: "system" });
const leaf = () => node("Платежи", { element_effective: "container" });
const dbWithKids = () => node("Склад", {
  shape: "database", has_children: true, child_count: 1, element_effective: "system",
});

// Глиф строки (nodeTree.shared.ShapeGlyph). С Ф8 эпика вид узла с детьми решает элемент
// (types/treeNesting): система — пунктирный прямоугольник («group» здесь — любой узел с
// детьми, его вид проверяют тесты глифов), контейнер с компонентами — «коробка с
// крышкой»; цилиндр у базы, прямоугольник у сервиса-листа.
function glyphKind(root: Element | null): "group" | "database" | "service" | null {
  const glyph = root?.querySelector(".nt-glyph");
  const svg = glyph?.querySelector("svg");
  if (!glyph || !svg) return null;
  if (glyph.getAttribute("data-nesting") !== "leaf") return "group";
  if (svg.querySelector('path[d^="M2 2 v6.2"]')) return "database";
  return "service";
}

describe("nodeNesting — общая точка решения", () => {
  it("group — только сервис с детьми; база, брокер и пользователь — всегда лист", () => {
    expect(nodeNesting(group())).toBe("group");
    expect(nodeNesting(leaf())).toBe("leaf");
    expect(nodeNesting(dbWithKids())).toBe("leaf");
    expect(nodeNesting(node("Kafka", { shape: "broker", has_children: true }))).toBe("leaf");
    expect(nodeNesting(node("Покупатель", { shape: "person", has_children: true }))).toBe("leaf");
  });
});

describe("подсказка строки дерева (treeRowTitle)", () => {
  it("слой — только у сервиса с детьми; уровень развёртывания — у системы", () => {
    expect(treeRowTitle("editor", group())).toBe("Открыть слой: Ядро");
    expect(treeRowTitle("deploy", group())).toBe("Открыть уровень: Ядро");
    expect(treeRowTitle("editor", leaf())).toBe("Показать на схеме: Платежи");
    expect(treeRowTitle("deploy", leaf())).toBe("Показать на схеме: Платежи");
    expect(treeRowTitle("editor", dbWithKids())).toBe("Показать на схеме: Склад");
    // «Развёртывание» с Ф4 эпика следует элементу от сервера (D33): база с детьми для
    // него система — размещается её единицами, уровень открывается, как у сервера.
    expect(treeRowTitle("deploy", dbWithKids())).toBe("Открыть уровень: Склад");
    expect(treeRowTitle("pages", group())).toBe("Страница: Ядро");
  });
});

describe("порядок сиблингов (compareByRank)", () => {
  it("база с детьми стоит в ранге баз, сервис с детьми — первым", () => {
    const order = [dbWithKids(), leaf(), group()].sort(compareByRank).map((n) => n.name);
    expect(order).toEqual(["Ядро", "Платежи", "Склад"]);
  });
});

describe("дерево объектов (NodeTreePanel)", () => {
  beforeEach(() => vi.clearAllMocks());

  async function scene() {
    const onDrillTo = vi.fn();
    const onPickLeaf = vi.fn();
    vi.mocked(nodesApi.list).mockResolvedValue([group(), leaf(), dbWithKids()]);
    vi.mocked(nodesApi.getChildren).mockResolvedValue([node("Каталог", { parent_id: "Ядро" })]);
    const utils = render(
      <NodeTreePanel mode="editor" onDrillTo={onDrillTo} onPickLeaf={onPickLeaf} isArchitect={false} />,
    );
    await waitFor(() => expect(screen.getByText("Склад")).toBeInTheDocument());
    return { ...utils, onDrillTo, onPickLeaf };
  }
  const row = (name: string) => screen.getByText(name).closest(".nt-row");

  it("шеврон, жирное имя и глиф группы — только у сервиса с детьми", async () => {
    await scene();
    expect(row("Ядро")?.querySelector(".nt-chevzone")).not.toBeNull();
    expect(screen.getByText("Ядро").className).toBe("nt-name nt-name--container");
    expect(glyphKind(row("Ядро"))).toBe("group");
    for (const [name, glyph] of [["Платежи", "service"], ["Склад", "database"]] as const) {
      expect(row(name)?.querySelector(".nt-chevzone")).toBeNull();
      expect(screen.getByText(name).className).toBe("nt-name");
      expect(glyphKind(row(name))).toBe(glyph);
    }
  });

  it("клик: сервис с детьми — дрилл и раскрытие ветки, база с детьми — как лист", async () => {
    const { onDrillTo, onPickLeaf } = await scene();
    expect(row("Склад")).toHaveAttribute("title", "Показать на схеме: Склад");
    await userEvent.click(screen.getByText("Склад"));
    expect(onPickLeaf).toHaveBeenCalledWith(expect.objectContaining({ id: "Склад" }));
    expect(onDrillTo).not.toHaveBeenCalled();
    expect(nodesApi.getChildren).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Ядро"));
    expect(onDrillTo).toHaveBeenCalledWith([expect.objectContaining({ id: "Ядро" })]);
    await waitFor(() => expect(screen.getByText("Каталог")).toBeInTheDocument());
    expect(nodesApi.getChildren).toHaveBeenCalledWith("Ядро");
  });

  it("результаты поиска: глиф и клик по тем же правилам", async () => {
    const { onDrillTo, onPickLeaf } = await scene();
    vi.mocked(nodesApi.search).mockResolvedValue([
      node("Ядро-2", { has_children: true, child_count: 1 }),
      node("Склад-2", { shape: "database", has_children: true, child_count: 1 }),
    ]);
    await userEvent.type(screen.getByPlaceholderText(/поиск/i), "2");
    await waitFor(() => expect(screen.getByText("Склад-2")).toBeInTheDocument(), { timeout: 1000 });
    expect(glyphKind(row("Ядро-2"))).toBe("group");
    expect(glyphKind(row("Склад-2"))).toBe("database");
    await userEvent.click(screen.getByText("Склад-2"));
    expect(onPickLeaf).toHaveBeenCalledWith(expect.objectContaining({ id: "Склад-2" }));
    await userEvent.click(screen.getByText("Ядро-2"));
    expect(onDrillTo).toHaveBeenCalledWith([expect.objectContaining({ id: "Ядро-2" })]);
  });
});

describe("пикер конца связи (NodeSearchPicker)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it("глиф группы — только у сервиса с детьми", async () => {
    vi.mocked(nodesApi.search).mockResolvedValue([group(), leaf(), dbWithKids()]);
    render(<NodeSearchPicker value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Поиск по имени..."), { target: { value: "а" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const item = (name: string) => screen.getByText(name).parentElement;
    expect(glyphKind(item("Ядро"))).toBe("group");
    expect(glyphKind(item("Платежи"))).toBe("service");
    expect(glyphKind(item("Склад"))).toBe("database");
  });
});

describe("инспектор гостя (GhostInspector)", () => {
  const ghost = (over: Partial<GhostNode>): GhostNode => ({
    id: "g1", name: "Гость", role: null, technology: null, is_external: false,
    shape: "service", status: "existing", node_depth: 1, has_children: false,
    child_count: 0, ancestors: [], ...over,
  }) as GhostNode;

  it("глиф группы — только у сервиса с детьми", () => {
    const cases = [
      [ghost({ has_children: true, child_count: 3 }), "group"],
      [ghost({}), "service"],
      [ghost({ shape: "database", has_children: true, child_count: 1 }), "database"],
    ] as const;
    for (const [g, kind] of cases) {
      const { container, unmount } = render(
        <GhostInspector ghost={g} onGoToSource={vi.fn()} onNavigateNode={vi.fn()} />,
      );
      expect(glyphKind(container.querySelector(".insp-ghost-head"))).toBe(kind);
      unmount();
    }
  });
});

describe("инспектор узла (NodeInspector): технология", () => {
  beforeEach(() => vi.clearAllMocks());
  const cb = { ancestors: [], onNodeSaved: vi.fn(), onNodeDeleted: vi.fn(), onNavigateNode: vi.fn() };

  it("сервис с детьми — сводная технология потомков без поля ввода", async () => {
    vi.mocked(nodesApi.getDescendants).mockResolvedValue([
      node("k1", { parent_id: "Ядро", technology: "Go" }),
    ]);
    render(<NodeInspector node={group()} isArchitect {...cb} />);
    expect(await screen.findByText("Go")).toBeInTheDocument();
    expect(nodesApi.getDescendants).toHaveBeenCalledWith("Ядро");
    expect(screen.queryByPlaceholderText("Python, Kafka, Redis…")).toBeNull();
  });

  it("база с детьми — своя технология полем, потомков не запрашивает", () => {
    render(<NodeInspector node={dbWithKids()} isArchitect {...cb} />);
    expect(screen.getByPlaceholderText("Python, Kafka, Redis…")).toBeInTheDocument();
    expect(nodesApi.getDescendants).not.toHaveBeenCalled();
  });
});

describe("инспектор связи (EdgeInspector): глифы концов", () => {
  beforeEach(() => vi.clearAllMocks());

  it("глиф группы — только у сервиса с детьми", async () => {
    vi.mocked(brokerChannelsApi.list).mockResolvedValue([]);
    vi.mocked(nodesApi.get).mockImplementation((id: string) =>
      Promise.resolve(id === "s" ? node("s", { name: "Ядро", has_children: true, child_count: 2 })
        : node("t", { name: "Склад", shape: "database", has_children: true, child_count: 1 })),
    );
    const edge = {
      id: "e1", label: "чтение", technology: null, channel: null,
      source_id: "s", target_id: "t", version: 1, created_at: "",
      original_source_id: "s", original_target_id: "t",
      original_source_name: "Ядро", original_target_name: "Склад",
    } as LevelEdge;
    render(<EdgeInspector edge={edge} isArchitect={false} onEdgeSaved={vi.fn()} onEdgeDeleted={vi.fn()} />);
    const end = (name: string) => screen.getByText(name).parentElement;
    await waitFor(() => expect(glyphKind(end("Ядро"))).toBe("group"));
    await waitFor(() => expect(glyphKind(end("Склад"))).toBe("database"));
  });
});
