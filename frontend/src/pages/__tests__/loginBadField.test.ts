// Поле пароля после отказа входа (редизайн, фаза 13в): в фокусе рамка и кольцо одного
// цвета, цвета опасности, а не красная рамка в кольце акцента. jsdom стилей не считает:
// правила читаем текстом.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "LoginPage.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
// Все объявления правил, где селектор (в списке через запятую) совпадает с заданным.
function decls(selector: string): string {
  return css.split("}")
    .map((chunk) => chunk.split("{"))
    .filter(([sel]) => sel.split(",").some((one) => one.trim() === selector))
    .map(([, body]) => body ?? "")
    .join(";");
}

describe("поле пароля в состоянии ошибки", () => {
  it("в фокусе рамка цветом опасности и кольцо тоном опасности, без акцента", () => {
    const focus = decls(".ds-input.login-input--bad:focus");
    expect(focus).toContain("border-color: var(--c-danger)");
    expect(focus).toMatch(/box-shadow: 0 0 0 3px [^;]*var\(--c-danger\)/);
    expect(focus).not.toContain("accent");
  });
});
