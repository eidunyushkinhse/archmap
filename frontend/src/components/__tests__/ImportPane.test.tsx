// Панель импорта YAML: пропавшие между попытками объекты названы поимённо, а не
// молчат (полевой QA docs/qa-zabbix-7.md, раунд 2 — «ампутация» 31→27, 30→14).
//
// Правка Ф2г: панель НЕ ЗНАЕТ, откуда файлы, — в ней нет ни карточки «Замечания к
// файлу N», ни кнопки «Скопировать замечания для агента», ни заметки о повторном
// входе; пофайловые замечания уехали в свёртку «Придется подправить вручную»,
// ошибки разбора — только в красном статусе.
//
// С Ф-E панель говорит о ввозе одной СТРОКОЙ СТАТУСА вместо сводки счётчиков, а
// остаток слияния показывает вопросами: строки «Готово к импорту: … объектов»,
// «Корневые», «Склеено узлов», «Без якоря», «Из архивов», секции «Замечания к
// слитой схеме» и «Споры содержимого» с экрана ушли.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import ImportPane from "../project/ImportPane";
import type { ArchiveInputs, RemainderInputs } from "../project/ImportPane";
import { buildQuestions } from "../project/remainder";
import type { FamilyConflictOut, ImportPreviewOut, RemainderOut } from "../../types";

const green = (names: string[], over: Partial<ImportPreviewOut> = {}): ImportPreviewOut => ({
  ok: true, errors: [], node_count: names.length, edge_count: 0, roots: names.slice(0, 1),
  files: 1, merged_count: 0, merged: [], merged_nodes: [], nodes_without_anchor: 0,
  conflicts: [], warnings: [], dropped_edges: 0,
  node_names: names, file_remarks: [], schema_errors: [], schema_warnings: [], ...over,
});

const red = (errors: string[], over: Partial<ImportPreviewOut> = {}): ImportPreviewOut => ({
  ok: false, errors, node_count: 0, edge_count: 0, roots: [], files: 1,
  merged_count: 0, merged: [], merged_nodes: [], nodes_without_anchor: 0,
  conflicts: [], warnings: [], dropped_edges: 0, node_names: [],
  file_remarks: [], schema_errors: [], schema_warnings: [], ...over,
});

// Пустой остаток: превью без вопросов. Точечные тесты доливают в него своё.
const ОСТАТОК: RemainderOut = {
  field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
  unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [],
};
const остаток = (over: Partial<RemainderOut> = {}): RemainderOut => ({ ...ОСТАТОК, ...over });

// Бандл разбора, как его собирает родитель: вопросы считаются из превью.
function разбор(over: {
  conflicts?: FamilyConflictOut[]; remainder?: RemainderOut;
  onAnswer?: RemainderInputs["onAnswer"]; onResolve?: RemainderInputs["onResolve"];
  resolutions?: Record<string, string>;
} = {}): RemainderInputs {
  const r = over.remainder ?? ОСТАТОК;
  return {
    questions: buildQuestions({ family_conflicts: over.conflicts ?? [], remainder: r }),
    answers: {},
    onAnswer: over.onAnswer ?? vi.fn(),
    resolutions: over.resolutions ?? {},
    onResolve: over.onResolve ?? vi.fn(),
    unfixable: r.unfixable,
  };
}

// Сводку приносит родитель (дебаунс dry-run живёт в CreateProjectDialog) — здесь
// попытки агента моделируются перерисовкой с новой сводкой.
function paint(summary: ImportPreviewOut | null) {
  const view = render(<ImportPane docs={["nodes:"]} onDocs={vi.fn()} summary={summary} />);
  return (next: ImportPreviewOut | null) =>
    view.rerender(<ImportPane docs={["nodes:"]} onDocs={vi.fn()} summary={next} />);
}

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

// ── мульти-файловый режим: без карточки файла и копии для агента (Ф2г) ──────
//
// Раньше под панелью жили замечания АКТИВНОГО файла с кнопкой копирования его
// агенту (Ф6). Панель не знает, был ли агент, — поэтому карточки больше нет, а
// пофайловые замечания бэк кладёт в свёртку «Придется подправить вручную».

