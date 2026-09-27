// Догрузка архивов к ЖИВОМУ проекту (Ф4, docs/plan-unified-import.md).
//
// Что закрепляем: превью считает ДИФФ, а споры и остальной остаток задаются
// ВОПРОСАМИ (Ф-E) — живой кандидат подписан «Из проекта», дефолт бэка назван
// сноской, но не предвыбран; массовое «Взять из новых архивов» уезжает
// резолюциями на НЕ-текущих кандидатов и не трогает жесты; 409 применения — не
// тупик, а перезапрос превью с сохранением ручного выбора; отчёт применения
// виден в окне, и «Готово» уносит его строкой в тост.
//
// Фикстуры типизированы схемами контракта (не any): разъедется контракт — поймает
// tsc, а не глаз в проде. Поле current у кандидатов обязательно — по нему модалка
// отличает «моё» от привозного.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ImportIntoModal from "../project/ImportIntoModal";
import SchemaActions from "../SchemaActions";
import { projectsApi } from "../../api/projects";
import { ApiError } from "../../api/client";
import type {
  ContainerEdgeOut, FamilyConflictOut, IntoApplyOut, IntoPreviewOut, RemainderOut,
} from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    get: vi.fn(), importIntoPreview: vi.fn(), importIntoApply: vi.fn(),
  },
}));
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const СПОР: FamilyConflictOut = {
  id: "doc|Ярмарка/orders|Оформление заказа",
  family: "doc",
  node_path: "Ярмарка / orders",
  key: "Оформление заказа",
  candidates: [
    {
      origin: 0, origin_label: "Текущий проект", source_label: "Из проекта", summary: "12 строк",
      body: "flowchart TD\n  A-->B", truncated: false, current: true,
    },
    {
      origin: 1, origin_label: "b.zip", source_label: "Из архива Ярмарка", summary: "20 строк",
      body: "flowchart TD\n  A-->C", truncated: false, current: false,
    },
  ],
  default: "cand:0",
  allow_all: true,
};

// Второй спор — между двумя архивами, живого кандидата в нём нет: массовые
// действия его не трогают.
const СПОР_БЕЗ_МОЕГО: FamilyConflictOut = {
  ...СПОР,
  id: "spec|Ярмарка/api|openapi",
  family: "spec",
  key: "openapi",
  candidates: [
    { origin: 1, origin_label: "b.zip", source_label: "Из архива Ярмарка", summary: "3 операции", body: "openapi: 3", truncated: false, current: false },
    { origin: 2, origin_label: "c.zip", source_label: "Из архива Склад", summary: "5 операций", body: "openapi: 3.1", truncated: false, current: false },
  ],
  default: "cand:0",
  allow_all: false,
};

// Связь в контейнер (вопрос 4.3) — жест, а не спор: массовые кнопки его не трогают.
const В_КОНТЕЙНЕР: ContainerEdgeOut = {
  id: "edge|Склад / Синхронизатор|Ярмарка||target",
  from_path: "Склад / Синхронизатор", to_path: "Ярмарка",
  label: "заказы", technology: "HTTP", end: "target", container_path: "Ярмарка",
  components: [{ path: "Ярмарка / orders", has_children: false }],
};

const остаток = (over: Partial<RemainderOut> = {}): RemainderOut => ({
  field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
  unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [], ...over,
});

const превью = (over: Partial<IntoPreviewOut> = {}): IntoPreviewOut => ({
  ok: true,
  errors: [],
  nodes_new: 3,
  nodes_new_paths: ["Ярмарка / billing", "Ярмарка / billing / api"],
  new_nodes: [
    { path: "Ярмарка / billing", source: { repo: "github.com/org/billing" } },
    { path: "Ярмарка / billing / api", source: null },
  ],
  nodes_matched: 0,
  matched_nodes: [],
  edges_new: 2,
  families: { docs: 4, specs: 1, tables: 0, channels: 0, params: 0, processes: 1 },
  family_conflicts: [СПОР],
  // Остаток слияния (Ф-E) по умолчанию пуст — тесты разбора доливают своё.
  remainder: остаток(),
  warnings: ["процесс «Оплата» — тёзка уже имеющегося: приедет с суффиксом « (2)»"],
  base_graph_rev: 7,
  base_meta_rev: 11,
  ...over,
});

