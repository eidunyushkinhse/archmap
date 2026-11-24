// Окно «Обновить из кода» на новом языке (редизайн, фаза 6а): язык описаний из меню и
// подсказки уходят в задание агенту; выбор файлов и вставка текстом дают план; пустой и
// нечитаемый план держат «Применить» выключенной; применение зовёт API с выбранными
// галочками и закрывает окно; отказ сохранения виден; Escape при открытом меню языка
// закрывает только меню. Modal настоящий (test-setup открывает <dialog> атрибутом open).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SyncRepoModal from "../docsImport/SyncRepoModal";
import { projectsApi } from "../../api/projects";
import { ApiError } from "../../api/client";
import type { Project, SyncApplyOut, SyncPreviewOut } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: { get: vi.fn(), importPrompt: vi.fn(), syncPreview: vi.fn(), syncApply: vi.fn() },
}));

const WAIT = { timeout: 3000 };

function plan(over: Partial<SyncPreviewOut> = {}): SyncPreviewOut {
  return {
    ok: true, errors: [], files: 1, conflicts: [], warnings: [], is_noop: false, graph_rev: 7,
    summary: { nodes_create: 3, nodes_missing: 1, nodes_unchanged: 5 },
    nodes: [
      { returned: false, path: "Ярмарка / Склад", action: "create", fields: [] },
      { returned: false, path: "Ярмарка / Возвраты", action: "create", fields: [] },
      { returned: false, path: "Ярмарка / Отзывы", action: "create", fields: [] },
      { returned: false, path: "Ярмарка / Старый", action: "missing", fields: [] },
    ],
    edges: [],
    ...over,
  } as SyncPreviewOut;
}

const APPLIED: SyncApplyOut = {
  created_nodes: ["a", "b", "c"], updated_nodes: [], deprecated_nodes: [], created_edges: [],
  updated_edges: [], skipped: [], graph_rev: 8, code_changes_cleared: [],
};

function renderModal() {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(<SyncRepoModal projectId="p1" onClose={onClose} onApplied={onApplied} />);
  return { onClose, onApplied };
}

const fileInput = () => document.querySelector("dialog input[type=file]") as HTMLInputElement;
const applyButton = () => screen.getByRole("button", { name: "Применить" });
const copyButton = () => screen.getByRole("button", { name: "Скопировать задание" });
const lastPrompt = () => vi.mocked(projectsApi.importPrompt).mock.calls.at(-1)?.[0];

async function putFile(text = "nodes:\n  - name: Склад\n") {
  await userEvent.upload(fileInput(), new File([text], "orders.yaml"));
  await waitFor(() => expect(projectsApi.syncPreview).toHaveBeenCalled(), WAIT);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.get).mockResolvedValue({ id: "p1", name: "Ярмарка" } as Project);
  vi.mocked(projectsApi.importPrompt).mockResolvedValue({ prompt: "задание" });
  vi.mocked(projectsApi.syncPreview).mockResolvedValue(plan());
  vi.mocked(projectsApi.syncApply).mockResolvedValue(APPLIED);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

