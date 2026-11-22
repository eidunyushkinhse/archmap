// Окно «Догрузить архив»: страховочная сетка поведения перед разрезом окна и переводом на
// новый язык (редизайн, фаза 6г). Тесты держатся за поведение: архивы уходят в превью в
// порядке окна, снятие архива пересчитывает превью, архив этого же проекта применять не
// даёт, отказ применения виден и окно остаётся открытым, после применения отчёт и «Готово».
//
// Где окно рисуется по-разному (строка «Нового», снятие файла), вид спрятан в помощники:
// сетка написана на прежнем окне, после перевода поменялись только помощники. Тесты нового
// вида — в конце файла: вступления и «Вставить текст» нет, не-архив даёт отказ над
// футером, «и ещё N» раскрывает перечень, футер, строки без «·».
// Modal настоящий (test-setup открывает <dialog> атрибутом open).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const строкаНового = (объектов: string, связей: string) => new RegExp(`Нового: ${объектов}, ${связей}`);

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

  // Архив этого же проекта: превью успешно, но ничего не добавляет. Вместо зелёного
  // «Готово к импорту» при погашенной «Применить» и строки «Нового: 0 объектов, 0 связей» —
  // одна тихая строка (хвост фазы 6г); перечень найденного остаётся.
  const безНового = (): IntoPreviewOut => превью({
    nodes_new: 0, new_nodes: [], edges_new: 0,
    families: { docs: 0, specs: 0, tables: 0, channels: 0, params: 0, processes: 0, sites: 0 },
    nodes_matched: 2, matched_nodes: [{ path: "Ярмарка", basis: "name" }, { path: "Ярмарка / Заказы", basis: "code" }],
  });

  it("архив этого же проекта: тихая строка «нет ничего нового», применять нечего", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(безНового());
    await открыть(zip("yarm.zip"));
    expect(await screen.findByText("В архиве нет ничего нового", {}, WAIT)).toHaveClass("ii-quiet");
    expect(screen.queryByText("Готово к импорту")).toBeNull();
    expect(screen.queryByText(/Нового:/)).toBeNull();
    expect(screen.getByText(/Найдено в проекте: 2 объекта/)).toBeInTheDocument();
    expect(применить()).toBeDisabled();
  });

  it("два архива без нового: «В архивах нет ничего нового»", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(безНового());
    await открыть(zip("yarm.zip"), zip("yarm-2.zip"));
    expect(await screen.findByText("В архивах нет ничего нового", {}, WAIT)).toBeInTheDocument();
    expect(применить()).toBeDisabled();
  });

  it("архив с новым: статус и строка «Нового» на месте, тихой строки нет", async () => {
    await открыть(zip("grafana.zip"));
    expect(await screen.findByText(строкаНового("2 объекта", "1 связь"), {}, WAIT)).toBeInTheDocument();
    expect(screen.getByText("Готово к импорту")).toBeInTheDocument();
    expect(screen.queryByText(/нет ничего нового/)).toBeNull();
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

describe("догрузка архива: вид нового языка", () => {
  const НЕ_АРХИВ = "Сюда загружаются архивы .zip. Файлы YAML загружаются пунктом «Обновить из кода».";
  const пусто = () => render(<ImportIntoModal projectId="p-1" onClose={onClose} onApplied={onApplied} />);
  const подвал = () => document.querySelector(".ds-win-foot") as HTMLElement;
  // Перетаскивание файлов на окно: принимает всё окно.
  const бросить = (...файлы: File[]) => fireEvent.drop(document.querySelector(".ds-win") as HTMLElement, {
    dataTransfer: { types: ["Files"], files: файлы },
  });

  it("вступления нет; зона архивов без «Вставить текст»", () => {
    пусто();
    expect(screen.getByText("Перетащите сюда архивы проекта .zip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выбрать файлы" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Вставить текст" })).toBeNull();
    expect(screen.queryByText(/Схемы сольются/)).toBeNull();
    expect(document.querySelector("dialog")?.textContent).not.toMatch(/агент/i);
  });

  it("YAML перетащили: отказ над футером, превью не зовётся, файла в окне нет", async () => {
    пусто();
    бросить(new File(["nodes: []"], "model.yaml"));
    expect(await within(подвал()).findByRole("alert")).toHaveTextContent(НЕ_АРХИВ);
    expect(screen.queryByRole("button", { name: "Убрать model.yaml" })).toBeNull();
    expect(projectsApi.importIntoPreview).not.toHaveBeenCalled();
    expect(применить()).toBeDisabled();
  });

  it("YAML выбрали с диска вместе с архивом: архив принят, отказ про YAML", async () => {
    пусто();
    await userEvent.upload(fileInput(), [new File(["nodes: []"], "model.yaml"), zip("grafana.zip")], { applyAccept: false });
    expect(within(подвал()).getByRole("alert")).toHaveTextContent(НЕ_АРХИВ);
    await waitFor(() => expect(последнееПревью()?.[1].map((f) => f.name)).toEqual(["grafana.zip"]), WAIT);
    // Следующий заход архивов снимает отказ.
    await userEvent.upload(fileInput(), zip("zulip.zip"));
    expect(within(подвал()).queryByRole("alert")).toBeNull();
  });

  it("«и ещё N» раскрывает перечень найденного целиком", async () => {
    const пути = Array.from({ length: 12 }, (_, i) => ({ path: `Ярмарка / сервис ${i + 1}`, basis: "code" as const }));
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({ nodes_matched: 12, matched_nodes: пути }));
    await открыть(zip("yarm.zip"));
    await screen.findByText(/Найдено в проекте: 12 объектов/, {}, WAIT);
    expect(screen.queryByText("Ярмарка / сервис 9")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "и ещё 4" }));
    expect(screen.getByText("Ярмарка / сервис 9")).toBeInTheDocument();
    expect(screen.getByText("Ярмарка / сервис 12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^и ещё/ })).toBeNull();
  });

  it("сервер прислал начало перечня: остаток тихим «и ещё N», без кнопки", async () => {
    const пути = Array.from({ length: 8 }, (_, i) => ({ path: `Ярмарка / сервис ${i + 1}`, basis: "name" as const }));
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({ nodes_matched: 37, matched_nodes: пути }));
    await открыть(zip("yarm.zip"));
    expect(await screen.findByText("и ещё 29", {}, WAIT)).toHaveClass("ii-quiet");
    expect(screen.queryByRole("button", { name: /^и ещё/ })).toBeNull();
  });

  it("строки диффа и отчёта без «·»; футер «Применить», «Отмена»", async () => {
    vi.mocked(projectsApi.importIntoPreview).mockResolvedValue(превью({
      families: { docs: 2, specs: 1, tables: 0, channels: 3, params: 0, processes: 0, sites: 0 },
      nodes_matched: 1, matched_nodes: [{ path: "Ярмарка", basis: "name" }],
    }));
    vi.mocked(projectsApi.importIntoApply).mockResolvedValue({
      ...ОТЧЁТ, nodes_filled: 1, docs_created: 2, docs_replaced: 1, specs_applied: 1,
      processes: [{
        process_id: "pr1", name: "Оформление заказа", participants: 3, unbound: 0, messages: 4,
        attached: 4, dangling: 0, self_messages: 0, fragments: 0, unsupported: [], doc_linked: 2, doc_unresolved: 1,
      } as IntoApplyOut["processes"][number]],
    });
    await открыть(zip("grafana.zip"));
    expect(await screen.findByText("Добавится: 2 схемы логики, 1 спецификация, 3 канала", {}, WAIT)).toBeInTheDocument();
    expect(within(подвал()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Применить", "Отмена"]);
    expect(document.querySelector(".ds-win-body")?.textContent).not.toContain("·");

    await userEvent.click(применить());
    await screen.findByText("Архивы догружены", {}, WAIT);
    expect(screen.getByText(/^Создано объектов: 2, связей: 1, дополнено объектов: 1$/)).toBeInTheDocument();
    expect(screen.getByText(/^Схем логики: 2, заменено: 1, спецификаций: 1$/)).toBeInTheDocument();
    expect(screen.getByText(/^Процессов: 1, привязок шагов: 2/).textContent)
      .toBe("Процессов: 1, привязок шагов: 2, схема не найдена: 1");
    expect(document.querySelector(".ds-win-body")?.textContent).not.toContain("·");
    expect(within(подвал()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Готово"]);
  });
});
