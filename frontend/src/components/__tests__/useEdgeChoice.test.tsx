// Окно «Выберите связь» (useEdgeChoice → EdgeChoiceModal): связи пучка с одинаковой
// подписью различаются настоящими концами (edge.md E57, 2026-11-02). Шапка называет общую
// пару по отображаемым концам стрелки, строка — свой настоящий конец там, где связи
// расходятся. Кнопка «+ Добавить связь» отдаёт хозяину эти же концы: новая связь ведёт к
// показанной паре, а не к концам первой связи пучка.
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { useEdgeChoice } from "../graph/interaction/useEdgeChoice";
import type { LevelEdge } from "../../types";
import type { EdgeChoiceEnds } from "../graph/types";

// Нативный <dialog> в jsdom не открывается — прозрачная обёртка (паттерн NodePage.test).
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="modal">{children}</div>,
}));

const NAMES: Record<string, string> = {
  user: "Пользователь", orders: "Заказы", cat: "Каталог", cart: "Корзина", pay: "Оплата",
};

function le(id: string, source: string, target: string, label: string, technology: string | null = null): LevelEdge {
  return {
    id, label, technology, source_id: source, target_id: target, version: 1, created_at: "",
    original_source_id: source, original_target_id: target,
    original_source_name: NAMES[source], original_target_name: NAMES[target],
  } as LevelEdge;
}

function setup(edges: LevelEdge[], onAddFromChoice?: (rep: LevelEdge, ends?: EdgeChoiceEnds) => void) {
  const onPick = vi.fn();
  const hook = renderHook(() => useEdgeChoice({
    resolveEdge: (id) => edges.find((e) => e.id === id) ?? null,
    labelOf: (id) => NAMES[id] ?? id,
    onPick,
    onAddFromChoice,
  }));
  return { hook, onPick };
}

describe("окно выбора связи: строки различимы по концам", () => {
  const bus = [
    le("u1", "user", "cat", "пользуется"),
    le("u2", "user", "cart", "пользуется"),
    le("p", "user", "pay", "платит", "HTTPS"),
  ];

  it("пучок в свёрнутую систему: шапка «Пользователь → Заказы», у строки свой настоящий конец", async () => {
    const { hook, onPick } = setup(bus);
    act(() => hook.result.current.onEdgesChoice(bus, { source: "user", target: "orders" }));
    render(<>{hook.result.current.choiceModal}</>);
    const modal = screen.getByTestId("modal");
    expect(within(modal).getByText("Пользователь → Заказы")).toBeInTheDocument();
    const rows = within(modal).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      "пользуется→ Каталог", "пользуется→ Корзина", "платит · HTTPS→ Оплата",
    ]);
    await userEvent.click(within(modal).getByRole("button", { name: "пользуется → Корзина" }));
    expect(onPick).toHaveBeenCalledWith(bus[1]);
  });

  it("концы стрелки не известны — шапка не выдаёт конец одной связи за общий", () => {
    const { hook } = setup(bus);
    act(() => hook.result.current.onEdgesChoice(bus));
    render(<>{hook.result.current.choiceModal}</>);
    const modal = screen.getByTestId("modal");
    expect(within(modal).getByText("Пользователь → несколько объектов")).toBeInTheDocument();
    expect(within(modal).queryByText("Пользователь → Каталог")).toBeNull();
  });

  it("расходятся оба конца — строка называет оба", () => {
    const mixed = [le("a", "user", "cat", "смотрит"), le("b", "cart", "pay", "смотрит")];
    const { hook } = setup(mixed);
    act(() => hook.result.current.onEdgesChoice(mixed, { source: null, target: null }));
    render(<>{hook.result.current.choiceModal}</>);
    const rows = within(screen.getByTestId("modal")).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(["смотритПользователь → Каталог", "смотритКорзина → Оплата"]);
  });

  it("общие концы — шапка их называет, вторых строчек нет", () => {
    const pair = [le("a", "user", "cat", "читает"), le("b", "user", "cat", "пишет")];
    const { hook } = setup(pair);
    act(() => hook.result.current.onEdgesChoice(pair, { source: "user", target: "cat" }));
    render(<>{hook.result.current.choiceModal}</>);
    const modal = screen.getByTestId("modal");
    expect(modal).toHaveTextContent("Пользователь → Каталог");
    expect(within(modal).getAllByRole("button").map((r) => r.textContent)).toEqual(["читает", "пишет"]);
  });

  it("одна связь — сразу выбрана, окна нет", () => {
    const { hook, onPick } = setup(bus);
    act(() => hook.result.current.onEdgesChoice([bus[0]], { source: "user", target: "orders" }));
    expect(onPick).toHaveBeenCalledWith(bus[0]);
    expect(hook.result.current.choiceModal).toBeNull();
  });
});

describe("окно выбора связи: «+ Добавить связь» (E97, 2026-11-02)", () => {
  const bus = [le("u1", "user", "cat", "пользуется"), le("u2", "user", "cart", "пользуется")];

  it("отдаёт первую связь пучка и концы стрелки, по которой открыто окно; окно закрывается", async () => {
    const onAdd = vi.fn();
    const { hook } = setup(bus, onAdd);
    const ends: EdgeChoiceEnds = {
      source: "user", target: "orders",
      connect: {
        source: { kind: "direct", id: "user", name: "Пользователь" },
        target: { kind: "into", id: "orders", name: "Заказы" },
      },
    };
    act(() => hook.result.current.onEdgesChoice(bus, ends));
    const { rerender } = render(<>{hook.result.current.choiceModal}</>);
    await userEvent.click(within(screen.getByTestId("modal")).getByRole("button", { name: "+ Добавить связь" }));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onAdd).toHaveBeenCalledWith(bus[0], ends);
    rerender(<>{hook.result.current.choiceModal}</>);
    expect(screen.queryByTestId("modal")).toBeNull();
  });

  it("концы не известны — отдаёт только первую связь", async () => {
    const onAdd = vi.fn();
    const { hook } = setup(bus, onAdd);
    act(() => hook.result.current.onEdgesChoice(bus));
    render(<>{hook.result.current.choiceModal}</>);
    await userEvent.click(within(screen.getByTestId("modal")).getByRole("button", { name: "+ Добавить связь" }));
    expect(onAdd.mock.calls).toEqual([[bus[0], undefined]]);
  });

  it("без хозяина дозаписи (просмотр) кнопки нет", () => {
    const { hook } = setup(bus);
    act(() => hook.result.current.onEdgesChoice(bus, { source: "user", target: "orders" }));
    render(<>{hook.result.current.choiceModal}</>);
    expect(within(screen.getByTestId("modal")).queryByRole("button", { name: "+ Добавить связь" })).toBeNull();
  });
});
