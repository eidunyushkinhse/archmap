// Легенда холста, раздел «Обозначения» (Ф8 эпика docs/plan-c4-elements.md, Р20/Р24):
// на холсте объектов — «Объект с другого уровня», «Рамка системы» (серый пунктир без
// заливки) и «Рамка контейнера» (тот же пунктир с заливкой цветом глубины); на холсте
// «Развёртывание» — прежние строки и «Система целиком на площадке» (пунктирная карточка).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import SchemaLegend from "../SchemaLegend";

async function open(variant?: "schema" | "deployment") {
  render(<SchemaLegend variant={variant} />);
  await userEvent.click(screen.getByRole("button", { name: /Легенда/ }));
}

// Подписи раздела «Обозначения» по порядку (подпись — последний span строки: у свотча
// «1/2» свой текст внутри svg).
const notations = () => {
  const title = screen.getByText("Обозначения");
  return [...(title.parentElement?.children ?? [])].slice(1).map((row) => row.lastElementChild?.textContent);
};
const swatchRect = (label: string) =>
  screen.getByText(label).previousElementSibling?.querySelector("rect");

describe("SchemaLegend", () => {
  it("холст объектов: рамки системы и контейнера вместо границы родительского слоя", async () => {
    await open();
    expect(notations()).toEqual(["Объект с другого уровня", "Рамка системы", "Рамка контейнера"]);
    expect(screen.queryByText("Граница родительского слоя")).toBeNull();
    // Обе рамки — пунктир; заливка только у контейнера (цвет глубины 0, плотнее, чем на холсте).
    expect(swatchRect("Рамка системы")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(swatchRect("Рамка системы")?.getAttribute("fill")).toBe("transparent");
    expect(swatchRect("Рамка контейнера")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(swatchRect("Рамка контейнера")?.getAttribute("fill")).toBe("rgba(17,104,189,0.15)");
  });

  it("холст «Развёртывание»: прежние строки и система целиком на площадке", async () => {
    await open("deployment");
    expect(notations()).toEqual([
      "Площадка", "Свёрнутая площадка", "Размещение не указано",
      "Система целиком на площадке", "Объект на нескольких площадках",
    ]);
    expect(swatchRect("Система целиком на площадке")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(screen.queryByText("Рамка контейнера")).toBeNull();
  });
});
