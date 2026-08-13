// Полноэкранный просмотр ER-диаграммы.
//
// Тест поставлен ровно на ту поломку, которой окно открывалось ПУСТЫМ: Modal кладёт
// контент во внутреннюю обёртку без высоты, поэтому сцена с `flex: 1` схлопывалась в
// ноль. Высоту задаёт собственный контейнер окна — это и проверяем, вместе с тем, что
// диаграмма вообще отрисована.
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ErDiagramModal from "../ErDiagramModal";

// Нативный <dialog> в jsdom не открывается — та же замена, что в тестах доков.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="modal">{children}</div>,
}));
vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <pre data-testid="chart">{chart}</pre>,
}));

describe("ErDiagramModal", () => {
  it("рисует диаграмму, а сцене задана высота, а не «сколько получится»", () => {
    const { container } = render(
      <ErDiagramModal chart={'erDiagram\n  "orders" {\n  }'} title="Структура: Хранилище" onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("chart").textContent).toContain('"orders"');
    expect(screen.getByText("Структура: Хранилище")).toBeInTheDocument();

    // Контейнер окна обязан нести собственную высоту: без неё сцена (flex:1) даёт
    // ноль, и окно открывается пустым.
    const sized = container.querySelector<HTMLElement>("[style*='height']");
    expect(sized?.style.height).toMatch(/calc\(100vh/);
    expect(sized?.style.flexDirection).toBe("column");
  });
});
