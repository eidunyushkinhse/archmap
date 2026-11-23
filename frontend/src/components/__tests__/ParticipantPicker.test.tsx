// Выбор участников процесса: глиф строки — тот же вид узла, что в дереве объектов
// (treeNesting). Пустая система (Р39) — глиф системы, хотя вложенных у неё нет.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ParticipantPicker from "../processes/ParticipantPicker";
import { nodesApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({ nodesApi: { getAll: vi.fn() } }));

function node(id: string, over: Partial<Node> = {}): Node {
  return {
    id, name: id, description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    element: null, element_effective: "container", container_name: null,
    version: 1, created_at: "", updated_at: "", sites: [], ...over,
  };
}

const nestingOf = (name: string) =>
  screen.getByText(name).parentElement?.querySelector(".nt-glyph")?.getAttribute("data-nesting");

describe("ParticipantPicker: глиф строки", () => {
  it("пустая система — глиф системы, лист — глиф листа, система с детьми — системы", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue([
      node("Склад", { element: "system", element_effective: "system" }),
      node("orders"),
      node("Торговля", { has_children: true, child_count: 1, element_effective: "system" }),
      node("api", { parent_id: "Торговля" }),
    ]);
    render(<ParticipantPicker added={new Set()} onAdd={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Склад")).toBeInTheDocument());
    expect(nestingOf("Склад")).toBe("system");
    expect(nestingOf("orders")).toBe("leaf");
    expect(nestingOf("Торговля")).toBe("system");
  });
});

// Механика выбора (страховочная сетка перевода на новый язык, фаза 13г): «Добавить» заперта
// без выбора, число выбранных в имени кнопки, пачка уходит в onAdd, уже добавленный не
// выбирается; поиск раскрывает путь к находке, промах не показывает строк; раскрытие ветки
// шевроном; загрузка, пустая схема и отказ — текстом.
describe("ParticipantPicker: выбор, поиск, состояния", () => {
  beforeEach(() => {
    vi.mocked(nodesApi.getAll).mockReset();
  });
  const tree = () => [
    node("orders", { name: "Сервис заказов" }),
    node("trade", { name: "Торговля", has_children: true, child_count: 1, element_effective: "system" }),
    node("api", { name: "Order API", parent_id: "trade" }),
    node("buyer", { name: "Покупатель", shape: "person" }),
  ];
  const rowOf = (name: string) => screen.getByText(name).parentElement as HTMLElement;
  const box = (name: string) => rowOf(name).querySelector("input[type=checkbox]") as HTMLInputElement;

  it("«Добавить» заперта без выбора; два флажка дают «Добавить (2)» и пачку в onAdd", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue(tree());
    const onAdd = vi.fn();
    render(<ParticipantPicker added={new Set(["buyer"])} onAdd={onAdd} />);
    await screen.findByText("Сервис заказов");
    expect(screen.getByRole("button", { name: "Добавить" })).toBeDisabled();
    await userEvent.click(box("Сервис заказов"));
    await userEvent.click(screen.getByText("Торговля"));
    const add = screen.getByRole("button", { name: "Добавить (2)" });
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith(["orders", "trade"]);
    expect(screen.getByRole("button", { name: "Добавить" })).toBeDisabled();
  });

  it("уже добавленный: флажок отмечен и заперт, «в процессе», щелчок по имени не выбирает", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue(tree());
    render(<ParticipantPicker added={new Set(["buyer"])} onAdd={vi.fn()} />);
    await screen.findByText("Покупатель");
    expect(box("Покупатель")).toBeChecked();
    expect(box("Покупатель")).toBeDisabled();
    expect(rowOf("Покупатель")).toHaveTextContent("в процессе");
    await userEvent.click(screen.getByText("Покупатель"));
    expect(screen.getByRole("button", { name: "Добавить" })).toBeDisabled();
  });

  it("шеврон раскрывает ветку; поиск раскрывает путь к находке, промах строк не показывает", async () => {
    vi.mocked(nodesApi.getAll).mockResolvedValue(tree());
    render(<ParticipantPicker added={new Set()} onAdd={vi.fn()} />);
    await screen.findByText("Торговля");
    expect(screen.queryByText("Order API")).toBeNull();
    await userEvent.click(rowOf("Торговля").firstElementChild as HTMLElement);
    expect(screen.getByText("Order API")).toBeInTheDocument();
    await userEvent.click(rowOf("Торговля").firstElementChild as HTMLElement);
    expect(screen.queryByText("Order API")).toBeNull();

    const search = screen.getByPlaceholderText("Поиск по имени");
    await userEvent.type(search, "order");
    expect(screen.getByText("Order API")).toBeInTheDocument();
    expect(screen.getByText("Торговля")).toBeInTheDocument();
    expect(screen.queryByText("Сервис заказов")).toBeNull();
    await userEvent.clear(search);
    await userEvent.type(search, "ыыы");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("загрузка, пустая схема и отказ загрузки — текстом", async () => {
    vi.mocked(nodesApi.getAll).mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<ParticipantPicker added={new Set()} onAdd={vi.fn()} />);
    expect(screen.getByText("Загрузка")).toBeInTheDocument();
    unmount();

    vi.mocked(nodesApi.getAll).mockResolvedValue([]);
    const second = render(<ParticipantPicker added={new Set()} onAdd={vi.fn()} />);
    expect(await screen.findByText("В схеме нет объектов")).toBeInTheDocument();
    second.unmount();

    vi.mocked(nodesApi.getAll).mockRejectedValue(new Error("Сервер не ответил"));
    render(<ParticipantPicker added={new Set()} onAdd={vi.fn()} />);
    expect(await screen.findByText("Не удалось загрузить объекты. Сервер не ответил")).toBeInTheDocument();
  });
});
