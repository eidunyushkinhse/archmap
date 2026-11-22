// Панель ввоза окна «Новый проект»: пропавшие между попытками объекты названы поимённо, а
// не молчат (полевой QA docs/qa-zabbix-7.md, раунд 2 — «ампутация» 31→27, 30→14).
//
// Правка Ф2г: панель НЕ ЗНАЕТ, откуда файлы, — в ней нет ни карточки «Замечания к
// файлу N», ни кнопки «Скопировать замечания для агента», ни заметки о повторном
// входе; пофайловые замечания уехали в свёртку «Придется подправить вручную»,
// ошибки разбора — только в красном статусе.
//
// С Ф-E панель говорит о ввозе одной СТРОКОЙ СТАТУСА вместо сводки счётчиков, а
// остаток слияния показывает вопросами.
//
// Редизайн (фаза 6б): входы — общая зона файлов (FileZone) и список имён вместо чипов.
// YAML с диска подписан именем, вставленный текстом — «Файл N» (его номер входа, им же
// бэк подписывает источник: «Из файла N»), архив — именем; одинаковые имена различаются
// номером. Имя YAML открывает его текст в поле, у архива открывать нечего.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ImportPane from "../project/ImportPane";
import type { RemainderInputs } from "../project/ImportPane";
import { useImportInputs } from "../project/useImportInputs";
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
  unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [], node_elements: [],
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

// Входами владеет родитель (useImportInputs в окне) — здесь его роль играет обёртка.
// Вставленные тексты — входы без имени; порядок входов превью виден строкой «входы».
function Harness({ initial = [], summary, remainder }: {
  initial?: string[]; summary: ImportPreviewOut | null; remainder?: RemainderInputs;
}) {
  const inputs = useImportInputs(initial.map((text) => ({ text, name: null })));
  return (
    <>
      <ImportPane
        inputs={inputs}
        text="Перетащите сюда файлы YAML или архивы .zip"
        pastePlaceholder="Вставьте сюда YAML"
        summary={summary}
        remainder={remainder ?? разбор()}
      />
      <output data-testid="входы">{inputs.files.map((f) => f.name || "без имени").join(", ")}</output>
    </>
  );
}

// Сводку приносит родитель (дебаунс dry-run живёт в useUnifiedImport) — здесь попытки
// агента моделируются перерисовкой с новой сводкой.
function paint(summary: ImportPreviewOut | null) {
  const view = render(<Harness initial={["nodes:"]} summary={summary} />);
  return (next: ImportPreviewOut | null) => view.rerender(<Harness initial={["nodes:"]} summary={next} />);
}

const файлы = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const имя = (name: string | RegExp) => screen.getByRole("button", { name });
const входы = () => screen.getByTestId("входы").textContent;

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

