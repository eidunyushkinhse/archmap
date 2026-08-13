// Панель импорта YAML: то, что лечит «ампутацию» (полевой QA docs/qa-zabbix-7.md,
// раунд 2 — на замечания слабая модель отвечает удалением узлов: 31→27, 30→14).
//
// Закрепляем два обещания: замечания для агента звучат по-разному при ошибках
// разбора и при зелёной сводке с предупреждениями (во втором случае — «дополняй,
// не удаляй»), а пропавшие между попытками объекты названы поимённо, а не молчат.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ImportPane from "../project/ImportPane";
import type { ImportPreviewOut } from "../../types";

const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  // jsdom не даёт navigator.clipboard — подменяем целиком.
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

const green = (names: string[], over: Partial<ImportPreviewOut> = {}): ImportPreviewOut => ({
  ok: true, errors: [], node_count: names.length, edge_count: 0, roots: names.slice(0, 1),
  files: 1, merged_count: 0, merged: [], conflicts: [], warnings: [], dropped_edges: 0,
  node_names: names, ...over,
});

const red = (errors: string[]): ImportPreviewOut => ({
  ok: false, errors, node_count: 0, edge_count: 0, roots: [], files: 1,
  merged_count: 0, merged: [], conflicts: [], warnings: [], dropped_edges: 0, node_names: [],
});

// Сводку приносит родитель (дебаунс dry-run живёт в CreateProjectDialog) — здесь
// попытки агента моделируются перерисовкой с новой сводкой.
function paint(summary: ImportPreviewOut | null) {
  const view = render(<ImportPane docs={["nodes:"]} onDocs={vi.fn()} summary={summary} />);
  return (next: ImportPreviewOut | null) =>
    view.rerender(<ImportPane docs={["nodes:"]} onDocs={vi.fn()} summary={next} />);
}

async function copyRemarks(): Promise<string> {
  await userEvent.click(screen.getByRole("button", { name: /Скопировать замечания/ }));
  expect(writeText).toHaveBeenCalledTimes(1);
  return writeText.mock.calls[0][0];
}

describe("замечания для агента", () => {
  it("ошибки разбора — просим исправить", async () => {
    paint(red(["Некорректный YAML: ошибка (строка 3)"]));
    const text = await copyRemarks();
    expect(text).toMatch(/^Валидатор импорта ArchMap нашёл замечания к YAML\. Исправь их/);
    expect(text).toContain("- Некорректный YAML: ошибка (строка 3)");
  });

  it("зелёная сводка — просим ДОПОЛНЯТЬ, а не удалять", async () => {
    paint(green(["Система", "api"], { warnings: ["объектов без единой связи: 1 («api»)"] }));
    const text = await copyRemarks();
    expect(text).toContain("принял YAML, но оставил предупреждения");
    expect(text).toContain("ДОПОЛНЯЯ схему");
    expect(text).toContain("а НЕ удаляй объекты: удаление хуже недостающей связи");
    expect(text).not.toContain("Исправь их");
    expect(text).toContain("- объектов без единой связи: 1 («api»)");
  });
});

describe("дифф попыток", () => {
  it("исчезнувшие объекты названы поимённо", () => {
    const again = paint(green(["Система", "orders", "api", "worker"]));
    // Первая попытка: сравнивать не с чем.
    expect(screen.queryByText(/Исчезли/)).toBeNull();

    again(green(["Система", "orders"]));
    const line = screen.getByText(/Исчезли:/);
    expect(line).toHaveTextContent("Стало 2 объекта (было 4)");
    expect(line).toHaveTextContent("Исчезли: api, worker");
  });

  it("рост схемы предупреждением не считается", () => {
    const again = paint(green(["Система", "orders"]));
    again(green(["Система", "orders", "api"]));
    expect(screen.queryByText(/Исчезли/)).toBeNull();
  });

  it("длинный список исчезнувших обрезан до восьми имён", () => {
    const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const again = paint(green(["Система", ...many]));
    again(green(["Система"]));
    const line = screen.getByText(/Исчезли:/);
    expect(line).toHaveTextContent("Исчезли: c0, c1, c2, c3, c4, c5, c6, c7 и ещё 4");
  });
});
