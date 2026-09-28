// Сторож бага Ф2г: «Открыть» у схемы логики показывал окно из шапки и подвала, а
// диаграммы не было. Причина — в CSS: сцена вьюера несёт и .doc-pv (flex: 1, то
// есть flex-basis 0%), и в колонке окна без заданной высоты такой basis брался от
// содержимого — абсолютной обёртки пан/зума, то есть от нуля. height сцены при
// этом игнорировалась, сцена схлопывалась в 0 (headless-замер: 860×0).
//
// jsdom раскладку не считает, поэтому стережём то, что её определяет: правило
// сцены задаёт высоту с flex-basis auto, а его селектор сильнее .doc-pv (исход не
// зависит от порядка подключения CSS) — и именно этот селектор совпадает с
// разметкой вьюера.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DocViewer from "../project/remainder/DocViewer";

// CSS читаем с диска: импорт «?raw» у стилей vitest отдаёт пустым (стили в
// тестах не обрабатываются). Путь — по частям, как у routerVersion.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const remainderCss = readFileSync(join(HERE, "..", "project", "remainder", "remainder.css"), "utf8");
const docOverlayCss = readFileSync(join(HERE, "..", "inspector", "docOverlay.css"), "utf8");

vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <div data-testid="mmd">{chart}</div>,
}));

interface Rule { selector: string; decls: Record<string, string> }

/** Плоский разбор CSS без @-блоков: достаточно для правил вьюера. */
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

describe("сцена вьюера схемы логики (баг Ф2г)", () => {
  const сцена = rules(remainderCss).filter((r) => r.selector.includes(".rq-ov-stage"));

  it("высота задана, flex-basis — auto, а не 0% от .doc-pv", () => {
    expect(сцена).toHaveLength(1);
    const { decls } = сцена[0]!;
    expect(decls.height).toBeTruthy();
    const basis = decls["flex-basis"] ?? decls.flex?.split(/\s+/)[2];
    expect(basis).toBe("auto");
  });

  it("селектор сцены сильнее .doc-pv, с которым она делит flex", () => {
    const docPv = rules(docOverlayCss).find((r) => r.selector === ".doc-pv");
    // Конфликт настоящий: общий класс превью доков растягивает flex: 1.
    expect(docPv?.decls.flex).toBe("1");
    expect(classCount(сцена[0]!.selector)).toBeGreaterThan(classCount(".doc-pv"));
  });

  it("селектор правила совпадает с разметкой вьюера", () => {
    render(
      <DocViewer
        title="Запрос метрических данных" source="Из архива plugin-a.zip" tag="mermaid · flowchart"
        body="flowchart TD" diagram onPick={vi.fn()} onClose={vi.fn()}
      />,
    );
    const stage = document.querySelector(".rq-ov-stage");
    expect(stage).not.toBeNull();
    expect(stage!.matches(сцена[0]!.selector)).toBe(true);
    expect(stage!.classList.contains("doc-pv")).toBe(true);
  });
});
