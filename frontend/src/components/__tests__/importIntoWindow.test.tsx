// Окно «Догрузить архив»: страховочная сетка поведения перед разрезом окна и переводом на
// новый язык (редизайн, фаза 6г). Тесты держатся за поведение: архивы уходят в превью в
// порядке окна, снятие архива пересчитывает превью, архив этого же проекта применять не
// даёт, отказ применения виден и окно остаётся открытым, после применения отчёт и «Готово».
//
// Где окно рисуется по-разному (строка «Нового», снятие файла), вид спрятан в помощники:
// сетка написана на прежнем окне, после перевода меняются только помощники.
// Modal настоящий (test-setup открывает <dialog> атрибутом open).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ImportIntoModal from "../project/ImportIntoModal";
import { projectsApi } from "../../api/projects";
import { ApiError } from "../../api/client";
import type { IntoApplyOut, IntoPreviewOut } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: { get: vi.fn(), importIntoPreview: vi.fn(), importIntoApply: vi.fn() },
}));

const WAIT = { timeout: 3000 };

const превью = (over: Partial<IntoPreviewOut> = {}): IntoPreviewOut => ({
  ok: true, errors: [], nodes_new: 2, nodes_new_paths: [],
  new_nodes: [{ path: "Grafana", source: null }, { path: "Grafana / API", source: { repo: "github.com/grafana/grafana" } }],
  nodes_matched: 0, matched_nodes: [], edges_new: 1,
  families: { docs: 0, specs: 0, tables: 0, channels: 3, params: 0, processes: 0, sites: 0 },
  family_conflicts: [],
  remainder: {
    field_conflicts: [], container_edges: [], isolated_groups: [], fuzzy_pairs: [],
    unfixable: [], converted_warnings: [], node_paths: [], node_has_children: [], node_elements: [],
  },
  warnings: [], base_graph_rev: 1, base_meta_rev: 1, ...over,
});

const ОТЧЁТ: IntoApplyOut = {
  project_id: "p-1", nodes_created: 2, nodes_filled: 0, edges_created: 1, docs_created: 0,
  docs_replaced: 0, specs_applied: 0, params_replaced: 0, db: null, channels: null, config: null,
  processes: [], warnings: [], unfixable: [], resolved_conflicts: 0, channel_stubs: 0,
  graph_rev: 2, meta_rev: 2,
};

const onClose = vi.fn();
const onApplied = vi.fn();
const zip = (name: string) => new File(["PK"], name, { type: "application/zip" });
const fileInput = () => document.querySelector("dialog input[type=file]") as HTMLInputElement;
const применить = () => screen.getByRole("button", { name: "Применить" });
const последнееПревью = () => vi.mocked(projectsApi.importIntoPreview).mock.calls.at(-1);

// ── помощники вида ───────────────────────────────────────────────────────────
const строкаНового = (объектов: string, связей: string) => new RegExp(`Нового: ${объектов} · ${связей}`);

async function открыть(...файлы: File[]) {
  render(<ImportIntoModal projectId="p-1" onClose={onClose} onApplied={onApplied} />);
  await userEvent.upload(fileInput(), файлы);
  await waitFor(() => expect(projectsApi.importIntoPreview).toHaveBeenCalled(), WAIT);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью());
  vi.mocked(projectsApi.importIntoApply).mockResolvedValue(ОТЧЁТ);
});

describe("догрузка архива: превью и применение", () => {
  it("пустое окно превью не просит, применять нечего", () => {
    render(<ImportIntoModal projectId="p-1" onClose={onClose} onApplied={onApplied} />);
    expect(screen.getByRole("heading", { name: "Догрузить архив" })).toBeInTheDocument();
    expect(projectsApi.importIntoPreview).not.toHaveBeenCalled();
    expect(применить()).toBeDisabled();
  });

  it("два архива уходят в превью в порядке окна; снятие архива пересчитывает превью", async () => {
    await открыть(zip("grafana.zip"), zip("zulip.zip"));
    expect(последнееПревью()?.[1].map((f) => f.name)).toEqual(["grafana.zip", "zulip.zip"]);
    expect(await screen.findByText(строкаНового("2 объекта", "1 связь"), {}, WAIT)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Убрать grafana.zip" }));
    await waitFor(() => expect(последнееПревью()?.[1].map((f) => f.name)).toEqual(["zulip.zip"]));
    await userEvent.click(screen.getByRole("button", { name: "Убрать zulip.zip" }));
    expect(screen.queryByText(/Нового:/)).toBeNull();
    expect(применить()).toBeDisabled();
  });

  it("архив этого же проекта: нового нет, применять нечего", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({
      nodes_new: 0, new_nodes: [], edges_new: 0,
      families: { docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0, sites: 0 },
      nodes_matched: 2, matched_nodes: [{ path: "Ярмарка", basis: "name" }, { path: "Ярмарка / Заказы", basis: "code" }],
    }));
    await открыть(zip("yarm.zip"));
    expect(await screen.findByText(строкаНового("0 объектов", "0 связей"), {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText(/Найдено в проекте: 2 объекта/)).toBeInTheDocument();
    expect(применить()).toBeDisabled();
  });

  it("отказ применения виден, окно открыто, повтор возможен", async () => {
    await открыть(zip("grafana.zip"));
    await screen.findByText(/Нового:/, {}, WAIT);
    vi.mocked(projectsApi.importIntoApply).mockRejectedValueOnce(new ApiError(422, "Архив grafana.zip повреждён"));
    await userEvent.click(применить());
    expect(await screen.findByText("Архив grafana.zip повреждён", {}, WAIT)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(применить()).toBeEnabled();
  });

  it("после применения отчёт в окне, «Готово» уносит итог наверх", async () => {
    await открыть(zip("grafana.zip"));
    await screen.findByText(/Нового:/, {}, WAIT);
    await userEvent.click(применить());
    expect(await screen.findByText("Архивы догружены", {}, WAIT)).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onApplied).toHaveBeenCalledWith("Догружено: 2 объекта, 1 связь");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
