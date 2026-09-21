// Догрузка архивов к ЖИВОМУ проекту (Ф4, docs/plan-unified-import.md).
//
// Что закрепляем: превью считает ДИФФ и показывает споры, у спора с живым
// кандидатом предвыбран «мой» (дефолт ставит бэк — фронт его не перебивает);
// массовое «везде взять из архивов» уезжает резолюциями на НЕ-текущих кандидатов;
// 409 применения — не тупик, а перезапрос превью с сохранением ручного выбора;
// отчёт применения виден в окне, и «Готово» уносит его строкой в тост.
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
import type { FamilyConflictOut, IntoApplyOut, IntoPreviewOut } from "../../types";

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
  // Остаток слияния (Ф-E) в этих сценариях пуст: модалка проверяется по спорам.
  remainder: {
    field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
    unfixable: [], node_paths: [], node_has_children: [],
  },
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
  it("архив положен: дифф, семьи и спор с предвыбранным «моим»", async () => {
    await открыть(zip("b.zip"));

    expect(await screen.findByText(/Нового: 3 объекта · 2 связи/)).toBeInTheDocument();
    expect(screen.getByText(/Приедет:.*4 схемы логики/)).toBeInTheDocument();
    expect(screen.getByText("Ярмарка / billing")).toBeInTheDocument();
    expect(screen.getByText(/тёзка уже имеющегося/)).toBeInTheDocument();

    // Спор виден, кандидат текущего проекта различим НАЧЕРТАНИЕМ: лейбл входа №0
    // бэк фиксирует говорящим («Текущий проект»), текстовой приписки к нему нет.
    expect(screen.getByText("Споры содержимого (1)")).toBeInTheDocument();
    const моё = screen.getByRole("radio", { name: /Текущий проект · 12 строк/ });
    const изАрхива = screen.getByRole("radio", { name: /b\.zip · 20 строк/ });
    expect(within(моё.closest("label")!).getByText("Текущий проект"))
      .toHaveStyle({ fontWeight: "700" });
    expect(within(изАрхива.closest("label")!).getByText("b.zip"))
      .toHaveStyle({ fontWeight: "600" });
    expect(screen.queryByText(/— текущий проект/i)).not.toBeInTheDocument();
    // …и выбран по умолчанию: перетереть своё знание можно только руками.
    expect(моё).toBeChecked();
    expect(изАрхива).not.toBeChecked();

    // Файлы уехали в превью в том порядке, в каком их видит пользователь.
    const [id, files] = vi.mocked(projectsApi.importIntoPreview).mock.calls[0];
    expect(id).toBe("p-1");
    expect(files.map((f) => f.name)).toEqual(["b.zip"]);
  });

  it("«везде взять из архивов» уводит выбор на НЕ-текущих кандидатов", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(
      превью({ family_conflicts: [СПОР, СПОР_БЕЗ_МОЕГО] }),
    );
    await открыть(zip("b.zip"), zip("c.zip"));
    await screen.findByText("Споры содержимого (2)");

    await userEvent.click(screen.getByRole("button", { name: "Везде взять из архивов" }));
    expect(screen.getByRole("radio", { name: /b\.zip · 20 строк/ })).toBeChecked();
    // Обратное массовое действие снимает выбор — дефолт бэка и есть «моё».
    await userEvent.click(screen.getByRole("button", { name: "Везде оставить моё" }));
    expect(screen.getByRole("radio", { name: /Текущий проект/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Везде взять из архивов" }));

    await userEvent.click(применить());
    await waitFor(() => expect(projectsApi.importIntoApply).toHaveBeenCalled());
    const [, files, opts] = применение() ?? [];
    expect(files?.map((f) => f.name)).toEqual(["b.zip", "c.zip"]);
    // Спор с живым переведён на архивного кандидата; спор двух архивов не тронут.
    expect(opts?.resolutions).toEqual({ [СПОР.id]: "cand:1" });
    // Fence — из ТЕКУЩЕГО превью.
    expect(opts?.baseGraphRev).toBe(7);
    expect(opts?.baseMetaRev).toBe(11);
  });

  it("409 применения: превью перезапрошено, ручной выбор уцелел", async () => {
    await открыть(zip("b.zip"));
    await screen.findByText("Споры содержимого (1)");

    await userEvent.click(screen.getByRole("radio", { name: /b\.zip · 20 строк/ }));
    expect(screen.getByRole("radio", { name: /b\.zip · 20 строк/ })).toBeChecked();

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
    // Выбор пережил перезапрос: id спора тот же, галка на месте.
    expect(screen.getByRole("radio", { name: /b\.zip · 20 строк/ })).toBeChecked();

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
    // Замечания видны ДО закрытия — молча их проглотить нельзя.
    expect(screen.getByText(/Нет такого/)).toBeInTheDocument();
    expect(screen.getByText("Разрешено споров содержимого: 1")).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onApplied).toHaveBeenCalledWith(
      expect.stringMatching(/^Догружено: 3 объекта, 2 связи, 4 схемы логики/),
    );
    expect(onClose).toHaveBeenCalled();
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
