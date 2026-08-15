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

// То же, но документы задаёт тест: заход пользователя — новый массив docs.
function paintDocs(docs: string[], summary: ImportPreviewOut | null, onDocs = vi.fn()) {
  const view = render(<ImportPane docs={docs} onDocs={onDocs} summary={summary} />);
  return (nextDocs: string[], next: ImportPreviewOut | null) =>
    view.rerender(<ImportPane docs={nextDocs} onDocs={onDocs} summary={next} />);
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

describe("гвард «вход не изменился»", () => {
  // Находка полевой приёмки: агент отчитывался «Исправление: добавлена связь…», не
  // тронув файл, — пользователь трижды нёс сюда байт-в-байт тот же документ и трижды
  // получал то же замечание. Панель обязана назвать это вслух.
  it("тот же документ вторым заходом — заметка над сводкой", () => {
    const again = paintDocs(["nodes: a"], green(["Система"]));
    expect(screen.queryByText(/Содержимое не изменилось/)).toBeNull();

    again(["nodes: a"], green(["Система"]));
    expect(screen.getByText(/Содержимое не изменилось с прошлой проверки/)).toHaveTextContent(
      "агент мог отчитаться об исправлении, не внеся его",
    );
  });

  it("изменившийся документ заметку снимает", () => {
    const again = paintDocs(["nodes: a"], green(["Система"]));
    again(["nodes: a"], green(["Система"]));
    expect(screen.getByText(/Содержимое не изменилось/)).toBeInTheDocument();
    // Тот же ОДИН документ, но другого содержания: гвард сравнивает текст, а не счёт.
    again(["nodes: b"], green(["Система"]));
    expect(screen.queryByText(/Содержимое не изменилось/)).toBeNull();
  });
});

describe("вопрос об устаревших файлах", () => {
  // Второе замечание приёмки: после круга замечаний пользователь тащит новый файл, а
  // старый остаётся в панели — убрать его приходилось догадкой.
  it("после копирования замечаний спрашивает, оставить ли файлы, и убирает их", async () => {
    const onDocs = vi.fn();
    paintDocs(["nodes: a"], red(["Некорректный YAML: ошибка (строка 3)"]), onDocs);
    expect(screen.queryByText(/Оставить их\?/)).toBeNull();

    await copyRemarks();
    expect(screen.getByText(/текущие файлы в панели устареют. Оставить их\?/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Убрать из панели" }));
    expect(onDocs).toHaveBeenCalledWith([""]);
    expect(screen.queryByText(/Оставить их\?/)).toBeNull();
  });

  it("«Оставить» закрывает вопрос и файлы не трогает", async () => {
    const onDocs = vi.fn();
    paintDocs(["nodes: a"], red(["Некорректный YAML: ошибка (строка 3)"]), onDocs);
    await copyRemarks();

    await userEvent.click(screen.getByRole("button", { name: "Оставить" }));
    expect(screen.queryByText(/Оставить их\?/)).toBeNull();
    expect(onDocs).not.toHaveBeenCalled();
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