const ОТЧЁТ: IntoApplyOut = {
  project_id: "p-1",
  nodes_created: 3,
  nodes_filled: 1,
  edges_created: 2,
  docs_created: 4,
  docs_replaced: 1,
  specs_applied: 1,
  params_replaced: 0,
  db: null,
  channels: null,
  config: null,
  processes: [],
  warnings: ["docs/x.mmd: узел «Нет такого» не найден — файл пропущен"],
  // Экрану — пункты свёртки (Ф2г-2), сырые warnings — для MCP.
  unfixable: [{
    id: "input|1|0", file: 1,
    text: "b.zip: docs/x.mmd: узел «Нет такого» не найден — файл пропущен",
  }],
  resolved_conflicts: 1,
  channel_stubs: 0,
  graph_rev: 8,
  meta_rev: 12,
};

const onApplied = vi.fn();
const onClose = vi.fn();

/** Скрытый input окна принимает .zip (в jsdom файл — обычный new File). */
function положить(...файлы: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  return userEvent.upload(input, файлы);
}

const zip = (name: string) => new File(["PK"], name, { type: "application/zip" });

/** Аргументы последнего применения. */
const применение = () => vi.mocked(projectsApi.importIntoApply).mock.calls.at(-1);

async function открыть(...файлы: File[]) {
  render(<ImportIntoModal projectId="p-1" onClose={onClose} onApplied={onApplied} />);
  await положить(...(файлы.length ? файлы : [zip("b.zip")]));
  await waitFor(() => expect(projectsApi.importIntoPreview).toHaveBeenCalled());
}

const применить = () => screen.getByRole("button", { name: "Применить" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью());
  vi.mocked(projectsApi.importIntoApply).mockResolvedValue(ОТЧЁТ);
});

