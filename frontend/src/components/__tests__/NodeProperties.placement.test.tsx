// Строка «Размещение» карточки «Свойства» (docs/tasks/deployment-view.md, Ф3): перечень
// площадок из node.sites (имя, «в <родитель>»; у контейнера это площадки его объектов,
// где стоит часть — «часть объектов»), пусто — «не указано», у «Пользователя» строки
// нет. Редактор открывает настоящее окно «Размещение» на одном объекте: площадки
// грузятся по нажатию, размещение в окне отмечено, применение зовёт перечитывание
// страницы. Хук правки свойств — настоящий (useNodePatch), моков нет ни у него, ни у окна.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NodeProperties from "../nodePage/NodeProperties";
import { useNodePatch } from "../../pages/useNodePatch";
import { deploymentApi } from "../../api/deployment";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { Node, SiteOut } from "../../types";

// Модалка — прозрачная обёртка: jsdom не выставляет содержимое <dialog> в a11y-дерево.
vi.mock("../../ui/Modal", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../api/nodes", () => ({
  nodesApi: { update: vi.fn(), get: vi.fn(), getAll: vi.fn(), anchorPreview: vi.fn() },
}));
vi.mock("../../api/deployment", () => ({
  deploymentApi: { sites: vi.fn(), setPlacements: vi.fn(), createSite: vi.fn() },
}));

type Site = Node["sites"][number];
const OWN_K8S: Site = { id: "k8s", name: "Кластер prod", kind: "kubernetes", parent_id: "aws", parent_name: "AWS", partial: false };
const OWN_VM: Site = { id: "vm1", name: "vm-1", kind: "vm", partial: false };
const PART_K8S: Site = { ...OWN_K8S, partial: true };

function node(over: Partial<Node> = {}): Node {
  return {
    id: "n1", name: "Витрина", description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "container",
    version: 1, created_at: "", updated_at: "", sites: [],
    ...over,
  };
}

function site(id: string, name: string, kind: SiteOut["kind"], parent_id: string | null = null): SiteOut {
  return { id, name, kind, technology: null, description: null, parent_id, version: 1, instance_count: 0 };
}
const SITES = [site("aws", "AWS", "cloud"), site("k8s", "Кластер prod", "kubernetes", "aws"), site("vm1", "vm-1", "vm")];

function Harness({ n, isArchitect, isContainer, onPlacementChanged }: {
  n: Node; isArchitect: boolean; isContainer: boolean; onPlacementChanged: () => void;
}) {
  const patch = useNodePatch(n);
  return (
    <NodeProperties
      patch={patch}
      isArchitect={isArchitect}
      isContainer={isContainer}
      techLoading={false}
      aggTech=""
      onPlacementChanged={onPlacementChanged}
    />
  );
}

function setup(over: Partial<Node> = {}, opts: { isArchitect?: boolean; isContainer?: boolean } = {}) {
  const onPlacementChanged = vi.fn();
  render(
    <Harness
      n={node(over)}
      isArchitect={opts.isArchitect ?? true}
      isContainer={opts.isContainer ?? false}
      onPlacementChanged={onPlacementChanged}
    />,
  );
  return onPlacementChanged;
}

const editButton = () => screen.queryByRole("button", { name: "Изменить размещение" });

