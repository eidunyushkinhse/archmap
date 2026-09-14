// Превью шаблона в витрине создания проекта: два вида шаблонов — каркас с
// запечёнными координатами и ПАКЕТНЫЙ демо-шаблон без координат вовсе
// (docs/plan-demo-template.md, решение Р3).
//
// Что закрепляем: каркас рисуется по своим x/y и движок не зовёт вообще, а
// шаблон без координат просит ту же раскладку, что и холст (resolvePointsElk),
// и рисует узлы по её ответу. Иначе обещание «превью = будущая раскладка
// проекта» держалось бы только для каркасов, а демо показывало бы пустую рамку.
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import C4Preview from "../project/C4Preview";
import { resolvePointsElk } from "../project/schemaPreviewLayout";
import type { TemplateOut } from "../../types";

vi.mock("../project/schemaPreviewLayout", () => ({
  resolvePointsElk: vi.fn(),
}));

const шаблон = (
  координаты: { x: number | null; y: number | null }[],
): TemplateOut => ({
  id: координаты[0].x === null ? "demo-marketplace" : "webapp",
  name: "Шаблон",
  tagline: "строка",
  blurb: "абзац",
  techs: ["Python"],
  nodes: [
    { key: "n0", name: "Ярмарка", shape: "service", role: "система", technology: null,
      is_external: false, x: координаты[0].x, y: координаты[0].y },
    { key: "n1", name: "Покупатель", shape: "person", role: null, technology: null,
      is_external: true, x: координаты[1].x, y: координаты[1].y },
  ],
  edges: [{ source: "n1", target: "n0", label: "пользуется", technology: "HTTPS" }],
});

beforeEach(() => {
  vi.mocked(resolvePointsElk).mockReset();
});

describe("превью шаблона", () => {
  it("каркас рисуется по запечённым координатам, движок не нужен", () => {
    render(<C4Preview template={шаблон([{ x: 30, y: 190 }, { x: 340, y: 190 }])} width={600} height={280} />);
    expect(screen.getByText("Ярмарка")).toBeInTheDocument();
    expect(screen.getByText("Покупатель")).toBeInTheDocument();
    expect(resolvePointsElk).not.toHaveBeenCalled();
  });

  it("пакетный шаблон без координат раскладывает тем же ELK, что и холст", async () => {
    vi.mocked(resolvePointsElk).mockResolvedValue([{ x: 0, y: 0 }, { x: 310, y: 0 }]);
    render(<C4Preview template={шаблон([{ x: null, y: null }, { x: null, y: null }])} width={600} height={280} />);

    await waitFor(() => expect(screen.getByText("Ярмарка")).toBeInTheDocument());
    expect(screen.getByText("Покупатель")).toBeInTheDocument();
    // Движок получает ключи узлов и связи превью — без координат (их и нет).
    expect(resolvePointsElk).toHaveBeenCalledWith(
      [
        { id: "n0", is_external: false, x: null, y: null },
        { id: "n1", is_external: true, x: null, y: null },
      ],
      [{ source: "n1", target: "n0" }],
    );
  });
});
