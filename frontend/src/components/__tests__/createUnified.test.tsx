// Единый ввоз в окне создания проекта (Ф2б, docs/plan-unified-import.md).
//
// Что закрепляем: отдельного таба «Из архива» нет — .zip такой же вход панели
// «Импорт», как YAML; при ЕДИНСТВЕННОМ входе-архиве поля имени и описания не
// показываются вовсе (П3 — они приедут из манифеста), споры содержимого
// разрешаются прямо в превью и уезжают в применение словарём резолюций, а отчёт
// применения показывается В ДИАЛОГЕ до перехода в проект (замечания — видимая
// деградация, прятать их за навигацией нельзя).
//
// Фикстуры типизированы схемами контракта (не any): разъедется контракт —
// поймает tsc, а не глаз в проде.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CreateProjectDialog from "../project/CreateProjectDialog";
import { projectsApi } from "../../api/projects";
import type {
  ArchiveImportResult, FamilyConflictOut, ImportPreviewOut, UnifiedPreviewOut,
} from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    templates: vi.fn(), importPrompt: vi.fn(), create: vi.fn(),
    unifiedPreview: vi.fn(), importUnified: vi.fn(),
  },
}));
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const c4 = (over: Partial<ImportPreviewOut> = {}): ImportPreviewOut => ({
  ok: true, errors: [], node_count: 4, edge_count: 1, roots: ["Ярмарка"],
  node_names: ["Ярмарка", "orders"], files: 1, merged_count: 0, merged: [],
  merged_nodes: [], nodes_without_anchor: 0,
  conflicts: [], warnings: [], dropped_edges: 0,
  file_remarks: [{ file: 1, errors: [], warnings: [] }],
  schema_errors: [], schema_warnings: [], ...over,
});

const превью = (over: Partial<UnifiedPreviewOut> = {}): UnifiedPreviewOut => ({
  ok: true, errors: [], c4: c4(),
  families: { docs: 2, specs: 1, tables: 0, channels: 0, params: 0, processes: 0 },
  family_conflicts: [],
  // Остаток слияния (Ф-E) в этих сценариях пуст: панель проверяется по сводке.
  remainder: {
    field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
    unfixable: [], node_paths: [], node_has_children: [],
  },
  warnings: [], name_source: "fields", ...over,
});

const ИЗ_МАНИФЕСТА = превью({
  name_source: "manifest", manifest_name: "Ярмарка v2", manifest_description: "демо-проект",
});

const СПОР: FamilyConflictOut = {
  id: "doc|Ярмарка/orders|Оформление заказа",
  family: "doc",
  node_path: "Ярмарка / orders",
  key: "Оформление заказа",
  candidates: [
    { origin: 0, origin_label: "a.zip", source_label: "Из архива Ярмарка", summary: "12 строк", body: "flowchart TD\n  A-->B", truncated: false, current: false },
    { origin: 1, origin_label: "b.zip", source_label: "Из архива Ярмарка", summary: "20 строк", body: "flowchart TD\n  A-->C", truncated: true, current: false },
  ],
  default: "all",
  allow_all: true,
};

const ОТЧЁТ: ArchiveImportResult = {
  project_id: "p-new",
  project_name: "Ярмарка",
  nodes: 4,
  edges: 1,
  docs_created: 2,
  specs_applied: 1,
  db: null,
  channels: null,
  config: null,
  processes: [],
  warnings: ["docs/x.mmd: узел «Нет такого» не найден — файл пропущен"],
  resolved_conflicts: 0,
  channel_stubs: 0,
};

const onCreated = vi.fn();
const ИМЯ = "Например, «Платёжная платформа»";

/** Открыть окно на табе «Импорт» — единой панели ввоза. */
async function открыть() {
  render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={onCreated} />);
  await userEvent.click(screen.getByText("Импорт"));
}

/** Скрытый input панели принимает и .yaml, и .zip. */
function положить(...файлы: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  return userEvent.upload(input, файлы);
}

/** Аргументы последнего вызова применения. */
const применение = () => vi.mocked(projectsApi.importUnified).mock.calls.at(-1);
/** Имена входов последнего превью — в том порядке, в каком они уехали. */
const входы = () =>
  vi.mocked(projectsApi.unifiedPreview).mock.calls.at(-1)?.[0].map((f) => f.name);

