// Окно «Новый объект»: что уходит на сервер. Тело POST /nodes сверяется строкой JSON —
// байт в байт, вместе с порядком ключей: вид окна (подписи, поля, выбор статуса и
// принадлежности) меняется, а запрос нет. Бросок шаблона на уровень кладёт позицию в само
// создание, бросок в раскрытую рамку — отдельным сохранением раскладки в вид текущего
// уровня (posView), после создания.
//
// Страховочные тесты фазы 9б редизайна: зелёные на прежнем виде окна (флажок «Внешний» и
// три кнопки статуса) и на новом (выпадающие значения «Принадлежность» и «Статус»). Как
// выбрать «Внешний» и статус, знают помощники ниже; ожидания от вида окна не зависят.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeModal from "../NodeModal";
import { nodesApi, viewsApi } from "../../api/nodes";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { create: vi.fn(), get: vi.fn(), list: vi.fn(), getChildren: vi.fn() },
  viewsApi: { saveLayout: vi.fn() },
}));

const saved = (over: Partial<Node> = {}) => ({ id: "c1", name: "x", shape: "service", element: null, parent_id: null, ...over }) as Node;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodesApi.list).mockResolvedValue([]);
  vi.mocked(nodesApi.getChildren).mockResolvedValue([]);
  vi.mocked(nodesApi.create).mockImplementation(async (data) => saved({ name: data.name, parent_id: data.parent_id ?? null }));
  vi.mocked(viewsApi.saveLayout).mockResolvedValue(undefined as never);
});

const dialog = () => document.querySelector("dialog")!;
const typeField = () => dialog().querySelector<HTMLButtonElement>(".ts-trigger");
const nameField = () => dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-autofocus]")!;
const descField = () => dialog().querySelector<HTMLTextAreaElement>("textarea")!;
const byPlaceholder = (text: string) => screen.getByPlaceholderText(text);
const createBtn = () => screen.getByText("Создать").closest("button")!;
const body = () => vi.mocked(nodesApi.create).mock.calls[0][0];

async function ready() {
  await waitFor(() => expect(typeField()).not.toBeNull());
}
function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}
function pickType(label: string) {
  fireEvent.click(typeField()!);
  const option = [...dialog().querySelectorAll<HTMLButtonElement>(".ts-option")]
    .find((b) => b.querySelector(".ts-label")?.textContent === label)!;
  fireEvent.click(option);
}
// Принадлежность «Внешний» и статус — выбор в окне (вид окна решает, как именно): пункт
// меню выпадающего значения.
function pickFromMenu(current: string, label: string) {
  fireEvent.click(screen.getByText(current).closest("button")!);
  const item = [...dialog().querySelectorAll<HTMLButtonElement>(".np-menu button")].find((b) => b.textContent === label)!;
  fireEvent.click(item);
}
function setExternal() {
  pickFromMenu("Внутренний", "Внешний");
}
function setStatus(label: string) {
  pickFromMenu("Существует", label);
}

describe("NodeModal — тело POST /nodes", () => {
  it("по умолчанию: название без пробелов по краям, пустые поля null, внутренний, существующий", async () => {
    render(<NodeModal parentId={null} type="container" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    type(nameField(), "  Склад  ");
    fireEvent.click(createBtn());
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(JSON.stringify(body())).toBe(
      '{"name":"Склад","description":null,"role":null,"technology":null,"parent_id":null,'
      + '"is_external":false,"shape":"service","status":"existing","element":"container","pos_x":null,"pos_y":null}',
    );
    expect(viewsApi.saveLayout).not.toHaveBeenCalled();
  });

  it("внешний объект со статусом «Проектируется» и всеми полями", async () => {
    render(<NodeModal parentId={null} type="system" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    type(nameField(), "Платёжный шлюз");
    type(descField(), "Приём оплаты");
    type(byPlaceholder("например, API или шлюз"), "шлюз");
    type(byPlaceholder("например, Python"), "REST");
    setExternal();
    setStatus("Проектируется");
    fireEvent.click(createBtn());
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(JSON.stringify(body())).toBe(
      '{"name":"Платёжный шлюз","description":"Приём оплаты","role":"шлюз","technology":"REST","parent_id":null,'
      + '"is_external":true,"shape":"service","status":"planned","element":"system","pos_x":null,"pos_y":null}',
    );
  });

  it("«Пользователь»: технология и внешность, заданные до смены типа, не уходят", async () => {
    render(<NodeModal parentId={null} type="system" onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    type(nameField(), "Покупатель");
    type(byPlaceholder("например, Python"), "Python");
    setExternal();
    setStatus("Выводится");
    pickType("Пользователь");
    fireEvent.click(createBtn());
    await waitFor(() => expect(nodesApi.create).toHaveBeenCalledOnce());
    expect(JSON.stringify(body())).toBe(
      '{"name":"Покупатель","description":null,"role":null,"technology":null,"parent_id":null,'
      + '"is_external":false,"shape":"person","status":"deprecated","pos_x":null,"pos_y":null}',
    );
  });
});

describe("NodeModal — позиция броска шаблона", () => {
  it("бросок на уровень: позиция уходит в создание, раскладка отдельно не пишется", async () => {
    const onSaved = vi.fn();
    render(<NodeModal parentId={null} type="database" initialPos={{ x: 120, y: 340 }} onClose={vi.fn()} onSaved={onSaved} />);
    await ready();
    type(nameField(), "Склад");
    fireEvent.click(createBtn());
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ parent_id: null, shape: "database", pos_x: 120, pos_y: 340 });
    expect(viewsApi.saveLayout).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }), true);
  });

  it("бросок в раскрытую рамку: создание без позиции, позиция — в вид текущего уровня после создания", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue(saved({ id: "k1", element: "container", has_children: true } as Partial<Node>));
    const order: string[] = [];
    vi.mocked(nodesApi.create).mockImplementation(async (data) => { order.push("create"); return saved({ name: data.name, parent_id: "k1" }); });
    vi.mocked(viewsApi.saveLayout).mockImplementation(async () => { order.push("layout"); return undefined as never; });
    const onSaved = vi.fn();
    render(<NodeModal parentId="k1" type="component" initialPos={{ x: 40, y: 60 }} posView="s1" onClose={vi.fn()} onSaved={onSaved} />);
    await ready();
    type(nameField(), "api");
    fireEvent.click(createBtn());
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(body()).toMatchObject({ parent_id: "k1", pos_x: null, pos_y: null });
    expect(viewsApi.saveLayout).toHaveBeenCalledWith("s1", { c1: { x: 40, y: 60 } });
    expect(order).toEqual(["create", "layout"]);
  });

  it("бросок в рамку на верхнем уровне: вид текущего уровня — null", async () => {
    vi.mocked(nodesApi.get).mockResolvedValue(saved({ id: "s1", element: "system", has_children: true } as Partial<Node>));
    render(<NodeModal parentId="s1" type="container" initialPos={{ x: 5, y: 7 }} posView={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    await ready();
    type(nameField(), "billing");
    fireEvent.click(createBtn());
    await waitFor(() => expect(viewsApi.saveLayout).toHaveBeenCalledOnce());
    expect(viewsApi.saveLayout).toHaveBeenCalledWith(null, { c1: { x: 5, y: 7 } });
    expect(body()).toMatchObject({ parent_id: "s1", pos_x: null, pos_y: null });
  });
});
