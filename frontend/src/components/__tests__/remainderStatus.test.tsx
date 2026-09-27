// Соседи блока разбора: строка статуса (§2, Р7), свёртка незакрываемых замечаний
// (§6, Р6) и массовые кнопки догрузки (§7, Р10).
//
// Что закрепляем: три состояния статуса вместо прежней сводки счётчиков, ссылка
// «Открыть файл …» переключает вход (иначе виновника ищут глазами по чипам),
// свёртка — маркированный список готовых пунктов без «агента» (правка Ф2г), а
// массовые кнопки закрывают ТОЛЬКО споры — жесты остаются работой человека.
import { render, screen, within } from "@testing-library/react";
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
  id: "u1",
  text: "«Поллер» (внутри «Zabbix») в разных файлах имеет разные метаданные. ArchMap не знает, "
    + "это один и тот же объект или нет. Если это дубль, его нужно будет удалить вручную.",
  file: null, ...over,
});

describe("UnfixableFold (§6, правка Ф2г)", () => {
  it("свёрнута по умолчанию, раскрывается вводкой и маркированным списком", async () => {
    render(<UnfixableFold items={[
      замечание(),
      замечание({ id: "u2", text: "У 1 объекта («api») нет ни одной связи.", file: 1 }),
    ]} />);
    const заголовок = screen.getByRole("button", { name: "Придется подправить вручную (2)" });
    expect(заголовок).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list")).toBeNull();
    await userEvent.click(заголовок);
    expect(screen.getByText(
      "В файлах есть нестыковки, которые ArchMap не сможет закрыть одним вопросом. Вот их список:",
    )).toBeInTheDocument();
    const пункты = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(пункты.map((li) => li.textContent)).toEqual([
      замечание().text, "У 1 объекта («api») нет ни одной связи.",
    ]);
  });

  it("только текст пункта: ни кнопок копирования, ни «Можно доработать», ни «Если оставить»", async () => {
    render(<UnfixableFold items={[замечание()]} />);
    await userEvent.click(screen.getByRole("button", { name: /Придется подправить вручную/ }));
    expect(screen.getAllByRole("button")).toHaveLength(1); // только сам заголовок свёртки
    expect(screen.queryByText(/агент/)).toBeNull();
    expect(screen.queryByText(/Можно доработать|Если оставить/)).toBeNull();
  });

  it("без замечаний не показывается вовсе", () => {
    const { container } = render(<UnfixableFold items={[]} />);
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