describe("догрузка архива · превью и споры", () => {
  it("архив положен: дифф, семьи и спор вопросом с живым кандидатом «Из проекта»", async () => {
    await открыть(zip("b.zip"));

    expect(await screen.findByText(/Нового: 3 объекта · 2 связи/)).toBeInTheDocument();
    expect(screen.getByText(/Приедет:.*4 схемы логики/)).toBeInTheDocument();
    expect(screen.getByText("Ярмарка / billing")).toBeInTheDocument();
    // Ф2г: сырых строк «Проверьте» в окне нет — тёзку показывает свёртка
    // «Придется подправить вручную» пунктом с бэка (remainder.unfixable).
    expect(screen.queryByText(/тёзка уже имеющегося/)).toBeNull();

    // Спор задан ВОПРОСОМ: прежней секции с радиокнопками нет, кандидаты
    // подписаны источником знания, живой — «Из проекта» (§4.7).
    expect(screen.getByText("Не всё сошлось идеально")).toBeInTheDocument();
    expect(screen.queryByText("Споры содержимого (1)")).toBeNull();
    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe(
      "У объекта «Оформление заказа» в разных источниках разные схемы с одинаковым"
      + " названием. Какую считаем правильной?");
    const моё = screen.getByRole("button", { name: "Из проекта" });
    const изАрхива = screen.getByRole("button", { name: "Из архива Ярмарка" });
    // Ничего не предвыбрано: дефолт бэка («оставить моё») назван сноской, а не
    // галкой — перетереть живое знание можно только явным выбором.
    expect(моё).toHaveAttribute("aria-pressed", "false");
    expect(изАрхива).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Если не отвечать/).textContent).toContain(
      "в проект попадёт вариант «Из проекта»");

    // Файлы уехали в превью в том порядке, в каком их видит пользователь.
    const [id, files] = vi.mocked(projectsApi.importIntoPreview).mock.calls[0];
    expect(id).toBe("p-1");
    expect(files.map((f) => f.name)).toEqual(["b.zip"]);
  });

  it("«везде взять из архивов» уводит выбор на НЕ-текущих кандидатов", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({
      family_conflicts: [СПОР, СПОР_БЕЗ_МОЕГО],
      remainder: остаток({ container_edges: [В_КОНТЕЙНЕР] }),
    }));
    await открыть(zip("b.zip"), zip("c.zip"));
    await screen.findByText("вопрос 1 из 3");

    await userEvent.click(screen.getByRole("button", { name: "Взять из новых архивов" }));
    expect(screen.getByRole("button", { name: "Из архива Ярмарка" }))
      .toHaveAttribute("aria-pressed", "true");
    // Обратное массовое действие снимает выбор — дефолт бэка и есть «моё».
    await userEvent.click(screen.getByRole("button", { name: "Оставить, как было в проекте" }));
    expect(screen.getByRole("button", { name: "Из архива Ярмарка" }))
      .toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "Взять из новых архивов" }));

    await userEvent.click(применить());
    await waitFor(() => expect(projectsApi.importIntoApply).toHaveBeenCalled());
    const [, files, opts] = применение() ?? [];
    expect(files?.map((f) => f.name)).toEqual(["b.zip", "c.zip"]);
    // Спор с живым переведён на архивного кандидата; спор двух архивов не тронут.
    expect(opts?.resolutions).toEqual({ [СПОР.id]: "cand:1" });
    // Жест (связь в контейнер) массовой кнопкой не закрывается — он остался без
    // ответа, и в применение не уехало ничего лишнего.
    expect(opts?.decisions).toBeNull();
    // Fence — из ТЕКУЩЕГО превью.
    expect(opts?.baseGraphRev).toBe(7);
    expect(opts?.baseMetaRev).toBe(11);
  });

  it("жест разбора уезжает решением, и ради одних вопросов кнопка жива", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({
      nodes_new: 0, new_nodes: [], nodes_new_paths: [], edges_new: 0,
      families: { docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0 },
      family_conflicts: [],
      remainder: остаток({ container_edges: [В_КОНТЕЙНЕР] }),
    }));
    await открыть(zip("b.zip"));
    await screen.findByText("вопрос 1 из 1");

    // Сноска в догрузке говорит о ДОГРУЗКЕ: проект уже создан.
    expect(screen.getByText(/Если не отвечать/).textContent).toContain(
      "после догрузки будет ждать в панели незавершённости");
    // Массовых кнопок нет: спорить не с чем, а жест закрывает только человек.
    expect(screen.queryByRole("button", { name: "Взять из новых архивов" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /orders/ }));
    // Нового архив не везёт, но разобрать вопрос — уже повод применить.
    expect(применить()).toBeEnabled();
    await userEvent.click(применить());

    await waitFor(() => expect(projectsApi.importIntoApply).toHaveBeenCalled());
    const [, , opts] = применение() ?? [];
    expect(opts?.decisions).toEqual({
      edges: { [В_КОНТЕЙНЕР.id]: { to_path: "Ярмарка / orders" } },
    });
  });

  it("409 применения: превью перезапрошено, ручной выбор уцелел", async () => {
    await открыть(zip("b.zip"));
    await screen.findByText("вопрос 1 из 1");

    await userEvent.click(screen.getByRole("button", { name: "Из архива Ярмарка" }));
    expect(screen.getByRole("button", { name: "Из архива Ярмарка" }))
      .toHaveAttribute("aria-pressed", "true");

    vi.mocked(projectsApi.importIntoApply).mockRejectedValueOnce(
      new ApiError(409, "Проект изменился после расчёта — обновите превью и повторите"),
    );
    // Свежий план после 409 — с другим fence: применение обязано уехать уже с ним.
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(
      превью({ base_graph_rev: 9, base_meta_rev: 13 }),
    );

    await userEvent.click(применить());

    expect(await screen.findByText(/превью обновлено, проверьте и повторите/)).toBeInTheDocument();
    await waitFor(() => expect(projectsApi.importIntoPreview).toHaveBeenCalledTimes(2));
    // Выбор пережил перезапрос: id спора тот же, вариант остался выбранным.
    expect(screen.getByRole("button", { name: "Из архива Ярмарка" }))
      .toHaveAttribute("aria-pressed", "true");

    await userEvent.click(применить());
    await waitFor(() => expect(projectsApi.importIntoApply).toHaveBeenCalledTimes(2));
    const [, , opts] = применение() ?? [];
    expect(opts?.resolutions).toEqual({ [СПОР.id]: "cand:1" });
    expect(opts?.baseGraphRev).toBe(9);
  });

  it("успех: отчёт в окне, «Готово» уносит строку итога наверх", async () => {
    await открыть(zip("b.zip"));
    await screen.findByText(/Нового: 3 объекта/);

    await userEvent.click(применить());

    expect(await screen.findByText("Архивы догружены")).toBeInTheDocument();
    expect(screen.getByText(/Создано объектов: 3 · связей: 2/)).toBeInTheDocument();
    // Замечания видны ДО закрытия — свёрткой «Придется подправить вручную», а не
    // сырым списком «Замечания» (Ф2г-2): сырые строки ответа на экран не попадают.
    expect(screen.queryByText("Замечания")).toBeNull();
    expect(screen.queryByText("docs/x.mmd: узел «Нет такого» не найден — файл пропущен"))
      .toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Придется подправить вручную (1)" }));
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "b.zip: docs/x.mmd: узел «Нет такого» не найден — файл пропущен");
    expect(screen.getByText("Разрешено споров содержимого: 1")).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onApplied).toHaveBeenCalledWith(
      expect.stringMatching(/^Догружено: 3 объекта, 2 связи, 4 схемы логики/),
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe("догрузка архива · отказ и свёртка (правка Ф2г)", () => {
  it("два битых архива — список ошибок под красным статусом", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({
      ok: false,
      errors: ["a.zip: Файл не читается как zip-архив", "c.zip: В архиве нет файла C4 (contents.c4)"],
    }));
    await открыть(zip("a.zip"), zip("c.zip"));

    expect(await screen.findByText("Что-то пошло не так")).toBeInTheDocument();
    const пункты = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(пункты.map((li) => li.textContent)).toEqual([
      "a.zip: Файл не читается как zip-архив.",
      "c.zip: В архиве нет файла C4 (contents.c4).",
    ]);
    expect(применить()).toBeDisabled();
  });

  it("отчёт без замечаний — ни свёртки, ни пустого списка", async () => {
    vi.mocked(projectsApi.importIntoApply).mockResolvedValue({
      ...ОТЧЁТ, warnings: ["узел «Ярмарка / orders»: поле «роль» пустовало — залито из архива"],
      unfixable: [],
    });
    await открыть(zip("b.zip"));
    await screen.findByText(/Нового: 3 объекта/);
    await userEvent.click(применить());

    expect(await screen.findByText("Архивы догружены")).toBeInTheDocument();
    expect(screen.queryByText(/Придется подправить вручную/)).toBeNull();
    expect(screen.queryByText(/пустовало/)).toBeNull();
  });

  it("незакрываемое — свёрткой «Придется подправить вручную» без кнопок для агента", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({
      remainder: остаток({
        unfixable: [{
          id: "remark|3", file: null,
          text: "У файлов разные корневые объекты («Ярмарка», «Склад»), поэтому в проекте будет несколько корней.",
        }],
      }),
    }));
    await открыть(zip("b.zip"));

    await userEvent.click(await screen.findByRole("button", { name: "Придется подправить вручную (1)" }));
    expect(screen.getByText(/У файлов разные корневые объекты/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Скопировать замечани/ })).toBeNull();
  });
});

