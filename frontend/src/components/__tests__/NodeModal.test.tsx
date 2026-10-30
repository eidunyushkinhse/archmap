// Окно «Новый объект». Первое поле — «Тип» (Р36 раздела 13 docs/plan-c4-elements.md):
// варианты по месту создания (корень, система, контейнер, лист без элемента), серый пункт
// не выбирается, предвыбор по шаблону палитры и по последнему созданному соседу, без типа
// «Создать» неактивна, сбой загрузки родителя виден в окне. Первый вложенный объект листа
// задаёт родителя тем же запросом (Р38, parent_element). Подтверждение клавишей Enter — то
// же, что кнопка «Создать» (ui/Modal.onSubmit). События тура — NodeModal.tourEvents.test.
//
// jsdom не открывает <dialog>: роли внутри скрыты, поэтому поля ищутся селекторами.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeModal from "../NodeModal";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { create: vi.fn(), get: vi.fn(), list: vi.fn(), getChildren: vi.fn() },
  viewsApi: { saveLayout: vi.fn() },
}));

function node(over: Partial<Node> = {}): Node {
  return {
    id: "p1", name: "orders", description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "container", container_name: null,
    version: 1, created_at: "2026-10-30T10:00:00Z", updated_at: "", sites: [],
    ...over,
  };
}

// Место создания: родитель (null — верхний уровень) и его вложенные объекты.
function place(parent: Node | null, siblings: Node[] = []) {
  if (parent) vi.mocked(nodesApi.get).mockResolvedValue(parent);
  vi.mocked(nodesApi.list).mockResolvedValue(siblings);
  vi.mocked(nodesApi.getChildren).mockResolvedValue(siblings);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodesApi.create).mockImplementation(async (data) => node({ id: "c1", name: data.name, parent_id: data.parent_id ?? null }));
});

const nameField = () => document.querySelector<HTMLInputElement>("dialog input")!;
const typeField = () => document.querySelector<HTMLButtonElement>("dialog .ts-trigger");
const createBtn = () => screen.getByText("Создать").closest("button")!;
const options = () => [...document.querySelectorAll<HTMLButtonElement>("dialog .ts-option")];
const option = (label: string) => options().find((b) => b.querySelector(".ts-label")?.textContent === label)!;

async function ready() {
  await waitFor(() => expect(typeField()).not.toBeNull());
}
function pick(label: string) {
  fireEvent.click(typeField()!);
  fireEvent.click(option(label));
}
function save(name: string) {
  fireEvent.change(nameField(), { target: { value: name } });
  fireEvent.click(createBtn());
}
const body = () => vi.mocked(nodesApi.create).mock.calls[0][0];

describe("NodeModal — поле «Тип» по месту создания", () => {
  it("верхний уровень: без предвыбора «Создать» неактивна, компонент серый с причиной", async () => {
    place(null);
    render(<NodeModal parentId={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(nodesApi.list).toHaveBeenCalledWith(null);
    expect(typeField()!.textContent).toContain("Выберите тип");
    expect(createBtn()).toBeDisabled();

    fireEvent.click(typeField()!);
    expect(options().map((b) => b.querySelector(".ts-label")!.textContent)).toEqual([
      "Система", "Контейнер", "Компонент", "База данных", "Брокер", "Пользователь",
    ]);
    const component = option("Компонент");
    expect(component).toHaveAttribute("aria-disabled", "true");
    expect(component.textContent).toContain("Компонентом объект бывает только внутри контейнера.");
    // Серый пункт не выбирается: меню остаётся открытым, тип не выбран.
    fireEvent.click(component);
    expect(typeField()!.textContent).toContain("Выберите тип");
    expect(createBtn()).toBeDisabled();

    fireEvent.click(option("Система"));
    expect(typeField()!.textContent).toContain("Система");
    save("Ярмарка");
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ name: "Ярмарка", shape: "service", element: "system", parent_id: null });
    expect(body()).not.toHaveProperty("parent_element");
  });

  it("система с вложенными: контейнер пишется элементом, родитель не трогается", async () => {
    const system = node({ id: "s1", name: "Ярмарка", element_effective: "system", has_children: true, child_count: 1 });
    place(system, [node({ id: "k1", element_effective: "container", parent_id: "s1" })]);
    render(<NodeModal parentId="s1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(nodesApi.get).toHaveBeenCalledWith("s1");
    expect(nodesApi.getChildren).toHaveBeenCalledWith("s1");
    // Предвыбор — тип последнего созданного соседа.
    expect(typeField()!.textContent).toContain("Контейнер");
    fireEvent.click(typeField()!);
    expect(option("Компонент").textContent).toContain("сделайте «Ярмарка» контейнером в его свойствах");
    fireEvent.click(typeField()!);
    save("orders");
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ shape: "service", element: "container", parent_id: "s1" });
    expect(body()).not.toHaveProperty("parent_element");
  });

  it("контейнер: предвыбран «Компонент», элемент не шлётся, база серая", async () => {
    const container = node({ id: "k1", element: "container", has_children: true, child_count: 1 });
    place(container, [node({ id: "a1", element_effective: "component", parent_id: "k1" })]);
    render(<NodeModal parentId="k1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(typeField()!.textContent).toContain("Компонент");
    fireEvent.click(typeField()!);
    expect(option("База данных")).toHaveAttribute("aria-disabled", "true");
    expect(option("База данных").textContent).toContain("создайте её рядом с «orders»");
    fireEvent.click(typeField()!);
    save("api");
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ shape: "service", parent_id: "k1" });
    expect(body()).not.toHaveProperty("element");
    expect(body()).not.toHaveProperty("parent_element");
  });

  it("лист без элемента: компонент делает его контейнером — одним запросом (Р38)", async () => {
    place(node({ id: "l1", name: "billing" }));
    render(<NodeModal parentId="l1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(createBtn()).toBeDisabled();
    pick("Компонент");
    expect(screen.getByText("«billing» станет контейнером.")).toBeInTheDocument();
    save("worker");
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ shape: "service", parent_id: "l1", parent_element: "container" });
    expect(body()).not.toHaveProperty("element");
  });

  it("лист без элемента: любой другой тип делает его системой", async () => {
    place(node({ id: "l1", name: "billing" }));
    render(<NodeModal parentId="l1" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    pick("База данных");
    expect(screen.getByText("«billing» станет системой.")).toBeInTheDocument();
    save("billing-db");
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ shape: "database", parent_id: "l1", parent_element: "system" });
  });
});

