// Лимиты mermaid из mermaidLoader.initialize — на НАСТОЯЩЕМ парсере (тот же приём,
// что в dbErDiagram.test.ts): без него поднятые константы тихо вернутся к дефолтам.
//
// Проверяется maxEdges: из двух лимитов только он смотрится НА ПАРСЕ. maxTextSize
// библиотека смотрит в render — гонять рендер в jsdom ради константы значило бы
// завести хрупкий тест, поэтому его тут нет.
import { describe, expect, it } from "vitest";
import { loadMermaid, validateMermaid } from "../mermaidLoader";

describe("лимиты mermaid", () => {
  it("диаграмма шире дефолтных 500 рёбер разбирается", async () => {
    // Дефолты библиотеки — защита от ЧУЖОГО ввода; у нас ввод собственный (схема БД
    // на 200 таблиц), и на нём защита срабатывает как отказ показать диаграмму.
    const edges = Array.from({ length: 600 }, (_, i) => `  n${i} --> n${i + 1}`);
    expect(await validateMermaid(["graph TD", ...edges].join("\n"))).toBeNull();
  });

  it("раскладка ELK и перенос подписей 200 px заданы явно (дефолты 12.x: elk и 120)", async () => {
    // Сторож констант initialize: с 12.0 библиотека сузила перенос до 120 px — узлы
    // превращались в столбики по 5–7 строк; раскладку держим явной, чтобы вид схем не
    // зависел от смены дефолта в следующих версиях.
    const cfg = (await loadMermaid()).mermaidAPI.getConfig();
    expect(cfg.layout).toBe("elk");
    expect(cfg.flowchart?.wrappingWidth).toBe(200);
    expect(cfg.securityLevel).toBe("strict");
  });
});
