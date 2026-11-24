// Колонка кода окна документа (DocEditorColumn) на новом языке (редизайн, фаза 7б): у
// схемы логики, у спецификации и у читателя. Полосы-заголовка над кодом нет; под кодом
// строка состояния: слева ошибка (со строкой — ставит каретку) или тихая заметка, когда
// всё в порядке — пусто; справа «Загрузить файл». У читателя строки состояния нет.
import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FlowchartDoc from "../inspector/FlowchartDoc";
import OpenApiDoc from "../inspector/OpenApiDoc";
import type { MmdStatus } from "../MermaidRenderer";

vi.mock("../../api/dataRefs", () => ({ dataRefsApi: { preview: vi.fn(() => Promise.resolve([])) } }));
// Рендерер mermaid: «мусор» в тексте — ошибка на второй строке, «ждать» — загрузка.
vi.mock("../MermaidRenderer", () => ({
  default: function Mmd({ chart, onStatus }: { chart: string; onStatus?: (s: MmdStatus) => void }) {
    useEffect(() => {
      if (chart.includes("ждать")) onStatus?.({ kind: "loading" });
      else if (chart.includes("мусор")) onStatus?.({ kind: "error", line: 2, message: "Parse error on line 2:\n  ((мусор" });
      else onStatus?.({ kind: "ok" });
    }, [chart, onStatus]);
    return <div data-testid="mmd">{chart}</div>;
  },
}));
vi.mock("../OpenApiViewer", () => ({ default: () => <div data-testid="swagger" /> }));

const CHART = "graph TD\n  A[Старт] --> B[Конец]";
const SPEC = "openapi: 3.0.0\ninfo:\n  title: T\n  version: 1.0.0\npaths: {}\n";

const field = () => document.querySelector("textarea.doc-edta") as HTMLTextAreaElement;
const bar = () => document.querySelector(".doc-edbar") as HTMLElement | null;
const left = () => document.querySelector(".doc-edbar-msg") as HTMLElement;

function chart(initial: string, isArchitect = true) {
  render(<FlowchartDoc initial={initial} nodeId="n1" isArchitect={isArchitect} showCode onDraft={vi.fn()} />);
}
function specDoc(initial: string, isArchitect = true) {
  render(<OpenApiDoc initial={initial} isArchitect={isArchitect} showCode onDraft={vi.fn()} />);
}

describe("колонка кода схемы логики", () => {
  it("полосы-заголовка нет; «Синтаксис корректен» нет, слева пусто; справа «Загрузить файл»", async () => {
    chart(CHART);
    await screen.findByTestId("mmd");
    expect(screen.queryByText(/Код · mermaid flowchart/i)).toBeNull();
    expect(document.querySelector(".doc-edhead")).toBeNull();
    expect(screen.queryByText("Синтаксис корректен")).toBeNull();
    expect(left()).toBeEmptyDOMElement();
    // Строка состояния — сразу под полем кода, кнопка файла — у её правого края.
    expect(field().nextElementSibling).toBe(bar());
    const load = screen.getByRole("button", { name: "Загрузить файл" });
    expect(bar()).toContainElement(load);
    expect(load).toHaveClass("doc-filebtn");
    expect(load.getAttribute("title")).toMatch(/^Взять схему из файла .* Файл можно и перетащить на поле$/);
  });

  it("ошибка со строкой — слева, одной строкой с полным текстом в title; щелчок ставит каретку", async () => {
    chart("graph TD\n  ((мусор\n  C --> D");
    const ошибка = await screen.findByRole("button", { name: /^Строка 2: Parse error on line 2: \(\(мусор$/ });
    expect(left()).toContainElement(ошибка);
    expect(ошибка).toHaveClass("doc-ederr");
    expect(ошибка.querySelector(".doc-ederr-msg")).toHaveAttribute("title", "Строка 2: Parse error on line 2: ((мусор");
    await userEvent.click(ошибка);
    expect(field()).toHaveFocus();
    // Начало второй строки: после «graph TD\n».
    expect(field().selectionStart).toBe("graph TD\n".length);
  });

  it("ошибку исправили — слева снова пусто", async () => {
    chart("graph TD\n  ((мусор");
    await screen.findByRole("button", { name: /^Строка 2:/ });
    fireEvent.change(field(), { target: { value: CHART } });
    await waitFor(() => expect(left()).toBeEmptyDOMElement());
  });

  it("пока превью загружается — тихое «Открываем схему»", async () => {
    chart("graph TD\n  ждать");
    expect(await screen.findByText("Открываем схему")).toHaveClass("doc-ednote");
  });

  it("отказ принять файл — на месте ошибки", async () => {
    chart(CHART);
    await screen.findByTestId("mmd");
    fireEvent.drop(field(), { dataTransfer: { files: [new File(["PNG\u0000\u0000"], "logo.png", { type: "text/plain" })] } });
    const отказ = await screen.findByText("Это не текстовый файл");
    expect(left()).toContainElement(отказ);
    expect(field().value).toBe(CHART);
  });

  it("читатель: код только для чтения, строки состояния нет", async () => {
    chart(CHART, false);
    await screen.findByTestId("mmd");
    expect(field()).toHaveAttribute("readonly");
    expect(bar()).toBeNull();
    expect(screen.queryByText(/Копировать можно/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Загрузить файл" })).toBeNull();
    // Обёртки прежнего вида больше нет.
    expect(field().closest(".legacy-root")).toBeNull();
  });
});

describe("колонка кода спецификации", () => {
  it("полосы-заголовка нет; без ошибки слева пусто; справа «Загрузить файл»", () => {
    specDoc(SPEC);
    expect(screen.queryByText(/Код · OpenAPI 3\.0 \(YAML\)/)).toBeNull();
    expect(screen.queryByText("Синтаксис корректен")).toBeNull();
    expect(left()).toBeEmptyDOMElement();
    expect(bar()).toContainElement(screen.getByRole("button", { name: "Загрузить файл" }));
  });

  it("ошибка YAML со строкой — слева, щелчок ставит каретку", async () => {
    specDoc("openapi: [\n  broken");
    const ошибка = screen.getByRole("button", { name: /^Строка \d+:/ });
    expect(left()).toContainElement(ошибка);
    await userEvent.click(ошибка);
    expect(field()).toHaveFocus();
  });

  it("читатель: строки состояния нет", () => {
    specDoc(SPEC, false);
    expect(field()).toHaveAttribute("readonly");
    expect(bar()).toBeNull();
    expect(screen.queryByText(/Копировать можно/)).toBeNull();
    expect(field().closest(".legacy-root")).toBeNull();
  });
});
