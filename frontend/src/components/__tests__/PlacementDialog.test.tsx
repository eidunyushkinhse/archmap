// Окно «Размещение» (docs/tasks/deployment-view.md §6): галочки по площадкам выбранных
// объектов (все — отмечена, часть — частичная), «Применить» шлёт набор целиком
// (нетронутая частичная сохраняется у каждого объекта), «Убрать размещение» — пустой
// набор. Дерево площадок общее с окном «Площадки» (SiteTree): свёрнуто, кроме предков
// площадок, где стоят выбранные; новая площадка заводится «+» в дереве (родитель — где
// нажали) и появляется отмеченной, отказ по пределу демо — строкой в окне. Контейнер —
// это его объекты (deployment.md D30): набор пишется им по составу проекта, снятие —
// после второго шага со списком «объект: площадки» («Снять», «Назад»).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PlacementDialog from "../deployment/PlacementDialog";
import { deploymentApi } from "../../api/deployment";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { DeploymentNode, Node, SiteOut } from "../../types";

// Модалка — прозрачная обёртка: jsdom не выставляет содержимое <dialog> в a11y-дерево.
vi.mock("../../ui/Modal", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../api/deployment", () => ({
  deploymentApi: { setPlacements: vi.fn(), createSite: vi.fn() },
}));
vi.mock("../../api/nodes", () => ({ nodesApi: { getAll: vi.fn() } }));

function site(id: string, parent_id: string | null = null, technology: string | null = null): SiteOut {
  return { id, name: id, kind: "kubernetes", technology, description: null, parent_id, version: 1, instance_count: 0 };
}
const ref = (id: string, partial = false): Node["sites"][number] => ({ id, name: id, kind: "vm", partial });
// Объект: own — его площадки. Контейнер (has_children): whole — где стоят все его
// объекты, partial — где часть.
function obj(id: string, own: string[]): DeploymentNode {
  return {
    id, name: id.toUpperCase(), description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    version: 1, created_at: "", updated_at: "",
    sites: own.map((s) => ref(s)), instances: own,
  };
}
function box(id: string, name: string, whole: string[], partial: string[] = []): DeploymentNode {
  return {
    ...obj(id, whole), name, has_children: true, child_count: 2,
    sites: [...whole.map((s) => ref(s)), ...partial.map((s) => ref(s, true))],
  };
}
// Узел состава проекта (ответ /nodes/all).
function pn(id: string, name: string, parent_id: string | null, sites: Node["sites"], shape: Node["shape"] = "service"): Node {
  return { ...obj(id, []), name, parent_id, shape, sites };
}

