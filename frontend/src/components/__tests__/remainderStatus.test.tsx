// Соседи блока разбора: строка статуса (§2, Р7), свёртка незакрываемых замечаний
// (§6, Р6) и массовые кнопки догрузки (§7, Р10).
//
// Что закрепляем: три состояния статуса вместо прежней сводки счётчиков, ссылка
// «Открыть файл …» переключает вход (иначе виновника ищут глазами по чипам),
// копия замечания уносится агенту тем же вступлением, что и раньше, а массовые
// кнопки закрывают ТОЛЬКО споры — жесты остаются работой человека.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import type { FieldDisputeOut, RemainderOut, UnfixableOut } from "../../types";
import {
  BulkBox, StatusLine, UnfixableFold, buildQuestions, bulkAnswers, splitErrorLine,
} from "../project/remainder";
import type { Answers, Resolutions } from "../project/remainder";

describe("StatusLine (§2, Р7)", () => {
  it("три состояния — своими словами", () => {
    const { rerender } = render(<StatusLine state="ok" />);
    expect(screen.getByText("Готово к импорту")).toBeInTheDocument();
    rerender(<StatusLine state="ask" />);
    expect(screen.getByText("Есть вопросы")).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
    rerender(<StatusLine state="bad" />);
    expect(screen.getByText("Что-то пошло не так")).toBeInTheDocument();
    expect(screen.getByText("!")).toBeInTheDocument();
  });

  it("называет первую ошибку с файлом и строкой, ссылка открывает вход", async () => {
    const onOpenFile = vi.fn();
    render(
      <StatusLine
        state="bad"
        error={{ chipLabel: "2 · grafana.yaml", chipIndex: 1, line: 84, text: "у объекта «Сервер Grafana» два родителя" }}
        onOpenFile={onOpenFile}
      />,
    );
    expect(screen.getByText(/Проблема в файле/).textContent).toBe(
      "Проблема в файле 2 · grafana.yaml. Строка 84: у объекта «Сервер Grafana» два родителя.");
    await userEvent.click(screen.getByRole("button", { name: "Открыть файл 2 · grafana.yaml" }));
    expect(onOpenFile).toHaveBeenCalledWith(1);
  });

  it("без строки — двоеточие, без файла — ни чипа, ни ссылки", () => {
    const { rerender } = render(
      <StatusLine state="bad" error={{ chipLabel: "1 · zabbix.yaml", chipIndex: 0, line: null, text: "связь ведёт в никуда" }} />,
    );
    expect(screen.getByText(/Проблема в файле/).textContent).toBe(
      "Проблема в файле 1 · zabbix.yaml: связь ведёт в никуда.");
    rerender(
      <StatusLine state="bad" error={{ chipLabel: null, chipIndex: null, line: null, text: "входы не имеют общих корневых узлов" }} />,
    );
    expect(screen.getByText("входы не имеют общих корневых узлов.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("без файла, но со строкой — номер остаётся в сообщении", () => {
    // Адресовать нечему (ошибка слитой схемы), но «где именно» — единственное,
    // что у такого сообщения есть: терять номер строки нельзя.
    render(
      <StatusLine
        state="bad"
        error={{ chipLabel: null, chipIndex: null, line: 42, text: "узел «api» объявлен дважды" }}
      />,
    );
    expect(screen.getByText(/узел «api»/).textContent).toBe(
      "Строка 42: узел «api» объявлен дважды.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("номер строки вынимается из текста ошибки — из начала и из скобок", () => {
    expect(splitErrorLine("Строка 84: у объекта два родителя"))
      .toEqual({ line: 84, text: "у объекта два родителя" });
    expect(splitErrorLine("строка 7 — узел не найден."))
      .toEqual({ line: 7, text: "узел не найден" });
    // Форма самого частого источника — ошибок разбора YAML (app/import_yaml.py):
    // номер в скобках ПОСРЕДИ текста, а не в начале.
    expect(splitErrorLine(
      "Некорректный YAML: ошибка разметки (строка 29). Частая причина — двоеточие с пробелом",
    )).toEqual({
      line: 29,
      text: "Некорректный YAML: ошибка разметки. Частая причина — двоеточие с пробелом",
    });
    expect(splitErrorLine("Некорректный YAML: ошибка разметки (строка 29)"))
      .toEqual({ line: 29, text: "Некорректный YAML: ошибка разметки" });
    // Номера нет вовсе — текст целиком, без хвостовой точки (её ставит шаблон).
    expect(splitErrorLine("входы не имеют общих корневых узлов."))
      .toEqual({ line: null, text: "входы не имеют общих корневых узлов" });
  });
});

const замечание = (over: Partial<UnfixableOut> = {}): UnfixableOut => ({
  id: "u1", text: "«Поллер» встречается в файлах как РАЗНЫЕ объекты",
  how: "Можно доработать прогоном агента. Пусть он задаст каждому объекту свой source.path.",
  agent: "Zabbix", if_left: "Если оставить: в проекте будут два объекта с одним именем.",
  file: 1, ...over,
});

const ВСТУПЛЕНИЕ = "Валидатор импорта ArchMap принял ваш YAML — один из нескольких файлов системы.";

describe("UnfixableFold (§6, Р6)", () => {
  it("свёрнута по умолчанию, раскрывается с вводкой и карточками", async () => {
    render(<UnfixableFold items={[замечание(), замечание({ id: "u2", agent: null })]} intro={ВСТУПЛЕНИЕ} />);
    const заголовок = screen.getByRole("button", { name: /Что исправит только новый прогон агента \(2\)/ });
    expect(screen.queryByText(/Это замечания о том, как написаны сами файлы/)).toBeNull();
    await userEvent.click(заголовок);
    expect(screen.getByText(/Это замечания о том, как написаны сами файлы/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Скопировать замечание для агента Zabbix" })).toBeInTheDocument();
    // Владельца нет — кнопка без имени (Р6).
    expect(screen.getByRole("button", { name: "Скопировать замечание для агента" })).toBeInTheDocument();
    expect(screen.getAllByText(/Если оставить:/)).toHaveLength(2);
  });

  it("копирует замечание с тем же вступлением и отзывается «Скопировано»", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom не даёт navigator.clipboard — подменяем целиком.
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<UnfixableFold items={[замечание()]} intro={ВСТУПЛЕНИЕ} />);
    await userEvent.click(screen.getByRole("button", { name: /Что исправит/ }));
    await userEvent.click(screen.getByRole("button", { name: /Скопировать замечание/ }));
    expect(writeText).toHaveBeenCalledWith(
      `${ВСТУПЛЕНИЕ}\n- «Поллер» встречается в файлах как РАЗНЫЕ объекты`);
    await waitFor(() => expect(screen.getByText("Скопировано ✓")).toBeInTheDocument());
  });

  it("без замечаний не показывается вовсе", () => {
    const { container } = render(<UnfixableFold items={[]} intro={ВСТУПЛЕНИЕ} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("BulkBox (§7, Р10)", () => {
  const поле = (over: Partial<FieldDisputeOut> = {}): FieldDisputeOut => ({
    id: "field|Ярмарка/orders|description", node_path: "Ярмарка / orders", field: "description",
    candidates: [
      { origin: 0, origin_label: "Текущий проект", source_label: "Из проекта", value: "Моё", current: true },
      { origin: 1, origin_label: "1 · plugin.zip", source_label: "Из архива плагина", value: "Из архива", current: false },
    ],
    default: 0, ...over,
  });
  const остаток: RemainderOut = {
    field_conflicts: [поле()], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
    unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [],
  };

  it("две кнопки и подпись — как в ТЗ", async () => {
    const onKeepMine = vi.fn();
    const onTakeArchives = vi.fn();
    render(<BulkBox onKeepMine={onKeepMine} onTakeArchives={onTakeArchives} />);
    expect(screen.getByText("Решить все конфликты одной кнопкой:")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Оставить, как было в проекте" }));
    await userEvent.click(screen.getByRole("button", { name: "Взять из новых архивов" }));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
    expect(onTakeArchives).toHaveBeenCalledTimes(1);
  });

  it("массовый ответ ставит выбор спорам и не трогает жесты", () => {
    const qs = buildQuestions({ family_conflicts: [], remainder: остаток });
    const пусто = { answers: {} as Answers, resolutions: {} as Resolutions };
    expect(bulkAnswers(qs, false, пусто).answers).toEqual({
      "field|Ярмарка/orders|description": { kind: "field", index: 1 },
    });
    expect(bulkAnswers(qs, true, пусто).answers).toEqual({
      "field|Ярмарка/orders|description": { kind: "field", index: 0 },
    });
  });
});