describe("мульти-файловый импорт: замечания не адресуются агенту файла", () => {
  it("ни карточки «Замечания к файлу N», ни строки «замечаний нет», ни копии", async () => {
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={двухфайловая()} />);

    expect(screen.queryByText(/Замечания к файлу/)).toBeNull();
    expect(screen.queryByText(/замечаний нет/)).toBeNull();
    expect(screen.queryByText(Ф1)).toBeNull();
    expect(screen.queryByText(СХЕМА)).toBeNull();
    expect(screen.queryByRole("button", { name: /Скопировать замечания/ })).toBeNull();

    // Открытие другого входа ничего такого не показывает.
    await userEvent.click(имя("Файл 2"));
    expect(screen.queryByText(/Замечания к файлу/)).toBeNull();
    expect(screen.queryByText(Ф2)).toBeNull();
  });

  it("пофайловые замечания — пунктами свёртки, а не списком под файлом", async () => {
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
    expect(within(document.querySelector(".rq-uf") as HTMLElement).getByRole("listitem")).toHaveTextContent(
      "У связи «orders → kafka» с брокером «kafka» не указан канал.");
  });

  it("имена файлов с диска — в списке, текст открывается по имени", async () => {
    render(<Harness summary={двухфайловая()} />);
    await userEvent.upload(файлы(), [
      new File(["nodes: a"], "billing.yaml", { type: "text/plain" }),
      new File(["nodes: b"], "orders.yaml", { type: "text/plain" }),
    ]);

    await waitFor(() => expect(имя("billing.yaml")).toBeInTheDocument());
    // Поля нет, пока файл не открыт: принесённый файл читают, а не правят.
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(имя("orders.yaml"));
    expect(screen.getByRole("textbox", { name: "Текст orders.yaml" })).toHaveValue("nodes: b");
    expect(имя("orders.yaml")).toHaveAttribute("aria-pressed", "true");
    expect(входы()).toBe("billing.yaml, orders.yaml");
  });

  it("одинаковые имена различаются номером входа", async () => {
    render(<Harness summary={null} />);
    await userEvent.upload(файлы(), [
      new File(["nodes: a"], "schema.yaml"),
      new File(["nodes: b"], "schema.yaml"),
    ]);
    await waitFor(() => expect(имя("schema.yaml (1)")).toBeInTheDocument());
    expect(имя("schema.yaml (2)")).toBeInTheDocument();
  });

  it("вставка текстом: запись «Файл N» с полем, пустая в превью не едет", async () => {
    render(<Harness summary={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Вставить текст" }));
    const поле = screen.getByRole("textbox", { name: "Текст Файл 1" });
    expect(поле).toHaveAttribute("placeholder", "Вставьте сюда YAML");
    expect(входы()).toBe("");
    await userEvent.type(поле, "nodes: a");
    // Вставленный текстом вход уезжает без имени (Ф2г).
    expect(входы()).toBe("без имени");
    await userEvent.click(screen.getByRole("button", { name: "Убрать Файл 1" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(входы()).toBe("");
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
    const again = paint(green(["Система"]));
    again(green(["Система"]));
    expect(screen.queryByText(/Содержимое не изменилось/)).toBeNull();
    expect(screen.queryByText(/агент/)).toBeNull();
  });
});

// ── архивные входы (Ф2б) ─────────────────────────────────────────────────────
//
// Архив знания — такой же вход, как YAML: своё имя в том же списке и свой номер (нумерация
// входов сплошная: непустые YAML, затем архивы — на неё ссылаются ошибки бэка).

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

describe("архивные входы", () => {
  it("архив — в списке после YAML и в превью после них, открывать у него нечего", async () => {
    render(<Harness initial={["nodes: a"]} summary={двухфайловая()} />);
    await userEvent.upload(файлы(), [
      new File(["zip"], "archmap.zip", { type: "application/zip" }),
      new File(["nodes: b"], "b.yaml"),
    ]);

    await waitFor(() => expect(входы()).toBe("без имени, b.yaml, archmap.zip"));
    const список = within(screen.getByRole("list", { name: "Файлы" }));
    expect(список.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Файл 1×", "b.yaml×", "archmap.zip×",
    ]);
    // Имя архива — не кнопка: тело архива не правят.
    expect(screen.queryByRole("button", { name: "archmap.zip" })).toBeNull();
    // Счётчиков приезжающего знания в панели больше нет (Ф-E).
    expect(screen.queryByText(/Из архивов:/)).toBeNull();
    expect(screen.queryByText(/Готово к импорту: /)).toBeNull();
  });

  it("ошибка в архиве названа его именем, без ссылки «Открыть файл»", async () => {
    const битый = red(["файл 2: архив повреждён"], {
      files: 2,
      file_remarks: [
        { file: 1, errors: [], warnings: [] },
        { file: 2, errors: ["архив повреждён"], warnings: [] },
      ],
    });
    render(<Harness initial={["nodes: a"]} summary={битый} />);
    await userEvent.upload(файлы(), [new File(["zip"], "donor.zip")]);

    await waitFor(() => expect(screen.getByText(/Проблема в файле/)).toHaveTextContent(
      "Проблема в файле donor.zip: архив повреждён."));
    expect(screen.queryByRole("button", { name: /Открыть файл/ })).toBeNull();
  });

  it("спор содержимого стал вопросом разбора, выбор уходит наверх", async () => {
    const onResolve = vi.fn();
    render(
      <Harness
        initial={["nodes: a"]}
        summary={двухфайловая()}
        remainder={разбор({ conflicts: [СПЕКА_СПОР], onResolve })}
      />,
    );

    // Прежней секции «Споры содержимого (1)» с радиокнопками нет: спор задан
    // вопросом, кандидаты подписаны источником знания, а не именем файла.
    expect(screen.queryByText("Споры содержимого (1)")).toBeNull();
    expect(screen.getByText(/Без ваших решений не объединить/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe(
      "У объекта «openapi» в разных файлах разные спецификации с одинаковым названием."
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

  it("есть вопросы — статус «не всё сошлось», блок показывает первый", () => {
    render(
      <Harness
        initial={["nodes: a"]}
        summary={green(["Ярмарка", "orders"])}
        remainder={разбор({ conflicts: [СПЕКА_СПОР] })}
      />,
    );

    expect(screen.getByText("Не всё сошлось идеально")).toBeInTheDocument();
    expect(screen.getByText("вопрос 1 из 1")).toBeInTheDocument();
  });

  it("незакрываемое замечание без вопросов — тоже «Не всё сошлось идеально»", () => {
    render(
      <Harness
        initial={["nodes: a"]}
        summary={green(["Ярмарка"])}
        remainder={разбор({
          remainder: остаток({
            unfixable: [{
              id: "u1",
              text: "У «Поллер» (на верхнем уровне) в разных файлах разные источники.",
              file: null,
            }],
          }),
        })}
      />,
    );

    expect(screen.getByText("Не всё сошлось идеально")).toBeInTheDocument();
    // Ф2г-2: состояние бывает и без вопросов — прежнее «Есть вопросы» тут врало бы.
    expect(screen.queryByText("Есть вопросы")).toBeNull();
    expect(screen.queryByText(/Без ваших решений не объединить/)).toBeNull();
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

  it("ошибка без файла-виновника — без подписи файла и без ссылки", () => {
    paint(red(["входы не имеют общих корневых узлов"], {
      files: 2, schema_errors: ["входы не имеют общих корневых узлов"],
    }));

    expect(screen.getByText("Что-то пошло не так")).toBeInTheDocument();
    expect(screen.getByText("входы не имеют общих корневых узлов.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Открыть файл/ })).toBeNull();
  });

  it("два битых файла — список под статусом, пункт на ошибку со ссылкой на вход", async () => {
    const битые = red([
      "файл 1: Некорректный YAML: ошибка разметки (строка 3)",
      "файл 3: nodes[0]: name — обязательная непустая строка",
    ], {
      files: 3,
      file_remarks: [
        { file: 1, errors: ["Некорректный YAML: ошибка разметки (строка 3)"], warnings: [] },
        { file: 2, errors: [], warnings: [] },
        { file: 3, errors: ["nodes[0]: name — обязательная непустая строка"], warnings: [] },
      ],
    });
    render(<Harness initial={["nodes: a", "nodes: b", "nodes: c"]} summary={битые} />);

    expect(screen.getByText("Что-то пошло не так")).toBeInTheDocument();
    const пункты = within(document.querySelector(".rq-st-sub ul") as HTMLElement).getAllByRole("listitem");
    expect(пункты.map((li) => li.textContent)).toEqual([
      "Файл 1. Строка 3: Некорректный YAML: ошибка разметки.",
      "Файл 3. nodes[0]: name — обязательная непустая строка.",
    ]);
    // Префиксы «файл N:» плоского списка сводки на экран не попадают.
    expect(screen.queryByText(/файл 1:/)).toBeNull();
    // В поле сначала последняя вставка; ссылка пункта открывает свой вход.
    expect(screen.getByDisplayValue("nodes: c")).toBeInTheDocument();
    await userEvent.click(within(пункты[0]!).getByRole("button", { name: "Файл 1" }));
    expect(screen.getByDisplayValue("nodes: a")).toBeInTheDocument();
  });

  it("ссылка статуса открывает виновника в поле", async () => {
    const битый = red(["файл 1: nodes[0]: name — обязательная непустая строка"], {
      files: 2,
      file_remarks: [
        { file: 1, errors: ["Строка 3: name — обязательная непустая строка"], warnings: [] },
        { file: 2, errors: [], warnings: [] },
      ],
    });
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={битый} />);

    expect(screen.getByText(/Проблема в файле/).textContent).toBe(
      "Проблема в файле 1. Строка 3: name — обязательная непустая строка.");
    // В поле сначала последняя вставка, не виновник.
    expect(имя("Файл 2")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Открыть файл 1" }));
    // Открыт первый вход: его текст в поле, имя отмечено.
    expect(имя("Файл 1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("nodes: a")).toBeInTheDocument();
  });
});