const SITES = [site("cloud", null, "AWS"), site("k8s", "cloud"), site("vm1"), site("vm2")];
const check = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}`) }) as HTMLInputElement;
const expand = (name: string) => userEvent.click(screen.getByRole("button", { name: `Развернуть «${name}»` }));

function setup(objects: DeploymentNode[], sites: SiteOut[] = SITES) {
  const props = { onClose: vi.fn(), onApplied: vi.fn(), onSitesChanged: vi.fn() };
  render(<PlacementDialog objects={objects} sites={sites} {...props} />);
  return props;
}

describe("PlacementDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deploymentApi.setPlacements).mockResolvedValue(undefined);
  });

  it("подзаголовок: имя одного объекта или число объектов", () => {
    setup([obj("a", [])]);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("галочки: у всех — отмечена, у части — частичная; предки площадок раскрыты", () => {
    setup([obj("a", ["k8s", "vm1"]), obj("b", ["k8s"])]);
    expect(screen.getByText("2 объекта")).toBeInTheDocument();
    // объекты стоят на вложенной k8s — её родитель cloud раскрыт сразу
    expect(screen.getByRole("button", { name: "Свернуть «cloud»" })).toBeInTheDocument();
    expect(check("k8s").checked).toBe(true);
    expect(check("k8s").indeterminate).toBe(false);
    expect(check("vm1").checked).toBe(false);
    expect(check("vm1").indeterminate).toBe(true);
    expect(check("cloud").checked).toBe(false);
    expect(check("cloud").indeterminate).toBe(false);
    expect(check("vm2").checked).toBe(false);
    // технология площадки — серым рядом с именем
    expect(screen.getByText("AWS")).toBeInTheDocument();
  });

  it("«Применить» шлёт набор целиком: отмеченные площадки всем объектам", async () => {
    const props = setup([obj("a", ["k8s"]), obj("b", ["k8s"])]);
    await userEvent.click(check("vm2"));
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["a", "b"], ["k8s", "vm2"]));
    expect(deploymentApi.setPlacements).toHaveBeenCalledTimes(1);
    expect(props.onApplied).toHaveBeenCalled();
  });

  it("частичная галочка: тронули — отмечена всем, не тронули — у каждого как было", async () => {
    setup([obj("a", ["k8s", "vm1"]), obj("b", ["k8s"])]);
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledTimes(2));
    expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["a"], ["k8s", "vm1"]);
    expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["b"], ["k8s"]);

    vi.mocked(deploymentApi.setPlacements).mockClear();
    await userEvent.click(check("vm1"));
    expect(check("vm1").checked).toBe(true);
    expect(check("vm1").indeterminate).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["a", "b"], ["k8s", "vm1"]));
  });

  it("«Убрать размещение» у объекта шлёт пустой набор сразу", async () => {
    const props = setup([obj("a", ["k8s"])]);
    await userEvent.click(screen.getByRole("button", { name: "Убрать размещение" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["a"], []));
    expect(props.onApplied).toHaveBeenCalled();
    expect(nodesApi.getAll).not.toHaveBeenCalled();
  });

  it("«Убрать размещение» выключена, когда размещения нет ни у кого", () => {
    setup([obj("a", [])]);
    expect(screen.getByRole("button", { name: "Убрать размещение" })).toBeDisabled();
  });

  it("дерево свёрнуто, когда выбранные нигде не стоят; «+» под площадкой — после шеврона", async () => {
    setup([obj("a", [])]);
    expect(screen.queryByRole("checkbox", { name: /^k8s/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /внутри «cloud»/ })).toBeNull();
    await expand("cloud");
    expect(check("k8s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Добавить площадку внутри «cloud»" })).toBeInTheDocument();
  });

  it("новая площадка «+» под cloud появляется в дереве отмеченной и уходит в набор", async () => {
    vi.mocked(deploymentApi.createSite).mockResolvedValue({ ...site("new-id", "cloud"), name: "Кластер prod" });
    const props = setup([obj("a", [])]);
    await expand("cloud");
    await userEvent.click(screen.getByRole("button", { name: "Добавить площадку внутри «cloud»" }));
    expect(screen.queryByRole("combobox", { name: "Внутри площадки" })).toBeNull();
    await userEvent.type(screen.getByRole("textbox", { name: "Имя" }), "Кластер prod");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(deploymentApi.createSite).toHaveBeenCalledWith({
      name: "Кластер prod", kind: "other", technology: null, description: null, parent_id: "cloud",
    }));
    expect(check("Кластер prod").checked).toBe(true);
    expect(props.onSitesChanged).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["a"], ["new-id"]));
  });

  it("предел демо при создании площадки — строкой в окне с жирным началом", async () => {
    vi.mocked(deploymentApi.createSite).mockRejectedValue(
      new ApiError(409, "Демо-проект поддерживает до 20 площадок.", "demo_limit"),
    );
    setup([obj("a", [])]);
    await userEvent.click(screen.getByRole("button", { name: "Добавить площадку" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Имя" }), "Ещё одна");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не получилось добавить площадку. Демо-проект поддерживает до 20 площадок.");
  });

  it("прочий отказ применения — строкой в окне, окно остаётся", async () => {
    vi.mocked(deploymentApi.setPlacements).mockRejectedValue(new ApiError(422, "Пользователя разместить нельзя"));
    const props = setup([obj("a", ["k8s"])]);
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Пользователя разместить нельзя");
    expect(props.onApplied).not.toHaveBeenCalled();
  });

  // ── Контейнер — это его объекты (deployment.md D30) ──
  // «Заказы» ⊃ Order API (vm2), Каталог (vm1), Покупатель («Пользователь», не
  // размещается): у контейнера vm1 и vm2 — частичные.
  const container = () => box("c", "Заказы", [], ["vm1", "vm2"]);
  const inside = (): Node[] => [
    pn("c", "Заказы", null, [ref("vm1", true), ref("vm2", true)]),
    pn("x", "Order API", "c", [ref("vm2")]),
    pn("y", "Каталог", "c", [ref("vm1")]),
    pn("u", "Покупатель", "c", [], "person"),
  ];

  it("контейнер: частичные галочки по его объектам; набор пишется объектам по составу проекта", async () => {
    let resolveAll: (ns: Node[]) => void = () => {};
    vi.mocked(nodesApi.getAll).mockReturnValue(new Promise((r) => { resolveAll = r; }));
    const props = setup([container()]);
    expect(check("vm1").indeterminate).toBe(true);
    expect(check("vm2").indeterminate).toBe(true);
    // состав грузится: галочки работают, ждёт только запись
    expect(screen.getByText("Загрузка…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Убрать размещение" })).toBeDisabled();
    await expand("cloud");
    await userEvent.click(check("k8s"));
    resolveAll(inside());
    await waitFor(() => expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled());
    expect(nodesApi.getAll).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    // k8s — всем, нетронутые частичные — у каждого как было; «Пользователю» не пишется
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledTimes(2));
    expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["x"], ["k8s", "vm2"]);
    expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["y"], ["k8s", "vm1"]);
    expect(props.onApplied).toHaveBeenCalled();
  });

  it("контейнер, у которого все объекты на одной площадке, — галочка отмечена; снятая — пишется всем", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      pn("c", "Заказы", null, [ref("vm1")]),
      pn("x", "Order API", "c", [ref("vm1")]),
      pn("y", "Каталог", "c", [ref("vm1")]),
    ]);
    setup([box("c", "Заказы", ["vm1"])]);
    expect(check("vm1").checked).toBe(true);
    await userEvent.click(check("vm1"));
    await userEvent.click(check("vm2"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["x", "y"], ["vm2"]));
    expect(deploymentApi.setPlacements).toHaveBeenCalledTimes(1);
  });

  it("«Убрать размещение» у контейнера: второй шаг со списком объектов → «Снять» шлёт пустой набор объектам", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue(inside());
    const props = setup([container()]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Убрать размещение" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Убрать размещение" }));
    expect(deploymentApi.setPlacements).not.toHaveBeenCalled();
    expect(screen.getByText("Снять размещение «Заказы»?")).toBeInTheDocument();
    expect(screen.getByText(/Размещение всех его компонентов будет снято/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Объекты с другим размещением" });
    expect(list).toHaveTextContent("Каталог: vm1");
    expect(list).toHaveTextContent("Order API: vm2");
    expect(list).not.toHaveTextContent("Покупатель");
    await userEvent.click(screen.getByRole("button", { name: "Снять" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["x", "y"], []));
    expect(props.onApplied).toHaveBeenCalled();
  });

  it("второй шаг: «Назад» возвращает галочки как были, без записи", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue(inside());
    setup([container()]);
    await expand("cloud");
    await userEvent.click(check("k8s"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Убрать размещение" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Убрать размещение" }));
    await userEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(check("k8s").checked).toBe(true);
    expect(check("vm1").indeterminate).toBe(true);
    expect(deploymentApi.setPlacements).not.toHaveBeenCalled();
  });

  it("контейнер без объектов едет сам — отказ сервера строкой в окне", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      pn("c", "Заказы", null, []),
      pn("u", "Покупатель", "c", [], "person"),
    ]);
    vi.mocked(deploymentApi.setPlacements).mockRejectedValue(
      new ApiError(422, "В «Заказы» нет объектов, которые можно разместить"),
    );
    setup([box("c", "Заказы", [])]);
    await userEvent.click(check("vm1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["c"], ["vm1"]));
    expect(await screen.findByRole("alert")).toHaveTextContent("нет объектов, которые можно разместить");
  });

  it("состав не загрузился — отказ строкой с «Повторить», галочки живы", async () => {
    vi.mocked(nodesApi.getAll).mockRejectedValueOnce(new ApiError(500, "Сервер недоступен")).mockResolvedValue(inside());
    setup([container()]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Не удалось загрузить объекты контейнера. Сервер недоступен");
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
    await userEvent.click(check("vm2"));
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled());
    expect(check("vm2").checked).toBe(true);
  });

  it("без контейнеров состав проекта не грузится", () => {
    setup([obj("a", ["k8s"])]);
    expect(nodesApi.getAll).not.toHaveBeenCalled();
    expect(screen.queryByText("Загрузка…")).toBeNull();
  });
});