describe("меню «Действия со схемой» · пункт догрузки", () => {
  it("клик по пункту открывает окно догрузки", async () => {
    render(
      <SchemaActions
        projectId="p-1"
        isArchitect
        exportScope={{
          key: "all",
          title: "Экспорт схемы",
          load: () => Promise.resolve({ content: "" }),
          archive: { filename: "archmap.zip", load: () => Promise.resolve(new Blob()) },
        }}
        onSynced={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Действия со схемой" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Импорт проекта (zip)" }));

    expect(screen.getByText("Импорт проекта из архива")).toBeInTheDocument();
    // Пустое окно превью не запрашивает — считать нечего.
    expect(projectsApi.importIntoPreview).not.toHaveBeenCalled();
  });
});

describe("основание склейки и якоря новых (Ф2 docs/plan-anchor-ux.md)", () => {
  // Догрузка сопоставляет узлы ЯКОРЕМ, и до Ф2 самое спорное её решение — «это тот
  // же объект» — не показывалось вовсе: превью говорило только про новое.
  it("найденные в проекте названы с основанием каждой находки", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({
      nodes_matched: 5,
      matched_nodes: [
        { path: "Ярмарка / orders", basis: "code" },
        { path: "Ярмарка / Каталог-БД", basis: "dependency" },
        { path: "Ярмарка", basis: "name" },
      ],
    }));
    await открыть(zip("b.zip"));

    expect(await screen.findByText(/Найдено в проекте: 5 объектов/)).toBeInTheDocument();
    expect(screen.getByText("Ярмарка / orders — по коду")).toBeInTheDocument();
    expect(screen.getByText("Ярмарка / Каталог-БД — по имени зависимости")).toBeInTheDocument();
    expect(screen.getByText("Ярмарка — по имени на верхнем уровне")).toBeInTheDocument();
    // Перечень обрезан капом — остаток назван счётчиком, а не съеден молча.
    expect(screen.getByText("…ещё 2")).toBeInTheDocument();
  });

  it("сопоставлять нечего — строки нет вовсе", async () => {
    await открыть(zip("b.zip"));
    await screen.findByText(/Нового: 3 объекта/);

    expect(screen.queryByText(/Найдено в проекте/)).not.toBeInTheDocument();
  });

  it("у новых объектов помечено отсутствие якоря", async () => {
    await открыть(zip("b.zip"));

    // Фикстура: у «billing» якорь-код есть, у его компонента — нет.
    expect(await screen.findByText("Ярмарка / billing")).toBeInTheDocument();
    expect(screen.getByText(/Ярмарка \/ billing \/ api \(без якоря\)/)).toBeInTheDocument();
  });
});
