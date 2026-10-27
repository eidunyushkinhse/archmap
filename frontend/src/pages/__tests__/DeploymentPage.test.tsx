// DeploymentPage (режим «Развёртывание», docs/tasks/deployment-view.md): загрузка графа
// уровня из адреса → холст получает проекцию (состав площадок, предел вложенности,
// пометки, реестр концов), панель выделения считает объекты без повторов, «Снять
// выделение» — токеном холсту, «Переразложить» шлёт null-батч ключей deploy: и
// возвращает свёрнутость площадок, смена уровня и вход в контейнер — навигацией,
// двойной клик по объекту ведёт на страницу объекта. Ф6: дерево слева (уровень, показ
// объекта), путь уровня текстом, режим размещения щелчком по площадке, контейнер целиком.
// Холст, дерево и поллинг замоканы: проверяется оркестрация страницы.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeploymentPage from "../DeploymentPage";
import type LevelGraph from "../../components/LevelGraph";
import type NodeTreePanel from "../../components/NodeTreePanel";
import { deploymentApi } from "../../api/deployment";
import { nodesApi, viewsApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { DeploymentGraph, DeploymentNode, Node as AppNode, SiteOut } from "../../types";

type LGProps = ComponentProps<typeof LevelGraph>;
const lg: { current: LGProps | null } = { current: null };

vi.mock("../../components/LevelGraph", () => ({
  default: (p: LGProps) => { lg.current = p; return <div data-testid="level-graph" />; },
}));
// Дерево — маркер с пропсами: его поведение покрыто NodeTreePanel.test.tsx.
type TreeProps = Extract<ComponentProps<typeof NodeTreePanel>, { mode: "deploy" }>;
const tree: { current: TreeProps | null } = { current: null };
vi.mock("../../components/NodeTreePanel", () => ({
  default: (p: TreeProps) => { tree.current = p; return <div data-testid="tree" />; },
}));
// Модалка — прозрачная обёртка: jsdom не выставляет содержимое <dialog> в a11y-дерево.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="modal">{children}</div>,
}));
vi.mock("../../components/SchemaLegend", () => ({ default: () => null }));
// Окна — маркеры: их поведение покрыто своими тестами, здесь — проводка страницы.
vi.mock("../../components/deployment/PlacementDialog", () => ({
  default: ({ objects, onApplied }: { objects: { id: string }[]; onApplied: () => void }) => (
    <div data-testid="placement-dialog" data-objects={objects.map((o) => o.id).join(",")}>
      <button onClick={onApplied}>applied</button>
    </div>
  ),
}));
vi.mock("../../components/deployment/SitesDialog", () => ({
  default: ({ isArchitect }: { isArchitect: boolean }) => (
    <div data-testid="sites-dialog" data-architect={String(isArchitect)} />
  ),
}));
vi.mock("../useRemoteSync", () => ({ useRemoteSync: vi.fn() }));
vi.mock("../../api/deployment", () => ({ deploymentApi: { graph: vi.fn(), setPlacements: vi.fn() } }));
vi.mock("../../api/nodes", () => ({
  nodesApi: { getAll: vi.fn() },
  viewsApi: { saveLayout: vi.fn() },
}));

function site(id: string, parent_id: string | null = null): SiteOut {
  return { id, name: id, kind: "vm", technology: null, description: null, parent_id, version: 1, instance_count: 0 };
}
function obj(id: string, places: string[]): DeploymentNode {
  return {
    id, name: id.toUpperCase(), description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    version: 1, created_at: "", updated_at: "",
    sites: places.map((sid) => ({ id: sid, name: sid.toUpperCase(), kind: "vm" as const, partial: false })),
    instances: places,
  };
}
function graph(over: Partial<DeploymentGraph> = {}): DeploymentGraph {
  return {
    sites: [site("s1"), site("t")],
    nodes: [obj("a", ["s1", "t"]), obj("b", ["s1"])],
    edges: [{ id: "e1", label: null, technology: null, source_id: "a", target_id: "b", version: 1 }],
    layout: { "deploy:a@s1": { x: 10, y: 20 }, "deploy:site:s1": { x: 0, y: 0 } },
    version: 7, graph_rev: 3, meta_rev: 2,
    ...over,
  };
}

