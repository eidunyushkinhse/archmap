// Ручки правки на диаграмме процесса на токенах языка (редизайн, фаза 13г): кружки «+» под
// участниками, крестик удаления и стрелка «на страницу объекта» на шапке. Геометрия и
// поведение прежние, проверяются только цвета и тени: без теней, цвета — var(--c-*), а не
// палитра диаграммы. Вид крестика и стрелки, включая наведение, — правила processes.css
// (инлайн-цвет раньше перебивал правило наведения).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SequenceDiagram from "../processes/SequenceDiagram";
import type { SeqParticipant } from "../processes/sequence/layout";

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "processes", "processes.css"), "utf8");
// Тело правила с точным селектором (первое вхождение).
const rule = (selector: string) => {
  const at = CSS.indexOf(selector + " {");
  expect(at).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf("}", at));
};

const part = (id: string, name: string): SeqParticipant => ({
  id, nodeId: "node-" + id, name, role: "сервис",
  shape: "service", external: false, status: "existing",
});

function renderEditable() {
  return render(
    <SequenceDiagram
      participants={[part("a", "Клиент"), part("b", "Заказы")]}
      messages={[]}
      ghost
      onConnect={vi.fn()}
      onDeleteParticipant={vi.fn()}
      onOpenNode={vi.fn()}
    />,
  );
}

describe("ручки правки на диаграмме: токены языка", () => {
  it("кружок «+»: фон --c-bg, рамка и значок --c-accent, без тени", () => {
    renderEditable();
    const circle = screen.getByTitle("Шаг от «Клиент»");
    const style = circle.getAttribute("style") ?? "";
    expect(style).toContain("background: var(--c-bg)");
    expect(style).toContain("border: 1.5px solid var(--c-accent)");
    expect(style).toContain("color: var(--c-accent)");
    expect(style).not.toContain("box-shadow");
    expect(style).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
  });

  it("крестик и стрелка на шапке: цвета не инлайном, без тени", () => {
    renderEditable();
    const del = document.querySelector(".bp-phead-del");
    const openNode = document.querySelector(".bp-phead-open");
    for (const el of [del, openNode]) {
      expect(el).not.toBeNull();
      const style = el?.getAttribute("style") ?? "";
      expect(style).not.toMatch(/(^|;\s*)(border|background|color|box-shadow):/);
    }
  });

  it("правила крестика и стрелки: рамка --c-line-strong, наведение — опасность и акцент", () => {
    expect(rule(".bp-phead-del")).toContain("border: 1px solid var(--c-line-strong);");
    expect(rule(".bp-phead-del")).toContain("color: var(--c-danger);");
    expect(rule(".bp-phead-del:hover")).toContain("border-color: var(--c-danger);");
    expect(rule(".bp-phead-del:hover")).toContain("background: var(--c-hover);");
    expect(rule(".bp-phead-open")).toContain("border: 1px solid var(--c-line-strong);");
    expect(rule(".bp-phead-open:hover")).toContain("color: var(--c-accent);");
    expect(rule(".bp-phead-open:hover")).toContain("background: var(--c-hover);");
    for (const sel of [".bp-phead-del", ".bp-phead-open", ".bp-phead-del:hover", ".bp-phead-open:hover"]) {
      expect(rule(sel)).not.toContain("box-shadow");
      expect(rule(sel)).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    }
  });
});