const Ф1 = "связь «orders → kafka»: конец — брокер «kafka», а канал не указан";
const Ф2 = "связь «payments → orders»: в channel перечень «a, b» — разделите";
const СХЕМА = "Ярмарка / orders: technology: оставлено «Go» (файл 1), отброшено «Rust» (файл 2)";

// Сводка двух файлов. Плоские warnings — объединение корзин (так их собирает бэк).
const двухфайловая = (over: Partial<ImportPreviewOut> = {}): ImportPreviewOut =>
  green(["Ярмарка", "orders", "payments"], {
    files: 2,
    warnings: [Ф1, Ф2, СХЕМА],
    file_remarks: [
      { file: 1, errors: [], warnings: [Ф1] },
      { file: 2, errors: [], warnings: [Ф2] },
    ],
    schema_warnings: [СХЕМА],
    ...over,
  });

// Документами и их именами владеет родитель (CreateProjectDialog) — в тестах его
// роль играет эта обёртка: без неё чипы не переключались бы и файлы не добавлялись.
function Harness({ initial, summary, archives, remainder }: {
  initial: string[]; summary: ImportPreviewOut | null; archives?: ArchiveInputs;
  remainder?: RemainderInputs;
}) {
  const [docs, setDocs] = useState(initial);
  const [names, setNames] = useState<(string | null)[]>([]);
  return (
    <ImportPane
      docs={docs}
      onDocs={setDocs}
      names={names}
      onNames={setNames}
      summary={summary}
      archives={archives}
      remainder={remainder}
    />
  );
}

const chip = (name: string | RegExp) => screen.getByRole("button", { name });

describe("мульти-файловый импорт: замечания не адресуются агенту файла", () => {
  it("ни карточки «Замечания к файлу N», ни строки «замечаний нет», ни копии", async () => {
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={двухфайловая()} />);

    expect(screen.queryByText(/Замечания к файлу/)).toBeNull();
    expect(screen.queryByText(/замечаний нет/)).toBeNull();
    expect(screen.queryByText(Ф1)).toBeNull();
    expect(screen.queryByText(СХЕМА)).toBeNull();
    expect(screen.queryByRole("button", { name: /Скопировать замечания/ })).toBeNull();

    // Смена активного чипа ничего такого не показывает.
    await userEvent.click(chip("Файл 2"));
    expect(screen.queryByText(/Замечания к файлу/)).toBeNull();
    expect(screen.queryByText(Ф2)).toBeNull();
  });

  it("пофайловые замечания — пунктами свёртки, а не списком под чипом", async () => {
    render(
      <Harness
        initial={["nodes: a", "nodes: b"]}
        summary={двухфайловая()}
        remainder={разбор({
          remainder: остаток({
            unfixable: [{
              id: "remark|0", file: 0,
              text: "У связи «orders → kafka» с брокером «kafka» не указан канал. Его нужно будет вписать в карточке связи вручную.",
            }],
          }),
        })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Придется подправить вручную (1)" }));
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "У связи «orders → kafka» с брокером «kafka» не указан канал.");
  });

  it("имя файла с диска попадает в чип", async () => {
    render(<Harness initial={[""]} summary={двухфайловая()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, [
      new File(["nodes: a"], "billing.yaml", { type: "text/plain" }),
      new File(["nodes: b"], "orders.yaml", { type: "text/plain" }),
    ]);

    await waitFor(() => expect(chip("1 · billing.yaml")).toBeInTheDocument());
    expect(chip("2 · orders.yaml")).toBeInTheDocument();
  });
});

describe("одно-файловый режим", () => {
  it("конфликты слияния — как были, «Проверьте:» и копии для агента нет", () => {
    paint(green(["Ярмарка", "orders"], {
      conflicts: ["C1"],
      warnings: ["W1"],
      file_remarks: [{ file: 1, errors: [], warnings: ["C1", "W1"] }],
    }));

    expect(screen.getByText("Конфликты слияния (оставлено первое значение):")).toBeInTheDocument();
    expect(screen.getByText("C1")).toBeInTheDocument();
    expect(screen.queryByText("Проверьте:")).toBeNull();
    expect(screen.queryByText("W1")).toBeNull();
    expect(screen.queryByText(/Замечания к файлу/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Скопировать замечания/ })).toBeNull();
  });

  it("повторный тот же документ — без заметки про агента", () => {
    const view = render(<ImportPane docs={["nodes: a"]} onDocs={vi.fn()} summary={green(["Система"])} />);
    view.rerender(<ImportPane docs={["nodes: a"]} onDocs={vi.fn()} summary={green(["Система"])} />);
    expect(screen.queryByText(/Содержимое не изменилось/)).toBeNull();
    expect(screen.queryByText(/агент/)).toBeNull();
  });
});

