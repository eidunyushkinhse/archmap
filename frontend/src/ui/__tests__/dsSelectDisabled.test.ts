// Запертый список выбора (редизайн, фаза 13в): одно правило примитива ds-select в ui/ds.css
// вместо прозрачности браузера и местного правила окна шага. jsdom стилей не считает:
// правила читаем текстом.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8");
// Тело правила с ровно таким селектором (без комментариев).
function rule(css: string, selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = clean.split("}").find((chunk) => chunk.split("{")[0].trim() === selector);
  return at?.split("{")[1] ?? "";
}

describe("запертый ds-select", () => {
  it("подложка и текст тише, курсор обычный, прозрачность 1, шеврон тише", () => {
    const ds = read("ui", "ds.css");
    const body = rule(ds, ".ds-select select:disabled");
    expect(body).toContain("background: var(--c-bg-subtle)");
    expect(body).toContain("color: var(--c-fg-faint)");
    expect(body).toContain("cursor: default");
    expect(body).toContain("opacity: 1");
    expect(rule(ds, ".ds-select:has(select:disabled) svg")).toContain("color: var(--c-fg-faint)");
  });

  it("местного правила списка типа связи в окне шага нет, правило запертого поля осталось", () => {
    const css = read("components", "processes", "processes.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/\.mc-sync select:disabled/);
    expect(rule(css, ".mc-field .ds-input:disabled")).toContain("background: var(--c-bg-subtle)");
  });
});