const кнопка = () => screen.getByRole("button", { name: /Создать проект|Открыть проект/ });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.templates).mockResolvedValue([]);
  vi.mocked(projectsApi.unifiedPreview).mockResolvedValue(превью());
  vi.mocked(projectsApi.importUnified).mockResolvedValue(ОТЧЁТ);
});

describe("единый ввоз · создание проекта", () => {
  it("один архив: имя из манифеста, поля скрыты, отчёт и переход в проект", async () => {
    vi.mocked(projectsApi.unifiedPreview).mockResolvedValue(ИЗ_МАНИФЕСТА);
    await открыть();
    // Таба «Из архива» больше нет — zip кладут в ту же панель.
    expect(screen.queryByText("Из архива")).toBeNull();
    expect(кнопка()).toBeDisabled();

    await положить(new File(["zip"], "archmap.zip", { type: "application/zip" }));

    expect(await screen.findByText(/Имя и описание — из архива/, {}, { timeout: 3000 }))
      .toHaveTextContent("«Ярмарка v2»");
    expect(screen.getByText("демо-проект")).toBeInTheDocument();
    // П3: полей нет вовсе, и кнопка активна без единого символа имени.
    expect(screen.queryByPlaceholderText(ИМЯ)).toBeNull();
    expect(кнопка()).toBeEnabled();

    await userEvent.click(кнопка());

    await waitFor(() => expect(projectsApi.importUnified).toHaveBeenCalled());
    const [файлы, опции] = применение() ?? [];
    expect(файлы?.map((f) => f.name)).toEqual(["archmap.zip"]);
    // Имя из манифеста — переопределения не подсовываем.
    expect(опции?.name).toBeUndefined();

    // Сводка и замечания видны ДО перехода — молча провалиться нельзя.
    expect(await screen.findByText("«Ярмарка» создан")).toBeInTheDocument();
    expect(screen.getByText(/Нет такого/)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Открыть проект" }));
    expect(onCreated).toHaveBeenCalledWith("p-new");
  });

  it("спор содержимого: выбор кандидата уезжает резолюциями", async () => {
    vi.mocked(projectsApi.unifiedPreview).mockResolvedValue(
      превью({ c4: c4({ files: 2 }), family_conflicts: [СПОР] }),
    );
    await открыть();
    await положить(
      new File(["a"], "a.zip", { type: "application/zip" }),
      new File(["b"], "b.zip", { type: "application/zip" }),
    );

    expect(await screen.findByText("Споры содержимого (1)", {}, { timeout: 3000 }))
      .toBeInTheDocument();
    expect(screen.getByText(/выберите, чьё описание ехать должно/)).toBeInTheDocument();
    expect(screen.getByText("Схема логики · Оформление заказа")).toBeInTheDocument();
    // Предвыбор — дефолт бэка («взять все» у доков).
    expect(screen.getByRole("radio", { name: /Взять все/ })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: /b\.zip · 20 строк/ }));
    expect(screen.getByRole("radio", { name: /b\.zip · 20 строк/ })).toBeChecked();

    // Двух входов мало для манифеста — имя задаёт пользователь.
    await userEvent.type(screen.getByPlaceholderText(ИМЯ), "Федерация");
    await userEvent.click(кнопка());

    await waitFor(() => expect(projectsApi.importUnified).toHaveBeenCalled());
    const [файлы, опции] = применение() ?? [];
    expect(файлы?.map((f) => f.name)).toEqual(["a.zip", "b.zip"]);
    expect(опции?.name).toBe("Федерация");
    expect(опции?.resolutions).toEqual({ [СПОР.id]: "cand:1" });
  });

  it("yaml + zip: имя обязательно, входы едут в порядке «тексты, потом архивы»", async () => {
    await открыть();
    fireEvent.change(screen.getByPlaceholderText(/Перетащите сюда/), {
      target: { value: "nodes:\n  - name: Ярмарка" },
    });
    await положить(new File(["zip"], "archmap.zip", { type: "application/zip" }));

    await waitFor(() => expect(projectsApi.unifiedPreview).toHaveBeenCalled(), { timeout: 3000 });
    // Норматив порядка: непустые YAML в порядке чипов, затем архивы.
    await waitFor(() => expect(входы()).toEqual(["Файл 1.yaml", "archmap.zip"]));

    // name_source = "fields" — поля на месте, без имени создавать нечего.
    expect(await screen.findByPlaceholderText(ИМЯ)).toBeInTheDocument();
    expect(кнопка()).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(ИМЯ), "Ярмарка");
    expect(кнопка()).toBeEnabled();
  });
});