describe("NodeProperties: строка «Размещение»", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deploymentApi.sites).mockResolvedValue(SITES);
    vi.mocked(deploymentApi.setPlacements).mockResolvedValue(undefined);
  });

  it("без размещения — «не указано»", () => {
    setup({ sites: [] }, { isArchitect: false });
    expect(screen.getByText("Размещение")).toBeInTheDocument();
    expect(screen.getByText("не указано")).toBeInTheDocument();
  });

  it("размещение объекта: имена площадок, «в <родитель>» у вложенной", () => {
    setup({ sites: [OWN_K8S, OWN_VM] }, { isArchitect: false });
    expect(screen.getByText("Кластер prod")).toBeInTheDocument();
    expect(screen.getByText("в AWS")).toBeInTheDocument();
    expect(screen.getByText("vm-1")).toBeInTheDocument();
    expect(screen.queryByText(/часть объектов/)).toBeNull();
    expect(screen.queryByText("не указано")).toBeNull();
  });

  it("у контейнера площадка, где стоит часть его объектов, помечена «часть объектов»", () => {
    setup({ sites: [PART_K8S, OWN_VM], has_children: true, child_count: 2 }, { isArchitect: false, isContainer: true });
    expect(screen.getByText("Кластер prod")).toBeInTheDocument();
    expect(screen.getAllByText("часть объектов")).toHaveLength(1);
    expect(screen.getByText("vm-1")).toBeInTheDocument();
  });

  it("у «Пользователя» строки нет", () => {
    setup({ shape: "person" });
    expect(screen.queryByText("Размещение")).toBeNull();
    expect(editButton()).toBeNull();
  });

  it("читатель видит размещение, но не правит", () => {
    setup({ sites: [OWN_K8S] }, { isArchitect: false });
    expect(editButton()).toBeNull();
  });

  it("«Изменить» грузит площадки и открывает окно на объекте; применение перечитывает страницу", async () => {
    const onPlacementChanged = setup({ sites: [OWN_K8S] });
    await userEvent.click(editButton()!);

    expect(deploymentApi.sites).toHaveBeenCalledTimes(1);
    // Окно «Размещение» на одном объекте: в подзаголовке его имя, его площадка отмечена.
    const k8s = await screen.findByRole("checkbox", { name: /^Кластер prod/ });
    expect(screen.getAllByText("Витрина").length).toBeGreaterThan(0);
    expect((k8s as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /^vm-1/ }) as HTMLInputElement).checked).toBe(false);

    await userEvent.click(screen.getByRole("checkbox", { name: /^vm-1/ }));
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));

    await waitFor(() => expect(onPlacementChanged).toHaveBeenCalledTimes(1));
    expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["n1"], ["k8s", "vm1"]);
    expect(nodesApi.getAll).not.toHaveBeenCalled();
    // Окно закрылось — строка перечитает node.sites от страницы.
    expect(screen.queryByRole("button", { name: "Применить" })).toBeNull();
  });

  it("система в окне: площадка части объектов — частичная галочка, набор пишется её контейнерам", async () => {
    // Элемент — как ответил бы сервер: узел с детьми без хранимого элемента — система,
    // её листья — контейнеры (единицы размещения, D33).
    const SYSTEM: Partial<Node> = { sites: [PART_K8S], has_children: true, child_count: 2, element_effective: "system" };
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      node(SYSTEM),
      node({ id: "x", name: "API", parent_id: "n1", sites: [OWN_K8S] }),
      node({ id: "y", name: "Корзина", parent_id: "n1", sites: [] }),
    ]);
    const onPlacementChanged = setup(SYSTEM, { isContainer: true });
    await userEvent.click(editButton()!);
    const k8s = await screen.findByRole("checkbox", { name: /^Кластер prod/ }) as HTMLInputElement;
    expect(k8s.checked).toBe(false);
    expect(k8s.indeterminate).toBe(true);

    await userEvent.click(screen.getByRole("checkbox", { name: /^vm-1/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));

    await waitFor(() => expect(onPlacementChanged).toHaveBeenCalledTimes(1));
    expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["x"], ["vm1", "k8s"]);
    expect(deploymentApi.setPlacements).toHaveBeenCalledWith(["y"], ["vm1"]);
  });

  it("отказ загрузки площадок — текстом под строкой, окно не открывается", async () => {
    vi.mocked(deploymentApi.sites).mockRejectedValue(new ApiError(500, "Сервер недоступен"));
    const onPlacementChanged = setup({ sites: [] });
    await userEvent.click(editButton()!);

    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить площадки. Сервер недоступен");
    expect(screen.queryByRole("button", { name: "Применить" })).toBeNull();
    expect(onPlacementChanged).not.toHaveBeenCalled();
  });

  it("«Отмена» закрывает окно без записи", async () => {
    const onPlacementChanged = setup({ sites: [OWN_K8S] });
    await userEvent.click(editButton()!);
    await userEvent.click(await screen.findByRole("button", { name: "Отмена" }));

    expect(screen.queryByRole("button", { name: "Применить" })).toBeNull();
    expect(deploymentApi.setPlacements).not.toHaveBeenCalled();
    expect(onPlacementChanged).not.toHaveBeenCalled();
  });
});
