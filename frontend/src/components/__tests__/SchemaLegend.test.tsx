// Легенда холста, раздел «Обозначения» (Ф8 эпика docs/plan-c4-elements.md, Р20/Р24):
// на холсте объектов — «Объект с другого уровня», «Рамка системы» (серый пунктир без
// заливки), «Рамка контейнера» (тот же пунктир с заливкой цветом глубины) и знаки в углу
// блока: дерево системы и сетка контейнера (у листа — без числа, N4в, приёмка Ф12
// 2026-10-31); на холсте «Развёртывание» — прежние строки и «Система целиком на площадке»
// (пунктирная карточка).
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
  it("типы объектов словами типов, без слова «Сервис» (Р35)", async () => {
    await open();
    const title = screen.getByText("Типы объектов");
    const labels = [...(title.parentElement?.children ?? [])].slice(1).map((row) => row.lastElementChild?.textContent);
    expect(labels).toEqual(["Система, контейнер, компонент", "База данных", "Брокер сообщений", "Пользователь"]);
  });

  it("холст объектов: рамки системы и контейнера вместо границы родительского слоя", async () => {
    await open();
    expect(notations()).toEqual([
      "Объект с другого уровня", "Рамка системы", "Рамка контейнера",
      "Система, рядом число вложенных объектов", "Контейнер, рядом число компонентов",
    ]);
    expect(screen.queryByText("Граница родительского слоя")).toBeNull();
    // знаки в углу — те же глифы, что на блоке: дерево (три кружка) и сетка (четыре квадратика)
    const tree = screen.getByText("Система, рядом число вложенных объектов").previousElementSibling;
    expect(tree?.querySelectorAll("circle")).toHaveLength(3);
    const grid = screen.getByText("Контейнер, рядом число компонентов").previousElementSibling;
    expect(grid?.querySelectorAll('rect[width="7"]')).toHaveLength(4);
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
