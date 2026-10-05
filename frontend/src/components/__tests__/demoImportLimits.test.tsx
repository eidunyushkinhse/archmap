// Пределы демо-стенда в окнах ввоза (docs/tasks/demo-mode.md, экран 3 прототипа):
// «Проект не помещается в демо» с полоской «142 из 100» в окне «Новый проект», в
// догрузке архива и в синке; «Файл слишком большой для демо» до отправки файла.
// Кнопка применения в обоих случаях погашена. Вне демо ничего из этого нет.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CreateProjectDialog from "../project/CreateProjectDialog";
import ImportIntoModal from "../project/ImportIntoModal";
import SyncRepoModal from "../docsImport/SyncRepoModal";
import { projectsApi } from "../../api/projects";
import { getDemoLimits } from "../../api/auth";
import { excessText, humanSize } from "../demo/demoLimits";
import type {
  DemoLimits, ImportPreviewOut, IntoPreviewOut, SyncPreviewOut, UnifiedPreviewOut,
} from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    importPrompt: vi.fn(), create: vi.fn(), get: vi.fn(),
    unifiedPreview: vi.fn(), importUnified: vi.fn(),
    importIntoPreview: vi.fn(), importIntoApply: vi.fn(),
    syncPreview: vi.fn(), syncApply: vi.fn(),
  },
}));
vi.mock("../../api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/auth")>()),
  getDemoLimits: vi.fn(),
}));
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const LIMITS: DemoLimits = {
  nodes: 100, edges: 120, docs: 75, processes: 10, text_bytes: 250 * 1024, file_bytes: 250 * 1024,
};
const OVER = { kind: "nodes" as const, actual: 142, limit: 100 };

const c4 = (): ImportPreviewOut => ({
  ok: true, errors: [], node_count: 142, edge_count: 1, roots: ["Плёнка"],
  node_names: ["Плёнка"], files: 2, merged_count: 0, merged: [], merged_nodes: [],
  nodes_without_anchor: 0, conflicts: [], warnings: [], dropped_edges: 0,
  file_remarks: [], schema_errors: [], schema_warnings: [],
});
const REMAINDER = {
  field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
  unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [],
};
const unified = (demo_excess: UnifiedPreviewOut["demo_excess"]): UnifiedPreviewOut => ({
  ok: true, errors: [], c4: c4(),
  families: { docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0 },
  family_conflicts: [], remainder: REMAINDER, warnings: [], name_source: "fields", demo_excess,
});

function положить(...файлы: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  return userEvent.upload(input, файлы);
}

const OVER_TEXT = "Проект не помещается в демо. В файлах 142 объекта, а в демо можно до 100. "
  + "Уберите часть файлов или загрузите проект поменьше.";
const FILE_TEXT = "Файл слишком большой для демо. «billing-full.zip» весит 1,4 МБ, "
  + "а в демо можно загрузить до 250 КБ.";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDemoLimits).mockReturnValue(LIMITS);
});

describe("Новый проект → Импорт", () => {
  async function открыть() {
    render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByText("Импорт"));
  }

  it("объектов больше предела: плашка, полоска «142 из 100», «Создать» погашена", async () => {
    vi.mocked(projectsApi.unifiedPreview).mockResolvedValue(unified(OVER));
    await открыть();
    await userEvent.type(screen.getByPlaceholderText("Например, «Платёжная платформа»"), "Плёнка");
    await положить(new File(["nodes: []"], "Файл 1.yaml"), new File(["nodes: []"], "Файл 2.yaml"));
    const alert = await screen.findByText("Проект не помещается в демо.", {}, { timeout: 3000 });
    expect(alert.parentElement).toHaveTextContent(OVER_TEXT);
    expect(screen.getByText("Объекты")).toBeInTheDocument();
    expect(screen.getByText("142 из 100")).toBeInTheDocument();
    expect(screen.queryByText("Готово к импорту")).toBeNull();
    expect(screen.getByRole("button", { name: "Создать проект" })).toBeDisabled();
  });

  it("в пределах: плашки нет, кнопка доступна", async () => {
    vi.mocked(projectsApi.unifiedPreview).mockResolvedValue(unified(null));
    await открыть();
    await userEvent.type(screen.getByPlaceholderText("Например, «Платёжная платформа»"), "Плёнка");
    await положить(new File(["nodes: []"], "a.yaml"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Создать проект" })).toBeEnabled(),
      { timeout: 3000 });
    expect(screen.queryByText("Проект не помещается в демо.")).toBeNull();
  });

  it("файл больше предела: отказ до отправки, превью не запрашивается", async () => {
    await открыть();
    await положить(new File([new Uint8Array(Math.round(1.4 * 1024 * 1024))], "billing-full.zip"));
    expect(await screen.findByRole("alert")).toHaveTextContent(FILE_TEXT);
    expect(screen.getByTitle("billing-full.zip")).toBeInTheDocument(); // чип файла на месте
    expect(screen.getByRole("button", { name: "Создать проект" })).toBeDisabled();
    await new Promise((r) => setTimeout(r, 700)); // дебаунс превью прошёл бы
    expect(projectsApi.unifiedPreview).not.toHaveBeenCalled();
  });

  it("вне демо файл любого размера уходит в превью", async () => {
    vi.mocked(getDemoLimits).mockReturnValue(null);
    vi.mocked(projectsApi.unifiedPreview).mockResolvedValue(unified(null));
    await открыть();
    await положить(new File([new Uint8Array(300 * 1024)], "big.zip"));
    await waitFor(() => expect(projectsApi.unifiedPreview).toHaveBeenCalled(), { timeout: 3000 });
    expect(screen.queryByText("Файл слишком большой для демо.")).toBeNull();
  });
});

