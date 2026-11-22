// Окно «Новый проект»: поведение, которое переживает смену вида (редизайн, фаза 6б).
//
// Страховочная сетка перед разрезом окна: тесты написаны на прежнем окне и зелёные на нём,
// поэтому всё, что зависит от вёрстки, спрятано в помощники ниже (поле, режим, кнопка
// задания, выбор языка). Что закрепляем: название и описание переживают смену всех
// четырёх режимов; каждый режим создаёт проект своим вызовом API; «Копия» берёт
// выбранный образец; ввоз показывает итог превью и отказ; принесённые файлы переживают
// переход «Импорт» ↔ «ИИ-агент»; язык и подсказки уходят в задание агенту; отказ сервера
// виден. Последний блок — поведение нового окна: кнопка задания без названия просит его,
// Escape при открытом меню языка закрывает только меню. Modal настоящий (test-setup
// открывает <dialog> атрибутом open).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CreateProjectDialog from "../project/CreateProjectDialog";
import { projectsApi } from "../../api/projects";
import type {
  ArchiveImportResult, ImportPreviewOut, Project, UnifiedPreviewOut,
} from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    importPrompt: vi.fn(), create: vi.fn(), unifiedPreview: vi.fn(), importUnified: vi.fn(),
  },
}));

const WAIT = { timeout: 3000 };

const проект = (id: string, name: string): Project => ({
  id, name, description: null, archived_at: null,
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
  object_count: 3, edge_count: 2, updated_by: null,
  preview: { nodes: [], edges: [] },
  my_role: "owner", owner_username: null, visible_to_all: false,
});

const c4 = (over: Partial<ImportPreviewOut> = {}): ImportPreviewOut => ({
  ok: true, errors: [], node_count: 2, edge_count: 0, roots: ["Ярмарка"],
  node_names: ["Ярмарка", "orders"], files: 2, merged_count: 0, merged: [], merged_nodes: [],
  nodes_without_anchor: 0, conflicts: [], warnings: [], dropped_edges: 0,
  file_remarks: [], schema_errors: [], schema_warnings: [], ...over,
});

const превью = (over: Partial<UnifiedPreviewOut> = {}): UnifiedPreviewOut => ({
  ok: true, errors: [], c4: c4(),
  families: { docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0, sites: 0 },
  family_conflicts: [],
  remainder: {
    field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
    unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [], node_elements: [],
  },
  warnings: [], name_source: "fields", ...over,
});

const ОТКАЗ = "Некорректный YAML: ошибка разметки (строка 3)";
const плохое = (): UnifiedPreviewOut => превью({
  ok: false, errors: [ОТКАЗ],
  c4: c4({ ok: false, errors: [ОТКАЗ], files: 1, file_remarks: [{ file: 1, errors: [ОТКАЗ], warnings: [] }] }),
});

const ОТЧЁТ: ArchiveImportResult = {
  project_id: "p-new", project_name: "Федерация", nodes: 2, edges: 0, docs_created: 0,
  specs_applied: 0, db: null, channels: null, config: null, processes: [], warnings: [],
  unfixable: [], resolved_conflicts: 0, channel_stubs: 0,
};

// ── Помощники: всё, что зависит от вёрстки окна ────────────────────────────────
const название = () => screen.getByPlaceholderText(/Платёжная платформа/);
const описание = () => screen.getByPlaceholderText(/оротко о проекте/);
const подсказки = () => screen.getByPlaceholderText(/монорепо/);
const режим = (m: string) => screen.getByText(m, { selector: "button" });
const создать = () => screen.getByRole("button", { name: /^(Создать проект|Открыть проект)$/ });
const задание = () => screen.getByRole("button", { name: /^Скопировать (промпт|задание)$/ });
const файлы = () => document.querySelector('dialog input[type="file"]') as HTMLInputElement;
/** Значение поля: у прежнего окна input/textarea, у нового — поле, растущее по тексту. */
const значение = (el: HTMLElement) => (el as HTMLInputElement | HTMLTextAreaElement).value;

async function выбратьЯзык(подпись: "Русский" | "Английский") {
  const select = document.querySelector("dialog select");
  if (select) {
    await userEvent.selectOptions(select, подпись === "Английский" ? "en" : "ru");
    return;
  }
  await userEvent.click(screen.getByRole("button", { name: /Язык описаний/ }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: подпись }));
}

async function положить(...имена: string[]) {
  await userEvent.upload(файлы(), имена.map((n) => new File([`nodes:\n  - name: ${n}\n`], n)));
  await waitFor(() => expect(projectsApi.unifiedPreview).toHaveBeenCalled(), WAIT);
}