async function setup(isArchitect = true, g: DeploymentGraph = graph(), level: string | null = null) {
  vi.mocked(deploymentApi.graph).mockResolvedValue(g);
  const onOpenNode = vi.fn();
  const onNavigateLevel = vi.fn();
  const page = (lvl: string | null) => (
    <DeploymentPage isArchitect={isArchitect} level={lvl} onNavigateLevel={onNavigateLevel} onOpenNode={onOpenNode} />
  );
  const view = render(page(level));
  if (g.nodes.length > 0) await screen.findByTestId("level-graph");
  // новый адрес — новый уровень (так приходит и «назад» браузера)
  const goTo = (lvl: string | null) => view.rerender(page(lvl));
  return { onOpenNode, onNavigateLevel, goTo };
}
const props = (): LGProps => {
  if (!lg.current) throw new Error("холст не отрисован");
  return lg.current;
};
const treeProps = (): TreeProps => {
  if (!tree.current) throw new Error("дерево не отрисовано");
  return tree.current;
};
// Узел проекта (ответ /nodes/all и строки дерева): sites — площадки объекта; у контейнера
// — площадки его объектов (partial — стоит часть).
function pnode(
  id: string, name: string, parent_id: string | null,
  over: { has_children?: boolean; shape?: AppNode["shape"]; own?: string[]; partial?: string[] } = {},
): AppNode {
  return {
    id, name, parent_id, has_children: over.has_children ?? false, shape: over.shape ?? "service",
    sites: [
      ...(over.own ?? []).map((sid) => ({ id: sid, name: sid.toUpperCase(), kind: "vm" as const, partial: false })),
      ...(over.partial ?? []).map((sid) => ({ id: sid, name: sid.toUpperCase(), kind: "vm" as const, partial: true })),
    ],
  } as AppNode;
}