// ── единая панель: архивные входы (Ф2б) ──────────────────────────────────────
//
// Архив знания — такой же вход, как YAML: свой чип в той же полосе и свой номер
// (нумерация входов сплошная — на неё ссылаются ошибки бэка). Тело архива не
// редактируется — вместо textarea карточка.

const ЗАМ_АРХИВА = "docs/orders.mmd: узел «Нет такого» не найден — файл пропущен";

const архивы = (over: Partial<ArchiveInputs> = {}): ArchiveInputs => ({
  files: [new File(["zip"], "archmap.zip", { type: "application/zip" })],
  onFiles: vi.fn(),
  ...over,
});

const СПЕКА_СПОР: FamilyConflictOut = {
  id: "spec|Ярмарка / orders|openapi",
  family: "spec",
  node_path: "Ярмарка / orders",
  key: "openapi",
  candidates: [
    { origin: 0, origin_label: "a.zip", source_label: "Из архива Ярмарка", summary: "12 строк, 400 Б", body: "openapi: 3.0.0", truncated: false, current: false },
    { origin: 1, origin_label: "b.zip", source_label: "Из архива Склад", summary: "20 строк, 800 Б", body: "openapi: 3.1.0", truncated: true, current: false },
  ],
  default: "cand:0",
  allow_all: false,
};