const входы = () =>
  vi.mocked(projectsApi.unifiedPreview).mock.calls.at(-1)?.[0].map((f) => f.name);

function открыть(projects: Project[] = []) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<CreateProjectDialog projects={projects} onClose={onClose} onCreated={onCreated} />);
  return { onClose, onCreated };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.create).mockResolvedValue(проект("p-new", "Новый"));
  vi.mocked(projectsApi.unifiedPreview).mockResolvedValue(превью());
  vi.mocked(projectsApi.importUnified).mockResolvedValue(ОТЧЁТ);
  vi.mocked(projectsApi.importPrompt).mockResolvedValue({ prompt: "задание" });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true,
  });
});

describe("Новый проект: поля и режимы", () => {
  it("название и описание переживают смену всех четырёх режимов и уходят в создание", async () => {
    const { onCreated } = открыть([проект("p1", "Ярмарка")]);
    await userEvent.type(название(), "Платформа");
    await userEvent.type(описание(), "Коротко");
    for (const m of ["Копия", "Импорт", "ИИ-агент", "Пустой"]) {
      await userEvent.click(режим(m));
      expect(значение(название())).toBe("Платформа");
      expect(значение(описание())).toBe("Коротко");
    }
    await userEvent.click(создать());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("p-new"));
    expect(projectsApi.create).toHaveBeenCalledWith({
      name: "Платформа", description: "Коротко", start: "blank",
    });
  });

  it("«Копия»: выбранный образец уезжает в создание", async () => {
    const { onCreated } = открыть([проект("p1", "Ярмарка"), проект("p2", "Плёнка")]);
    await userEvent.click(режим("Копия"));
    await userEvent.click(screen.getByRole("button", { name: /Плёнка/ }));
    await userEvent.type(название(), "Копия Плёнки");
    await userEvent.click(создать());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("p-new"));
    expect(projectsApi.create).toHaveBeenCalledWith({
      name: "Копия Плёнки", description: null, start: "copy:p2",
    });
  });

  it("без названия «Создать проект» выключена, в режимах ввоза — и без файлов", async () => {
    открыть();
    expect(создать()).toBeDisabled();
    await userEvent.type(название(), "Платформа");
    expect(создать()).toBeEnabled();
    await userEvent.click(режим("Импорт"));
    expect(создать()).toBeDisabled();
    await userEvent.click(режим("ИИ-агент"));
    expect(создать()).toBeDisabled();
  });

  it("отказ сервера виден, кнопка снова доступна", async () => {
    vi.mocked(projectsApi.create).mockRejectedValue(new Error("Проект с таким именем уже есть"));
    const { onCreated } = открыть();
    await userEvent.type(название(), "Ярмарка");
    await userEvent.click(создать());
    expect(await screen.findByText("Проект с таким именем уже есть")).toBeInTheDocument();
    expect(создать()).toBeEnabled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("Новый проект: ввоз файлов", () => {
  it("«Импорт»: превью, создание и отчёт до перехода в проект", async () => {
    const { onCreated } = открыть();
    await userEvent.click(режим("Импорт"));
    await userEvent.type(название(), "Федерация");
    await положить("a.yaml", "b.yaml");
    expect(await screen.findByText("Готово к импорту", {}, WAIT)).toBeInTheDocument();
    expect(входы()).toEqual(["a.yaml", "b.yaml"]);
    await waitFor(() => expect(создать()).toBeEnabled());
    await userEvent.click(создать());
    await waitFor(() => expect(projectsApi.importUnified).toHaveBeenCalled());
    const [files, opts] = vi.mocked(projectsApi.importUnified).mock.calls.at(-1) ?? [];
    expect(files?.map((f) => f.name)).toEqual(["a.yaml", "b.yaml"]);
    expect(opts?.name).toBe("Федерация");
    expect(await screen.findByText("«Федерация» создан")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Открыть проект" }));
    expect(onCreated).toHaveBeenCalledWith("p-new");
  });

  it("нечитаемый файл: отказ виден, «Создать проект» выключена", async () => {
    vi.mocked(projectsApi.unifiedPreview).mockResolvedValue(плохое());
    открыть();
    await userEvent.click(режим("Импорт"));
    await userEvent.type(название(), "Платформа");
    await положить("broken.yaml");
    expect(await screen.findByText("Что-то пошло не так", {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText(/Проблема в файле/)).toHaveTextContent("broken.yaml");
    expect(создать()).toBeDisabled();
  });

  it("принесённые файлы переживают переход «Импорт» ↔ «ИИ-агент»", async () => {
    открыть();
    await userEvent.click(режим("Импорт"));
    await положить("a.yaml");
    await userEvent.click(режим("ИИ-агент"));
    expect(screen.getAllByText(/a\.yaml/).length).toBeGreaterThan(0);
    expect(screen.getByText("Готово к импорту")).toBeInTheDocument();
    await userEvent.click(режим("Пустой"));
    await userEvent.click(режим("Импорт"));
    expect(screen.getAllByText(/a\.yaml/).length).toBeGreaterThan(0);
    expect(await screen.findByText("Готово к импорту", {}, WAIT)).toBeInTheDocument();
    expect(входы()).toEqual(["a.yaml"]);
  });

  it("«ИИ-агент»: файлы ответов создают проект тем же ввозом", async () => {
    открыть();
    await userEvent.click(режим("ИИ-агент"));
    await userEvent.type(название(), "Федерация");
    await положить("a.yaml", "b.yaml");
    await waitFor(() => expect(создать()).toBeEnabled(), WAIT);
    await userEvent.click(создать());
    await waitFor(() => expect(projectsApi.importUnified).toHaveBeenCalled());
    expect(projectsApi.create).not.toHaveBeenCalled();
  });
});

describe("Новый проект: задание агенту", () => {
  it("язык и подсказки уходят в задание вместе с названием", async () => {
    открыть();
    await userEvent.click(режим("ИИ-агент"));
    await userEvent.type(название(), "Платформа");
    await выбратьЯзык("Английский");
    await userEvent.type(подсказки(), "монорепо");
    await userEvent.click(задание());
    await waitFor(() => expect(projectsApi.importPrompt).toHaveBeenCalled());
    expect(vi.mocked(projectsApi.importPrompt).mock.calls.at(-1)?.[0]).toMatchObject({
      systemName: "Платформа", lang: "en", hints: "монорепо", depth: 2,
    });
  });
});

describe("Новый проект: новое окно (фаза 6б)", () => {
  it("кнопка задания без названия: фокус в название, строка-просьба, задание не копируется", async () => {
    открыть();
    await userEvent.click(режим("ИИ-агент"));
    const кнопка = задание();
    expect(кнопка).toBeEnabled();
    await userEvent.click(кнопка);
    expect(название()).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("Сначала введите название. Оно попадёт в задание агенту.");
    expect(projectsApi.importPrompt).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    // Название введено — строка гаснет, задание копируется.
    await userEvent.type(название(), "Платформа");
    expect(screen.queryByText(/Сначала введите название/)).toBeNull();
    await userEvent.click(задание());
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("задание"));
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeInTheDocument();
  });

  it("Escape при открытом меню языка закрывает только меню, следующий — окно", async () => {
    const { onClose } = открыть();
    await userEvent.click(режим("ИИ-агент"));
    const value = screen.getByRole("button", { name: "Язык описаний Русский" });
    await userEvent.click(value);
    const item = screen.getByRole("menuitemradio", { name: "Русский" });
    expect(item).toHaveFocus();

    // Браузер закрывает <dialog> по Escape событием cancel, если keydown не погашен.
    const dialog = document.querySelector("dialog")!;
    const notPrevented = fireEvent.keyDown(item, { key: "Escape" });
    if (notPrevented) fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(notPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(value).toHaveFocus();

    expect(fireEvent.keyDown(value, { key: "Escape" })).toBe(true);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("окно открывается с фокусом в названии; Enter в нём создаёт проект", async () => {
    const { onCreated } = открыть();
    expect(название()).toHaveFocus();
    await userEvent.type(название(), "Платформа{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("p-new"));
    expect(значение(название())).toBe("Платформа");
  });

  it("после ввоза полей и режимов нет, только отчёт и «Открыть проект»", async () => {
    открыть();
    await userEvent.click(режим("Импорт"));
    await userEvent.type(название(), "Федерация");
    await положить("a.yaml");
    await waitFor(() => expect(создать()).toBeEnabled(), WAIT);
    await userEvent.click(создать());
    expect(await screen.findByText("«Федерация» создан")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Платёжная платформа/)).toBeNull();
    expect(screen.queryByText("Пустой", { selector: "button" })).toBeNull();
    expect(screen.getByText("Объектов: 2")).toBeInTheDocument();
    expect(screen.getByText("Связей: 0")).toBeInTheDocument();
  });
});
