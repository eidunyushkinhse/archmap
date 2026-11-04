// Пометка «собрано сборщиком фактов» во входах (фаза 3 docs/tasks/fact-collector.md): бэк
// узнаёт файл сборщика по шапке «# archmap-scan …» и кладёт строку в file_remarks[i].scanner
// превью ввоза и в scanner плана обновления. Окна показывают её серым у входа: человек
// видит, что описаний и связей по смыслу в файле нет и их предстоит дописать.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ImportPane from "../project/ImportPane";
import SyncRepoModal from "../docsImport/SyncRepoModal";
import { projectsApi } from "../../api/projects";
import type { ImportPreviewOut, Project, SyncPreviewOut } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: { importPrompt: vi.fn(), get: vi.fn(), syncPreview: vi.fn(), syncApply: vi.fn() },
}));
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const ПОМЕТКА =
  "Собрано сборщиком фактов ArchMap 0.1.0 по коммиту 49ce20c3 репозитория github.com/org/yarmarka: "
  + "у объектов и связей есть основание в манифестах и коде, описаний и связей по смыслу нет, "
  + "их добавит агент или человек";

const сводка = (scanner: (string | null)[]): ImportPreviewOut => ({
  ok: true, errors: [], node_count: 7, edge_count: 8, roots: ["Ярмарка"],
  files: scanner.length, merged_count: 0, merged: [], merged_nodes: [], nodes_without_anchor: 0,
  conflicts: [], warnings: [], dropped_edges: 0, node_names: ["Ярмарка"],
  file_remarks: scanner.map((s, i) => ({ file: i + 1, errors: [], warnings: [], scanner: s })),
  schema_errors: [], schema_warnings: [],
});

describe("окно «Новый проект»: пометка у входа", () => {
  it("файл сборщика: строка под полем активного входа", async () => {
    render(
      <ImportPane docs={["# archmap-scan 0.1.0\nnodes:", "nodes: []"]} onDocs={vi.fn()} summary={сводка([ПОМЕТКА, null])} />,
    );
    expect(screen.getByText(ПОМЕТКА)).toBeInTheDocument();
    // Второй вход собран агентом: у него строки нет.
    await userEvent.click(screen.getByRole("button", { name: "Файл 2" }));
    expect(screen.queryByText(/Собрано сборщиком фактов/)).toBeNull();
  });

  it("обычный файл: строки нет", () => {
    render(<ImportPane docs={["nodes: []"]} onDocs={vi.fn()} summary={сводка([null])} />);
    expect(screen.queryByText(/Собрано сборщиком фактов/)).toBeNull();
  });
});

describe("окно «Обновить из кода»: пометка над планом", () => {
  it("строка о файле сборщика перед планом", async () => {
    vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Ярмарка" } as Project);
    const план: SyncPreviewOut = {
      ok: true, errors: [], files: 1, nodes: [], edges: [], conflicts: [], warnings: [],
      summary: { nodes_create: 7 }, is_noop: false, graph_rev: 3, scanner: [ПОМЕТКА],
    };
    vi.mocked(projectsApi.syncPreview).mockResolvedValue(план);
    render(<SyncRepoModal projectId="p1" onClose={vi.fn()} onApplied={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(["# archmap-scan 0.1.0\nnodes: []\n"], "schema.yaml"));

    const строка = await screen.findByText(ПОМЕТКА, {}, { timeout: 3000 });
    const сводкаПлана = screen.getByText("7 новых");
    expect(строка.compareDocumentPosition(сводкаПлана) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