describe("Импорт проекта (zip) в живой проект", () => {
  const into = (demo_excess: IntoPreviewOut["demo_excess"]): IntoPreviewOut => ({
    ok: true, errors: [], nodes_new: 50, nodes_new_paths: [], new_nodes: [], nodes_matched: 0,
    matched_nodes: [], edges_new: 0,
    families: { docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0 },
    family_conflicts: [], remainder: REMAINDER, warnings: [], base_graph_rev: 1, base_meta_rev: 1,
    demo_excess,
  });

  it("после загрузки проект выйдет за предел: плашка и полоска, «Применить» погашена", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(into({ kind: "nodes", actual: 105, limit: 100 }));
    render(<ImportIntoModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
    await положить(new File(["zip"], "donor.zip"));
    const head = await screen.findByText("Проект не помещается в демо.");
    expect(head.parentElement).toHaveTextContent(
      "После загрузки в проекте будет 105 объектов, а в демо можно до 100. "
      + "Уберите часть файлов или загрузите проект поменьше.",
    );
    expect(screen.getByText("105 из 100")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
  });

  it("архив больше предела не отправляется", async () => {
    render(<ImportIntoModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
    await положить(new File([new Uint8Array(Math.round(1.4 * 1024 * 1024))], "billing-full.zip"));
    expect(await screen.findByRole("alert")).toHaveTextContent(FILE_TEXT);
    expect(projectsApi.importIntoPreview).not.toHaveBeenCalled();
  });
});

describe("Импорт схемы (синк с кодом)", () => {
  const sync = (demo_excess: SyncPreviewOut["demo_excess"]): SyncPreviewOut => ({
    ok: true, errors: [], files: 1, nodes: [], edges: [], conflicts: [], warnings: [],
    summary: { create: 70 }, is_noop: false, graph_rev: 3, demo_excess,
  });

  it("после синка проект выйдет за предел: плашка вместо плана, «Применить» погашена", async () => {
    vi.mocked(projectsApi.get).mockResolvedValue({ name: "Ярмарка" } as never);
    vi.mocked(projectsApi.syncPreview).mockResolvedValue(sync({ kind: "edges", actual: 130, limit: 120 }));
    render(<SyncRepoModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
    await положить(new File(["nodes:\n  - name: X\n"], "run.yaml"));
    const head = await screen.findByText("Проект не помещается в демо.", {}, { timeout: 3000 });
    expect(head.parentElement).toHaveTextContent(
      "После загрузки в проекте будет 130 связей, а в демо можно до 120.",
    );
    expect(screen.getByText("Связи")).toBeInTheDocument();
    expect(screen.getByText("130 из 120")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
  });

  it("файл больше предела с диска не берётся, отказ виден", async () => {
    vi.mocked(projectsApi.get).mockResolvedValue({ name: "Ярмарка" } as never);
    render(<SyncRepoModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
    await положить(new File([new Uint8Array(300 * 1024)], "run.yaml"));
    expect(await screen.findByText(
      "Файл слишком большой для демо. «run.yaml» весит 300 КБ, а в демо можно загрузить до 250 КБ.",
    )).toBeInTheDocument();
    expect(projectsApi.syncPreview).not.toHaveBeenCalled();
  });
});

describe("тексты превышения", () => {
  it("каждая семья по-русски", () => {
    expect(excessText({ kind: "edges", actual: 121, limit: 120 }, "files"))
      .toBe("В файлах 121 связь, а в демо можно до 120. Уберите часть файлов или загрузите проект поменьше.");
    expect(excessText({ kind: "docs", actual: 80, limit: 75 }, "files")).toContain("80 схем логики");
    expect(excessText({ kind: "processes", actual: 12, limit: 10 }, "project")).toContain("12 процессов");
    expect(excessText({ kind: "text", actual: 300 * 1024, limit: 250 * 1024 }, "files"))
      .toContain("В файлах 300 КБ текста, а в демо можно до 250 КБ.");
  });

  it("размер: КБ вверх, МБ с запятой", () => {
    expect(humanSize(250 * 1024 + 1)).toBe("251 КБ");
    expect(humanSize(Math.round(1.4 * 1024 * 1024))).toBe("1,4 МБ");
  });
});
