// Шина тура (docs/tasks/demo-tour.md) из окна «Новый объект»: созданный объект
// уходит событием «node-created» с именем, формой и родителем; отказ — без события.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import NodeModal from "../NodeModal";
import { nodesApi } from "../../api/nodes";
import { onTourEvent, type TourBusEvent } from "../tour/tourBus";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: { create: vi.fn() },
  viewsApi: { saveLayout: vi.fn() },
}));

const events: TourBusEvent[] = [];
let off: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  off = onTourEvent((e) => { events.push(e); });
});
afterEach(() => off());

// Поле «Название» — первое в окне (jsdom не открывает <dialog>, роли внутри скрыты).
function fillAndSave(name: string) {
  fireEvent.change(document.querySelector("dialog input")!, { target: { value: name } });
  fireEvent.click(screen.getByText("Создать"));
}

describe("NodeModal — событие тура", () => {
  it("создан объект — «node-created»", async () => {
    vi.mocked(nodesApi.create).mockResolvedValue({ id: "c1", name: "Касса", shape: "service", parent_id: "s1" } as Node);
    const onSaved = vi.fn();
    render(<NodeModal parentId="s1" shape="service" onClose={vi.fn()} onSaved={onSaved} />);
    fillAndSave("Касса");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(events).toEqual([{ type: "node-created", id: "c1", name: "Касса", shape: "service", parentId: "s1" }]);
  });

  it("сервер отказал — события нет", async () => {
    vi.mocked(nodesApi.create).mockRejectedValue(new Error("нет"));
    render(<NodeModal parentId={null} shape="person" onClose={vi.fn()} onSaved={vi.fn()} />);
    fillAndSave("Банк");
    expect(await screen.findByText("нет")).toBeInTheDocument();
    expect(events).toEqual([]);
  });
});
