// Способы старта в окне «Новый проект».
//
// Что закрепляем: способов ЧЕТЫРЕ — «Пустой / Копия / Импорт / ИИ-агент»; «Шаблон»
// убран 2026-09-30 вместе с витриной каркасов (демо-пакет ждёт онбординга). Окно
// открывается на «Пустом» и больше не ходит за каталогом шаблонов, а в POST
// /projects уезжает только «blank» или «copy:<id>» — ветки «template:» у бэка нет.
//
// Фикстура проекта типизирована схемой контракта (не any): разъедется контракт —
// поймает tsc.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import CreateProjectDialog from "../project/CreateProjectDialog";
import { projectsApi } from "../../api/projects";
import type { Project } from "../../types";

vi.mock("../../api/projects", () => ({
  projectsApi: {
    importPrompt: vi.fn(), create: vi.fn(), unifiedPreview: vi.fn(), importUnified: vi.fn(),
  },
}));
// Нативный <dialog> в jsdom не открывается — та же замена, что в соседних тестах.
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const ИМЯ = "Например, «Платёжная платформа»";

const проект = (id: string, name: string): Project => ({
  id, name, description: null, archived_at: null,
  created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
  object_count: 3, edge_count: 2, updated_by: null,
  preview: { nodes: [], edges: [] },
});

const onCreated = vi.fn();

/** Подписи кнопок-способов в порядке показа. */
const способы = () =>
  Array.from(document.querySelectorAll(".cp-segs > .cp-seg")).map((b) => b.textContent);

const создать = () => screen.getByRole("button", { name: "Создать проект" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectsApi.create).mockResolvedValue(проект("p-new", "Новый"));
});

describe("окно создания проекта · способы старта", () => {
  it("четыре способа, «Шаблона» нет; по умолчанию — «Пустой»", () => {
    render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={onCreated} />);
    expect(способы()).toEqual(["Пустой", "Копия", "Импорт", "ИИ-агент"]);
    expect(screen.queryByText("Шаблон")).toBeNull();
    expect(screen.getByRole("button", { name: "Пустой" })).toHaveClass("cp-seg--on");
    expect(screen.getByText("Пустая схема")).toBeInTheDocument();
    // Без проектов копировать нечего.
    expect(screen.getByRole("button", { name: "Копия" })).toBeDisabled();
  });

  it("«Пустой»: в создание уезжает start=blank", async () => {
    render(<CreateProjectDialog projects={[]} onClose={vi.fn()} onCreated={onCreated} />);
    expect(создать()).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(ИМЯ), "Платформа");
    await userEvent.click(создать());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("p-new"));
    expect(projectsApi.create).toHaveBeenCalledWith({
      name: "Платформа", description: null, start: "blank",
    });
  });

  it("«Копия»: в создание уезжает start=copy:<id> выбранного источника", async () => {
    const источники = [проект("p1", "Ярмарка"), проект("p2", "Плёнка")];
    render(<CreateProjectDialog projects={источники} onClose={vi.fn()} onCreated={onCreated} />);
    await userEvent.click(screen.getByRole("button", { name: "Копия" }));
    await userEvent.click(screen.getByRole("button", { name: /Плёнка/ }));
    await userEvent.type(screen.getByPlaceholderText(ИМЯ), "Копия Плёнки");
    await userEvent.click(создать());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("p-new"));
    expect(projectsApi.create).toHaveBeenCalledWith({
      name: "Копия Плёнки", description: null, start: "copy:p2",
    });
  });
});
