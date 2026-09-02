// Режим «Из архива» в окне создания проекта (Ф5 эпика архива).
//
// Что закрепляем: имя ОПЦИОНАЛЬНО (без него — из манифеста), отчёт применения
// показывается В ДИАЛОГЕ до перехода в проект (замечания — видимая деградация,
// прятать их за навигацией нельзя), «Открыть проект» ведёт в созданный.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CreateProjectDialog from "../project/CreateProjectDialog";
import { projectsApi } from "../../api/projects";
import type { ArchiveImportResult } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    templates: vi.fn(), importPrompt: vi.fn(), importPreview: vi.fn(), create: vi.fn(),
    importArchive: vi.fn(),
  },
}));
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

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
};

async function открыть() {
  render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={onCreated} />);
  await userEvent.click(screen.getByText("Из архива"));
}

const onCreated = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.templates).mockResolvedValue([]);
  vi.mocked(projectsApi.importArchive).mockResolvedValue(ОТЧЁТ);
});

describe("создание проекта из архива", () => {
  it("без файла кнопка не активна, с файлом — импорт без обязательного имени", async () => {
    await открыть();
    const кнопка = screen.getByRole("button", { name: "Создать проект" });
    expect(кнопка).toBeDisabled();

    const файл = new File(["zip"], "archmap.zip", { type: "application/zip" });
    await userEvent.upload(screen.getByLabelText(/Выбрать файл/), файл);
    expect(кнопка).toBeEnabled();

    await userEvent.click(кнопка);

    await waitFor(() =>
      expect(projectsApi.importArchive).toHaveBeenCalledWith(файл, undefined));
  });

  it("отчёт показан в диалоге, «Открыть проект» ведёт в созданный", async () => {
    await открыть();
    await userEvent.upload(
      screen.getByLabelText(/Выбрать файл/),
      new File(["zip"], "archmap.zip", { type: "application/zip" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Создать проект" }));

    // Сводка и замечания видны ДО перехода — молча провалиться нельзя.
    expect(await screen.findByText("«Ярмарка» создан")).toBeTruthy();
    expect(screen.getByText(/Нет такого/)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Открыть проект" }));

    expect(onCreated).toHaveBeenCalledWith("p-new");
  });

  it("введённое имя уезжает переопределением", async () => {
    await открыть();
    await userEvent.type(
      screen.getByPlaceholderText("Например, «Платёжная платформа»"), "Своё имя");
    const файл = new File(["zip"], "a.zip", { type: "application/zip" });
    await userEvent.upload(screen.getByLabelText(/Выбрать файл/), файл);

    await userEvent.click(screen.getByRole("button", { name: "Создать проект" }));

    await waitFor(() =>
      expect(projectsApi.importArchive).toHaveBeenCalledWith(файл, "Своё имя"));
  });
});
