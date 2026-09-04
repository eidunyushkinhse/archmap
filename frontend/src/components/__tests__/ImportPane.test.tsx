// Панель импорта YAML: то, что лечит «ампутацию» (полевой QA docs/qa-zabbix-7.md,
// раунд 2 — на замечания слабая модель отвечает удалением узлов: 31→27, 30→14).
//
// Закрепляем два обещания: замечания для агента звучат по-разному при ошибках
// разбора и при зелёной сводке с предупреждениями (во втором случае — «дополняй,
// не удаляй»), а пропавшие между попытками объекты названы поимённо, а не молчат.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ImportPane from "../project/ImportPane";
import type { ArchiveInputs } from "../project/ImportPane";
import type { FamilyConflictOut, ImportPreviewOut } from "../../types";

const writeText = vi.fn((_text: string) => Promise.resolve());

beforeEach(() => {
  writeText.mockClear();
  // jsdom не даёт navigator.clipboard — подменяем целиком.
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

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

// ── мульти-файловый режим: замечания адресованы (Ф6) ────────────────────────
//
// Панель принимает YAML НЕСКОЛЬКИХ репозиториев, у каждого свой агент, видящий
// только свой код. Плоский список замечаний с одной кнопкой отдавал агенту
// репозитория A замечания к файлу B и к слитой схеме, которых он починить не может.
// Закрепляем: у каждого файла свой список и своя кнопка, схемные замечания
// показываются, но агенту не уезжают.

const Ф1 = "связь «orders → kafka»: конец — брокер «kafka», а канал не указан";
const Ф2 = "связь «payments → orders»: в channel перечень «a, b» — разделите";
const СХЕМА = "Ярмарка / orders: technology: оставлено «Go» (файл 1), отброшено «Rust» (файл 2)";

// Сводка двух файлов. Плоские warnings — объединение корзин (так их собирает бэк):
// мутация «кнопка копирует плоский список» обязана уронить тесты ниже.
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
function Harness({ initial, summary, archives }: {
  initial: string[]; summary: ImportPreviewOut | null; archives?: ArchiveInputs;
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
    />
  );
}

const chip = (name: string | RegExp) => screen.getByRole("button", { name });

describe("мульти-файловый импорт: пофайловые замечания", () => {
  it("список замечаний — активного файла, переключение чипа его меняет", async () => {
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={двухфайловая()} />);

    expect(screen.getByText(/Замечания к файлу 1/)).toBeInTheDocument();
    expect(screen.getByText(Ф1)).toBeInTheDocument();
    expect(screen.queryByText(Ф2)).toBeNull();

    await userEvent.click(chip("Файл 2"));
    expect(screen.getByText(/Замечания к файлу 2/)).toBeInTheDocument();
    expect(screen.getByText(Ф2)).toBeInTheDocument();
    expect(screen.queryByText(Ф1)).toBeNull();
  });

  it("кнопка копирует замечания ТОЛЬКО активного файла", async () => {
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={двухфайловая()} />);

    const первый = await copyRemarks();
    expect(первый).toContain(`- ${Ф1}`);
    expect(первый).not.toContain(Ф2);
    expect(первый).not.toContain(СХЕМА);

    writeText.mockClear();
    await userEvent.click(chip("Файл 2"));
    // Подпись кнопки на две секунды после копирования — «Скопировано ✓».
    await userEvent.click(screen.getByRole("button", { name: /Скопирова(ть замечания|но)/ }));
    const второй = writeText.mock.calls[0][0];
    expect(второй).toContain(`- ${Ф2}`);
    expect(второй).not.toContain(Ф1);
    expect(второй).not.toContain(СХЕМА);
  });

  it("интро говорит агенту, что его файл — один из нескольких", async () => {
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={двухфайловая()} />);

    const text = await copyRemarks();
    expect(text).toContain("один из нескольких файлов системы");
    // Урок «ампутации» из одно-файлового интро сохранён.
    expect(text).toContain("ДОПОЛНЯЯ схему");
    expect(text).toContain("а НЕ удаляй объекты");
    expect(text).toContain("СВОЙ YAML-документ");
  });

  it("замечания слитой схемы показаны отдельной секцией и агенту не уезжают", async () => {
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={двухфайловая()} />);

    expect(screen.getByText("Замечания к слитой схеме:")).toBeInTheDocument();
    expect(screen.getByText(СХЕМА)).toBeInTheDocument();
    expect(screen.getByText(/о взаимном устройстве файлов/)).toHaveTextContent(
      "добавьте файлы остальных репозиториев",
    );
    // У секции нет своей кнопки: копирование в панели ровно одно — пофайловое.
    expect(screen.getAllByRole("button", { name: /Скопировать замечания/ })).toHaveLength(1);
    expect(await copyRemarks()).not.toContain(СХЕМА);
  });

  it("файл без замечаний говорит об этом, кнопки у него нет", async () => {
    render(
      <Harness
        initial={["nodes: a", "nodes: b"]}
        summary={двухфайловая({
          warnings: [Ф1, СХЕМА],
          file_remarks: [
            { file: 1, errors: [], warnings: [Ф1] },
            { file: 2, errors: [], warnings: [] },
          ],
        })}
      />,
    );

    await userEvent.click(chip("Файл 2"));
    expect(screen.getByText("К файлу 2 замечаний нет.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Скопировать замечания/ })).toBeNull();
  });

  it("ошибки разбора адресуют к файлу-виновнику, а его список — без префикса", async () => {
    const битый = red(["файл 2: nodes[0]: name — обязательная непустая строка"], {
      files: 2,
      file_remarks: [
        { file: 1, errors: [], warnings: [] },
        { file: 2, errors: ["nodes[0]: name — обязательная непустая строка"], warnings: [] },
      ],
    });
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={битый} />);

    expect(screen.getByText(/Замечания к файлу 2 —/)).toBeInTheDocument();
    await userEvent.click(chip("Файл 2"));
    const text = await copyRemarks();
    expect(text).toContain("- nodes[0]: name — обязательная непустая строка");
    expect(text).not.toContain("файл 2:");
    expect(text).toContain("нашёл замечания к вашему YAML-файлу");
  });

  it("конфирм после копирования убирает ТОЛЬКО активный файл", async () => {
    render(<Harness initial={["nodes: a", "nodes: b"]} summary={двухфайловая()} />);

    await userEvent.click(chip("Файл 2"));
    await copyRemarks();
    expect(screen.getByText(/этот файл в панели устареет/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Убрать этот файл из панели" }));
    // Остался один документ — крестиков и второго чипа больше нет.
    expect(screen.queryByRole("button", { name: "Файл 2" })).toBeNull();
    expect(chip("Файл 1")).toBeInTheDocument();
  });

  it("имя файла с диска попадает в чип и в заголовок его замечаний", async () => {
    render(<Harness initial={[""]} summary={двухфайловая()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, [
      new File(["nodes: a"], "billing.yaml", { type: "text/plain" }),
      new File(["nodes: b"], "orders.yaml", { type: "text/plain" }),
    ]);

    await waitFor(() => expect(chip("1 · billing.yaml")).toBeInTheDocument());
    expect(chip("2 · orders.yaml")).toBeInTheDocument();
    // Активен последний загруженный — заголовок называет и номер, и имя.
    expect(screen.getByText("Замечания к файлу 2 · orders.yaml:")).toBeInTheDocument();
  });
});

describe("одно-файловый режим не изменился (регрессия Ф6)", () => {
  it("одна кнопка, прежнее интро, все замечания списком", async () => {
    paint(green(["Ярмарка", "orders"], {
      conflicts: ["C1"],
      warnings: ["W1"],
      // Бэк при одном файле кладёт всё сюда же — панель этих полей не касается.
      file_remarks: [{ file: 1, errors: [], warnings: ["C1", "W1"] }],
    }));

    expect(screen.getByText("Конфликты слияния (оставлено первое значение):")).toBeInTheDocument();
    expect(screen.getByText("Проверьте:")).toBeInTheDocument();
    expect(screen.queryByText(/Замечания к файлу/)).toBeNull();
    expect(screen.queryByText("Замечания к слитой схеме:")).toBeNull();

    const text = await copyRemarks();
    expect(text).toContain("принял YAML, но оставил предупреждения");
    expect(text).not.toContain("один из нескольких файлов");
    expect(text).toContain("- C1");
    expect(text).toContain("- W1");
  });

  it("вопрос об устаревании по-прежнему про весь вход", async () => {
    const onDocs = vi.fn();
    paintDocs(["nodes: a"], red(["Некорректный YAML: ошибка (строка 3)"]), onDocs);
    await copyRemarks();

    expect(screen.getByText(/текущие файлы в панели устареют/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Убрать из панели" }));
    expect(onDocs).toHaveBeenCalledWith([""]);
  });
});

// ── единая панель: архивные входы (Ф2б) ──────────────────────────────────────
//
// Архив знания — такой же вход, как YAML: свой чип в той же полосе, свой номер
// (нумерация входов сплошная — на неё ссылаются замечания бэка) и свои замечания.
// Правит его не агент, а экспорт, поэтому кнопки «для агента» у него нет, а тело
// не редактируется — вместо textarea карточка.

const ЗАМ_АРХИВА = "docs/orders.mmd: узел «Нет такого» не найден — файл пропущен";

const архивы = (over: Partial<ArchiveInputs> = {}): ArchiveInputs => ({
  files: [new File(["zip"], "archmap.zip", { type: "application/zip" })],
  onFiles: vi.fn(),
  counts: { docs: 3, specs: 1, tables: 0, channels: 0, params: 0, processes: 0 },
  conflicts: [],
  resolutions: {},
  onResolve: vi.fn(),
  ...over,
});

const СПЕКА_СПОР: FamilyConflictOut = {
  id: "spec|Ярмарка / orders|openapi",
  family: "spec",
  node_path: "Ярмарка / orders",
  key: "openapi",
  candidates: [
    { origin: 0, origin_label: "a.zip", summary: "12 строк, 400 Б", body: "openapi: 3.0.0", truncated: false, current: false },
    { origin: 1, origin_label: "b.zip", summary: "20 строк, 800 Б", body: "openapi: 3.1.0", truncated: true, current: false },
  ],
  default: "cand:0",
  allow_all: false,
};

describe("архивные входы единой панели", () => {
  it("чип архива помечен «zip» и продолжает нумерацию входов", () => {
    render(<Harness initial={["nodes: a"]} summary={двухфайловая()} archives={архивы()} />);

    // Один непустой YAML — архив занимает вход 2 (им же подписаны его замечания).
    expect(chip("zip 2 · archmap.zip")).toBeInTheDocument();
    // Знание архива в C4-счётчиках не видно — его называет отдельная строка.
    expect(screen.getByText(/Из архивов:/)).toHaveTextContent("3 схемы логики · 1 спека");
  });

  it("клик по чипу архива открывает карточку с замечаниями ЕГО входа", async () => {
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

    expect(screen.getByText("Замечания к архиву:")).toBeInTheDocument();
    expect(screen.getByText(ЗАМ_АРХИВА)).toBeInTheDocument();
    expect(screen.queryByText(Ф1)).toBeNull();
    // Тело архива не правят — textarea заменена карточкой.
    expect(screen.queryByPlaceholderText(/Перетащите сюда/)).toBeNull();
    // Архив собирал экспорт, а не агент: кнопки «для агента» у него нет.
    expect(screen.queryByRole("button", { name: /Скопировать замечания/ })).toBeNull();
  });

  it("архив без замечаний говорит об этом (корзина бывает короче номера)", async () => {
    render(
      <Harness
        initial={["nodes: a"]}
        summary={двухфайловая({ file_remarks: [{ file: 1, errors: [], warnings: [Ф1] }] })}
        archives={архивы()}
      />,
    );

    await userEvent.click(chip("zip 2 · archmap.zip"));
    expect(screen.getByText("К архиву замечаний нет.")).toBeInTheDocument();
  });

  it("спор содержимого: предвыбран дефолт, выбор уходит наверх", async () => {
    const onResolve = vi.fn();
    render(
      <Harness
        initial={["nodes: a"]}
        summary={двухфайловая()}
        archives={архивы({ conflicts: [СПЕКА_СПОР], onResolve })}
      />,
    );

    expect(screen.getByText("Споры содержимого (1)")).toBeInTheDocument();
    expect(screen.getByText("Спека API · openapi")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /a\.zip · 12 строк/ })).toBeChecked();
    // Скаляру брать всё некуда — вариант «взять все» есть только у доков.
    expect(screen.queryByRole("radio", { name: /Взять все/ })).toBeNull();
    // Обрезанное тело честно говорит, что показано начало.
    expect(screen.getByText("…показано начало")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /b\.zip · 20 строк/ }));
    expect(onResolve).toHaveBeenCalledWith(СПЕКА_СПОР.id, "cand:1");
  });
});
