// Живая плашка «Обращения» в редакторе схемы логики. Пометка «читает:/пишет:» в
// тексте — единственный ввод обращений к данным (пивот §9 plan-db-docs.md), и
// плашка — единственное место, где видно, поймалась ли она. Проверяем ровно это:
// найденную цель, названную причину промаха, молчание на доках без пометок (там и
// сеть не трогается) и отсутствие плашки у наблюдателя.
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import FlowchartDoc from "../inspector/FlowchartDoc";
import { dataRefsApi } from "../../api/dataRefs";
import type { DataRefPreviewItem } from "../../types";

vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn() } }));
// Mermaid тяжёлый и грузится ленивым чанком — для плашки он безразличен.
vi.mock("../MermaidRenderer", () => ({ default: () => <div data-testid="mmd" /> }));

const item = (over: Partial<DataRefPreviewItem> = {}): DataRefPreviewItem => ({
  ref: "orders.status",
  mode: "read",
  status: "ok",
  target: "Хранилище · orders.status",
  ...over,
});

const CHART_REF = 'graph TD\n  A["Проверить заказ<br>читает: orders.status"]';
const CHART_PLAIN = "graph TD\n  A[Проверить заказ] --> B[Готово]";

function renderDoc(initial: string, isArchitect = true) {
  render(
    <FlowchartDoc initial={initial} isArchitect={isArchitect} showCode onCommit={vi.fn()} />,
  );
}

// Переждать дебаунс (600 мс) вместе с ответом мока.
const пережить_дебаунс = () => act(async () => { await vi.advanceTimersByTimeAsync(700); });

describe("FlowchartDoc: плашка обращений", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => vi.useRealTimers());

  it("пометка «читает: …» — плашка называет найденную цель", async () => {
    vi.mocked(dataRefsApi.preview).mockResolvedValue([item()]);
    renderDoc(CHART_REF);

    // До паузы в наборе сеть не трогаем — иначе запрос на каждый символ.
    expect(dataRefsApi.preview).not.toHaveBeenCalled();
    await пережить_дебаунс();

    await waitFor(() => expect(screen.getByText("Обращения")).toBeInTheDocument());
    expect(screen.getByText("читает")).toBeInTheDocument();
    expect(screen.getByText("orders.status")).toBeInTheDocument();
    expect(screen.getByText(/→ Хранилище · orders\.status ✓/)).toBeInTheDocument();
    // Разбирается ТЕКСТ редактора, в том числе ещё не сохранённый.
    expect(vi.mocked(dataRefsApi.preview).mock.calls[0][0]).toContain("читает: orders.status");
  });

  it("битая пометка: плашка называет причину — таблицы нет", async () => {
    vi.mocked(dataRefsApi.preview).mockResolvedValue([
      item({ ref: "ordrs.status", status: "unknown_table", target: null }),
    ]);
    renderDoc('graph TD\n  A["Проверить заказ<br>читает: ordrs.status"]');

    await пережить_дебаунс();

    await waitFor(() => expect(screen.getByText(/таблица не найдена/)).toBeInTheDocument());
    expect(screen.getByText("ordrs.status")).toBeInTheDocument();
  });

  it("«нет колонки» и «неоднозначно» — теми же словами, что в панели алертов", async () => {
    vi.mocked(dataRefsApi.preview).mockResolvedValue([
      item({ ref: "orders.stat", mode: "write", status: "unknown_column", target: "Хранилище · orders" }),
      item({ ref: "orders", status: "ambiguous", target: null }),
    ]);
    renderDoc(CHART_REF);

    await пережить_дебаунс();

    // У «нет колонки» таблица известна — её называем, иначе непонятно, с чем сверяться.
    await waitFor(() =>
      expect(screen.getByText(/колонки нет в таблице \(Хранилище · orders\)/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/имя неоднозначно — укажите „БД \/ таблица“/)).toBeInTheDocument();
    expect(screen.getByText("пишет")).toBeInTheDocument();
  });

  it("док без пометок: плашки нет и сеть не трогается вовсе", async () => {
    vi.mocked(dataRefsApi.preview).mockResolvedValue([item()]);
    renderDoc(CHART_PLAIN);

    await пережить_дебаунс();

    expect(dataRefsApi.preview).not.toHaveBeenCalled();
    expect(screen.queryByText("Обращения")).toBeNull();
  });

  it("наблюдателю плашки нет — пометки он читает в самой диаграмме", async () => {
    vi.mocked(dataRefsApi.preview).mockResolvedValue([item()]);
    renderDoc(CHART_REF, false);

    await пережить_дебаунс();

    expect(screen.queryByText("Обращения")).toBeNull();
    expect(dataRefsApi.preview).not.toHaveBeenCalled();
  });
});
