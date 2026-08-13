// Лимиты mermaid из mermaidLoader.initialize — на НАСТОЯЩЕМ парсере (тот же приём,
// что в dbErDiagram.test.ts): без него поднятые константы тихо вернутся к дефолтам.
//
// Проверяется maxEdges: из двух лимитов только он смотрится НА ПАРСЕ. maxTextSize
// библиотека смотрит в render — гонять рендер в jsdom ради константы значило бы
// завести хрупкий тест, поэтому его тут нет.
import { describe, expect, it } from "vitest";
import { validateMermaid } from "../mermaidLoader";

describe("лимиты mermaid", () => {
  it("диаграмма шире дефолтных 500 рёбер разбирается", async () => {
    // Дефолты библиотеки — защита от ЧУЖОГО ввода; у нас ввод собственный (схема БД
    // на 200 таблиц), и на нём защита срабатывает как отказ показать диаграмму.
    const edges = Array.from({ length: 600 }, (_, i) => `  n${i} --> n${i + 1}`);
    expect(await validateMermaid(["graph TD", ...edges].join("\n"))).toBeNull();
  });
});
