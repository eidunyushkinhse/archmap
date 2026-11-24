// Строки CI для токена «только сигнал CI» (находка 5, 2026-11-24): при отказе в журнал
// попадает ответ ArchMap, а не только «returned error: 401»; задание падает на коде 400 и
// выше; ключей -f и --fail-with-body нет (второго нет в curl старше 7.76). GitHub шлёт
// сигнал при push в основную ветку репозитория, как бы она ни называлась.
import { describe, expect, it } from "vitest";
import { CI_TABS, ciSnippet } from "../ciSignal";

const ORIGIN = "https://archmap.example.com";
const HEAD = `code=$(curl -sS -o /dev/stderr -w "%{http_code}" -X POST "${ORIGIN}/api/v1/code-changes"`;
const CHECK = '&& test "$code" -lt 400';

describe("строки CI", () => {
  it.each(CI_TABS.map((t) => t.id))("%s: ответ в журнал, код в переменную, без -f", (tab) => {
    const text = ciSnippet(tab, ORIGIN);
    expect(text).toContain(HEAD);
    expect(text.trimEnd().endsWith(CHECK)).toBe(true);
    expect(text).not.toMatch(/\s-f\w*\s|--fail/);
    // Секрет в строки не вписан: они ссылаются на переменную или секрет CI.
    expect(text).toContain("ARCHMAP_TOKEN");
  });

  it("GitLab: одна команда свёрнутым скаляром, задание необязательное, только основная ветка", () => {
    const lines = ciSnippet("gitlab", ORIGIN).split("\n");
    expect(lines).toContain("  allow_failure: true");
    expect(lines).toContain("    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH");
    const start = lines.indexOf("    - >");
    // Всё после «- >» — строки скаляра с одним отступом: YAML склеит их пробелом.
    expect(lines.slice(start + 1).every((l) => l.startsWith("      ") && !l.startsWith("       "))).toBe(true);
    expect(lines[start + 1]).toBe(`      ${HEAD}`);
    expect(lines.at(-1)).toBe(`      ${CHECK}`);
  });

  it("GitHub: push в основную ветку, как бы она ни называлась", () => {
    const text = ciSnippet("github", ORIGIN);
    const lines = text.split("\n");
    expect(lines[0]).toBe("on: push");
    expect(text).not.toContain("branches:");
    expect(text).not.toMatch(/\bmain\b/);
    expect(lines).toContain("    if: github.ref_name == github.event.repository.default_branch");
    expect(lines).toContain("    continue-on-error: true");
    expect(text).toContain("${{ secrets.ARCHMAP_TOKEN }}");
    expect(lines.at(-1)).toBe(`          ${CHECK}`);
  });

  it("curl: заполнители репозитория, коммита и ветки, ветка не main", () => {
    const text = ciSnippet("curl", ORIGIN);
    expect(text).toContain(`'{"repo":"<адрес репозитория>","commit":"<хэш коммита>","branch":"<ветка>"}')`);
    expect(text).not.toMatch(/\bmain\b/);
    expect(text.split("\n")[0]).toBe(`${HEAD} \\`);
  });
});