describe("Обновить из кода: задание агенту", () => {
  it("язык выбирается из меню и уходит в задание", async () => {
    renderModal();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    const value = screen.getByRole("button", { name: "Язык описаний Русский" });
    await userEvent.click(value);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: "Русский" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Английский" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Язык описаний Английский" })).toHaveFocus();

    await userEvent.click(copyButton());
    await waitFor(() => expect(lastPrompt()).toMatchObject({ lang: "en", depth: 2, systemName: "Ярмарка" }));
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeInTheDocument();
  });

  it("подсказки агенту уходят в задание; пилюль и пометки «необязательно» нет", async () => {
    renderModal();
    await waitFor(() => expect(copyButton()).toBeEnabled());
    expect(screen.queryByText(/необязательно/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Английский" })).toBeNull();
    await userEvent.type(screen.getByLabelText("Подсказки агенту"), "игнорируй каталог legacy/");
    await userEvent.click(copyButton());
    await waitFor(() => expect(lastPrompt()).toMatchObject({ hints: "игнорируй каталог legacy/", lang: "ru" }));
  });

  it("Escape при открытом меню языка закрывает только меню, следующий — окно", async () => {
    const { onClose } = renderModal();
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

    const second = fireEvent.keyDown(value, { key: "Escape" });
    expect(second).toBe(true);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Обновить из кода: ответы агента и план", () => {
  it("выбор файла даёт план: итог, разделы «название число» без «·», пропажи с вниманием", async () => {
    renderModal();
    expect(screen.queryByText("Заменить описания")).toBeNull(); // галочки — после файлов
    await putFile();
    expect(projectsApi.syncPreview).toHaveBeenCalledWith("p1", ["nodes:\n  - name: Склад\n"], expect.objectContaining({ update_names: false }));
    expect(await screen.findByText("3 новых, 1 пропавших, 5 без изменений")).toBeInTheDocument();
    const created = screen.getByText("Новые объекты").closest("p")!;
    expect(created.textContent).toBe("Новые объекты 3");
    expect(screen.getByText("Пропали из YAML").closest(".sync-sec")).toHaveClass("is-attention");
    expect(screen.getByText("orders.yaml")).toHaveAttribute("title", "orders.yaml");
    expect(applyButton()).toBeEnabled();
  });

  it("вставка текстом: запись «вставка-1» с полем, текст уходит в план", async () => {
    renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Вставить текст" }));
    expect(screen.getByRole("button", { name: "вставка-1" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Текст вставка-1"), { target: { value: "nodes: []\n" } });
    await waitFor(() => expect(projectsApi.syncPreview).toHaveBeenCalledWith("p1", ["nodes: []\n"], expect.anything()), WAIT);
    // Убрать запись — поле и план уходят вместе с ней.
    await userEvent.click(screen.getByRole("button", { name: "Убрать вставка-1" }));
    expect(screen.queryByLabelText("Текст вставка-1")).toBeNull();
    expect(screen.queryByText("Заменить описания")).toBeNull();
  });

  it("пустой план: «Применять нечего», «Применить» выключена", async () => {
    vi.mocked(projectsApi.syncPreview).mockResolvedValue(plan({ is_noop: true, nodes: [], summary: { nodes_unchanged: 5 } }));
    renderModal();
    await putFile();
    expect(await screen.findByText("Применять нечего. Схема уже соответствует YAML")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
  });

  it("нечитаемый YAML: список «YAML не читается», «Применить» выключена", async () => {
    vi.mocked(projectsApi.syncPreview).mockResolvedValue(plan({ ok: false, errors: ["Некорректный YAML (строка 3)"], nodes: [] }));
    renderModal();
    await putFile("nodes: [\n");
    expect(await screen.findByText("YAML не читается")).toBeInTheDocument();
    expect(screen.getByText("Некорректный YAML (строка 3)")).toBeInTheDocument();
    expect(applyButton()).toBeDisabled();
  });
});

describe("Обновить из кода: применение", () => {
  it("зовёт API с выбранными галочками и курсором плана, затем закрывается", async () => {
    const { onApplied, onClose } = renderModal();
    await putFile();
    await userEvent.click(screen.getByLabelText("Переименовать объекты"));
    await waitFor(() => expect(projectsApi.syncPreview).toHaveBeenLastCalledWith(
      "p1", expect.anything(), expect.objectContaining({ update_names: true }),
    ), WAIT);
    await waitFor(() => expect(applyButton()).toBeEnabled(), WAIT);
    await userEvent.click(applyButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(projectsApi.syncApply).toHaveBeenCalledWith(
      "p1", ["nodes:\n  - name: Склад\n"],
      { update_descriptions: false, update_names: true, sync_components: false, mark_missing_deprecated: false, restore_returned: false },
      7,
    );
    expect(onApplied).toHaveBeenCalledWith("Схема обновлена: 3 создано");
  });

  it("отказ сохранения виден над кнопками, окно остаётся", async () => {
    vi.mocked(projectsApi.syncApply).mockRejectedValue(new ApiError(409, "конфликт"));
    const { onClose } = renderModal();
    await putFile();
    await waitFor(() => expect(applyButton()).toBeEnabled(), WAIT);
    await userEvent.click(applyButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Схему изменили в другом окне или другим пользователем");
    expect(alert.closest(".ds-win-foot")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
