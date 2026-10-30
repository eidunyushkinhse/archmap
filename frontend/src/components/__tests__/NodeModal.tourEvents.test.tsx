// Шина тура (docs/tasks/demo-tour.md) из окна «Новый объект»: созданный объект
// уходит событием «node-created» с именем, формой и родителем; отказ — без события.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import NodeModal from "../NodeModal";
import { nodesApi } from "../../api/nodes";
import { onTourEvent, type TourBusEvent } from "../tour/tourBus";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { create: vi.fn(), get: vi.fn(), list: vi.fn(), getChildren: vi.fn() },
  viewsApi: { saveLayout: vi.fn() },
}));

// Родитель окна — пустая система тура («Моя система», Р39): вкладывать в неё можно всё,
// кроме компонента.
const system = {
  id: "s1", name: "Моя система", shape: "service", element: "system", element_effective: "system",
  has_children: false, container_name: null,
} as Node;

const events: TourBusEvent[] = [];
let off: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodesApi.get).mockResolvedValue(system);
  vi.mocked(nodesApi.getChildren).mockResolvedValue([]);
  vi.mocked(nodesApi.list).mockResolvedValue([]);
  events.length = 0;
  off = onTourEvent((e) => { events.push(e); });
});
afterEach(() => off());

// Поле «Название» — первое в окне (jsdom не открывает <dialog>, роли внутри скрыты).
// Варианты поля «Тип» окно загружает само — сначала дождаться поля.
async function fillAndSave(name: string) {
  await waitFor(() => expect(document.querySelector("dialog .ts-trigger")).not.toBeNull());
  fireEvent.change(document.querySelector("dialog input")!, { target: { value: name } });
  fireEvent.click(screen.getByText("Создать"));
}

describe("NodeModal — событие тура", () => {
  it("создан объект — «node-created»", async () => {
    vi.mocked(nodesApi.create).mockResolvedValue({ id: "c1", name: "Касса", shape: "service", parent_id: "s1" } as Node);
    const onSaved = vi.fn();
    render(<NodeModal parentId="s1" type="container" onClose={vi.fn()} onSaved={onSaved} />);
    await fillAndSave("Касса");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(events).toEqual([{ type: "node-created", id: "c1", name: "Касса", shape: "service", parentId: "s1" }]);
  });

  it("сервер отказал — события нет", async () => {
    vi.mocked(nodesApi.create).mockRejectedValue(new Error("нет"));
    render(<NodeModal parentId={null} type="person" onClose={vi.fn()} onSaved={vi.fn()} />);
    await fillAndSave("Банк");
    expect(await screen.findByText("нет")).toBeInTheDocument();
    expect(events).toEqual([]);
  });
});
