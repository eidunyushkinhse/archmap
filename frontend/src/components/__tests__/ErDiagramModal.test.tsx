// Полноэкранный просмотр ER-диаграммы.
//
// Тест поставлен ровно на ту поломку, которой окно открывалось ПУСТЫМ: Modal кладёт
// контент во внутреннюю обёртку без высоты, поэтому сцена с `flex: 1` схлопывалась в
// ноль. Высоту задаёт собственный корень окна — это и проверяем, вместе с тем, что
// диаграмма вообще отрисована.
//
// С фазы 9е редизайна высота и рост сцены заданы правилами docWindows.css (окно на каркасе
// ds-win), а не инлайн-стилем. jsdom раскладку и стили не считает, поэтому стережём то, что
// её определяет: правила читаются с диска, и их селекторы совпадают с разметкой окна.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(HERE, "..", ...parts), "utf8");

interface Rule { selector: string; decls: Record<string, string> }

/** Плоский разбор CSS без @-блоков: достаточно для правил окна. */
function rules(css: string): Rule[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .map((chunk) => chunk.split("{"))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([selector, body]) => ({
      selector: selector.trim(),
      decls: Object.fromEntries(
        body.split(";")
          .map((d) => d.split(":"))
          .filter((kv) => kv.length >= 2)
          .map(([k, ...v]) => [k.trim(), v.join(":").trim()]),
      ),
    }));
}
const classCount = (selector: string): number => (selector.match(/\.[\w-]+/g) ?? []).length;

describe("ErDiagramModal", () => {
  it("рисует диаграмму, а сцене задана высота, а не «сколько получится»", () => {
    const { container } = render(
      <ErDiagramModal chart={'erDiagram\n  "orders" {\n  }'} title="Структура: Хранилище" onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("chart").textContent).toContain('"orders"');
    expect(screen.getByText("Структура: Хранилище")).toBeInTheDocument();

    // Корень окна обязан нести собственную высоту и раскладку колонкой: без них сцена
    // (flex: 1) даёт ноль, и окно открывается пустым.
    const own = rules(read("docWindows.css"));
    const win = own.find((r) => r.selector === ".ds-win.dw-er");
    expect(win?.decls.height).toMatch(/calc\(100vh/);
    const root = container.querySelector<HTMLElement>(".dw-er");
    expect(root?.matches(win!.selector)).toBe(true);
    const dsWin = rules(read("..", "ui", "ds.css")).find((r) => r.selector === ".ds-win");
    expect(dsWin?.decls.display).toBe("flex");
    expect(dsWin?.decls["flex-direction"]).toBe("column");

    // Сцена растёт на всё место под шапкой от заданной (нулевой) высоты, а её селектор
    // сильнее .doc-pv, с которым она делит flex: исход не зависит от порядка CSS.
    const stage = own.find((r) => r.selector.includes(".dw-er-stage"));
    expect(stage?.decls.height).toBe("0");
    expect(stage?.decls["min-height"]).toBe("0");
    expect(stage?.decls.flex?.split(/\s+/)).toEqual(["1", "1", "auto"]);
    const docPv = rules(read("inspector", "docOverlay.css")).find((r) => r.selector === ".doc-pv");
    expect(docPv?.decls.flex).toBe("1");
    expect(classCount(stage!.selector)).toBeGreaterThan(classCount(".doc-pv"));
    const el = container.querySelector<HTMLElement>(".dw-er-stage");
    expect(el?.matches(stage!.selector)).toBe(true);
    expect(el?.classList.contains("doc-pv")).toBe(true);
    expect(el?.parentElement).toBe(root);
  });
});