describe("DeploymentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lg.current = null;
    tree.current = null;
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      pnode("c1", "Витрина", null, { has_children: true }),
      pnode("c2", "Каталог", "c1", { has_children: true }),
      pnode("l1", "Лист", "c1"),
      pnode("a", "A", null, { own: ["s1", "t"] }),
      pnode("b", "B", null, { own: ["s1"] }),
    ]);
    vi.mocked(viewsApi.saveLayout).mockResolvedValue({ version: 8, graph_rev: 4 });
    vi.mocked(deploymentApi.setPlacements).mockResolvedValue(undefined);
  });

  it("загрузка → холст получает проекцию: площадки, состав, пометки, без предела вложенности", async () => {
    await setup();
    expect(deploymentApi.graph).toHaveBeenCalledWith(null);
    const p = props();
    expect(p.nodes.map((n) => n.id)).toEqual(["deploy:site:s1", "deploy:site:t"]);
    expect(p.containerId).toBeNull();
    expect(p.viewLayout).toEqual(graph().layout);
    expect(p.projection?.inlineDepth).toBe(Infinity);
    expect(Object.keys(p.projection?.children ?? {}).sort()).toEqual(["deploy:site:s1", "deploy:site:t"]);
    expect(p.projection?.marks).toEqual({ "deploy:a@s1": "1/2", "deploy:a@t": "2/2" });
    // реестр концов — по записи на карточку, с цепочкой площадок
    expect(p.endpoints.map((e) => e.id).sort()).toEqual(["deploy:a@s1", "deploy:a@t", "deploy:b@s1"]);
    expect(p.mode).toMatchObject({ readOnly: true, arrangeOnly: true, edgesInspectable: false });
    expect(p.persistence?.viewMeta?.current).toEqual({ version: 7, graphRev: 3, metaRev: 2 });
  });

  it("дерево слева в режиме deploy: уровень подсвечен, клик по контейнеру — навигация на его уровень", async () => {
    const { onNavigateLevel, goTo } = await setup();
    expect(treeProps().mode).toBe("deploy");
    expect(treeProps().currentNodeId).toBeNull();
    expect(typeof treeProps().onPlace).toBe("function");
    treeProps().onOpenLevel(pnode("c2", "Каталог", "c1", { has_children: true }));
    expect(onNavigateLevel).toHaveBeenCalledWith("c2");
    goTo("c2");
    await waitFor(() => expect(deploymentApi.graph).toHaveBeenLastCalledWith("c2"));
    await waitFor(() => expect(props().containerId).toBe("c2"));
    expect(treeProps().currentNodeId).toBe("c2");
  });

  it("селекта уровня нет — путь текстом, «Весь проект» ведёт в корень", async () => {
    const { onNavigateLevel } = await setup(true, graph(), "c2");
    expect(screen.queryByRole("combobox")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Уровень" });
    await waitFor(() => expect(nav).toHaveTextContent("Весь проект›Витрина › Каталог"));
    await userEvent.click(screen.getByRole("button", { name: "Весь проект" }));
    expect(onNavigateLevel).toHaveBeenCalledWith(null);
  });

  it("на корне путь — «Весь проект» без ссылки", async () => {
    await setup();
    expect(screen.getByRole("navigation", { name: "Уровень" })).toHaveTextContent("Весь проект");
    expect(screen.queryByRole("button", { name: "Весь проект" })).toBeNull();
  });

  it("объект из дерева на текущем уровне: выделить все его карточки и навести камеру на первую", async () => {
    await setup();
    act(() => { treeProps().onPickObject(pnode("a", "A", null)); });
    expect(props().projection?.selectRequest).toEqual({ ids: ["deploy:a@s1", "deploy:a@t"], token: 1 });
    expect(props().locate).toEqual({ kind: "node", ids: ["deploy:a@s1"], token: 1 });
  });

  it("объект из дерева с другого уровня: уровень родителя и выделение после загрузки его графа", async () => {
    // На корне «c» — цельный контейнер: «l1» внутри него не рисуется.
    const box: DeploymentNode = { ...obj("c", ["s1"]), has_children: true, child_count: 2 };
    const root = graph({
      nodes: [box, { ...obj("l1", ["s1"]), parent_id: "c" }, { ...obj("l2", ["s1"]), parent_id: "c" }], edges: [],
    });
    const { onNavigateLevel, goTo } = await setup(true, root);
    act(() => { treeProps().onPickObject(pnode("l1", "L1", "c")); });
    expect(onNavigateLevel).toHaveBeenCalledWith("c");
    expect(props().projection?.selectRequest).toBeNull();
    vi.mocked(deploymentApi.graph).mockResolvedValue(graph({
      nodes: [{ ...obj("l1", ["s1"]), parent_id: "c" }, { ...obj("l2", ["s1"]), parent_id: "c" }], edges: [],
    }));
    goTo("c");
    await waitFor(() => expect(props().containerId).toBe("c"));
    await waitFor(() => expect(props().projection?.selectRequest).toEqual({ ids: ["deploy:l1@s1"], token: 1 }));
    expect(props().locate).toEqual({ kind: "node", ids: ["deploy:l1@s1"], token: 1 });
  });

  it("смена уровня руками снимает показ объекта", async () => {
    const { goTo } = await setup();
    act(() => { treeProps().onPickObject(pnode("a", "A", null)); });
    expect(props().projection?.selectRequest).not.toBeNull();
    goTo("c1");
    await waitFor(() => expect(props().containerId).toBe("c1"));
    expect(props().projection?.selectRequest).toBeNull();
    expect(props().locate).toBeNull();
  });

  it("уровень из адреса: граф уровня, холст с контейнером уровня; смена уровня снимает выделение", async () => {
    const { goTo } = await setup(true, graph(), "c1");
    expect(deploymentApi.graph).toHaveBeenCalledWith("c1");
    expect(props().containerId).toBe("c1");
    act(() => { props().drill.onSelectionChange?.(["deploy:a@s1"]); });
    expect(screen.getByRole("status")).toHaveTextContent("Выбран 1 объект");
    goTo(null);
    await waitFor(() => expect(deploymentApi.graph).toHaveBeenLastCalledWith(null));
    await waitFor(() => expect(props().containerId).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("панель выделения считает объекты без повторов; «Снять выделение» — токеном холсту", async () => {
    await setup();
    act(() => { props().drill.onSelectionChange?.(["deploy:a@s1", "deploy:a@t", "deploy:b@s1", "deploy:site:t"]); });
    expect(screen.getByRole("status")).toHaveTextContent("Выбрано 2 объекта");
    expect(props().projection?.clearSelectionToken).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Снять выделение" }));
    expect(props().projection?.clearSelectionToken).toBe(1);
    act(() => { props().drill.onSelectionChange?.(["deploy:b@s1"]); });
    expect(screen.getByRole("status")).toHaveTextContent("Выбран 1 объект");
  });

  it("«Указать размещение» открывает окно для выбранных объектов; применение перечитывает граф", async () => {
    await setup();
    act(() => { props().drill.onSelectionChange?.(["deploy:a@s1", "deploy:a@t", "deploy:b@s1"]); });
    await userEvent.click(screen.getByRole("button", { name: "Указать размещение" }));
    expect(screen.getByTestId("placement-dialog")).toHaveAttribute("data-objects", "a,b");
    await userEvent.click(screen.getByRole("button", { name: "applied" }));
    expect(screen.queryByTestId("placement-dialog")).toBeNull();
    await waitFor(() => expect(deploymentApi.graph).toHaveBeenCalledTimes(2));
    expect(props().mutationToken).toBe(1);
    expect(props().projection?.clearSelectionToken).toBe(1);
  });

  it("«Площадки» открывают окно площадок обеим ролям", async () => {
    await setup(false);
    await userEvent.click(screen.getByRole("button", { name: "Площадки" }));
    expect(screen.getByTestId("sites-dialog")).toHaveAttribute("data-architect", "false");
  });

  it("«Переразложить» шлёт null-батч всех ключей deploy: вида с версией и перечитывает граф", async () => {
    await setup();
    await userEvent.click(screen.getByRole("button", { name: "Переразложить" }));
    await waitFor(() => expect(viewsApi.saveLayout).toHaveBeenCalledWith(
      null, { "deploy:a@s1": null, "deploy:site:s1": null }, 7,
    ));
    await waitFor(() => expect(deploymentApi.graph).toHaveBeenCalledTimes(2));
    expect(props().relayoutToken).toBe(1);
  });

  it("«Переразложить» не раскрывает свёрнутые площадки: вторым батчем возвращает expanded: false", async () => {
    await setup(true, graph({
      layout: { "deploy:a@s1": { x: 10, y: 20 }, "deploy:site:s1": { x: 0, y: 0, expanded: false } },
    }));
    await userEvent.click(screen.getByRole("button", { name: "Переразложить" }));
    await waitFor(() => expect(viewsApi.saveLayout).toHaveBeenCalledTimes(2));
    expect(viewsApi.saveLayout).toHaveBeenNthCalledWith(1, null, { "deploy:a@s1": null, "deploy:site:s1": null }, 7);
    expect(viewsApi.saveLayout).toHaveBeenNthCalledWith(2, null, { "deploy:site:s1": { expanded: false } }, 8);
    await waitFor(() => expect(props().relayoutToken).toBe(1));
  });

  it("«Переразложить» при 409: перечитать и повторить оба батча один раз", async () => {
    await setup(true, graph({
      layout: { "deploy:site:s1": { expanded: false } },
    }));
    vi.mocked(viewsApi.saveLayout).mockRejectedValueOnce(new ApiError(409, "Вид изменён в другой сессии"));
    await userEvent.click(screen.getByRole("button", { name: "Переразложить" }));
    await waitFor(() => expect(viewsApi.saveLayout).toHaveBeenCalledTimes(3));
    expect(viewsApi.saveLayout).toHaveBeenNthCalledWith(2, null, { "deploy:site:s1": null }, 7);
    expect(viewsApi.saveLayout).toHaveBeenNthCalledWith(3, null, { "deploy:site:s1": { expanded: false } }, 8);
    await waitFor(() => expect(props().relayoutToken).toBe(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("двойной клик по карточке объекта → страница объекта; по площадке — ничего", async () => {
    const { onOpenNode } = await setup();
    const card = props().projection?.children?.["deploy:site:t"]?.[0] as AppNode;
    props().drill.onEditNode(card);
    expect(onOpenNode).toHaveBeenCalledWith("a");
    props().drill.onEditNode(props().nodes[0]);
    expect(onOpenNode).toHaveBeenCalledTimes(1);
  });

  it("цельный контейнер: карточка выделяется как объект, двойной клик — вход в его уровень навигацией", async () => {
    const box: DeploymentNode = { ...obj("c", ["s1"]), has_children: true, child_count: 2 };
    const g = graph({
      nodes: [box, { ...obj("l1", ["s1"]), parent_id: "c" }, { ...obj("l2", ["s1"]), parent_id: "c" }],
      edges: [],
    });
    const { onOpenNode, onNavigateLevel } = await setup(true, g);
    const card = props().projection?.children?.["deploy:site:s1"]?.[0] as AppNode;
    expect(card.id).toBe("deploy:c@s1");
    act(() => { props().drill.onSelectionChange?.([card.id]); });
    await userEvent.click(screen.getByRole("button", { name: "Указать размещение" }));
    expect(screen.getByTestId("placement-dialog")).toHaveAttribute("data-objects", "c");
    act(() => { props().drill.onEditNode(card); });
    expect(onNavigateLevel).toHaveBeenCalledWith("c");
    expect(onOpenNode).not.toHaveBeenCalled();
  });

  it("читатель: ни панели выделения, ни «Переразложить», расстановки нет", async () => {
    await setup(false);
    expect(props().mode).toMatchObject({ readOnly: true, arrangeOnly: false });
    expect(props().persistence).toBeUndefined();
    act(() => { props().drill.onSelectionChange?.(["deploy:a@s1"]); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Переразложить" })).toBeNull();
  });

  it("нет листьев — заглушка вместо холста", async () => {
    await setup(true, graph({ nodes: [], edges: [], layout: {} }));
    expect(await screen.findByText("Нет объектов для размещения")).toBeInTheDocument();
    expect(screen.queryByTestId("level-graph")).toBeNull();
  });

  // ── Режим размещения (deployment.md D29–D30) ──
  const banner = () => screen.queryByText(/Куда поставить/);

  it("иконка строки → баннер, панели выделения нет, холст в режиме выбора; Esc — выход", async () => {
    await setup();
    act(() => { props().drill.onSelectionChange?.(["deploy:a@s1"]); });
    expect(props().projection?.pickFrame).toBeUndefined();
    act(() => { treeProps().onPlace?.(pnode("b", "B", null)); });
    expect(screen.getByRole("status")).toHaveTextContent("Куда поставить «B»? Щёлкните площадку");
    expect(screen.queryByText(/Выбран/)).toBeNull();
    expect(typeof props().projection?.pickFrame).toBe("function");
    expect(treeProps().placingId).toBe("b");
    await userEvent.keyboard("{Escape}");
    expect(banner()).toBeNull();
    expect(props().projection?.pickFrame).toBeUndefined();
    expect(screen.getByRole("status")).toHaveTextContent("Выбран 1 объект");
  });

  it("читатель: иконки размещения нет", async () => {
    await setup(false);
    expect(treeProps().onPlace).toBeUndefined();
  });

  it("объект: щелчок по площадке — набор из неё; режим закрыт, граф перечитан, карточки выделены", async () => {
    await setup();
    act(() => { treeProps().onPlace?.(pnode("b", "B", null)); });
    act(() => { props().projection?.pickFrame?.("deploy:site:t"); });
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["b"], ["t"]));
    await waitFor(() => expect(banner()).toBeNull());
    await waitFor(() => expect(deploymentApi.graph).toHaveBeenCalledTimes(2));
    expect(props().mutationToken).toBe(1);
    await waitFor(() => expect(props().projection?.selectRequest).toEqual({ ids: ["deploy:b@s1"], token: 1 }));
    expect(props().locate).toBeNull();
  });

  it("щелчок по карточке объекта — площадка, где она стоит; группа «не указано» — ничего, режим жив", async () => {
    await setup(true, graph({ nodes: [obj("a", ["s1", "t"]), obj("b", [])] }));
    act(() => { treeProps().onPlace?.(pnode("b", "B", null)); });
    act(() => { props().projection?.pickFrame?.("deploy:site:unplaced"); });
    act(() => { props().projection?.pickFrame?.("deploy:b@unplaced"); });
    expect(deploymentApi.setPlacements).not.toHaveBeenCalled();
    expect(banner()).not.toBeNull();
    act(() => { props().projection?.pickFrame?.("deploy:a@t"); });
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["b"], ["t"]));
  });

  it("объект не на этом уровне после записи — тост «размещён»", async () => {
    await setup();
    act(() => { treeProps().onPlace?.(pnode("l1", "Лист", "c1")); });
    act(() => { props().projection?.pickFrame?.("deploy:site:s1"); });
    expect(await screen.findByText("„Лист“ размещён на „s1“")).toBeInTheDocument();
  });

  it("контейнер, чьи объекты нигде не стоят или стоят там же, — запись сразу (набор объектам раздаёт сервер)", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      pnode("c1", "Витрина", null, { has_children: true, partial: ["t"] }),
      pnode("l1", "Лист", "c1"),
      pnode("l2", "Каталог", "c1", { own: ["t"] }),
    ]);
    await setup();
    await waitFor(() => expect(nodesApi.getAll).toHaveBeenCalled());
    act(() => { treeProps().onPlace?.(pnode("c1", "Витрина", null, { has_children: true })); });
    act(() => { props().projection?.pickFrame?.("deploy:site:t"); });
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["c1"], ["t"]));
  });

  it("контейнер с объектами на других площадках: окно со списком; «Отмена» — без записи, «Разместить» — пишет", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      pnode("c1", "Витрина", null, { has_children: true }),
      pnode("l1", "Order API", "c1", { own: ["s1"] }),
      pnode("l2", "БД заказов", "c1", { own: ["s1", "dc"] }),
      pnode("l3", "Каталог", "c1", { own: ["t"] }),
    ]);
    await setup();
    const place = () => {
      act(() => { treeProps().onPlace?.(pnode("c1", "Витрина", null, { has_children: true })); });
      act(() => { props().projection?.pickFrame?.("deploy:site:t"); });
    };
    place();
    expect(await screen.findByText("Разместить «Витрина» на «t»?")).toBeInTheDocument();
    expect(screen.getByText(/Все его компоненты будут размещены там же/)).toBeInTheDocument();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["БД заказов: S1, DC", "Order API: S1"]);
    // «Отмена» окна (у баннера своя): окно закрыто, записи нет, режим жив
    await userEvent.click(within(screen.getByTestId("modal")).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByText("Разместить «Витрина» на «t»?")).toBeNull();
    expect(deploymentApi.setPlacements).not.toHaveBeenCalled();
    expect(banner()).not.toBeNull();

    act(() => { props().projection?.pickFrame?.("deploy:site:t"); });
    await userEvent.click(await screen.findByRole("button", { name: "Разместить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["c1"], ["t"]));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it("«Снять размещение» у контейнера: подтверждение со списком его объектов; «Снять» шлёт пустой набор", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      pnode("c1", "Витрина", null, { has_children: true, partial: ["s1"] }),
      pnode("l1", "Order API", "c1", { own: ["s1"] }),
      pnode("l2", "Каталог", "c1"),
    ]);
    await setup();
    act(() => { treeProps().onPlace?.(pnode("c1", "Витрина", null, { has_children: true })); });
    await userEvent.click(await screen.findByRole("button", { name: "Снять размещение" }));
    expect(await screen.findByText("Снять размещение «Витрина»?")).toBeInTheDocument();
    expect(screen.getByText(/Размещение всех его компонентов будет снято/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Order API: S1"]);
    await userEvent.click(screen.getByRole("button", { name: "Снять" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["c1"], []));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it("«Снять размещение» — только при размещении, шлёт пустой набор", async () => {
    await setup();
    await waitFor(() => expect(nodesApi.getAll).toHaveBeenCalled());
    act(() => { treeProps().onPlace?.(pnode("l1", "Лист", "c1")); });
    expect(screen.queryByRole("button", { name: "Снять размещение" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(banner()).toBeNull();
    act(() => { treeProps().onPlace?.(pnode("b", "B", null)); });
    await userEvent.click(await screen.findByRole("button", { name: "Снять размещение" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["b"], []));
  });

  it("отказ записи — текстом в баннере, режим остаётся", async () => {
    vi.mocked(deploymentApi.setPlacements).mockRejectedValue(new ApiError(422, "Пользователя разместить нельзя"));
    await setup();
    act(() => { treeProps().onPlace?.(pnode("b", "B", null)); });
    act(() => { props().projection?.pickFrame?.("deploy:site:t"); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось разместить. Пользователя разместить нельзя");
    expect(banner()).not.toBeNull();
  });

  it("смена уровня режим размещения не сбрасывает", async () => {
    const { goTo } = await setup();
    act(() => { treeProps().onPlace?.(pnode("b", "B", null)); });
    goTo("c1");
    await waitFor(() => expect(props().containerId).toBe("c1"));
    expect(banner()).not.toBeNull();
    expect(typeof props().projection?.pickFrame).toBe("function");
  });
});