describe("архивные входы единой панели", () => {
  it("чип архива помечен «zip» и продолжает нумерацию входов", () => {
    render(<Harness initial={["nodes: a"]} summary={двухфайловая()} archives={архивы()} />);

    // Один непустой YAML — архив занимает вход 2 (им же подписаны его замечания).
    expect(chip("zip 2 · archmap.zip")).toBeInTheDocument();
    // Счётчиков приезжающего знания в панели больше нет (Ф-E): статус говорит о
    // вопросах, а «3 схемы логики · 1 спека» решению не помогали.
    expect(screen.queryByText(/Из архивов:/)).toBeNull();
    expect(screen.queryByText(/Готово к импорту: /)).toBeNull();
  });

  it("клик по чипу архива открывает карточку без замечаний и без копии", async () => {
    render(
      <Harness
        initial={["nodes: a"]}
        summary={двухфайловая({
          file_remarks: [
            { file: 1, errors: [], warnings: [Ф1] },
            { file: 2, errors: [], warnings: [ЗАМ_АРХИВА] },
          ],
        })}
        archives={архивы()}
      />,
    );

    await userEvent.click(chip("zip 2 · archmap.zip"));

    expect(screen.getByText(/полный архив знания/)).toBeInTheDocument();
    // Замечания архива — пунктами свёртки, в карточке их нет (правка Ф2г).
    expect(screen.queryByText("Замечания к архиву:")).toBeNull();
    expect(screen.queryByText("К архиву замечаний нет.")).toBeNull();
    expect(screen.queryByText(ЗАМ_АРХИВА)).toBeNull();
    // Тело архива не правят — textarea заменена карточкой.
    expect(screen.queryByPlaceholderText(/Перетащите сюда/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Скопировать замечания/ })).toBeNull();
  });

  it("спор содержимого стал вопросом разбора, выбор уходит наверх", async () => {
    const onResolve = vi.fn();
    render(
      <Harness
        initial={["nodes: a"]}
        summary={двухфайловая()}
        archives={архивы()}
        remainder={разбор({ conflicts: [СПЕКА_СПОР], onResolve })}
      />,
    );

    // Прежней секции «Споры содержимого (1)» с радиокнопками нет: спор задан
    // вопросом, кандидаты подписаны источником знания, а не именем файла.
    expect(screen.queryByText("Споры содержимого (1)")).toBeNull();
    expect(screen.getByText(/Без ваших решений не объединить/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe(
      "У объекта «openapi» в разных источниках разные спеки с одинаковым названием."
      + " Какую считаем правильной?");
    // Ничего не предвыбрано — дефолт бэка назван сноской, а не галкой.
    expect(screen.getByText(/Если не отвечать/).textContent).toContain(
      "в проект попадёт вариант «Из архива Ярмарка»");
    expect(document.querySelectorAll(".rq-opt--on")).toHaveLength(0);

    await userEvent.click(screen.getAllByRole("button", { name: /Из архива Склад/ })[0]);
    expect(onResolve).toHaveBeenCalledWith(СПЕКА_СПОР.id, "cand:1");
  });
});

describe("статус ввоза вместо сводки (§2 ТЗ, Ф-E)", () => {
  it("зелёная сводка без вопросов — «Готово к импорту», счётчиков нет", () => {
    render(<Harness initial={["nodes: a"]} summary={green(["Ярмарка", "orders"])} />);

    expect(screen.getByText("Готово к импорту")).toBeInTheDocument();
    expect(screen.queryByText(/Готово к импорту: /)).toBeNull();
    expect(screen.queryByText(/Корневые:/)).toBeNull();
    expect(screen.queryByText(/Без ваших решений не объединить/)).toBeNull();
  });

  it("есть вопросы — статус зовёт их разобрать, блок показывает первый", () => {
    render(
      <Harness
        initial={["nodes: a"]}
        summary={green(["Ярмарка", "orders"])}
        remainder={разбор({ conflicts: [СПЕКА_СПОР] })}
      />,
    );

    expect(screen.getByText("Есть вопросы")).toBeInTheDocument();
    expect(screen.getByText("вопрос 1 из 1")).toBeInTheDocument();
  });

  it("незакрываемое замечание тоже переводит статус в «Есть вопросы»", () => {
    render(
      <Harness
        initial={["nodes: a"]}
        summary={green(["Ярмарка"])}
        remainder={разбор({
          remainder: остаток({
            unfixable: [{
              id: "u1",
              text: "«Поллер» (на верхнем уровне) в разных файлах имеет разные метаданные.",
              file: null,
            }],
          }),
        })}
      />,
    );

    expect(screen.getByText("Есть вопросы")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Придется подправить вручную (1)" }))
      .toBeInTheDocument();
  });

  it("отказ разбора: статус красный, строка ошибки, блока вопросов нет", () => {
    // Одно-файловый режим не особый: бэк кладёт ошибку в корзину файла 1
    // (import_merge.split_remarks), и статус называет вход с номером строки.
    const плохой = "Некорректный YAML: ошибка разметки (строка 29). Частая причина — двоеточие";
    paint(red([плохой], { file_remarks: [{ file: 1, errors: [плохой], warnings: [] }] }));

    expect(screen.getByText("Что-то пошло не так")).toBeInTheDocument();
    expect(screen.getByText(/Проблема в файле/).textContent).toBe(
      "Проблема в файле 1. Строка 29: Некорректный YAML: ошибка разметки."
      + " Частая причина — двоеточие.");
    expect(screen.queryByText("Не получается разобрать YAML:")).toBeNull();
    expect(screen.queryByText(/Без ваших решений не объединить/)).toBeNull();
  });

  it("ошибка без файла-виновника — без чипа и без ссылки", () => {
    paint(red(["входы не имеют общих корневых узлов"], {
      files: 2, schema_errors: ["входы не имеют общих корневых узлов"],
    }));

    expect(screen.getByText("Что-то пошло не так")).toBeInTheDocument();
    expect(screen.getByText("входы не имеют общих корневых узлов.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Открыть файл/ })).toBeNull();
  });

  it("ссылка статуса делает виновника активным входом", async () => {
    const битый = red(["файл 2: nodes[0]: name — обязательная непустая строка"], {
      files: 2,
      file_remarks: [
        { file: 1, errors: [], warnings: [] },
        { file: 2, errors: ["Строка 3: name — обязательная непустая строка"], warnings: [] },
      ],
    });
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={битый} />);

    expect(screen.getByText(/Проблема в файле/).textContent).toBe(
      "Проблема в файле 2. Строка 3: name — обязательная непустая строка.");
    await userEvent.click(screen.getByRole("button", { name: "Открыть файл 2" }));
    // Активен второй чип: вход, который надо чинить, открыт в редакторе.
    expect(chip("Файл 2").closest(".cp-chip")).toHaveClass("cp-chip--on");
    expect(screen.getByDisplayValue("nodes: b")).toBeInTheDocument();
  });
});