describe("NodeModal — предвыбор", () => {
  it("шаблон из палитры предвыбран, если возможен здесь", async () => {
    place(null);
    render(<NodeModal parentId={null} type="broker" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(typeField()!.textContent).toContain("Брокер");
    save("events");
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ shape: "broker" });
    expect(body()).not.toHaveProperty("element");
  });

  it("невозможный здесь шаблон не предвыбирается — работают правила места", async () => {
    place(null);
    render(<NodeModal parentId={null} type="component" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(typeField()!.textContent).toContain("Выберите тип");
    expect(createBtn()).toBeDisabled();
  });

  it("сосед: тип последнего созданного, выбор человека его перекрывает", async () => {
    place(null, [
      node({ id: "a", shape: "database", created_at: "2026-10-30T09:00:00Z" }),
      node({ id: "b", shape: "person", element_effective: null, created_at: "2026-10-30T11:00:00Z" }),
    ]);
    render(<NodeModal parentId={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(typeField()!.textContent).toContain("Пользователь");
    pick("Контейнер");
    save("gateway");
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ shape: "service", element: "container" });
  });
});

describe("NodeModal — поля и отказы", () => {
  it("«Пользователь»: без технологии и признака «Внешний»", async () => {
    place(null);
    render(<NodeModal parentId={null} type="person" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    expect(screen.queryByText("Технология")).toBeNull();
    expect(screen.queryByText("Внешний")).toBeNull();
    pick("Система");
    expect(screen.getByText("Технология")).toBeInTheDocument();
    expect(screen.getByText("Внешний")).toBeInTheDocument();
  });

  it("сбой загрузки родителя — причина в окне, «Повторить» загружает снова", async () => {
    vi.mocked(nodesApi.get).mockRejectedValueOnce(new ApiError(404, "Узел не найден"));
    vi.mocked(nodesApi.getChildren).mockResolvedValue([]);
    render(<NodeModal parentId="gone" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText("Не удалось узнать, какие типы возможны здесь.")).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();

    vi.mocked(nodesApi.get).mockResolvedValueOnce(node({ id: "gone", element: "container", has_children: true }));
    fireEvent.click(screen.getByText("Повторить"));
    await ready();
    expect(typeField()!.textContent).toContain("Компонент");
  });

  it("Enter в поле «Название» создаёт объект, как кнопка", async () => {
    place(null);
    const onSaved = vi.fn();
    render(<NodeModal parentId={null} type="database" onClose={vi.fn()} onSaved={onSaved} />);
    await ready();
    fireEvent.change(nameField(), { target: { value: "Склад" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(nodesApi.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Склад", shape: "database" }));
  });

  it("Enter при пустом названии — подсказка, запроса нет", async () => {
    place(null);
    render(<NodeModal parentId={null} type="database" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(screen.getByText("Название обязательно")).toBeInTheDocument();
    expect(nodesApi.create).not.toHaveBeenCalled();
  });

  it("Enter без типа — подсказка, запроса нет", async () => {
    place(null);
    render(<NodeModal parentId={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    fireEvent.change(nameField(), { target: { value: "Склад" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(screen.getByText("Выберите тип объекта")).toBeInTheDocument();
    expect(nodesApi.create).not.toHaveBeenCalled();
  });
});
