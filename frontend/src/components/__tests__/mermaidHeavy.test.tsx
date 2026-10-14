// Тяжёлая схема не рисуется сама (аудит R-16): у читателя схема редактора на тысячи
// связей рендерилась на главном потоке минутами.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HEAVY_EDGES, isHeavyChart } from "../mermaidLoader";

const render_ = vi.hoisted(() => vi.fn(async () => ({ svg: "<svg data-testid='svg'></svg>" })));
vi.mock("../mermaidLoader", async () => {
  const real = await vi.importActual<typeof import("../mermaidLoader")>("../mermaidLoader");
  return { ...real, mermaidLoaded: () => true, loadMermaid: async () => ({ parse: async () => true, render: render_ }) };
});

import MermaidRenderer from "../MermaidRenderer";

const heavy = ["graph TD", ...Array.from({ length: HEAVY_EDGES + 1 }, (_, i) => `  n${i} --> n${i + 1}`)].join("\n");

describe("тяжёлая схема mermaid", () => {
  it("isHeavyChart: обычная схема — нет, тысячи связей — да", () => {
    expect(isHeavyChart("graph TD\n  A --> B\n  B --> C")).toBe(false);
    expect(isHeavyChart(heavy)).toBe(true);
  });

  it("выше порога — вопрос вместо рендера, «Показать всё равно» рисует", async () => {
    render(<MermaidRenderer chart={heavy} />);
    expect(screen.getByRole("status")).toHaveTextContent("Схема большая");
    expect(render_).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Показать всё равно" }));
    await waitFor(() => expect(render_).toHaveBeenCalledOnce());
  });
});
