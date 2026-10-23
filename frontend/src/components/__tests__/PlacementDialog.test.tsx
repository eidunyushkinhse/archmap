// Окно «Размещение» (docs/tasks/deployment-view.md §6): галочки по своим экземплярам
// выбранных объектов (все — отмечена, часть — частичная, только унаследовано — подпись),
// «Применить» шлёт набор целиком (нетронутая частичная сохраняется у каждого объекта),
// «Убрать размещение» — пустой набор, новая площадка появляется отмеченной, отказ
// по пределу демо — строкой в окне. Контейнер размещается целиком: объекты внутри на
// других площадках — второй шаг в том же окне («Разместить» с флагом, «Назад»).
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
function obj(id: string, own: string[], inherited: { site: string; from: string }[] = []): DeploymentNode {
  return {
    id, name: id.toUpperCase(), description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    version: 1, created_at: "", updated_at: "",
    sites: inherited.map((i) => ({
      id: i.site, name: i.site, kind: "vm" as const, inherited_from_id: `id-${i.from}`, inherited_from_name: i.from,
    })),
    instances: own,
    effective: [
      ...own.map((site_id) => ({ site_id, inherited_from_id: null })),
      ...inherited.map((i) => ({ site_id: i.site, inherited_from_id: `id-${i.from}` })),
    ],
  };
}

const SITES = [site("cloud", null, "AWS"), site("k8s", "cloud"), site("vm1"), site("vm2")];
const box = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}`) }) as HTMLInputElement;

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

  it("галочки: у всех — отмечена, у части — частичная, только унаследовано — подпись", () => {
    setup([
      obj("a", ["k8s", "vm1"]),
      obj("b", ["k8s"], [{ site: "vm2", from: "Витрина" }]),
    ]);
    expect(screen.getByText("2 объекта")).toBeInTheDocument();
    expect(box("k8s").checked).toBe(true);
    expect(box("k8s").indeterminate).toBe(false);
    expect(box("vm1").checked).toBe(false);
    expect(box("vm1").indeterminate).toBe(true);
    expect(box("cloud").checked).toBe(false);
    expect(box("cloud").indeterminate).toBe(false);
    expect(box("vm2").checked).toBe(false);
    expect(screen.getByText("унаследовано от «Витрина»")).toBeInTheDocument();
    // технология площадки — серым рядом с именем
    expect(screen.getByText("AWS")).toBeInTheDocument();
  });

  it("«Применить» шлёт набор целиком: отмеченные площадки всем объектам", async () => {
    const props = setup([obj("a", ["k8s"]), obj("b", ["k8s"])]);
    await userEvent.click(box("vm2"));
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
    await userEvent.click(box("vm1"));
    expect(box("vm1").checked).toBe(true);
    expect(box("vm1").indeterminate).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["a", "b"], ["k8s", "vm1"]));
  });

  it("«Убрать размещение» шлёт пустой набор", async () => {
    const props = setup([obj("a", ["k8s"])]);
    await userEvent.click(screen.getByRole("button", { name: "Убрать размещение" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["a"], []));
    expect(props.onApplied).toHaveBeenCalled();
  });

  it("«Убрать размещение» выключена, когда своего размещения нет ни у кого", () => {
    setup([obj("a", [], [{ site: "vm2", from: "Витрина" }])]);
    expect(screen.getByRole("button", { name: "Убрать размещение" })).toBeDisabled();
  });

  it("новая площадка появляется в дереве отмеченной и уходит в набор", async () => {
    vi.mocked(deploymentApi.createSite).mockResolvedValue({ ...site("new-id"), name: "Кластер prod" });
    const props = setup([obj("a", [])]);
    await userEvent.click(screen.getByRole("button", { name: "+ Новая площадка" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Имя" }), "Кластер prod");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Внутри площадки" }), "cloud");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(deploymentApi.createSite).toHaveBeenCalledWith({
      name: "Кластер prod", kind: "other", technology: null, parent_id: "cloud",
    }));
    expect(box("Кластер prod").checked).toBe(true);
    expect(props.onSitesChanged).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["a"], ["new-id"]));
  });

  it("предел демо при создании площадки — строкой в окне с жирным началом", async () => {
    vi.mocked(deploymentApi.createSite).mockRejectedValue(
      new ApiError(409, "Демо-проект поддерживает до 20 площадок.", "demo_limit"),
    );
    setup([obj("a", [])]);
    await userEvent.click(screen.getByRole("button", { name: "+ Новая площадка" }));
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

  // ── Контейнер целиком (deployment.md D30) ──
  const ownSite = (id: string, inheritedFrom: string | null = null) => ({
    id, name: id, kind: "vm" as const, inherited_from_id: inheritedFrom,
  });
  const container = (): DeploymentNode => ({ ...obj("c", ["vm1"]), name: "Заказы", has_children: true, child_count: 2 });
  const inside = (): Node[] => [
    { id: "c", name: "Заказы", parent_id: null, sites: [ownSite("vm1")] },
    { id: "x", name: "Order API", parent_id: "c", sites: [ownSite("vm2")] },
    { id: "y", name: "Каталог", parent_id: "c", sites: [ownSite("vm1", "c")] },
  ] as Node[];

  it("контейнер с объектами на других площадках: второй шаг со списком → «Разместить» с флагом", async () => {
    let resolveAll: (ns: Node[]) => void = () => {};
    vi.mocked(nodesApi.getAll).mockReturnValue(new Promise((r) => { resolveAll = r; }));
    const props = setup([container()]);
    // состав грузится: галочки работают, ждёт только «Применить»
    expect(screen.getByText("Загрузка…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
    await userEvent.click(box("k8s"));
    resolveAll(inside());
    await waitFor(() => expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled());
    expect(nodesApi.getAll).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    expect(deploymentApi.setPlacements).not.toHaveBeenCalled();
    expect(screen.getByText("Разместить «Заказы» на «k8s», «vm1»?")).toBeInTheDocument();
    expect(screen.getByText(/Все его компоненты будут размещены там же/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Объекты с другим размещением" });
    expect(list).toHaveTextContent("Order API: vm2");
    expect(list).not.toHaveTextContent("Каталог");
    await userEvent.click(screen.getByRole("button", { name: "Разместить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(
      ["c"], ["k8s", "vm1"], { clearDescendants: true },
    ));
    expect(props.onApplied).toHaveBeenCalled();
  });

  it("второй шаг: «Назад» возвращает галочки как были, без записи", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue(inside());
    setup([container()]);
    await userEvent.click(box("k8s"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await userEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(box("k8s").checked).toBe(true);
    expect(box("vm1").checked).toBe(true);
    expect(deploymentApi.setPlacements).not.toHaveBeenCalled();
  });

  it("контейнер без конфликтов — запись сразу с флагом; «Убрать размещение» — без флага и без шага", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue(inside());
    const props = setup([container()]);
    await userEvent.click(box("vm2"));
    await userEvent.click(box("vm1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["c"], ["vm2"], { clearDescendants: true }));
    expect(props.onApplied).toHaveBeenCalledTimes(1);

    vi.mocked(deploymentApi.setPlacements).mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Убрать размещение" }));
    await waitFor(() => expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["c"], []));
  });

  it("без контейнеров состав проекта не грузится", () => {
    setup([obj("a", ["k8s"])]);
    expect(nodesApi.getAll).not.toHaveBeenCalled();
    expect(screen.queryByText("Загрузка…")).toBeNull();
  });
});
