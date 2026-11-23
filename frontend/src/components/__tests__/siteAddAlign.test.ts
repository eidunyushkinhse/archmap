// «+» дерева площадок (редизайн, фаза 13в): у правого края строки, в рост значков строк
// (ds-icon-btn, 28px), на одной вертикали с карандашом и корзиной на любой вложенности.
// Раньше значок стоял у шеврона своего уровня, и «+» разных уровней шли лесенкой. jsdom
// раскладку не считает: правила читаем текстом.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "deployment", "deployment.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
function rule(selector: string): string {
  const at = css.split("}").find((chunk) => chunk.split("{")[0].trim() === selector);
  return at?.split("{")[1] ?? "";
}

describe("«+» дерева площадок", () => {
  it("значок у правого края строки, поле справа как у строки, размер значка как у ds-icon-btn", () => {
    expect(rule(".site-add")).toContain("justify-content: flex-end");
    expect(rule(".site-add")).toContain("padding: 0 var(--space-1) 0 4px");
    expect(rule(".site-row")).toContain("padding: 0 var(--space-1) 0 4px");
    expect(rule(".site-add-glyph")).toContain("width: 28px");
    expect(rule(".site-add-glyph")).toContain("height: 28px");
  });
});
